// Down Detector v1.2.0 - check types and response parsers

import net from 'node:net';

import { worst } from './engine.mjs';

const UA = 'down-detector/1.0 (+status monitor)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...opts,
      signal: ac.signal,
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

async function getText(url, timeoutMs, headers) {
  const r = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.text();
}

async function getJson(url, timeoutMs, headers) {
  const text = await getText(url, timeoutMs, headers);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Response from ${url} was not JSON (starts: ${JSON.stringify(text.slice(0, 80))})`);
  }
}

const humanize = (s) => String(s || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
// First meaningful line, skipping markdown headings like "**Summary**" that Google puts at the top of updates.
const firstLine = (s) =>
  String(s || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !/^\*\*[^*]+\*\*:?$/.test(x) && !/^#+\s/.test(x))
    .map((x) => x.replace(/\*\*/g, ''))[0] || '';
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- Atlassian Statuspage ----------

const SP_COMPONENT = {
  operational: 'ok',
  under_maintenance: 'maintenance',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  major_outage: 'down',
};
const SP_INDICATOR = { none: 'ok', minor: 'degraded', major: 'down', critical: 'down', maintenance: 'maintenance' };

export function parseStatuspage(data, svc = {}) {
  const filter = svc.components?.map((s) => s.toLowerCase());
  const comps = (data.components || []).filter((c) => !c.group);
  const watched = filter ? comps.filter((c) => filter.includes(String(c.name).toLowerCase())) : comps;

  let level;
  if (filter) {
    if (!watched.length) {
      return { level: 'unknown', summary: `None of the configured components were found: ${svc.components.join(', ')}`, incidents: [] };
    }
    level = worst(watched.map((c) => SP_COMPONENT[c.status] ?? 'unknown'));
  } else {
    level = SP_INDICATOR[data.status?.indicator] ?? 'unknown';
  }

  const inProgressMaint = (data.scheduled_maintenances || []).filter((m) => m.status === 'in_progress');
  if (level === 'ok' && inProgressMaint.length && !filter) level = 'maintenance';

  const incidents = (data.incidents || [])
    .filter((i) => !['resolved', 'postmortem', 'completed'].includes(i.status))
    .filter((i) => !filter || !i.components?.length || i.components.some((c) => filter.includes(String(c.name).toLowerCase())))
    .map((i) => ({ id: i.id, title: i.name, url: i.shortlink || '', impact: i.impact || '', status: i.status || '' }));

  const bad = watched.filter((c) => c.status !== 'operational');
  let summary;
  if (bad.length) {
    const list = bad.slice(0, 5).map((c) => `${c.name} (${humanize(c.status)})`).join(', ');
    summary = `${bad.length} component${bad.length > 1 ? 's' : ''} affected: ${list}${bad.length > 5 ? ', …' : ''}`;
  } else if (incidents.length) {
    summary = incidents.map((i) => i.title).join('; ');
  } else {
    summary = filter ? 'All watched components operational' : data.status?.description || 'All systems operational';
  }
  return { level, summary: clip(summary, 240), incidents };
}

// ---------- Google (Workspace / Cloud incidents.json) ----------

const G_IMPACT = { SERVICE_OUTAGE: 'down', SERVICE_DISRUPTION: 'degraded' };

export function parseGoogle(data, svc = {}) {
  if (!Array.isArray(data)) throw new Error('Expected an array of incidents');
  const base = svc.pageUrl || 'https://www.google.com/appsstatus/dashboard/';
  const filter = svc.products?.map((s) => s.toLowerCase());
  const products = (i) => (i.affected_products || []).map((p) => p.title).filter(Boolean);

  const active = data
    .filter((i) => !i.end)
    .filter((i) => G_IMPACT[i.status_impact] || (!i.status_impact && i.severity && i.severity !== 'low'))
    .filter((i) => !filter || products(i).some((p) => filter.includes(p.toLowerCase())) || filter.includes(String(i.service_name || '').toLowerCase()));

  const levelOf = (i) => G_IMPACT[i.status_impact] ?? (i.severity === 'high' ? 'down' : 'degraded');
  const incidents = active.map((i) => {
    const who = products(i).join(', ') || i.service_name || 'Google';
    const what = firstLine(i.most_recent_update?.text) || firstLine(i.external_desc);
    return {
      id: i.id,
      title: clip(`${who}: ${what}`),
      url: i.uri ? new URL(i.uri, base).href : base,
      impact: levelOf(i),
    };
  });
  const level = worst(active.map(levelOf)) ?? 'ok';
  const summary = incidents.length ? incidents.map((i) => i.title).join('; ') : 'No active incidents';
  return { level, summary: clip(summary, 240), incidents };
}

// ---------- RSS (e.g. Azure status feed: items are active events) ----------

function decodeXml(s) {
  return String(s)
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseRss(xml, svc = {}, now = Date.now()) {
  if (!/<rss|<feed|<channel/i.test(xml)) throw new Error('Response was not an RSS feed');
  const maxAgeMs = (svc.maxAgeHours ?? 24) * 3600 * 1000;
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => {
    const body = m[1];
    const tag = (n) => {
      const mm = body.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i'));
      return mm ? decodeXml(mm[1].trim()) : '';
    };
    return { title: tag('title'), link: tag('link'), guid: tag('guid'), pubDate: tag('pubDate') };
  });
  const fresh = items.filter((it) => {
    const t = Date.parse(it.pubDate);
    return Number.isNaN(t) || now - t <= maxAgeMs;
  });
  const incidents = fresh.map((it) => ({ id: it.guid || it.link || it.title, title: clip(it.title || 'Untitled event'), url: it.link || svc.pageUrl || '' }));
  const level = incidents.length ? svc.itemLevel || 'degraded' : 'ok';
  const summary = incidents.length ? incidents.map((i) => i.title).join('; ') : 'No active events in feed';
  return { level, summary: clip(summary, 240), incidents };
}

// ---------- Microsoft 365 service health (Graph, needs app registration) ----------

const M365_OK = new Set(['serviceOperational', 'serviceRestored', 'falsePositive', 'postIncidentReviewPublished', 'resolved', 'resolvedExternal', 'mitigatedExternal', 'mitigated']);
const M365_DOWN = new Set(['serviceInterruption']);

export function parseM365(data, svc = {}) {
  const filter = svc.services?.map((s) => s.toLowerCase());
  const rows = (data.value || []).filter((o) => !filter || filter.includes(String(o.service).toLowerCase()));
  const levelOf = (o) => (M365_OK.has(o.status) ? 'ok' : M365_DOWN.has(o.status) ? 'down' : 'degraded');
  const bad = rows.filter((o) => levelOf(o) !== 'ok');
  const incidents = bad.map((o) => ({ id: `${o.id}:${o.status}`, title: `${o.service}: ${humanize(o.status)}`, url: svc.pageUrl || '', impact: levelOf(o) }));
  const level = worst(bad.map(levelOf)) ?? 'ok';
  const summary = incidents.length ? incidents.map((i) => i.title).join('; ') : `All ${rows.length} services operational`;
  return { level, summary: clip(summary, 240), incidents };
}

async function m365Token(env, timeoutMs) {
  const body = new URLSearchParams({
    client_id: env.M365_CLIENT_ID,
    client_secret: env.M365_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetchWithTimeout(
    `https://login.microsoftonline.com/${encodeURIComponent(env.M365_TENANT_ID)}/oauth2/v2.0/token`,
    { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    timeoutMs,
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Graph token request failed: HTTP ${r.status} ${j.error || ''}`.trim());
  return j.access_token;
}

// ---------- Direct HTTP probe ----------

async function httpAttempt(svc, timeoutMs, slowMs) {
  const start = performance.now();
  try {
    const r = await fetchWithTimeout(svc.url, { method: svc.method || 'GET', headers: svc.headers }, timeoutMs);
    const text = svc.expectText ? await r.text() : (await r.arrayBuffer(), '');
    const latencyMs = Math.round(performance.now() - start);
    const okStatus = svc.expectStatus ? svc.expectStatus.includes(r.status) : r.status >= 200 && r.status < 400;
    if (!okStatus) {
      // A rate limit means we couldn't check, not that the service is down. "unknown" only
      // alerts after several runs in a row (unknownThreshold), so a shared runner IP hitting
      // an anonymous API limit no longer pages anyone.
      const limited = (r.status === 403 || r.status === 429) && (r.headers.get('x-ratelimit-remaining') === '0' || r.headers.has('retry-after'));
      if (limited) return { level: 'unknown', summary: `Rate limited (HTTP ${r.status}), couldn't check`, latencyMs };
      return { level: 'down', summary: `HTTP ${r.status}`, latencyMs };
    }
    if (svc.expectText && !text.includes(svc.expectText)) return { level: 'down', summary: `HTTP ${r.status} but expected text "${svc.expectText}" missing`, latencyMs };
    if (latencyMs > slowMs) return { level: 'degraded', summary: `Slow: ${latencyMs} ms (limit ${slowMs} ms)`, latencyMs };
    return { level: 'ok', summary: `HTTP ${r.status} in ${latencyMs} ms`, latencyMs };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - start);
    const why = e.name === 'AbortError' ? `Timed out after ${timeoutMs} ms` : e.cause?.code || e.cause?.message || e.message;
    return { level: 'down', summary: `No response: ${why}`, latencyMs };
  }
}

