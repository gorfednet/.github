# Brief: 5.8 review round cap

Objective: a PR's 4th Claude review round is its last for Low findings. After it, Lows are triaged by reply and only Medium or higher forces a fix.
Model: Sonnet builder (the logic is checked by a planted test), Fable reviewer.
Files: `review-status.mjs` (count review rounds on the PR, print round and cap, report Lows past round 4 as triage-only), `REVIEW.md` template and the fleet copies it syncs to, `~/.claude/rules/shipping.md` mirror under `docs/claude-home/` (one sentence on the cap).
Evidence: .github 148 took 10 rounds, 138 took 4.
Done when: `review-status.mjs` prints the round and the cap on a planted 5-round PR fixture, a Low-only round 5 reads `clean` with "triage by reply", a Medium in round 5 still reads `findings`; the test watched failing once.

## Boundaries
- Your own worktree. Branch and draft PR in `gorfednet/.github`. Never merge, never force-push, never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
- CI waits: one `gh run watch <id> --interval 60 --exit-status` in the background. No `gh` loops.
- A blocked step never stalls you: park it with its resume time under `## Next` and do the next one.
- Builders run unit tests, typecheck and lint before handback. Fable reviews the diff.
- Return a PR with `## Next` (`- [ ]` lines, first line says merge when gates pass). Comment `claude review` on its own line on the final head.
