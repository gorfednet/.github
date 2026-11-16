# Brief: assess sizes its browser file concurrency from the slot (plan item 2.3)

Model: Sonnet builder. One session, one pull request in assess, ends when it merges. Starts after item 1.2 merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.3, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `tools/run-tests.ts`: `BROWSER_FILE_CONCURRENCY` becomes `Math.min(3, usableCpus())` unless `ASSESS_TEST_CONCURRENCY` is set. Import from the vendored kit.
- A unit test for the 2-cpu slot. Run the suite and the capture job's tests.

## Done
Merged, and the pool log shows the concurrency it used.