async function checkHttp(svc, defaults) {
  const timeoutMs = svc.timeoutMs ?? defaults.timeoutMs ?? 10000;
  const slowMs = svc.slowMs ?? defaults.slowMs ?? 8000;
  const retryDelayMs = svc.retryDelayMs ?? defaults.retryDelayMs ?? 15000;
  let r = await httpAttempt(svc, timeoutMs, slowMs);
  if (r.level !== 'ok') {
    await sleep(retryDelayMs);
    const r2 = await httpAttempt(svc, timeoutMs, slowMs);
    r = r2.level === 'ok' ? r2 : { ...r2, summary: `${r2.summary} (failed twice, ${Math.round(retryDelayMs / 1000)}s apart)` };
  }
  return { ...r, incidents: r.level === 'ok' ? [] : [{ id: 'probe', title: r.summary, url: svc.pageUrl || svc.url }] };
}

// ---------- TCP port probe (VPN gateways, on-prem services) ----------

function tcpAttempt(host, port, timeoutMs, slowMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.connect({ host, port });
    const done = (r) => {
      sock.destroy();
      resolve({ ...r, latencyMs: Math.round(performance.now() - start) });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      const ms = Math.round(performance.now() - start);
      if (ms > slowMs) done({ level: 'degraded', summary: `Port ${port} open but slow: ${ms} ms (limit ${slowMs} ms)` });
      else done({ level: 'ok', summary: `Port ${port} open in ${ms} ms` });
    });
    sock.once('timeout', () => done({ level: 'down', summary: `Port ${port}: timed out after ${timeoutMs} ms` }));
    sock.once('error', (e) => done({ level: 'down', summary: `Port ${port}: ${e.code || e.message}` }));
  });
}

