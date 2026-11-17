# Down Detector

v1.1.0. Watches the services we depend on and posts to Teams and phone push at the first sign of trouble.

It runs on GitHub Actions every 5 minutes and uses two kinds of checks:

- **Vendor status feeds** for GitHub, Cloudflare, Google Workspace, Azure and Microsoft 365 tenant health. These are accurate, but vendors often post 15 to 45 minutes late.
- **Direct probes** that load a real login page or API, for NetSuite, GitHub, Microsoft sign-in, Outlook and Google sign-in. These usually catch a problem first.

Alerts only go out when something changes: a new problem, a worse problem, a new incident on a service that's already down, or a recovery. Several changes in one run are batched into one message.

The status page shows a 24-hour history bar and uptime % per service, response time charts for direct probes, and a tile view for wall screens.

It ships in **dry-run mode**. It checks everything and shows what it would send, but sends nothing until you set `LIVE=true`.

---

## QUICK REFERENCE

| Task | Where |
|---|---|
| Add a service | Edit `config/services.json`, commit |
| Turn alerts on/off | Settings > Secrets and variables > Actions > Variables > `LIVE` = `true` / `false` |
| Send a test alert | Actions > Down Detector > Run workflow > tick "Send a TEST message" |
| Check a new feed's format | Actions > Down Detector > Run workflow > tick "Print raw responses" |
| See the last run | Actions > Down Detector > latest run > Summary |
| Status page | https://svisnesky.github.io/down-detector/ |
| Wall screen view | https://svisnesky.github.io/down-detector/?view=tv |
| Run tests locally | `npm test` |

Levels: **Down** (high-priority push), **Degraded**, **Can't check** (status source unreadable 3 runs in a row), **Maintenance** (silent by default), **Recovered** (quiet push).

---

## SETUP

### 1. Repo

