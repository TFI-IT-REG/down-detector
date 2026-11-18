// Down Detector dispatcher tests v1.0.0
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { readConfig, dispatch, checkAccess, renderPage, VERSION } from '../worker/src/lib.js';

const TOKEN = 'github_pat_TESTONLY_not_a_real_token';
const LIVE = { DRY_RUN: 'false', GITHUB_TOKEN: TOKEN };

function mockFetch(status, body = '') {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status });
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => worker._resetThrottle());

test('readConfig defaults to dry run and the TFI-IT-REG repo', () => {
  const c = readConfig({});
  assert.equal(c.dryRun, true);
  assert.equal(c.owner, 'TFI-IT-REG');
  assert.equal(c.repo, 'down-detector');
  assert.equal(c.workflow, 'monitor.yml');
  assert.equal(c.ref, 'main');
  assert.equal(c.hasToken, false);
});

test('only an exact "false" turns dry run off', () => {
  assert.equal(readConfig({ DRY_RUN: 'false' }).dryRun, false);
  assert.equal(readConfig({ DRY_RUN: ' FALSE ' }).dryRun, false);
  for (const v of ['true', 'no', '0', '', 'off']) assert.equal(readConfig({ DRY_RUN: v }).dryRun, true, v);
});

test('dry run never calls GitHub', async () => {
  const f = mockFetch(204);
  const r = await dispatch({ GITHUB_TOKEN: TOKEN }, f);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'dry-run');
  assert.match(r.message, /DRY RUN: would start TFI-IT-REG\/down-detector monitor\.yml on main/);
  assert.equal(f.calls.length, 0);
});

test('live without a token fails without calling GitHub', async () => {
  const f = mockFetch(204);
  const r = await dispatch({ DRY_RUN: 'false' }, f);
  assert.equal(r.ok, false);
  assert.match(r.message, /GITHUB_TOKEN/);
  assert.equal(f.calls.length, 0);
});

test('live dispatch posts to the workflow dispatch endpoint', async () => {
  const f = mockFetch(204);
  const r = await dispatch(LIVE, f);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'dispatched');
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.github.com/repos/TFI-IT-REG/down-detector/actions/workflows/monitor.yml/dispatches');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(init.headers['User-Agent'], /down-detector-dispatcher/);
  assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
});

test('a 200 with run details also counts as success', async () => {
  const r = await dispatch(LIVE, mockFetch(200, '{"workflow_run_id":1}'));
  assert.equal(r.ok, true);
});

test('GitHub errors come back with a hint and never throw', async () => {
  const r401 = await dispatch(LIVE, mockFetch(401, '{"message":"Bad credentials"}'));
  assert.equal(r401.ok, false);
  assert.equal(r401.status, 401);
  assert.match(r401.message, /expired/);
  const r403 = await dispatch(LIVE, mockFetch(403, '{"message":"Resource not accessible"}'));
  assert.match(r403.message, /Actions permission/);
  const r404 = await dispatch(LIVE, mockFetch(404));
  assert.match(r404.message, /repository access/);
});

test('network errors are caught', async () => {
  const r = await dispatch(LIVE, async () => { throw new Error('boom'); });
  assert.equal(r.ok, false);
  assert.match(r.message, /Network error.*boom/);
});

test('scheduled handler throws on failure so Cloudflare logs it', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  t.mock.method(console, 'log', () => {});
  globalThis.fetch = mockFetch(403);
  await assert.rejects(worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, LIVE), /403/);
  globalThis.fetch = mockFetch(204);
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, LIVE);
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, {}); // dry run
});

test('checkAccess reports an enabled workflow', async () => {
  const f = mockFetch(200, JSON.stringify({ name: 'Down Detector', state: 'active' }));
  const r = await checkAccess({ GITHUB_TOKEN: TOKEN }, f);
  assert.equal(r.ok, true);
  assert.match(r.message, /Down Detector/);
  assert.equal(f.calls[0].init.method, undefined); // GET only
});

test('checkAccess flags a disabled workflow and bad tokens', async () => {
  const d = await checkAccess({ GITHUB_TOKEN: TOKEN }, mockFetch(200, JSON.stringify({ name: 'x', state: 'disabled_manually' })));
  assert.equal(d.ok, false);
  assert.match(d.message, /disabled_manually/);
  const e = await checkAccess({ GITHUB_TOKEN: TOKEN }, mockFetch(401));
  assert.equal(e.ok, false);
  const m = await checkAccess({}, mockFetch(200));
  assert.match(m.message, /not set/);
});

test('status page shows mode and version and never the token', () => {
  const dry = renderPage({ GITHUB_TOKEN: TOKEN });
  assert.match(dry, /DRY RUN/);
  assert.match(dry, new RegExp(VERSION.replace(/\./g, '\\.')));
  assert.match(dry, /id="helpbtn"/);
  assert.ok(!dry.includes(TOKEN));
  const live = renderPage(LIVE);
  assert.match(live, /LIVE/);
  assert.ok(!live.includes(TOKEN));
  assert.match(renderPage({}), /missing/);
});

test('status page escapes config values', () => {
  const html = renderPage({ GH_REF: '<script>x</script>' });
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('fetch routes: page, check, throttle, 404, 405', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = mockFetch(200, JSON.stringify({ name: 'Down Detector', state: 'active' }));
  const env = { GITHUB_TOKEN: TOKEN };
  const page = await worker.fetch(new Request('https://w.example/'), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const check = await worker.fetch(new Request('https://w.example/check'), env);
  assert.equal((await check.json()).ok, true);
  const again = await worker.fetch(new Request('https://w.example/check'), env);
  assert.equal(again.status, 429);
  assert.equal((await worker.fetch(new Request('https://w.example/nope'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://w.example/', { method: 'POST' }), env)).status, 405);
});
