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