1. Create the repo and push this folder to it.
2. Pick public or private. See [COST](#cost) below. It decides how many free Actions minutes you get.

### 2. Teams group chat alert

1. In Teams, open the group chat.
2. Click **...** at the top of the chat > **Workflows**.
3. Pick **Send webhook alerts to a chat**. If you don't see it, search templates for "Post to a chat when a webhook request is received".
4. Name it "Down Detector", confirm the chat, and click **Add workflow**.
5. Copy the URL it gives you.
6. In GitHub: **Settings > Secrets and variables > Actions > Secrets > New repository secret**. Name: `TEAMS_WEBHOOK_URL`. Value: the URL.

The workflow posts as whoever created it in Teams, so set it up from the account you want the alerts to come from.

### 3. Phone push (pick one or both)

**ntfy** (free):
1. Install the ntfy app (iOS or Android).
2. Subscribe to a long random topic name, like `dd-7f3k9q2xv8m1`. Anyone who knows the name can read it, so don't use something guessable.
3. Add secret `NTFY_TOPIC` with that name.
4. To make Down alerts break through Do Not Disturb, allow critical/priority notifications for ntfy in your phone settings.

**Pushover** (30-day trial, then a one-time $5 per platform):
1. Create an account at pushover.net and install the app.
2. Copy your **User Key** from the dashboard and add it as secret `PUSHOVER_USER`.
3. Click **Create an Application/API Token**, name it "Down Detector", and add the token as secret `PUSHOVER_TOKEN`.

Down alerts go out at Pushover priority 1, which bypasses quiet hours. Recoveries go out at -1 (no sound).

### 4. Dead-man switch (recommended)

GitHub can delay or quietly stop scheduled runs. It disables schedules after 60 days with no commits in a public repo.
1. Create a free check at healthchecks.io. Period 5 minutes, grace 20 minutes.
2. Point its alert at your email or the same ntfy topic.
3. Add the ping URL as secret `HEARTBEAT_URL`.

If the monitor stops running, or alerts start failing to send, you hear about it from healthchecks.io.

### 5. Status page (optional)

1. **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Add variable `PUBLISH_PAGE` = `true`.
3. After the first run, add variable `PAGE_URL` with the Pages URL so alerts link to it.

Pages on a private repo needs a paid GitHub plan, and unless you're on Enterprise the page is public. It only shows vendor names and statuses.

### 6. Microsoft 365 tenant health (optional, needs a tenant admin)

This is the real view of *our* tenant. Without it, Microsoft is covered by the Azure feed and the sign-in/Outlook probes only.
1. **Entra admin center > Applications > App registrations > New registration**. Name it "Down Detector", single tenant.
2. **API permissions > Add a permission > Microsoft Graph > Application permissions > ServiceHealth.Read.All > Add**.
3. Click **Grant admin consent**.
4. **Certificates & secrets > New client secret**. Set it to expire in 12 or 24 months and put a reminder on the calendar.
5. Add secrets `M365_TENANT_ID` (Directory ID on the Overview page), `M365_CLIENT_ID` (Application ID), and `M365_CLIENT_SECRET` (the secret value).

### 7. Go live

1. Run **Actions > Down Detector > Run workflow** with "Send a TEST message" ticked. Confirm it arrives in Teams and on your phone.
2. Let it run in dry run for a day and look at the run summaries for false alarms.
3. Add variable `LIVE` = `true`.

---

## ADDING A SERVICE

Add an entry to `services` in `config/services.json`. Each `id` must be unique.

**Vendor uses Atlassian Statuspage** (most SaaS do; the page footer says "Powered by Atlassian Statuspage"):
```json
{ "id": "zoom", "name": "Zoom", "group": "Comms", "type": "statuspage", "url": "https://status.zoom.us" }
```
To watch only some components, add `"components": ["Zoom Meetings", "Zoom Phone"]`, using names exactly as they appear on the page.

**Any URL that should load** (login page, API, our storefront):
```json
{ "id": "store", "name": "Storefront", "group": "Ecommerce", "type": "http", "url": "https://shop.example.com/", "expectText": "Add to cart", "slowMs": 5000 }
```
Options: `expectStatus` (e.g. `[200]`), `expectText`, `slowMs`, `timeoutMs`, `failThreshold`.

**RSS feed of active incidents**:
```json
{ "id": "x", "name": "X", "type": "rss", "url": "https://.../feed", "maxAgeHours": 24 }
```

**Google Cloud** (same format as Workspace):
```json
{ "id": "gcp", "name": "Google Cloud", "type": "google", "url": "https://status.cloud.google.com/incidents.json", "pageUrl": "https://status.cloud.google.com/" }
```
Google Workspace can be narrowed with `"products": ["Gmail", "Google Drive"]`.

To pause a service without deleting it, set `"enabled": false`.

After adding one, run the workflow with "Print raw responses" ticked and check the log.

---

## TUNING

Defaults are at the top of `config/services.json`. Any of them can be overridden per service.

| Setting | Default | Meaning |
|---|---|---|
| `failThreshold` | 1 | Probe runs that must fail before alerting. Each run already retries once, 15s apart. |
| `unknownThreshold` | 3 | Runs where a status feed can't be read before a "Can't check" alert. |
| `retryDelayMs` | 15000 | Gap between a probe's first try and its retry. |
| `slowMs` | 8000 | A probe slower than this counts as Degraded. |
| `timeoutMs` | 10000 | Per-request timeout. |
| `notifyMaintenance` | false | Alert when a vendor starts or ends maintenance. |

---

## COST

GitHub bills each job in whole minutes, rounded up. At every 5 minutes, that's about 8,640 minutes a month, or roughly double with the status page deploy job.

- **Public repo:** standard runners are free and unlimited. Keep internal URLs and anything sensitive out of `services.json`. Secrets stay hidden either way.
- **Private repo:** the free plan includes 2,000 minutes a month and Team includes 3,000, so a 5-minute schedule goes over. Either change the cron to `*/15` or use a self-hosted runner.
- **Cloudflare Worker** (planned): cron runs every minute on the free plan with no minute billing. The check code is plain `fetch`, so it ports over directly.

---

## HOW IT WORKS

```
cron (5 min) -> restore state from Actions cache
             -> run every check in parallel
             -> compare to last alerted state per service
             -> batch changes -> Teams + ntfy + Pushover (or log them in dry run)
             -> save state, write site/status.json, ping heartbeat
```

- State lives in the Actions cache (`state/state.json`). If the cache gets evicted, the next run sets a new baseline. Healthy services stay silent, and anything already down alerts once.
- If every channel fails to send, the alert isn't marked as sent and is retried on the next run. The job also fails, so GitHub emails the repo owner.
- Files: `src/monitor.mjs` (main), `src/checks.mjs` (check types), `src/engine.mjs` (alert rules), `src/notify.mjs` (channels), `src/site/index.html` (status page).
- No dependencies. Node 20 or newer.

## KNOWN GAPS

- **NetSuite:** we only probe the login page. The official status page (status.netsuite.com) format hasn't been verified yet. A probe of our own account's domain or a health RESTlet would catch account-specific issues.
- **WMS:** not added yet. Need the vendor name and their status page.
- **Cloudflare:** disabled for now. Their page always shows some of 300+ data centers in partial outage, so unfiltered it reads Degraded around the clock. When we adopt it, enable it with a `components` filter for the products we use (Workers, Pages, D1, Access).
- Probes run from GitHub's servers, not our network, so they won't catch our own ISP or VPN problems.
