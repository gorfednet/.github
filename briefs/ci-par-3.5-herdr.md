# Brief: are jobs under Herdr throttled? (plan item 3.5)

Model: Sonnet builder. A measurement with a clear pass or fail. One session; a pull request in ops only if a fix is needed. Return a PR with `## Next`, or a line in `docs/plans/ci-parallelism.md` if not.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 3.5, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `net.gorfed.herdr-reconcile.plist` is `ProcessType Background`. Run a 20ms timer for 10 s under `hc run` and directly, on an idle Mac, and compare the fire intervals. Ship-bot's 13 November case: 20ms fired every 60ms under the default class.
- Throttled: change the template `hosts/gorfpael/herdr/launchd/net.gorfed.herdr-reconcile.plist.in` and reinstall. Not throttled: record the numbers.

## Done
The numbers are recorded, and a fix merged if one was needed.
