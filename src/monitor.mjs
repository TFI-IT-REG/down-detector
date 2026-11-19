#!/usr/bin/env node
// Down Detector v1.3.1
// Polls vendor status sources and direct probes, alerts on state changes.
// Dry run by default. Set LIVE=true to actually send notifications.
//
// Flags:
//   --test-alert   send a TEST message to every configured channel, then exit (always sends)
//   --probe        print raw responses from each status source (for verifying formats)

import { readFile, writeFile, mkdir, copyFile, appendFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from './checks.mjs';
import { evaluate, LABEL } from './engine.mjs';
import { buildRequests, channels, describeRequest, sendAll } from './notify.mjs';

export const VERSION = '1.3.1';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const env = process.env;
const argv = process.argv.slice(2);

const CONFIG_PATH = env.DD_CONFIG || join(root, 'config', 'services.json');
const STATE_PATH = env.DD_STATE || join(root, 'state', 'state.json');
const SITE_DIR = env.DD_SITE || join(root, 'site');
const LIVE = env.LIVE === 'true';
const ctx = { pageUrl: env.PAGE_URL || '', at: new Date().toISOString() };

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function summary(md) {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, md + '\n');
}

async function testAlert() {
  const configured = channels(env);
  if (!configured.length) {
    console.error('No channels configured. Set TEAMS_WEBHOOK_URL, NTFY_TOPIC, or PUSHOVER_TOKEN + PUSHOVER_USER.');
    process.exit(1);
  }
  const sample = [
    {
      id: 'test',
      name: 'Down Detector',
      group: 'Test',
      from: 'ok',
      to: 'degraded',
      kind: 'worse',
      summary: 'This is a test alert. If you can read this, the channel works. No action needed.',
      incidents: [],
      url: ctx.pageUrl,
      at: ctx.at,
    },
  ];
  const res = await sendAll(sample, env, { ...ctx, test: true });
  console.log(`Test alert: sent=${res.sent.join(',') || 'none'} failed=${res.failed.map((f) => `${f.channel} (${f.error})`).join(', ') || 'none'}`);
  await summary(`### Test alert\nSent: ${res.sent.join(', ') || 'none'}\n\nFailed: ${res.failed.map((f) => `${f.channel}: ${f.error}`).join('; ') || 'none'}`);
  if (res.failed.length) process.exit(1);
}

