# Herdr failed jobs: recovery (9 November 2026)

Fleet coordination 6 went through the 38 jobs with `lastResult: failed` in `~/.herdr-jobs/state.json`.

## Why they failed
- `spawnSync gh ENOENT`: the push worked, the PR step could not find `gh` (fixed in ops PR 54). The "not pushed" lines in the job reports were written before the push and are stale. Most branches were already on the remote with no PR.
- `no commits ... nothing to push`: the job stopped with no change (below).
- `no worktree found for the job`: the worktree was pruned after the job. Most of these branches already have PRs.

## Draft PRs opened
- .github: [98](https://github.com/gorfednet/.github/pull/98), [99](https://github.com/gorfednet/.github/pull/99), [100](https://github.com/gorfednet/.github/pull/100), [101](https://github.com/gorfednet/.github/pull/101), [102](https://github.com/gorfednet/.github/pull/102)
- 4thcltr.com: [248](https://github.com/gorfednet/4thcltr.com/pull/248), [249](https://github.com/gorfednet/4thcltr.com/pull/249)
- papers.4thcltr.com: [30](https://github.com/gorfednet/papers.4thcltr.com/pull/30)
- promptboi.com: [57](https://github.com/gorfednet/promptboi.com/pull/57), [58](https://github.com/gorfednet/promptboi.com/pull/58), [59](https://github.com/gorfednet/promptboi.com/pull/59), [60](https://github.com/gorfednet/promptboi.com/pull/60)

Not batched: the four promptboi.com branches all edit `docs/backlog.json`, so a batch needs conflict resolution. Merge them one at a time.

## Skipped: uncommitted work in the worktree
- promptboi.com `dynamic-routes-404-on-direct-load` and `seventeen-skipped-unit-tests`, and `nav-active-state-flickers-on-load` (same branch as the first). Branches are pushed; no PR yet.
- gorfmusic.com `no-unit-tests-under-57-e2e`, 4thcltr.com `assessment-demand-under-stage-a`, `cascade-legal-entity-on-incorporation`: dirty worktrees, no commits.
- 4thcltr.com `bottom-bar` and papers `papers-site-indexing`: no out log or branch found.

## Done, not failed (the job ended with an honest no-change hand-back)
- papers `numbers-derived-from-spec`: already `landed` on main (PR 27).
- papers `spec-drift-schedule`, `papers-site-indexing`: no change needed.
- .github `fleet-analytics-one-service`, `sitemap-rule-text-deferred-by-drift`, `towit-open-security-bump` (the fix is TowIt PR 3, outside this repo): no change made.
- gorfed.net `finish-four-wip-case-studies`: no change.

## Stopped, cause not established (open, not done)
- .github `publish-the-server-never-saw` (still `confirmed-bug`).
- 4thcltr.com `assessment-demand-under-stage-a`; `cascade-legal-entity-on-incorporation` (no code fix possible).
- gorfmusic.com `url-contract-never-verified`: blocked on ops.

## Next
- [ ] Main session: read and merge the draft PRs above, one at a time, per the gates.
- [ ] Clear the dirty promptboi.com and gorfmusic.com worktrees, then open their PRs.
