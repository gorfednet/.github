# Brief: 5.10 gh polling guard hook

Objective: a `PreToolUse` hook on Bash refuses a command that loops `gh` or `review-status.mjs` with `sleep` (`for`/`while`/`until`), or a busy-wait `until …; do :; done`. Its message points to `gh run watch <id> --interval 60 --exit-status` with `run_in_background`.
Model: Fable builder (it runs unprompted in every session).
Files: a hook script plus its `~/.claude/settings.json` entry, both shipped through `docs/claude-home/` in this repo. Do not edit live `~/.claude`. The owner approves that install in his own session once the PR merges; say so under `## Next`.
Evidence: 13 Nov, 3 session loops polled `gh` while the limit sat at 0, and one busy-wait spun a core for 3.5 h. Get the 3 real commands from the 13 Nov desk log or the session transcripts.
Done when: tests show the hook blocks each of the 3 real commands, passes `gh run watch --interval 60`, `gh pr view`, and a plain `sleep 5`; the guard watched failing once.

## Boundaries
- Your own worktree. Branch and draft PR in `gorfednet/.github`. Never merge, never force-push, never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
- CI waits: one `gh run watch <id> --interval 60 --exit-status` in the background. No `gh` loops.
- A blocked step never stalls you: park it with its resume time under `## Next` and do the next one.
- Builders run unit tests, typecheck and lint before handback. Fable reviews the diff.
- Return a PR with `## Next` (`- [ ]` lines, first line says merge when gates pass). Comment `claude review` on its own line on the final head.
