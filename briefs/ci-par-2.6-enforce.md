# Brief: the parallelism check fails instead of warning (plan item 2.6)

Model: Fable. It changes what CI enforces. One session, one pull request in gorfednet/.github, ends when it merges. Starts only when every repository in items 1.3, 2.1, 2.2 and 2.8 has merged. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.6, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `fleet-audit.yml` lists every repository with a pool row whose config fails `check-parallelism`, and every one whose `HEAVY_RUNS_ON` is hosted while it has a pool row. It must list 0 before the next step.
- The gate step becomes a failure. A pull request can always fix its own config, so verification rule 5 holds. Watch it fail once on a branch with the `workers` line removed.

## Done
Merged, with the audit's 0 in the PR.
