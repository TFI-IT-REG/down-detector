# Down Detector Dispatcher

v1.0.0. A Cloudflare Worker that starts the Down Detector workflow every 5 minutes.

GitHub's built-in schedule is best-effort and was skipping runs for hours at a time. This Worker uses a Cloudflare timer instead and asks GitHub to start the workflow, the same as clicking "Run workflow" in the Actions tab. GitHub's own schedule stays on as a backup. Extra runs are harmless, because alerts only fire when something changes.

It ships in **dry-run mode**. Each tick only logs "would start" until you set `DRY_RUN = "false"`.

Cost: free. Cron triggers and this traffic (288 calls a day) are well inside Cloudflare's free Workers plan, and Actions minutes are free because the repo is public.

---

## QUICK REFERENCE

| Task | How |
|---|---|
| Status page | Open the Worker's `workers.dev` URL. "Check token" tests the token without starting a run. |
| Watch ticks live | `npx wrangler tail` in this folder, or Cloudflare > Workers & Pages > down-detector-dispatcher > Logs |
| Go live | Set `DRY_RUN = "false"` in `wrangler.toml`, commit, `npx wrangler deploy` |
| Pause | Set `DRY_RUN = "true"`, commit, `npx wrangler deploy` |
| Replace the token | `npx wrangler secret put GITHUB_TOKEN` |
| Remove completely | `npx wrangler delete`. The GitHub schedule keeps running. |
| Run tests | `npm test` from the repo root |

---

## SETUP

### 1. Create the GitHub token

1. In GitHub, click your avatar > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
2. Token name: `down-detector-dispatcher`.
3. Resource owner: **TFI-IT-REG**.
4. Expiration: the longest the org allows. Put a calendar reminder a week before it expires.
5. Repository access: **Only select repositories** > `TFI-IT-REG/down-detector`.
6. Permissions > Repository permissions > **Actions**: **Read and write**. Leave everything else at No access. Metadata: Read-only is added on its own.
7. Click **Generate token** and copy it. You only see it once.
8. If the org requires approval, an org owner approves it under TFI-IT-REG > **Settings** > **Personal access tokens** > **Pending requests**.

The token belongs to whoever creates it. If that person leaves the org, it stops working and needs replacing.

### 2. Deploy the Worker (still in dry run)

From a computer with Node 20 or later:

```bash
git clone https://github.com/TFI-IT-REG/down-detector
```

```bash
cd down-detector/worker
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put GITHUB_TOKEN
```

Paste the token when asked. `wrangler deploy` prints the Worker's `workers.dev` URL.

### 3. Check it, then go live

Work through the checklist below. When dry run looks right, set `DRY_RUN = "false"` in `wrangler.toml`, commit it, and run `npx wrangler deploy` again.

Settings in `wrangler.toml` win on every deploy, so change `DRY_RUN` there, not in the Cloudflare dashboard.

---

## TEST CHECKLIST

- [ ] `npm test` passes from the repo root.
- [ ] The `workers.dev` page loads and shows **DRY RUN**, version 1.0.0 and Token **set**.
- [ ] **Check token** says the token can see "Down Detector" and it is enabled.
- [ ] `npx wrangler tail` shows a `dry-run` line within 5 minutes, and the Actions tab shows **no** new run from it.
- [ ] After going live, the page shows **LIVE**.
- [ ] Within 5 minutes the tail shows `dispatched`, and a new **workflow_dispatch** run appears in the Actions tab.
- [ ] Over the next hour, the Actions tab shows a run roughly every 5 minutes and the status page's "data is old" warning stays away.
- [ ] Failure path: temporarily set a wrong token with `npx wrangler secret put GITHUB_TOKEN`. The next tick logs an error with "expired" in it and shows as failed in Cloudflare. Put the real token back.

---

## HOW IT FAILS

- **Token expired or revoked:** each tick fails with a 401 and shows as an error in the Cloudflare logs. Runs stop, so the status page shows its "data is old" warning and the heartbeat monitor alerts.
- **Cloudflare down:** GitHub's own schedule still runs, just less often.
- **Workflow disabled in GitHub:** "Check token" reports the workflow's state.

## ROLLBACK

Set `DRY_RUN = "true"` and deploy, or run `npx wrangler delete`. Nothing in the main monitor depends on this Worker.
