// Down Detector Scheduler tests v1.0.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { tick } from '../worker/src/index.js';

const TOKEN = 'github_pat_TESTONLY_not_a_real_token';
const LIVE = { DRY_RUN: 'false', GITHUB_TOKEN: TOKEN };
const WF_URL = 'https://api.github.com/repos/TFI-IT-REG/down-detector/actions/workflows/monitor.yml';

function mockFetch(status, body = '') {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status });
  };
  fn.calls = calls;
  return fn;
}

const quiet = (t) => t.mock.method(console, 'log', () => {});

test('live tick posts to the workflow dispatch endpoint with the right body and headers', async (t) => {
  quiet(t);
  const f = mockFetch(204);
  const r = await tick(LIVE, f);
  assert.equal(r.started, true);
  assert.equal(r.dryRun, false);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, `${WF_URL}/dispatches`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.match(init.headers['User-Agent'], /down-detector-scheduler\/1\.0\.0/);
  assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
});

test('GH_REPO, GH_WORKFLOW and GH_REF override the defaults', async (t) => {
  quiet(t);
  const f = mockFetch(204);
  await tick({ ...LIVE, GH_REPO: 'TFI-IT-REG/other', GH_WORKFLOW: 'x.yml', GH_REF: 'dev' }, f);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/TFI-IT-REG/other/actions/workflows/x.yml/dispatches');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { ref: 'dev' });
});

test('only "false" (any case) is live; unset and anything else is dry run', async (t) => {
  quiet(t);
  for (const v of ['false', 'FALSE', 'False']) {
    const f = mockFetch(204);
    assert.equal((await tick({ DRY_RUN: v, GITHUB_TOKEN: TOKEN }, f)).started, true, v);
  }
  for (const v of [undefined, '', 'true', 'no', '0']) {
    const f = mockFetch(200, JSON.stringify({ name: 'Down Detector' }));
    const r = await tick({ DRY_RUN: v, GITHUB_TOKEN: TOKEN }, f);
    assert.equal(r.started, false, String(v));
    assert.equal(f.calls[0].init.method, undefined, 'dry run must only GET');
  }
});

test('dry run checks the token read-only and names the workflow', async (t) => {
  quiet(t);
  const f = mockFetch(200, JSON.stringify({ name: 'Down Detector' }));
  const r = await tick({ GITHUB_TOKEN: TOKEN }, f);
  assert.equal(r.dryRun, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, WF_URL);
  assert.match(r.message, /DRY RUN: would start "Down Detector".*Token OK/);
});

test('missing token throws before calling GitHub', async () => {
  const f = mockFetch(204);
  await assert.rejects(tick({ DRY_RUN: 'false' }, f), /GITHUB_TOKEN secret is not set/);
  await assert.rejects(tick({}, f), /GITHUB_TOKEN secret is not set/);
  assert.equal(f.calls.length, 0);
});

test('GitHub errors throw with the status code', async () => {
  await assert.rejects(tick(LIVE, mockFetch(401, 'Bad credentials')), /Dispatch failed, HTTP 401: Bad credentials/);
  await assert.rejects(tick(LIVE, mockFetch(403, 'nope')), /HTTP 403/);
  await assert.rejects(tick({ GITHUB_TOKEN: TOKEN }, mockFetch(404, 'Not Found')), /DRY RUN: token check failed, HTTP 404/);
});

test('scheduled hands the tick to waitUntil', async (t) => {
  quiet(t);
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  globalThis.fetch = mockFetch(204);
  const pending = [];
  await worker.scheduled({ cron: '*/5 * * * *' }, LIVE, { waitUntil: (p) => pending.push(p) });
  assert.equal(pending.length, 1);
  assert.equal((await pending[0]).started, true);
});

test('page shows mode, target and token state, never the token, and starts nothing', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  const f = mockFetch(204);
  globalThis.fetch = f;
  const live = await (await worker.fetch(new Request('https://w.example/'), LIVE)).text();
  assert.match(live, /Down Detector Scheduler v1\.0\.0/);
  assert.match(live, /Mode:\s+LIVE/);
  assert.match(live, /Repo:\s+TFI-IT-REG\/down-detector/);
  assert.match(live, /Token set: yes/);
  assert.ok(!live.includes(TOKEN));
  const dry = await (await worker.fetch(new Request('https://w.example/'), {})).text();
  assert.match(dry, /Mode:\s+DRY RUN/);
  assert.match(dry, /Token set: NO/);
  assert.equal(f.calls.length, 0, 'opening the page must not call GitHub');
});