async function checkTcp(svc, defaults) {
  const timeoutMs = svc.timeoutMs ?? defaults.timeoutMs ?? 10000;
  const slowMs = svc.slowMs ?? defaults.slowMs ?? 8000;
  const retryDelayMs = svc.retryDelayMs ?? defaults.retryDelayMs ?? 15000;
  const port = Number(svc.port);
  if (!svc.host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { level: 'unknown', summary: 'TCP check needs "host" and a valid "port"', incidents: [] };
  }
  let r = await tcpAttempt(svc.host, port, timeoutMs, slowMs);
  if (r.level !== 'ok') {
    await sleep(retryDelayMs);
    const r2 = await tcpAttempt(svc.host, port, timeoutMs, slowMs);
    r = r2.level === 'ok' ? r2 : { ...r2, summary: `${r2.summary} (failed twice, ${Math.round(retryDelayMs / 1000)}s apart)` };
  }
  return { ...r, incidents: r.level === 'ok' ? [] : [{ id: 'probe', title: r.summary, url: svc.pageUrl || '' }] };
}

// ---------- Dispatcher ----------

/**
 * Replace ${NAME} in string fields with env values so private hostnames can live in GitHub secrets
 * instead of the public config. Returns the list of missing variable names.
 */
export function resolveSecrets(svc, env = process.env) {
  const missing = new Set();
  const sub = (v) =>
    typeof v === 'string'
      ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => {
          if (env[n] === undefined || env[n] === '') {
            missing.add(n);
            return '';
          }
          return env[n];
        })
      : Array.isArray(v)
        ? v.map(sub)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
          : v;
  return { svc: sub(svc), missing: [...missing] };
}

export async function runCheck(rawSvc, defaults = {}, env = process.env, { probe = false } = {}) {
  const { svc, missing } = resolveSecrets(rawSvc, env);
  if (missing.length) {
    return { level: 'skipped', summary: `Not configured (needs secret${missing.length > 1 ? 's' : ''} ${missing.join(', ')})`, incidents: [] };
  }
  const timeoutMs = svc.timeoutMs ?? defaults.timeoutMs ?? 10000;
  const show = (raw) => {
    if (probe) console.log(`\n--- PROBE ${svc.id} (${svc.type}) ---\n${(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 1500)}\n`);
    return raw;
  };
  try {
    switch (svc.type) {
      case 'statuspage':
        return parseStatuspage(show(await getJson(`${svc.url.replace(/\/$/, '')}/api/v2/summary.json`, timeoutMs)), svc);
      case 'google':
        return parseGoogle(show(await getJson(svc.url, timeoutMs)), svc);
      case 'rss':
        return parseRss(show(await getText(svc.url, timeoutMs)), svc);
      case 'm365graph': {
        if (!env.M365_TENANT_ID || !env.M365_CLIENT_ID || !env.M365_CLIENT_SECRET) {
          return { level: 'skipped', summary: 'Not configured (needs M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET secrets)', incidents: [] };
        }
        const token = await m365Token(env, timeoutMs);
        const data = await getJson('https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews', timeoutMs, { authorization: `Bearer ${token}` });
        return parseM365(show(data), svc);
      }
      case 'http':
        return await checkHttp(svc, defaults);
      case 'tcp':
        return await checkTcp(svc, defaults);
      default:
        return { level: 'unknown', summary: `Unknown check type "${svc.type}"`, incidents: [] };
    }
  } catch (e) {
    const why = e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message;
    return { level: 'unknown', summary: `Could not read status source: ${why}`, incidents: [] };
  }
}
