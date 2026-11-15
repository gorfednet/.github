# Brief: one CPU budget for the fleet, in the verification kit (plan item 1.2)

Model: Fable. It changes what CI enforces for every repository. One session, one pull request in gorfednet/.github, ends when it merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 1.2, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `templates/verification-kit/lib/cpuBudget.mjs` (plain ESM, no dependencies) with a `.d.mts` sidecar: `usableCpus()` is the smallest of `os.cpus().length`, `os.availableParallelism()` and the cgroup v2 `cpu.max` or v1 `cfs_quota_us/cfs_period_us` quota. `playwrightWorkers()` is half of it, at least 1, and a `PLAYWRIGHT_WORKERS` value overrides it. Start from 4thcltr.com's `scripts/playwright-workers.mjs` and its 7 tests.
- `test/cpuBudget.test.mjs` under `node:test`, with the pool slot as probed: `os.cpus()` 12, `nproc` 8, `availableParallelism()` 2, `cpu.max` `200000 100000`. A remote slot may have 4 cpus: never assume 2.
- `bin/check-parallelism.mjs`: every `playwright.config.*` must set `workers` from `playwrightWorkers()` or a literal `1`, or carry a waiver comment that says why. Near misses that must fail: no `workers` line, the helper imported but unused, `PLAYWRIGHT_WORKERS` read with an `undefined` fallback. Add it to `canaries.json` and show the break in the PR.
- `assert-tests-executed`: when it reads a Playwright JSON report, print `N workers on M usable cpus (os.cpus X, availableParallelism Y)`, and fail when N > M.
- `verification-gate/action.yml`: a step that runs the check as a `::warning`. Rule V78 in `docs/verification-rules.md`. `write-manifest`, the kit version bump and the kit's test floor in `verification-kit.yml`.
- New repositories start protected: `templates/playwright.config.ts`, `docs/claude-home/skills/verification-bootstrap/SKILL.md` and `scripts/register-repo.mjs`.

## Done
The check warns on papers `main` before PR 43 and on heuristics `main`, and passes on 4thcltr.com. Named defects: 4thcltr.com on 4 October 2026, papers on 15 November 2026.
