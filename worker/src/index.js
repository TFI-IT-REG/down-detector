// Down Detector dispatcher v1.0.0 - Worker entry point
//
// Cloudflare Worker that starts the Down Detector GitHub Actions workflow on a
// fixed timer. Logic lives in lib.js; this file may only export handlers.

import { dispatch, checkAccess, renderPage } from './lib.js';

let lastCheck = 0;

export default {
  // Test hook: reset the /check throttle between tests. Not a route.
  _resetThrottle() { lastCheck = 0; },

  async scheduled(event, env, ctx) {
    const result = await dispatch(env);
    console.log(JSON.stringify({ ...result, cron: event?.cron, at: new Date(event?.scheduledTime ?? Date.now()).toISOString() }));
    // Throwing marks the cron invocation as failed in the Cloudflare dashboard.
    if (!result.ok) throw new Error(result.message);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/') {
      return new Response(renderPage(env), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/check') {
      // Light throttle so the public page can't burn the token's API quota.
      const now = Date.now();
      if (now - lastCheck < 10_000) {
        return Response.json({ ok: false, message: 'Checked a few seconds ago. Try again in 10 seconds.' }, { status: 429 });
      }
      lastCheck = now;
      return Response.json(await checkAccess(env), { headers: { 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
