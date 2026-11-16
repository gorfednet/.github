# Brief: a move to the pool proves itself first (plan item 2.4)

Model: Sonnet builder, and Fable reviews it. One session, one pull request in gorfednet/.github, ends when it merges. Starts after item 1.2 merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.4, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `scripts/pool-flip.mjs <repo> <label>`: refuse when the kit's `check-parallelism` fails on the repository's `main`; set `HEAVY_RUNS_ON`; rerun `main`'s CI and wait with `gh run watch --interval 60`; set it back to `"ubuntu-latest"` and exit non-zero when the run is red. Tests with a stubbed `gh`.
- The pool README's "Add a repository" step (bindercurve.com `infra/ci-runner/README.md`) points at it: a second small PR there.
- `docs/plans/ci-resourcing.md`: the column "Pool job seen running" becomes "Pool run passing", with the run id.

## Done
Merged. A session runs it; nothing runs it unattended.
