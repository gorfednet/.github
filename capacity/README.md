# Capacity check (plan row 1.9)

A token-free LaunchAgent (`net.gorfed.capacity`, every 15 minutes) that writes `~/.desk/capacity.json`. Desk reads it first on every pass and fills free slots from the ranked plan.

| State | Rule | Free slots |
|-------|------|-----------|
| `headroom` | 1-minute load under 0.7 x cores, at least 4 GB free, fewer than 5 working sessions | 5 minus working, capped at 2 (the builder rule) |
| `hold` | load over cores, or under 4 GB free | 0 |
| during a backup | CPU idle under 40% or under 4 GB free is `hold`; load is ignored. Otherwise `headroom` if fewer than 5 sessions are working | as `headroom` |
| `hold` on usage | weekly usage at 90% or over (`reason` says so) | 0 |
| `steady` | anything between | 0 |

Inputs: `os.loadavg()` against `sysctl -n hw.ncpu`; free plus inactive pages from `vm_stat`; working sessions = non-archived files under the Claude app's `claude-code-sessions` store with `lastActivityAt` in the last 10 minutes (the store has no explicit running flag, so this is a proxy).

Backups: Time Machine (`tmutil status` shows `Running = 1`) and Backblaze (a `bztransmit` process) make the load average count their disk waits, so while either runs the CPU idle figure (second `top` sample) replaces the load test. This is the rule of ops `builder-ok`. If the backup or the idle figure can't be read, the load rule applies. `capacity.json` carries `backup` and `idlePct`. After a change here, rerun `capacity/install.sh`.

Pool queue: set `CAPACITY_QUEUE_CMD` to a command that prints one number (one cached read of the pool, never per repo). Unset, `poolQueue` is `null` and the message says "unknown queued". Weekly usage is `usage.pct` in `~/.herdr-jobs/state.json`, the file `scripts/lib/usageAlert.mjs` reads. At 90 or over the state is `hold`. A missing or unreadable file, or a value that isn't a number from 0 to 1000, leaves the usual rules and records `weeklyUsage: null` with `weeklyUsageReason`. A hold on usage pushes "hold: weekly usage at N%, ..." once, like any other hold.

ntfy topic `ops-report` (token from `~/.ship-bot/ntfy.token`) gets "headroom for N, M queued" or "overloaded, hold" only when the state changes. A change into `steady` pushes nothing.

Install: `capacity/install.sh` (runs the tests first), from the gates-main worktree only. The script refuses any other checkout, because a copy installed from a working checkout drifts behind main (13 November 2026: 3 commits behind). fleet-status's "Installed tools behind main" row reports a stale copy. Remove: `capacity/install.sh --uninstall`. Tests: `capacity/check.sh`.

Failure handling: if a run throws, it writes `state: "unknown"` with an `error` and exits 1. If the session store is missing or empty, `working` is `null` and the state is at most `steady`. Desk treats a missing file, `unknown`, or `at` older than 30 minutes as unknown. A push is retried each run until it succeeds (`lastPushedState`). The installed plist sets no `CAPACITY_QUEUE_CMD`; add it to the plist's EnvironmentVariables by hand and note that re-running `install.sh` overwrites it. This job is a standing automation; the owner asked for the scheduled check on 13 November 2026.
