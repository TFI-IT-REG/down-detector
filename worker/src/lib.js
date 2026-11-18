// Down Detector dispatcher v1.0.0 - dispatch logic and status page
//
// Cloudflare Worker that starts the Down Detector GitHub Actions workflow on a
// fixed timer. GitHub's own cron schedule is best-effort and often skips runs
// for hours; a workflow_dispatch call starts a run right away.
//
// Safe by default: unless DRY_RUN is exactly "false", it only logs what it
// would do and never calls GitHub's dispatch endpoint.

export const VERSION = '1.0.0';
const API = 'https://api.github.com';

export function readConfig(env = {}) {
  return {
    owner: env.GH_OWNER || 'TFI-IT-REG',
    repo: env.GH_REPO || 'down-detector',
    workflow: env.GH_WORKFLOW || 'monitor.yml',
    ref: env.GH_REF || 'main',
    dryRun: String(env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false',
    hasToken: Boolean(env.GITHUB_TOKEN),
  };
}

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `down-detector-dispatcher/${VERSION}`,
  };
}

function workflowUrl(cfg) {
  return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${encodeURIComponent(cfg.workflow)}`;
}

function describe(cfg) {
  return `${cfg.owner}/${cfg.repo} ${cfg.workflow} on ${cfg.ref}`;
}

function statusHint(status) {
  if (status === 401) return 'Token is wrong or expired. Create a new one and update the GITHUB_TOKEN secret.';
  if (status === 403) return 'Token lacks Actions permission, or the org has not approved it yet.';
  if (status === 404) return 'Token cannot see this repo or workflow. Check the token\'s repository access.';
  if (status === 422) return 'GitHub rejected the request. Check GH_REF names a real branch and the workflow has workflow_dispatch.';
  return '';
}

// Start one workflow run. Never throws; returns { ok, action, status?, message }.
export async function dispatch(env, fetchImpl = fetch) {
  const cfg = readConfig(env);
  if (cfg.dryRun) {
    return { ok: true, action: 'dry-run', message: `DRY RUN: would start ${describe(cfg)}` };
  }
  if (!cfg.hasToken) {
    return { ok: false, action: 'error', message: 'GITHUB_TOKEN secret is not set' };
  }
  let res;
  try {
    res = await fetchImpl(`${workflowUrl(cfg)}/dispatches`, {
      method: 'POST',
      headers: { ...ghHeaders(env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: cfg.ref }),
    });
  } catch (err) {
    return { ok: false, action: 'error', message: `Network error calling GitHub: ${err.message}` };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, action: 'dispatched', status: res.status, message: `Started ${describe(cfg)}` };
  }
  let body = '';
  try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
  const hint = statusHint(res.status);
  return {
    ok: false,
    action: 'error',
    status: res.status,
    message: `GitHub returned ${res.status}. ${hint} ${body}`.replace(/\s+/g, ' ').trim(),
  };
}

// Read-only token check for the status page. Confirms the token can see the
// workflow. It cannot prove write access without starting a run.
export async function checkAccess(env, fetchImpl = fetch) {
  const cfg = readConfig(env);
  if (!cfg.hasToken) return { ok: false, message: 'GITHUB_TOKEN secret is not set' };
  let res;
  try {
    res = await fetchImpl(workflowUrl(cfg), { headers: ghHeaders(env.GITHUB_TOKEN) });
  } catch (err) {
    return { ok: false, message: `Network error calling GitHub: ${err.message}` };
  }
  if (res.ok) {
    let wf = {};
    try { wf = await res.json(); } catch { /* ignore */ }
    const active = wf.state === 'active';
    return {
      ok: active,
      message: active
        ? `Token can see "${wf.name || cfg.workflow}" and it is enabled.`
        : `Token can see the workflow but its state is "${wf.state}". Enable it in the Actions tab.`,
    };
  }
  return { ok: false, message: `GitHub returned ${res.status}. ${statusHint(res.status)}`.trim() };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderPage(env) {
  const cfg = readConfig(env);
  const mode = cfg.dryRun
    ? '<span class="pill warn">DRY RUN</span> Logs only. Nothing is sent to GitHub.'
    : '<span class="pill ok">LIVE</span> Starts a workflow run on every timer tick.';
  const runsUrl = `https://github.com/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${encodeURIComponent(cfg.workflow)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Down Detector Dispatcher</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2329;--muted:#5d6670;--line:#dde1e6;--ok:#1a7f45;--okbg:#e5f4ea;--warn:#8a5a00;--warnbg:#fdf1d8;--bad:#b42318;--badbg:#fde8e7;--btn:#fff;--tip:#1d2329;--tiptext:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121519;--card:#1b1f24;--text:#e6e9ec;--muted:#9aa4ae;--line:#2c3239;--ok:#5fd18b;--okbg:#173322;--warn:#f0c062;--warnbg:#3a2e12;--bad:#ff8a80;--badbg:#3d1d1b;--btn:#22272d;--tip:#e6e9ec;--tiptext:#121519}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}
dt{color:var(--muted)} dd{margin:0;word-break:break-word}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;margin-right:6px}
.ok{color:var(--ok);background:var(--okbg)} .warn{color:var(--warn);background:var(--warnbg)} .bad{color:var(--bad);background:var(--badbg)}
.btns{display:flex;gap:8px}
button{font:inherit;background:var(--btn);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;position:relative}
button:hover{border-color:var(--muted)}
[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:0;top:calc(100% + 6px);width:max-content;max-width:260px;background:var(--tip);color:var(--tiptext);font-size:12px;padding:6px 8px;border-radius:6px;z-index:2;text-align:left;white-space:normal}
#result{margin-top:12px;padding:10px 12px;border-radius:8px;display:none}
#help{display:none} #help.open{display:block}
#help p,#help li{color:var(--muted)} #help h2{font-size:16px;margin:0 0 8px}
a{color:inherit}
</style></head><body><main>
<header><h1>Down Detector Dispatcher</h1>
<div class="btns">
<button id="check" data-tip="Asks GitHub whether the token can see the workflow. Read-only: it does not start a run.">Check token</button>
<button id="helpbtn" aria-expanded="false" data-tip="How this works">?</button>
</div></header>
<div id="help" class="card"><h2>How it works</h2>
<p>GitHub's built-in schedule for Down Detector is best-effort and often skips runs for hours. This Worker runs on a Cloudflare timer every 5 minutes and asks GitHub to start the Down Detector workflow, the same as clicking "Run workflow" in the Actions tab.</p>
<ul>
<li><b>Dry run</b> (default): each tick only writes "would start" to the Worker log.</li>
<li><b>Live</b>: set <code>DRY_RUN = "false"</code> in <code>worker/wrangler.toml</code> and redeploy.</li>
<li>The GitHub schedule stays on as a backup. Extra runs are harmless: alerts only fire on changes.</li>
<li>If the token expires, ticks fail and show as errors in the Cloudflare logs. The status page's "data is old" warning and the heartbeat monitor also catch it.</li>
</ul>
<p>Version ${VERSION}. Setup and rollback steps are in <code>worker/README.md</code> in the repo.</p></div>
<div class="card"><dl>
<dt>Mode</dt><dd>${mode}</dd>
<dt>Starts</dt><dd>${esc(cfg.workflow)} on ${esc(cfg.ref)} in <a href="${esc(runsUrl)}">${esc(cfg.owner)}/${esc(cfg.repo)}</a></dd>
<dt>Timer</dt><dd>Every 5 minutes (set in wrangler.toml)</dd>
<dt>Token</dt><dd>${cfg.hasToken ? '<span class="pill ok">set</span>' : '<span class="pill bad">missing</span> Add the GITHUB_TOKEN secret'}</dd>
<dt>Version</dt><dd>${VERSION}</dd>
</dl><div id="result"></div></div>
</main>
<script>
const help=document.getElementById('help'),hb=document.getElementById('helpbtn');
hb.onclick=()=>{const o=help.classList.toggle('open');hb.setAttribute('aria-expanded',o)};
const out=document.getElementById('result'),btn=document.getElementById('check');
btn.onclick=async()=>{btn.disabled=true;out.style.display='block';out.className='';out.textContent='Checking...';
try{const r=await fetch('/check');const j=await r.json();out.className=j.ok?'ok':'bad';out.textContent=j.message}
catch(e){out.className='bad';out.textContent='Check failed: '+e.message}
finally{btn.disabled=false}};
</script></body></html>`;
}
