// Down Detector v1.0.0 - unit tests: parsers, engine, notification payloads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatuspage, parseGoogle, parseRss, parseM365 } from '../src/checks.mjs';
import { evaluate } from '../src/engine.mjs';
import { buildTeamsPayload, buildTitle, buildRequests, describeRequest, alertImage } from '../src/notify.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-17T12:00:00Z');

test('statuspage: all operational', () => {
  const r = parseStatuspage(JSON.parse(fx('statuspage-ok.json')));
  assert.equal(r.level, 'ok');
  assert.equal(r.incidents.length, 0);
});

test('statuspage: major incident, resolved incidents ignored', () => {
  const r = parseStatuspage(JSON.parse(fx('statuspage-incident.json')));
  assert.equal(r.level, 'down');
  assert.deepEqual(r.incidents.map((i) => i.id), ['inc1']);
  assert.match(r.summary, /Actions \(major outage\)/);
});

test('statuspage: component filter narrows to watched components', () => {
  const data = JSON.parse(fx('statuspage-incident.json'));
  const r = parseStatuspage(data, { components: ['Git Operations'] });
  assert.equal(r.level, 'ok');
  assert.equal(r.incidents.length, 0, 'incident on Actions should be filtered out');
  const r2 = parseStatuspage(data, { components: ['Pages'] });
  assert.equal(r2.level, 'degraded');
  const r3 = parseStatuspage(data, { components: ['Nope'] });
  assert.equal(r3.level, 'unknown');
});

test('google: only ongoing, non-informational incidents', () => {
  const r = parseGoogle(JSON.parse(fx('google.json')));
  assert.equal(r.level, 'degraded');
  assert.deepEqual(r.incidents.map((i) => i.id), ['g-live']);
  assert.equal(r.incidents[0].url, 'https://www.google.com/appsstatus/dashboard/incidents/g-live');
  assert.match(r.incidents[0].title, /^Gmail: We're investigating delays/);
});

test('google: product filter', () => {
  const r = parseGoogle(JSON.parse(fx('google.json')), { products: ['Google Drive'] });
  assert.equal(r.level, 'ok');
});

test('rss: active item counts, stale item ignored, entities decoded', () => {
  const r = parseRss(fx('rss-active.xml'), { maxAgeHours: 24 }, NOW);
  assert.equal(r.level, 'degraded');
  assert.equal(r.incidents.length, 1);
  assert.equal(r.incidents[0].title, 'Virtual Machines - East US & Central US');
  assert.equal(parseRss(fx('rss-empty.xml'), {}, NOW).level, 'ok');
  assert.throws(() => parseRss('<html>nope</html>'));
});

test('m365: worst status wins', () => {
  const r = parseM365(JSON.parse(fx('m365.json')));
  assert.equal(r.level, 'down');
  assert.equal(r.incidents.length, 2);
  assert.equal(parseM365(JSON.parse(fx('m365.json')), { services: ['Microsoft Teams'] }).level, 'ok');
});

// ---------- engine ----------

const svcSP = { id: 'gh', name: 'GitHub', type: 'statuspage' };
const svcHttp = { id: 'p', name: 'Probe', type: 'http' };
const ok = { level: 'ok', summary: 'fine', incidents: [] };
const down = { level: 'down', summary: 'broken', incidents: [{ id: 'i1', title: 'broken' }] };

test('engine: first run ok is a silent baseline', () => {
  const { change, state } = evaluate(svcSP, ok, undefined);
  assert.equal(change, null);
  assert.equal(state.alertedLevel, 'ok');
});

test('engine: first run already down alerts', () => {
  const { change } = evaluate(svcSP, down, undefined);
  assert.equal(change.to, 'down');
});

test('engine: ok -> down -> down(same) -> down(new incident) -> ok', () => {
  let s = evaluate(svcSP, ok, undefined).state;
  let r = evaluate(svcSP, down, s);
  assert.equal(r.change.kind, 'worse');
  s = r.state;
  r = evaluate(svcSP, down, s);
  assert.equal(r.change, null, 'no repeat alert');
  s = r.state;
  r = evaluate(svcSP, { ...down, incidents: [...down.incidents, { id: 'i2', title: 'more' }] }, s);
  assert.equal(r.change.kind, 'updated');
  s = r.state;
  r = evaluate(svcSP, ok, s);
  assert.equal(r.change.kind, 'recovered');
});

test('engine: unknown is held until threshold', () => {
  const unk = { level: 'unknown', summary: 'cannot read', incidents: [] };
  let s = evaluate(svcSP, ok, undefined).state;
  for (let i = 1; i <= 2; i++) {
    const r = evaluate(svcSP, unk, s, { unknownThreshold: 3 });
    assert.equal(r.change, null, `held on run ${i}`);
    s = r.state;
  }
  const r = evaluate(svcSP, unk, s, { unknownThreshold: 3 });
  assert.equal(r.change.to, 'unknown');
});

test('engine: http failThreshold 2 holds the first failure', () => {
  let s = evaluate(svcHttp, ok, undefined).state;
  let r = evaluate(svcHttp, down, s, { failThreshold: 2 });
  assert.equal(r.change, null);
  r = evaluate(svcHttp, down, r.state, { failThreshold: 2 });
  assert.equal(r.change.to, 'down');
});

test('engine: maintenance flips are silent by default', () => {
  const s = evaluate(svcSP, ok, undefined).state;
  const r = evaluate(svcSP, { level: 'maintenance', summary: 'm', incidents: [] }, s);
  assert.equal(r.change, null);
  const r2 = evaluate(svcSP, { level: 'maintenance', summary: 'm', incidents: [] }, s, { notifyMaintenance: true });
  assert.equal(r2.change.to, 'maintenance');
});

test('engine: skipped never alerts', () => {
  assert.equal(evaluate(svcSP, { level: 'skipped', summary: '', incidents: [] }, undefined).change, null);
});

// ---------- notify ----------

const changes = [
  { id: 'a', name: 'GitHub', group: 'Dev', from: 'ok', to: 'down', kind: 'worse', summary: 'Actions down', incidents: [{ id: 'x', title: 'Incident with Actions', url: 'https://stspg.io/abc' }], url: 'https://stspg.io/abc' },
  { id: 'b', name: 'Google Workspace', group: 'Google', from: 'degraded', to: 'ok', kind: 'recovered', summary: 'No active incidents', incidents: [], url: '' },
];

test('notify: titles', () => {
  assert.equal(buildTitle([changes[0]]), 'DOWN: GitHub');
  assert.equal(buildTitle([changes[1]]), 'RECOVERED: Google Workspace');
  assert.equal(buildTitle(changes), '2 service changes: 1 with issues, 1 recovered');
  assert.equal(buildTitle([changes[0]], { test: true }), 'TEST - DOWN: GitHub');
});

test('notify: Teams payload is a Workflows-style adaptive card message', () => {
  const p = buildTeamsPayload(changes, { pageUrl: 'https://example.github.io/dd/' });
  assert.equal(p.type, 'message');
  const card = p.attachments[0];
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.content.type, 'AdaptiveCard');
  assert.equal(card.content.version, '1.4');
  assert.equal(card.content.actions[0].url, 'https://example.github.io/dd/');
  const text = JSON.stringify(card.content.body);
  assert.match(text, /DOWN/);
  assert.match(text, /RECOVERED/);
});

