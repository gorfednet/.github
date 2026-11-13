# Brief: 5.9 housekeeping trains

Objective: kit refreshes, backlog reconciles, drain drafts and incident lines ride one train per repo per week, built by the janitor, never one PR each.
Model: Sonnet builder, Fable reviewer (janitor logic merges unattended).
Files: the janitor (`fleet-janitor` in this repo), `shipping.md` "Release trains" section mirror in `docs/claude-home/`. Classify housekeeping by label or title prefix (fail closed: unknown kinds stay out), build the train from `origin/main` with merge commits, list carried PRs in the body, comment on each carried PR, have `check-closing-keywords` scan carried PRs.
Evidence: about 40 of 70 open PRs on 13 Nov were housekeeping.
Done when: a dry run builds one train from 3 planted housekeeping PRs in a test repo or fixture, and leaves a planted feature PR out.

## Boundaries
- Your own worktree. Branch and draft PR in `gorfednet/.github`. Never merge, never force-push, never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
- CI waits: one `gh run watch <id> --interval 60 --exit-status` in the background. No `gh` loops.
- A blocked step never stalls you: park it with its resume time under `## Next` and do the next one.
- Builders run unit tests, typecheck and lint before handback. Fable reviews the diff.
- Return a PR with `## Next` (`- [ ]` lines, first line says merge when gates pass). Comment `claude review` on its own line on the final head.
