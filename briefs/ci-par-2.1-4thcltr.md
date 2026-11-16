# Brief: 4thcltr.com uses the kit's CPU budget in place of its own copy (plan item 2.1)

Model: Sonnet builder. One session, one pull request in 4thcltr.com, ends when it merges. Starts after item 1.2 merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.1, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- Refresh the kit. Delete `scripts/playwright-workers.mjs`, its `.d.mts` and `tests/playwright-workers.test.ts`; import `playwrightWorkers()` from `verification-kit/lib/cpuBudget.mjs` in `playwright.config.ts`. Keep the non-CI fallback the config has. Lower the unit floor by exactly the deleted tests, and say so.
- Add the missing dated line to `docs/incidents.md` for 4 October 2026 (commit `91259c9` has the facts).
- Typecheck, lint, the unit suite, the wordmark spec on its project. The pool log's worker count must equal `playwrightWorkers()` for that slot's usable cpus (1 on a 2-cpu slot).

## Done
Merged, the local helper gone, the check passes.
