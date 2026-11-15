# Heartbeats and the off-dapyllil push (plan row 1.13)

The janitor failed silently for 5 days, and ntfy runs on dapyllil, so a dapyllil outage hides every alert. Two additions:

1. **Dead-man pings.** Each job GETs a per-job URL after a good run. The service alerts through its own channels (email, phone push) when pings stop. Nothing here depends on dapyllil or this Mac.
2. **A second push path.** `pushOffbox` posts to the public `ntfy.sh` on a private topic name.

Both read their secret from `~/.heartbeats/`, never from the repository. An unenrolled job prints `unconfigured` and carries on.

| Job | Pings | Expected period | Grace |
|-----|-------|-----------------|-------|
| `ship-bot` | `ship-bot/ship-bot.mjs` after each live or observe pass (`/fail` when the pass throws) | 2 min | 10 min |
| `capacity` | `capacity/capacity.mjs` after each good run (`/fail` when the run throws); `install.sh` copies the helper into `~/.desk/capacity-app/lib/` | 15 min | 10 min |
| `herdr-reconcile` | `gorfednet/ops` `herdr-reconcile` after each finished pass (ops 75), run from ops `tools-main` since 13 November 2026 | 5 min | 10 min |
| `janitor` | step 9 of `janitor/PROMPT.md` | 1 day | 2 hours |

Files, one line each: `~/.heartbeats/<name>.url` (an `https://` ping URL, healthchecks.io style) and `~/.heartbeats/ntfy-topic` (12 or more characters, unguessable).

Weekly usage: `node scripts/heartbeat.mjs --usage` (logic in `scripts/lib/usageAlert.mjs`) reads `usage.pct` from `~/.herdr-jobs/state.json` and pushes once at 70% and once at 90%, remembering what reached someone in `~/.desk/usage-alerts.json`. Falling below 70% (a new week) clears the memory.

Capacity's 15-minute job runs the same check after each good run (`afterRun` in `capacity/capacity.mjs`). It pushes through ntfy `ops-report` and the off-box `ntfy.sh` topic, and either delivering counts.

## Proofs (14 November 2026, ET)

Run on the installed copies: ship-bot (`~/.ship-bot/app`) and capacity (`~/.desk/capacity-app`) matched origin/main 339cc0a, file for file.

- **Weekly usage push: proven.** `~/.herdr-jobs/hold` set, `usage.pct` planted at 90, capacity kicked at 11:10 ET. Its log read `"usage":{"action":"pushed","pct":90}` and `~/.desk/usage-alerts.json` became `{"fired":[70,90]}`. The off-box ntfy.sh topic returned "weekly usage at 90% (passed 90%)" stamped 11:10 ET. `state.json` and `usage-alerts.json` were restored from copies and the hold removed, all within about 2 minutes.
- **Dead-man alert: the check flips, delivery is not read.** The deliberate stop (`launchctl bootout` of `net.gorfed.capacity`) was denied by the sandbox classifier, so it did not run (backlog `heartbeat-deadman-deliberate-stop-unproven`). healthchecks.io's own log shows the real thing on 14 November: `capacity` went up to down at 11:05 ET, 25 minutes after its 10:40 ET ping (period 15 plus grace 10), and back to up at 11:10 ET on the next ping. The check has one integration, email to the owner. healthchecks.io has no per-flip notification log, so whether the email arrived was not read.
- **ntfy gap.** healthchecks.io has no ntfy integration here: a dead Mac produces an email and no phone push (backlog `healthchecks-alerts-email-only`).
- **Defect found and fixed in this change.** Those flips were false. Node's 250 ms connect timeout per address failed against hc-ping.com's IPv6 on this Mac: 10 of 15 fresh-process pings failed with ETIMEDOUT, and `capacity` had 5 false downs on 14 November (07:35, 08:05, 08:50, 10:20, 11:05 ET) and 6 in the month. `ship-bot/lib/heartbeat.mjs` now sets a 2 s timeout (15 of 15 passed with it, 10 of 10 through the helper). `test/heartbeatUsage.test.mjs` fails when the line is removed. Capacity and ship-bot need a reinstall to carry it (the installers copy the helper).
