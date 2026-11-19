// Down Detector Scheduler v1.0.0
//
// Cloudflare Worker that starts the Down Detector GitHub workflow every 5 minutes.
// GitHub's own cron is best effort and can skip runs for hours; Cloudflare's fires on time.
//
// Settings (Worker > Settings > Variables and Secrets):
//   GITHUB_TOKEN  secret    Fine-grained token, this repo only, "Actions: Read and write"
//   DRY_RUN       variable  Anything but "false" = dry run: checks the token, starts nothing
//   GH_REPO       variable  Optional, default "TFI-IT-REG/down-detector"
//   GH_WORKFLOW   variable  Optional, default "monitor.yml"
//   GH_REF        variable  Optional, default "main"
//
// Cron trigger (Worker > Settings > Triggers > Cron Triggers): */5 * * * *
//
// Opening the Worker URL shows this help text and whether it's live. It never starts a run.

const VERSION = '1.0.0';

function settings(env) {
  return {
    repo: env.GH_REPO || 'TFI-IT-REG/down-detector',
    workflow: env.GH_WORKFLOW || 'monitor.yml',
    ref: env.GH_REF || 'main',
    dryRun: String(env.DRY_RUN ?? '').toLowerCase() !== 'false',
    hasToken: Boolean(env.GITHUB_TOKEN),
  };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `down-detector-scheduler/${VERSION}`,
  };
}

export async function tick(env, fetchImpl = fetch) {
  const s = settings(env);
  if (!s.hasToken) {
    throw new Error('GITHUB_TOKEN secret is not set');
  }
  const base = `https://api.github.com/repos/${s.repo}/actions/workflows/${s.workflow}`;

  if (s.dryRun) {
    // Read-only call: proves the token can see the workflow without starting anything.
    const res = await fetchImpl(base, { headers: ghHeaders(env.GITHUB_TOKEN) });
    if (!res.ok) {
      throw new Error(`DRY RUN: token check failed, HTTP ${res.status}: ${await res.text()}`);
    }
    const wf = await res.json();
    const msg = `DRY RUN: would start "${wf.name}" (${s.workflow}) on ${s.ref} in ${s.repo}. Token OK.`;
    console.log(msg);
    return { started: false, dryRun: true, message: msg };
  }

  const res = await fetchImpl(`${base}/dispatches`, {
    method: 'POST',
    headers: { ...ghHeaders(env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: s.ref }),
  });
  if (!res.ok) {
    // Throwing marks the cron invocation as failed in Cloudflare's logs.
    throw new Error(`Dispatch failed, HTTP ${res.status}: ${await res.text()}`);
  }
  const msg = `Started ${s.workflow} on ${s.ref} in ${s.repo} (HTTP ${res.status}).`;
  console.log(msg);
  return { started: true, dryRun: false, message: msg };
}

function helpText(env) {
  const s = settings(env);
  return [
    `Down Detector Scheduler v${VERSION}`,
    '',
    `Mode:      ${s.dryRun ? 'DRY RUN (checks the token, starts nothing)' : 'LIVE (starts the workflow)'}`,
    `Repo:      ${s.repo}`,
    `Workflow:  ${s.workflow} on ${s.ref}`,
    `Token set: ${s.hasToken ? 'yes' : 'NO'}`,
    '',
    'How it works:',
    'Cloudflare runs this Worker on its cron trigger (every 5 minutes).',
    'Each run asks GitHub to start the Down Detector workflow.',
    'The GitHub schedule stays on as a backup. Extra runs are harmless:',
    'alerts only go out when a status changes.',
    '',
    'To go live: set variable DRY_RUN = false.',
    'To stop: delete the cron trigger or the Worker.',
    'Results: Worker > Logs, and the Actions tab on GitHub.',
    '',
  ].join('\n');
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  async fetch(request, env) {
    return new Response(helpText(env), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
