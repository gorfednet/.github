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

## Headless starter (plan row 1.10)

`starter.mjs` runs at the end of each capacity tick. When `capacity.json` is fresh and `headroom`, it starts the top-priority entry of `~/.desk/queue.json` (written only by Desk) in Herdr with `hc run --bg --name q-<id> --cwd <repo> <role> "<task>"`. The task text is a fixed template; the entry supplies only the brief path.

- Entry: `id`, `repo` (absolute path whose folder name is in ship-bot's `config.example.json`), `brief`, `role` (`builder` with model `sonnet`, or `runner` with `haiku`), `priority` (lower first). Opus, Fable and anything else are refused and logged.
- Limits: 1 start per tick, 3 live `q-` terminals (from `hc ls`), 12 starts in 24 h (the starter does not read weekly usage; Herdr's `lib/budget.mjs` does), stop at 90% weekly if a source ever exists.
- Mode: `~/.desk/starter.mode` containing `live` starts sessions. Absent or anything else is a dry run that only logs `DRY RUN: would start ...` to `~/.desk/starter.log`. Live starts push ntfy "started <id> (<model>) in <repo>".
- Done: `node starter.mjs --done <id>` (for the Herdr Stop hook, row 1.8) writes `~/.desk/queue-done.json`; an entry whose terminal has gone is marked done on the next tick. `DESK_DIR` overrides `~/.desk` for tests.
- Fail-closed: a corrupt state file, or an `hc ls` reply without a terminals list, stops the tick. A start is recorded before `hc run`; a failed start is parked (`failed` in `starter-state.json`), not retried; a live `q-<id>` terminal counts as started. Repos must resolve (realpath) to `sourceRoot/<dir>` of a non-`off` repo in the example config. Briefs are repo-relative or `origin/<branch>:<path>`.
- Dry run writes nothing but the log.

### Before flipping to `live` (open, from the Fable review)
The starter calls `hc run` directly, so it lacks what Herdr's reconciler has: a weekly-usage read, the 300,000-token and 60-minute kill, ending an idle session after its turn (3 idle sessions hold the 3 slots until `hc kill`), pushing the branch and opening the draft PR (the builder template says never push), and the first-message and approval-prompt handling. Decide whether 1.10 writes Herdr job files or calls its `startClaude` and `monitor` instead, before `starter.mode` says `live`. Nothing starts until then.
