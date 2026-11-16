# Brief: the browser-compat repositories take workers from the kit (plan item 2.2)

Model: Sonnet builder. One session per repository, one pull request each, each ends when it merges: gorfmusic.com, denseware.com, ssatcy.com, promptboi.com, gorfed.net. Starts after item 1.2 merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.2 and 2.10, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- Refresh the kit. `playwright.config.ts`: `workers` from `playwrightWorkers()` (it keeps honouring the shared workflow's `PLAYWRIGHT_WORKERS: 1`).
- gorfmusic.com only: its `canaries` job runs Playwright outside browser-compat with no worker setting. Confirm its log shows the kit's count for the slot (1 on a 2-cpu slot) after the change.
- Item 2.10: read the job's `N workers on M usable cpus` line. If `availableParallelism()` is above the usable cpus, set Vitest's `maxWorkers` from `usableCpus()` in the same PR.
- A kit refresh can show drift that needs diagnosis. Fix it in the same PR or record why not.

## Done
Each PR merged and the check passes.
