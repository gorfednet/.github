# Brief: timing specs assert the product at any frame rate (plan item 3.1)

Model: Fable. A decision about what a test may fail on. Start after the weekly reset on Friday 20 November 2026 at 05:00 ET. One session, one pull request in 4thcltr.com (the wordmark's source), ends when it merges. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 3.1 to 3.4, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- Start from 4thcltr.com's frame-clock `e2e/wordmark-fours.spec.ts` (14 and 15 November). A cut lands on the first frame at or after its cut time, at any frame rate. The 90ms bound stays and applies when the frames were on time. No bound loosened.
- Reproduce a starved runner with Chromium's CPU throttle. Show two breaks: a 100ms pace fails throttled and unthrottled.
- Coordinate first with the session on 4thcltr.com's red `main` (check the session list).
- Then write the briefs for 3.2 (papers and heuristics copies), 3.3 (4thcltr.com frame floors, model: gorfed.net `e2e/motion.spec.ts`) and 3.4 (BinderCurve's 500ms spend-planner budget out of the merge gate) into `briefs/` of gorfednet/.github.

## Done
Merged, and the three briefs exist.