test('notify: requests per channel and redaction', () => {
  const env = { TEAMS_WEBHOOK_URL: 'https://prod.example.com/workflows/abc?sig=SECRET', NTFY_TOPIC: 'secret-topic', PUSHOVER_TOKEN: 'tok', PUSHOVER_USER: 'usr' };
  const reqs = buildRequests(changes, env, {});
  assert.deepEqual(reqs.map((r) => r.channel), ['teams', 'ntfy', 'pushover']);
  const ntfy = reqs.find((r) => r.channel === 'ntfy');
  assert.equal(ntfy.init.headers['X-Priority'], '5');
  const po = new URLSearchParams(reqs.find((r) => r.channel === 'pushover').init.body);
  assert.equal(po.get('priority'), '1');
  const redacted = JSON.stringify(reqs.map(describeRequest));
  assert.doesNotMatch(redacted, /SECRET|secret-topic|tok&|=usr/);
});

// ---------- tcp + secret placeholders (v1.2.0) ----------
import net from 'node:net';
import { runCheck, resolveSecrets } from '../src/checks.mjs';

test('resolveSecrets substitutes env and reports missing names', () => {
  const svc = { id: 'v', type: 'tcp', host: '${VPN_HOST}', port: 443, name: 'VPN' };
  assert.deepEqual(resolveSecrets(svc, { VPN_HOST: 'vpn.example.com' }).svc.host, 'vpn.example.com');
  assert.deepEqual(resolveSecrets(svc, {}).missing, ['VPN_HOST']);
});

test('tcp check: missing secret is skipped, not down', async () => {
  const r = await runCheck({ id: 'v', type: 'tcp', host: '${VPN_HOST}', port: 443 }, {}, {});
  assert.equal(r.level, 'skipped');
  assert.match(r.summary, /needs secret VPN_HOST/);
});

