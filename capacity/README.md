# Capacity check (plan row 1.9)

A token-free LaunchAgent (`net.gorfed.capacity`, every 15 minutes) that writes `~/.desk/capacity.json`. Desk reads it first on every pass and fills free slots from the ranked plan.

| State | Rule | Free slots |
|-------|------|-----------|
| `headroom` | 1-minute load under 0.7 x cores, at least 4 GB free, fewer than 5 working sessions | 5 minus working, capped at 2 (the builder rule) |
| `hold` | load over cores, or under 4 GB free | 0 |
| `steady` | anything between | 0 |

Inputs: `os.loadavg()` against `sysctl -n hw.ncpu`; free plus inactive pages from `vm_stat`; working sessions = non-archived files under the Claude app's `claude-code-sessions` store with `lastActivityAt` in the last 10 minutes (the store has no explicit running flag, so this is a proxy).

Pool queue: set `CAPACITY_QUEUE_CMD` to a command that prints one number (one cached read of the pool, never per repo). Unset, `poolQueue` is `null` and the message says "unknown queued". Weekly usage has no local source, so `weeklyUsage` is always `null`.

ntfy topic `ops-report` (token from `~/.ship-bot/ntfy.token`) gets "headroom for N, M queued" or "overloaded, hold" only when the state changes. A change into `steady` pushes nothing.

Install: `capacity/install.sh` (runs the tests first). Remove: `capacity/install.sh --uninstall`. Tests: `capacity/check.sh`.

Failure handling: if a run throws, it writes `state: "unknown"` with an `error` and exits 1. If the session store is missing or empty, `working` is `null` and the state is at most `steady`. Desk treats a missing file, `unknown`, or `at` older than 30 minutes as unknown. A push is retried each run until it succeeds (`lastPushedState`). The installed plist sets no `CAPACITY_QUEUE_CMD`; add it to the plist's EnvironmentVariables by hand and note that re-running `install.sh` overwrites it. This job is a standing automation; the owner asked for the scheduled check on 13 November 2026.
