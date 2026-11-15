# Brief: gate-run enforces the loaded-Mac worker rule (plan item 2.9)

Model: Sonnet builder. One session, one pull request in ops, ends when it merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.9, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `hosts/gorfpael/herdr/bin/gate-run`: when `builder-ok` says the Mac is loaded, export `PLAYWRIGHT_WORKERS=2` for the gate and print that it did, instead of only warning. Leave a value the caller set alone.
- A test or a dry run that shows both branches. Then reinstall the script per `hosts/gorfpael/herdr/README.md`.

## Done
Merged and installed.
