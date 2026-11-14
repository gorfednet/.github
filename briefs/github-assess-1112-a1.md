# Brief: Bring every active repo to one kit version.

Model: Sonnet. One session, one pull request, ends when it merges. At most 2 builders live; run builder-ok before each. Return a PR with `## Next`.

Read docs/assessment-2026-11-12-output-quality.md lane A1 and backlog entry assess-1112-a1-*.

## Steps
- Target the kit version in `templates/verification-kit/MANIFEST.json` on main (0.62.0 on 14 November 2026; .github PR 132, kit 0.61.0, merged on 12 November).
- One refresh PR per repo via refresh-kit.mjs, order: 4thcltr.com, gorfed.net, heuristics, papers, career-portfolio, MoonMan (first install), BinderCurve, promptboi, denseware, ssatcy, gorfmusic, propose, assess, ops, intake. Batch where the repo's CI is short.
- Do not make kit drift fail a pull request: that check was retired on purpose (docs/verification-rules.md, "Kit is current and unmodified"), because the kit lives in another repository. Drift stays in the scheduled reports (fleet-audit.yml, STATUS.md).
- Tag each kit release in write-manifest so the version is derivable.

## Done
STATUS.md shows every active repo on one kit version.
