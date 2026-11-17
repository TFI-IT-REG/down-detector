// Down Detector v1.0.0 - notification channels (Teams Workflows webhook, ntfy, Pushover)

import { LABEL, LEVEL_RANK, worst } from './engine.mjs';
import { fetchWithTimeout } from './checks.mjs';

const TEAMS_COLOR = { down: 'Attention', degraded: 'Warning', unknown: 'Warning', maintenance: 'Accent', ok: 'Good' };

function worstTo(changes) {
  // Recoveries rank lowest so a mixed batch is titled by the bad news.
  return worst(changes.map((c) => c.to));
}

export function buildTitle(changes, { test = false } = {}) {
  const prefix = test ? 'TEST - ' : '';
  if (changes.length === 1) {
    const c = changes[0];
    const label = c.kind === 'updated' ? `UPDATE (${LABEL[c.to]})` : LABEL[c.to];
    return `${prefix}${label}: ${c.name}`;
  }
  const bad = changes.filter((c) => c.to !== 'ok').length;
  const good = changes.length - bad;
  const parts = [];
  if (bad) parts.push(`${bad} with issues`);
  if (good) parts.push(`${good} recovered`);
  return `${prefix}${changes.length} service changes: ${parts.join(', ')}`;
}

export function changeLine(c) {
  const label = c.kind === 'updated' ? 'UPDATE' : LABEL[c.to];
  const extra = c.incidents
    .slice(0, 3)
    .map((i) => i.title)
    .filter((t) => t && t !== c.summary);
  return `${label} ${c.name}: ${c.summary}${extra.length ? ' | ' + extra.join(' | ') : ''}`;
}

export function buildPlain(changes) {
  return changes.map(changeLine).join('\n');
}

export function priorityOf(changes) {
  const w = worstTo(changes);
  if (w === 'down') return { ntfy: 5, pushover: 1 };
  if (w === 'degraded' || w === 'unknown') return { ntfy: 4, pushover: 0 };
  return { ntfy: 3, pushover: -1 };
}

export function buildTeamsPayload(changes, ctx = {}) {
  const body = [
    { type: 'TextBlock', text: buildTitle(changes, ctx), weight: 'Bolder', size: 'Medium', wrap: true },
  ];
  for (const c of [...changes].sort((a, b) => (LEVEL_RANK[b.to] ?? 0) - (LEVEL_RANK[a.to] ?? 0))) {
    const items = [
      {
        type: 'TextBlock',
        text: `**${c.kind === 'updated' ? 'UPDATE' : LABEL[c.to]}**  ${c.name}${c.group ? `  (${c.group})` : ''}`,
        color: TEAMS_COLOR[c.to] || 'Default',
        wrap: true,
      },
      { type: 'TextBlock', text: c.summary || '-', wrap: true, spacing: 'None', isSubtle: true },
    ];
    for (const i of c.incidents.slice(0, 3)) {
      if (i.title && i.title !== c.summary) {
        items.push({ type: 'TextBlock', text: i.url ? `[${i.title}](${i.url})` : i.title, wrap: true, spacing: 'None', size: 'Small' });
      }
    }
    body.push({ type: 'Container', separator: true, items });
  }
  body.push({ type: 'TextBlock', text: `Checked ${new Date(ctx.at || Date.now()).toUTCString()}`, size: 'Small', isSubtle: true, wrap: true });

  const actions = [];
  if (ctx.pageUrl) actions.push({ type: 'Action.OpenUrl', title: 'Open status page', url: ctx.pageUrl });
  const first = changes.find((c) => c.url);
  if (first) actions.push({ type: 'Action.OpenUrl', title: `Vendor status: ${first.name}`, url: first.url });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

async function post(url, init, timeoutMs = 15000) {
  const r = await fetchWithTimeout(url, { method: 'POST', ...init }, timeoutMs);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return r.status;
}

/** Returns the list of channels configured via env. */
export function channels(env = process.env) {
  const list = [];
  if (env.TEAMS_WEBHOOK_URL) list.push('teams');
  if (env.NTFY_TOPIC) list.push('ntfy');
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) list.push('pushover');
  return list;
}

/**
 * Build every channel's request. Kept separate from sending so dry-run can show exactly what would go out.
 */
export function buildRequests(changes, env = process.env, ctx = {}) {
  const title = buildTitle(changes, ctx);
  const text = buildPlain(changes);
  const pr = priorityOf(changes);
  const click = ctx.pageUrl || changes.find((c) => c.url)?.url || '';
  const reqs = [];

  if (env.TEAMS_WEBHOOK_URL) {
    reqs.push({
      channel: 'teams',
      url: env.TEAMS_WEBHOOK_URL,
      init: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildTeamsPayload(changes, ctx)) },
    });
  }
  if (env.NTFY_TOPIC) {
    const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
    const headers = {
      'X-Title': title,
      'X-Priority': String(pr.ntfy),
      'X-Tags': worstTo(changes) === 'ok' ? 'white_check_mark' : 'rotating_light',
      'content-type': 'text/plain; charset=utf-8',
    };
    if (click) headers['X-Click'] = click;
    if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`;
    reqs.push({ channel: 'ntfy', url: `${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, init: { headers, body: text } });
  }
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) {
    const form = new URLSearchParams({
      token: env.PUSHOVER_TOKEN,
      user: env.PUSHOVER_USER,
      title: title.slice(0, 250),
      message: text.slice(0, 1024),
      priority: String(pr.pushover),
    });
    if (click) {
      form.set('url', click);
      form.set('url_title', 'Status');
    }
    reqs.push({
      channel: 'pushover',
      url: env.PUSHOVER_API || 'https://api.pushover.net/1/messages.json',
      init: { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
    });
  }
  return reqs;
}

/** Sends to every configured channel. Returns {sent:[], failed:[{channel,error}]}. */
export async function sendAll(changes, env = process.env, ctx = {}) {
  const reqs = buildRequests(changes, env, ctx);
  const sent = [];
  const failed = [];
  await Promise.all(
    reqs.map(async (r) => {
      try {
        await post(r.url, r.init);
        sent.push(r.channel);
      } catch (e) {
        failed.push({ channel: r.channel, error: e.message });
      }
    }),
  );
  return { sent, failed, attempted: reqs.length };
}

/** Redacts secrets for dry-run logging. */
export function describeRequest(r) {
  let url = r.url;
  if (r.channel === 'teams') url = url.replace(/(sig=)[^&]+/, '$1***').replace(/^(https:\/\/[^/]+).*/, '$1/...');
  if (r.channel === 'ntfy') url = url.replace(/\/[^/]+$/, '/***');
  let body = r.init.body;
  if (r.channel === 'pushover') body = body.replace(/(token|user)=[^&]+/g, '$1=***');
  return { channel: r.channel, url, headers: { ...r.init.headers, authorization: r.init.headers.authorization ? '***' : undefined }, body };
}
