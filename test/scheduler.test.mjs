import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { tick } from '../worker/scheduler.js';

function fakeFetch(status, body = '') {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status });
  };
  return { impl, calls };
}

test('dry run by default: only a GET, never a dispatch', async () => {
  const f = fakeFetch(200, JSON.stringify({ name: 'Down Detector' }));
  const r = await tick({ GITHUB_TOKEN: 't' }, f.impl);
  assert.equal(r.started, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, undefined);
  assert.match(f.calls[0].url, /TFI-IT-REG\/down-detector\/actions\/workflows\/monitor\.yml$/);
});

test('live posts a dispatch on main', async () => {
  const f = fakeFetch(204);
  const r = await tick({ GITHUB_TOKEN: 't', DRY_RUN: 'false' }, f.impl);
  assert.equal(r.started, true);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.match(f.calls[0].url, /monitor\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { ref: 'main' });
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer t');
});

test('GitHub error throws so Cloudflare logs a failure', async () => {
  const f = fakeFetch(403, 'Resource not accessible');
  await assert.rejects(tick({ GITHUB_TOKEN: 't', DRY_RUN: 'false' }, f.impl), /HTTP 403/);
});

test('missing token throws before any request', async () => {
  const f = fakeFetch(204);
  await assert.rejects(tick({ DRY_RUN: 'false' }, f.impl), /GITHUB_TOKEN/);
  assert.equal(f.calls.length, 0);
});

test('web request shows help and never dispatches', async () => {
  const res = await worker.fetch(new Request('https://x/'), { GITHUB_TOKEN: 't' });
  const text = await res.text();
  assert.match(text, /DRY RUN/);
  assert.match(text, /Token set: yes/);
  assert.doesNotMatch(text, /\bt\b.*Bearer/);
});