test('tcp check: open port is ok, closed port is down after retry', async () => {
  const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const ok = await runCheck({ id: 't', type: 'tcp', host: '${H}', port }, { retryDelayMs: 0 }, { H: '127.0.0.1' });
  assert.equal(ok.level, 'ok');
  assert.ok(Number.isInteger(ok.latencyMs));
  srv.close();
  await new Promise((r) => srv.once('close', r));
  const bad = await runCheck({ id: 't', type: 'tcp', host: '127.0.0.1', port }, { retryDelayMs: 0 }, {});
  assert.equal(bad.level, 'down');
  assert.match(bad.summary, /ECONNREFUSED.*failed twice/);
});

test('tcp check: bad config is unknown', async () => {
  const r = await runCheck({ id: 't', type: 'tcp', host: 'x', port: 'abc' }, {}, {});
  assert.equal(r.level, 'unknown');
});

// ---------- http probe: rate limits (v1.3.1) ----------
import http from 'node:http';

async function server(handler) {
  const srv = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/` };
}

test('http check: 403 with x-ratelimit-remaining 0 is unknown, not down', async () => {
  const { srv, url } = await server((req, res) => { res.writeHead(403, { 'x-ratelimit-remaining': '0' }); res.end('API rate limit exceeded'); });
  const r = await runCheck({ id: 'g', type: 'http', url }, { retryDelayMs: 0 }, {});
  srv.close();
  assert.equal(r.level, 'unknown');
  assert.match(r.summary, /Rate limited \(HTTP 403\)/);
});

test('http check: 429 with retry-after is unknown', async () => {
  const { srv, url } = await server((req, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end(); });
  const r = await runCheck({ id: 'g', type: 'http', url }, { retryDelayMs: 0 }, {});
  srv.close();
  assert.equal(r.level, 'unknown');
});

test('http check: plain 403 is still down', async () => {
  const { srv, url } = await server((req, res) => { res.writeHead(403); res.end(); });
  const r = await runCheck({ id: 'g', type: 'http', url }, { retryDelayMs: 0 }, {});
  srv.close();
  assert.equal(r.level, 'down');
  assert.match(r.summary, /HTTP 403.*failed twice/);
});

test('http check: secret header is sent, and a missing token skips the check', async () => {
  let seen = '';
  const { srv, url } = await server((req, res) => { seen = req.headers.authorization || ''; res.end('ok'); });
  const svc = { id: 'g', type: 'http', url, headers: { authorization: 'Bearer ${GITHUB_TOKEN}' } };
  const ok = await runCheck(svc, { retryDelayMs: 0 }, { GITHUB_TOKEN: 'tok-TESTONLY' });
  srv.close();
  assert.equal(ok.level, 'ok');
  assert.equal(seen, 'Bearer tok-TESTONLY');
  const skipped = await runCheck(svc, {}, {});
  assert.equal(skipped.level, 'skipped');
});

// ---------- Teams card image (v1.3.2) ----------
test('teams card shows the radio guard for problems and the cruising guard for recoveries', () => {
  const down = [{ id: 'a', name: 'NetSuite login', to: 'down', from: 'ok', kind: 'changed', summary: 'HTTP 503', incidents: [] }];
  const up = [{ id: 'a', name: 'NetSuite login', to: 'ok', from: 'down', kind: 'changed', summary: 'HTTP 200', incidents: [] }];
  const ctx = { pageUrl: 'https://example.github.io/dd/' };
  const cardOf = (c) => buildTeamsPayload(c, ctx).attachments[0].content;
  const img = (card) => card.body[0].columns[0].items[0];
  assert.equal(img(cardOf(down)).url, 'https://example.github.io/dd/alert-radio.png');
  assert.equal(img(cardOf(up)).url, 'https://example.github.io/dd/alert-ok.png');
  assert.equal(alertImage(down, { pageUrl: 'https://example.github.io/dd' }).url, 'https://example.github.io/dd/alert-radio.png');
  assert.equal(cardOf(down).body[0].columns[1].items[0].weight, 'Bolder');
});

test('teams card has no image when there is no page URL', () => {
  const down = [{ id: 'a', name: 'X', to: 'down', from: 'ok', kind: 'changed', summary: 's', incidents: [] }];
  const card = buildTeamsPayload(down, {}).attachments[0].content;
  assert.equal(card.body[0].type, 'TextBlock');
  assert.equal(alertImage(down, {}), null);
});
