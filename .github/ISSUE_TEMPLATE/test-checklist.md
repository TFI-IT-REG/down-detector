---
name: Down Detector test checklist
about: Walk through this before turning on LIVE, and after any big change
title: 'Test run: Down Detector v1.0.0'
labels: testing
---

File this issue, then tick the boxes as you go. The boxes are clickable in the issue.

## SETUP
- [ ] `npm test` passes locally (23 tests)
- [ ] Secret `TEAMS_WEBHOOK_URL` added
- [ ] Secret `NTFY_TOPIC` and/or `PUSHOVER_TOKEN` + `PUSHOVER_USER` added
- [ ] Secret `HEARTBEAT_URL` added and the healthchecks.io check created
- [ ] Variable `LIVE` is unset or `false`

## CHANNELS
- [ ] Run workflow with "Send a TEST message": the card shows up in the Teams group chat
- [ ] The same test arrives as a phone push
- [ ] Tapping the push opens the status page (or vendor page if no `PAGE_URL`)

## FIRST RUNS (dry run)
- [ ] Run workflow with "Print raw responses". Every status source in the log returns real data, not an HTML error page
- [ ] Run summary shows a table with every service
- [ ] No service shows "Can't check" unless that vendor's feed is genuinely broken
- [ ] The log shows `DRY RUN: would send` and nothing arrived in Teams or on your phone
- [ ] Second scheduled run says `No changes`

## ALERT PATH (forced failure)
- [ ] Temporarily add `{ "id": "fake", "name": "Fake outage", "type": "http", "url": "https://httpbin.org/status/503" }` and set `LIVE=true`
- [ ] Next run: one DOWN alert in Teams and on your phone, marked high priority
- [ ] The run after that: no repeat alert
- [ ] Change the URL to `https://httpbin.org/status/200`: one RECOVERED alert, quiet push
- [ ] Remove the fake service

## STATUS PAGE (if `PUBLISH_PAGE=true`)
- [ ] Page loads at the Pages URL and the banner shows when it was last checked
- [ ] "?" opens the how-it-works panel
- [ ] Hovering each button shows its label right away
- [ ] "Problems only" hides healthy services
- [ ] Looks right on a phone

## WATCHDOG
- [ ] healthchecks.io shows pings arriving about every 5 to 15 minutes
- [ ] Disable the workflow for 30 minutes: healthchecks.io alerts you. Re-enable it.

## GO LIVE
- [ ] One day of dry-run summaries reviewed with no false alarms
- [ ] `LIVE=true` set
- [ ] Group chat told what the alerts mean (link them to the status page "?" panel)
