# Brief: every pool repository has a passing pool run on record (plan item 2.7)

Model: Haiku runner. It runs one script per repository and reports the output. One session, no code; the result goes in `docs/plans/ci-resourcing.md` in one small PR. Starts after items 1.3, 2.1, 2.2 and 2.4 merge. Flip each repository only after its own conversion PR has merged. Return a PR with `## Next`.

Read `docs/plans/ci-parallelism.md` (in gorfednet/.github) item 2.7, and backlog entry `ci-parallelism-host-cpus`. Nothing else from earlier sessions.

## Steps
- `node scripts/pool-flip.mjs gorfednet/heuristics.4thcltr.com hx-heavy` first. Then the other 10 repositories moved on 15 November, one at a time: ssatcy, denseware, gorfmusic, promptboi, anal0g, blackpixel, rowan, subrythm, papers, gorfed.net.
- Check `gh api rate_limit` before you start. Stop on the first refusal or red run and report it; do not fix code.

## Done
Each repository's row says "passing" with a run id, or names why not.
