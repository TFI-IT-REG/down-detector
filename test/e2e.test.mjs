// Down Detector v1.0.0 - end-to-end: real monitor.mjs runs against a local mock of vendors and alert channels
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const monitor = new URL('../src/monitor.mjs', import.meta.url).pathname;

let server, base, dir;
const mode = { sp: 'ok', probe: 200 };
let received = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST') {
        received.push({ path: req.url, headers: req.headers, body });
        res.writeHead(req.url.startsWith('/hook/teams') ? 202 : 200).end('{}');
        return;
      }
      if (req.url === '/sp/api/v2/summary.json') return res.end(fx(mode.sp === 'ok' ? 'statuspage-ok.json' : 'statuspage-incident.json'));
      if (req.url === '/google.json') return res.end(fx('google.json'));
      if (req.url === '/rss') return res.end(fx('rss-empty.xml'));
      if (req.url === '/probe') return res.writeHead(mode.probe).end('issuer ok');
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'dd-e2e-'));
  writeFileSync(
    join(dir, 'services.json'),
    JSON.stringify({
      defaults: { timeoutMs: 3000, retryDelayMs: 0, failThreshold: 1, unknownThreshold: 3 },
      services: [
        { id: 'sp', name: 'Mock Statuspage', group: 'Dev', type: 'statuspage', url: `${base}/sp` },
        { id: 'goog', name: 'Mock Google', group: 'Google', type: 'google', url: `${base}/google.json` },
        { id: 'rss', name: 'Mock Feed', group: 'MS', type: 'rss', url: `${base}/rss` },
        { id: 'probe', name: 'Mock Probe', group: 'ERP', type: 'http', url: `${base}/probe`, expectText: 'issuer' },
        { id: 'm365', name: 'Mock M365', group: 'MS', type: 'm365graph' },
      ],
    }),
  );
});

after(() => server.close());

async function go(live, extraArgs = []) {
  received = [];
  const env = {
    PATH: process.env.PATH,
    LIVE: live ? 'true' : 'false',
    DD_CONFIG: join(dir, 'services.json'),
    DD_STATE: join(dir, 'state', 'state.json'),
    DD_SITE: join(dir, 'site'),
    PAGE_URL: 'https://example.github.io/dd/',
    TEAMS_WEBHOOK_URL: `${base}/hook/teams?sig=SECRET`,
    NTFY_SERVER: `${base}/hook/ntfy`,
    NTFY_TOPIC: 'secret-topic',
    PUSHOVER_TOKEN: 'tok',
    PUSHOVER_USER: 'usr',
    PUSHOVER_API: `${base}/hook/pushover`,
  };
  const { stdout } = await run(process.execPath, [monitor, ...extraArgs], { env });
  return stdout;
}

test('run 1 (dry run): baseline. Google already degraded so it is reported, nothing is sent', async () => {
  const out = await go(false);
  assert.match(out, /mode=DRY RUN/);
  assert.match(out, /DEGRADED Mock Google/);
  assert.match(out, /DRY RUN: would send 3 request/);
  assert.doesNotMatch(out, /sig=SECRET|secret-topic|=tok|=usr/);
  assert.equal(received.length, 0, 'dry run must not POST anything');
  const status = JSON.parse(readFileSync(join(dir, 'site', 'status.json'), 'utf8'));
  assert.equal(status.services.find((s) => s.id === 'm365').level, 'skipped');
  assert.ok(existsSync(join(dir, 'site', 'index.html')));
  assert.ok(existsSync(join(dir, 'site', 'scooter.webp')), 'sprites are published with the page');
  assert.ok(existsSync(join(dir, 'site', 'desk.webp')));
});

test('run 2 (live): nothing changed, nothing sent', async () => {
  const out = await go(true);
  assert.match(out, /No changes/);
  assert.equal(received.length, 0);
});

test('run 3 (live): statuspage outage + probe failure -> one batched alert per channel', async () => {
  mode.sp = 'incident';
  mode.probe = 503;
  const out = await go(true);
  assert.match(out, /2 change\(s\)/);
  assert.equal(received.length, 3);
  const teams = received.find((r) => r.path.startsWith('/hook/teams'));
  const card = JSON.parse(teams.body).attachments[0].content;
  assert.match(card.body[0].text, /2 service changes: 2 with issues/);
  const ntfy = received.find((r) => r.path === '/hook/ntfy/secret-topic');
  assert.equal(ntfy.headers['x-priority'], '5');
  assert.match(ntfy.body, /DOWN Mock Probe: HTTP 503/);
  const po = new URLSearchParams(received.find((r) => r.path === '/hook/pushover').body);
  assert.equal(po.get('priority'), '1');
  assert.equal(po.get('url'), 'https://example.github.io/dd/');
});

test('run 4 (live): still down, no repeat', async () => {
  const out = await go(true);
  assert.match(out, /No changes/);
  assert.equal(received.length, 0);
});

test('run 5 (live): both recover -> recovery alert at low priority', async () => {
  mode.sp = 'ok';
  mode.probe = 200;
  await go(true);
  assert.equal(received.length, 3);
  const ntfy = received.find((r) => r.path.startsWith('/hook/ntfy'));
  assert.match(ntfy.headers['x-title'], /2 recovered/);
  assert.equal(ntfy.headers['x-priority'], '3');
  const status = JSON.parse(readFileSync(join(dir, 'site', 'status.json'), 'utf8'));
  assert.equal(status.history[0].kind, 'recovered');
  // 24h sample history accumulates one sample per run and carries probe latency
  const probe = status.services.find((s) => s.id === 'probe');
  assert.equal(probe.samples.length, 5);
  assert.deepEqual(probe.samples.map((x) => x[1]), ['o', 'o', 'x', 'x', 'o']);
  assert.ok(Number.isInteger(probe.samples[0][2]));
  assert.equal(status.historyHours, 24);
  assert.equal(probe.slowMs, 8000);
});

test('samples older than the history window are pruned', async () => {
  const statePath = join(dir, 'state', 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  const old = Math.floor(Date.now() / 1000) - 25 * 3600;
  st.services.probe.samples.unshift([old, 'o', 10]);
  writeFileSync(statePath, JSON.stringify(st));
  await go(false);
  const probe = JSON.parse(readFileSync(join(dir, 'site', 'status.json'), 'utf8')).services.find((s) => s.id === 'probe');
  assert.ok(probe.samples.every((x) => x[0] > old));
  assert.equal(probe.samples.length, 6);
});

test('--test-alert sends a TEST message to every channel', async () => {
  const out = await go(false, ['--test-alert']);
  assert.match(out, /sent=/);
  assert.equal(received.length, 3);
  assert.match(received.find((r) => r.path.startsWith('/hook/ntfy')).headers['x-title'], /^TEST - /);
});
