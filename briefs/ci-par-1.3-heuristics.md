# Brief: heuristics.4thcltr.com takes its Playwright workers from the kit (plan item 1.3)

Model: Sonnet builder. One session, one pull request in heuristics.4thcltr.com, ends when it merges. Starts after item 1.2 merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 1.3, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `node verification-kit/bin/refresh-kit.mjs` to the kit version from 1.2.
- `playwright.config.ts`: `workers` from `playwrightWorkers()` in `verification-kit/lib/cpuBudget.mjs` on CI, Playwright's default off CI.
- Run the kit's `check-parallelism` and show it passes. One dated line in `docs/incidents.md`.
- Typecheck, lint, the unit suite, and `e2e/wordmark.spec.ts` on its projects. Its CI is hosted for now (the variable was set back on 15 November); item 2.7 moves it to the pool.

## Done
Merged, and the check passes in CI.
