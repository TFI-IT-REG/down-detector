# Down Detector Scheduler

v1.0.0. A Cloudflare Worker that starts the Down Detector workflow every 5 minutes.

GitHub's built-in schedule is best-effort and was skipping runs for hours at a time. This Worker uses a Cloudflare cron trigger instead and asks GitHub to start the workflow, the same as clicking "Run workflow" in the Actions tab. GitHub's own schedule stays on as a backup. Extra runs are harmless, because alerts only fire when something changes.

**Live since 2026-11-18.** The Worker is `down-detector-scheduler` in the TFI-IT Cloudflare account, managed in the Cloudflare dashboard. `src/index.js` here is a copy of the live code. Keep the two in sync: change it here first, then paste it into the dashboard.

Cost: free. 288 cron runs a day are well inside Cloudflare's free Workers plan, and Actions minutes are free because the repo is public.

---

## QUICK REFERENCE

| Task | Where |
|---|---|
| Is it live? | Open https://down-detector-scheduler.tfi-it.workers.dev. It shows Mode, Repo, Workflow and Token set. Opening it never starts a run. |
| Is it working? | GitHub > Actions > Down Detector: a **workflow_dispatch** run every 5 minutes |
| See each tick | Cloudflare > Workers & Pages > down-detector-scheduler > Logs |
| Pause | Settings > Variables and Secrets > `DRY_RUN` = `true`. Ticks then only check the token. |
| Stop completely | Settings > Trigger events > delete the cron trigger |
| Replace the token | Settings > Variables and Secrets > `GITHUB_TOKEN` > edit |
| Change the code | Edit `src/index.js` here, run `npm test`, merge, then Edit code in Cloudflare and paste it in |
| Run tests | `npm test` from the repo root |

---

## SETTINGS

All under Cloudflare > Workers & Pages > down-detector-scheduler > Settings.

| Name | Type | Value |
|---|---|---|
| `GITHUB_TOKEN` | Secret | Fine-grained GitHub token, this repo only, Actions: Read and write |
| `DRY_RUN` | Variable | `false` = live. Anything else = dry run (token check only). |
| `GH_REPO` | Variable | Optional, default `TFI-IT-REG/down-detector` |
| `GH_WORKFLOW` | Variable | Optional, default `monitor.yml` |
| `GH_REF` | Variable | Optional, default `main` |
| Cron trigger | Trigger events | `*/5 * * * *` |

`wrangler.toml` mirrors these. Deploying with `npx wrangler deploy` would overwrite the dashboard's variables and cron trigger with the file's values (the secret is kept), so keep the file matching what's live.

---

## REPLACING THE TOKEN

1. In GitHub, click your avatar > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
2. Resource owner: **TFI-IT-REG**. Repository access: **Only select repositories** > `TFI-IT-REG/down-detector`.
3. Permissions > Repository permissions > **Actions**: **Read and write**. Leave everything else at No access.
4. Generate it, then paste it into the `GITHUB_TOKEN` secret in Cloudflare.
5. If the org requires approval, an org owner approves it under TFI-IT-REG > **Settings** > **Personal access tokens** > **Pending requests**.

The token belongs to whoever created it. It stops working if it expires or that person leaves the org. Keep a calendar reminder a week before it expires.

---

## TEST CHECKLIST

Use after any change to the code, token or settings.

- [ ] `npm test` passes from the repo root.
- [ ] The Worker URL shows **LIVE**, `TFI-IT-REG/down-detector`, `monitor.yml on main` and Token set **yes**.
- [ ] Within 5 minutes, a new **workflow_dispatch** run appears in GitHub Actions and succeeds.
- [ ] Over the next hour, runs appear about every 5 minutes, and the status page has no "data is old" warning.
- [ ] Cloudflare Logs show `Started monitor.yml on main ...` for each tick.
- [ ] Dry-run check (optional): set `DRY_RUN` = `true`. The next tick logs `DRY RUN: would start "Down Detector" ... Token OK.` and no new run appears. Set it back to `false`.

---

## HOW IT FAILS

- **Token expired or revoked:** each tick logs `Dispatch failed, HTTP 401` in Cloudflare Logs. Runs stop, so the status page shows its "data is old" warning and the heartbeat monitor alerts.
- **Cloudflare down or cron deleted:** GitHub's own schedule still runs, just less often.
- **Workflow disabled in GitHub:** ticks log an HTTP error from GitHub.

## ROLLBACK

Delete the cron trigger, or set `DRY_RUN` to anything but `false`. Nothing in the main monitor depends on this Worker.
