# Brief: BinderCurve's fixed worker counts follow the slot (plan item 2.8)

Model: Sonnet builder. Priority 6: start only when the pool is quiet. One session, one pull request in bindercurve.com, ends when it merges. Starts after item 1.2 merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.8, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `playwright.config.ts` `resolveWorkers()`: its default of 2 ("headroom on 4-core hosts") becomes `playwrightWorkers()`. The axe and nightly-axe jobs read it.
- `vitest.config.ts`: `Math.min(4, os.cpus().length)` becomes `Math.min(4, usableCpus())`.
- `infra/ci-runner/pools.conf`: the comment on slot size names the kit helper. Correct the stale "two workers" comment in `deploy-check.yml`.

## Done
Merged, and the check passes.