async function main() {
  console.log(`Down Detector v${VERSION}  mode=${LIVE ? 'LIVE' : 'DRY RUN'}  channels=${channels(env).join(',') || 'none'}`);
  if (argv.includes('--test-alert')) return testAlert();

  const config = await readJson(CONFIG_PATH);
  if (!config) throw new Error(`Config not found: ${CONFIG_PATH}`);
  const defaults = config.defaults || {};
  const services = config.services.filter((s) => s.enabled !== false);
  const ids = new Set();
  for (const s of services) {
    if (!s.id || !s.name || !s.type) throw new Error(`Service entry missing id/name/type: ${JSON.stringify(s)}`);
    if (ids.has(s.id)) throw new Error(`Duplicate service id: ${s.id}`);
    ids.add(s.id);
  }

  const prevState = await readJson(STATE_PATH, { services: {}, history: [] });
  const now = ctx.at;

  const results = await Promise.all(
    services.map((s) =>
      runCheck(s, defaults, env, { probe: argv.includes('--probe') }).catch((e) => ({ level: 'unknown', summary: `Check crashed: ${e.message}`, incidents: [] })),
    ),
  );

  const nextState = { version: 1, lastRun: now, services: {}, history: prevState.history || [] };
  const changes = [];
  const HISTORY_HOURS = Number(env.HISTORY_HOURS || 24);
  const CODE = { ok: 'o', maintenance: 'm', unknown: 'u', degraded: 'd', down: 'x', skipped: 's' };
  const nowSec = Math.floor(Date.parse(now) / 1000);
  const cutoff = nowSec - HISTORY_HOURS * 3600;
  services.forEach((s, i) => {
    const prev = prevState.services?.[s.id];
    const { state, change } = evaluate(s, results[i], prev, defaults, now);
    // Rolling sample history for the dashboard: [epochSeconds, levelCode, latencyMs|null]
    state.samples = [...(prev?.samples || []).filter((x) => x[0] >= cutoff), [nowSec, CODE[results[i].level] ?? 'u', results[i].latencyMs ?? null]];
    nextState.services[s.id] = state;
    if (change) changes.push(change);
  });

  // Console table
  for (const [i, s] of services.entries()) {
    const r = results[i];
    console.log(`${r.level.toUpperCase().padEnd(11)} ${s.name.padEnd(32)} ${r.summary}`);
  }

  // Notify
  let notifyFailed = false;
  if (changes.length) {
    console.log(`\n${changes.length} change(s) to alert on:`);
    for (const c of changes) console.log(`  ${c.kind === 'updated' ? 'UPDATE' : LABEL[c.to]} ${c.name} (was ${c.from ?? 'new'})`);

    if (!LIVE) {
      const reqs = buildRequests(changes, env, ctx);
      console.log(`\nDRY RUN: would send ${reqs.length} request(s):`);
      for (const r of reqs) console.log(JSON.stringify(describeRequest(r), null, 2));
      if (!reqs.length) console.log('  (no channels configured)');
    } else {
      const res = await sendAll(changes, env, ctx);
      console.log(`Sent: ${res.sent.join(', ') || 'none'}`);
      for (const f of res.failed) console.error(`FAILED ${f.channel}: ${f.error}`);
      if (res.failed.length) notifyFailed = true;
      // If every channel failed, don't mark these as alerted so the next run retries.
      if (res.attempted > 0 && res.sent.length === 0) {
        for (const c of changes) {
          const p = prevState.services?.[c.id];
          nextState.services[c.id].alertedLevel = p?.alertedLevel ?? null;
          nextState.services[c.id].alertedSig = p?.alertedSig ?? null;
        }
      }
    }
    nextState.history = [...changes.map((c) => ({ ...c, live: LIVE })), ...nextState.history].slice(0, 100);
  } else {
    console.log('\nNo changes.');
  }

  await writeJson(STATE_PATH, nextState);

  // Status page data
  const status = {
    version: VERSION,
    generatedAt: now,
    live: LIVE,
    intervalMinutes: Number(env.INTERVAL_MINUTES || 5),
    historyHours: HISTORY_HOURS,
    services: services.map((s, i) => {
      const st = nextState.services[s.id];
      const r = results[i];
      return {
        id: s.id,
        name: s.name,
        group: s.group || 'Other',
        type: s.type,
        level: r.level === 'skipped' ? 'skipped' : st.alertedLevel ?? r.level,
        rawLevel: r.level,
        summary: r.summary,
        incidents: r.incidents,
        latencyMs: r.latencyMs ?? null,
        since: st.since,
        lastChecked: st.lastChecked,
        pageUrl: s.pageUrl || (s.type === 'statuspage' ? s.url : ''),
        slowMs: s.type === 'http' || s.type === 'tcp' ? s.slowMs ?? defaults.slowMs ?? 8000 : null,
        samples: st.samples,
      };
    }),
    history: nextState.history.slice(0, 50),
  };
  await mkdir(SITE_DIR, { recursive: true });
  await writeJson(join(SITE_DIR, 'status.json'), status);
  // Publish the page and everything beside it (sprites etc.).
  for (const f of await readdir(join(here, 'site'))) await copyFile(join(here, 'site', f), join(SITE_DIR, f));

  // Job summary
  const rows = status.services.map((s) => `| ${s.level} | ${s.name} | ${String(s.summary).replace(/\|/g, '/')} |`).join('\n');
  await summary(
    `### Down Detector v${VERSION} (${LIVE ? 'LIVE' : 'DRY RUN'})\n\n| Level | Service | Detail |\n|---|---|---|\n${rows}\n\n` +
      (changes.length ? `**Alerts:** ${changes.map((c) => `${LABEL[c.to]} ${c.name}`).join(', ')}` : 'No changes.'),
  );

  // Dead-man switch: only ping if this run finished cleanly.
  if (env.HEARTBEAT_URL && !notifyFailed) {
    try {
      await fetch(env.HEARTBEAT_URL);
    } catch (e) {
      console.error(`Heartbeat ping failed: ${e.message}`);
    }
  }

  if (notifyFailed) process.exit(1);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
