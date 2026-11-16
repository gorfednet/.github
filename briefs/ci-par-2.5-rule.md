# Brief: the shipping rule says where workers come from (plan item 2.5)

Model: Fable editor. Every session reads this file. One session, one pull request in gorfednet/.github, ends when it merges. Starts after items 1.2 and 2.4 merge. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.5, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `docs/claude-home/rules/shipping.md`, section "Runners": 2 lines. Playwright and test-runner worker counts come from the kit's `cpuBudget.mjs`, never the host's count. A repository moves to the pool only through `scripts/pool-flip.mjs`. Also correct "light gates on heuristics, papers and gorfed.net", which no longer describes where they run.
- After it merges, copy the file to `~/.claude/rules/shipping.md` and say so on the PR.

## Done
Merged and copied.
