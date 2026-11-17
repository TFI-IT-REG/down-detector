// Down Detector v1.0.0 - unit tests: parsers, engine, notification payloads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatuspage, parseGoogle, parseRss, parseM365 } from '../src/checks.mjs';
import { evaluate } from '../src/engine.mjs';
import { buildTeamsPayload, buildTitle, buildRequests, describeRequest } from '../src/notify.mjs';

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
