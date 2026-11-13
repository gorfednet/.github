# Brief: Bring every active repo to one kit version and make drift fail.

Model: Sonnet. One session, one pull request, ends when it merges. At most 2 builders live; run builder-ok before each. Return a PR with `## Next`.

Read docs/assessment-2026-11-12-output-quality.md lane A1 and backlog entry assess-1112-a1-*.

## Steps
- Land .github PR 132 (kit 0.61.0): once assert-checks-started, review-status clean and check-closing-keywords pass, label ready-to-merge. Ship-bot merges; never gh pr merge.
- One refresh PR per repo via refresh-kit.mjs, order: 4thcltr.com, gorfed.net, heuristics, papers, career-portfolio, MoonMan (first install), BinderCurve, promptboi, denseware, ssatcy, gorfmusic, propose, assess, ops, intake. Batch where the repo's CI is short.
- Make check-kit-drift fail when more than one minor behind, now, not 15 December. Show it failing once on a deliberately old copy, restore, say so on the PR.
- Tag each kit release in write-manifest so the version is derivable.

## Done
STATUS.md shows every active repo on one kit version; drift check watched failing once.
