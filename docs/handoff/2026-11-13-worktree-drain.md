# Worktree drain, 13 November 2026 (plan row 2.3)

Every dirty worktree and sibling clone under `~/Developer/gorfednet/` was read. Real work went to a `drain/<name>` branch (committed untouched, on its old base) with a draft PR carrying `## Next`. Nothing was deleted except the 61 ops job files, after a byte compare against the pushed branch. Skipped by instruction: `gates-main`, `desk-log`. No live session owned any dirty worktree (checked against `list_sessions` cwds), so none was messaged.

## Saved to a draft PR

| Worktree / clone | Branch | PR | What it holds |
|---|---|---|---|
| 4thcltr `vigilant-jones` (owner shots) | `docs/owner-shots-one-footer` | [4thcltr.com#261](https://github.com/gorfednet/4thcltr.com/pull/261) | the owner's `.owner-shots` and `.owner-shots-old` (110 PNGs) in `docs/design/owner-shots-2026-11-12/` |
| 4thcltr `v3-baselines` | `drain/v3-baselines` | [#262](https://github.com/gorfednet/4thcltr.com/pull/262) | 109 regenerated baselines, hero-status spec; base 6 weeks old |
| 4thcltr `vast-painting-diffie` | `drain/vast-painting-diffie` | [#263](https://github.com/gorfednet/4thcltr.com/pull/263) | full-page baselines, variant 1 of 4 |
| 4thcltr `quirky-puzzling-shannon` | `drain/quirky-puzzling-shannon` | [#264](https://github.com/gorfednet/4thcltr.com/pull/264) | variant 2 of 4 |
| 4thcltr `iridescent-squishing-glacier` | `drain/iridescent-squishing-glacier` | [#265](https://github.com/gorfednet/4thcltr.com/pull/265) | variant 3 of 4 |
| 4thcltr `composed-tickling-sundae` | `drain/composed-tickling-sundae` | [#266](https://github.com/gorfednet/4thcltr.com/pull/266) | variant 4 of 4 |
| 4thcltr `agent-aab33cc1cb87375c5` | `drain/agent-aab33cc1cb87375c5` | [#267](https://github.com/gorfednet/4thcltr.com/pull/267) | WCAG wording in 12 report locales |
| 4thcltr `dynamic-forging-comet` | `drain/dynamic-forging-comet` | [#268](https://github.com/gorfednet/4thcltr.com/pull/268) | header fit |
| 4thcltr `squishy-mixing-blanket` | `drain/squishy-mixing-blanket` | [#269](https://github.com/gorfednet/4thcltr.com/pull/269) | header fit, RegenerateButton |
| 4thcltr `serialized-toasting-lantern` | `drain/serialized-toasting-lantern` | [#270](https://github.com/gorfednet/4thcltr.com/pull/270) | one backlog edit |
| 4thcltr main clone (`home-doors`) | `drain/4thcltr.com` | [#271](https://github.com/gorfednet/4thcltr.com/pull/271) | concept images, AI-use post draft |
| MoonMan `agent-a39d5b316b73de9e3` (brand-icon) | `drain/agent-a39d5b316b73de9e3` | [MoonMan#331](https://github.com/gorfednet/MoonMan/pull/331) | brand icon generator and 7-week-old generated assets |
| MoonMan `agent-ad384985aa14e0e5a` | `drain/agent-ad384985aa14e0e5a` | [#332](https://github.com/gorfednet/MoonMan/pull/332) | store-assets feature graphic |
| MoonMan `synchronous-painting-nest` | `drain/synchronous-painting-nest` | [#333](https://github.com/gorfednet/MoonMan/pull/333) | runner pool plan, backlog (newer edits) |
| MoonMan `quizzical-pasteur-0573e3` | `drain/quizzical-pasteur-0573e3` | [#334](https://github.com/gorfednet/MoonMan/pull/334) | `RUNNER-POOL-PLAN.md` (older copy) |
| ops main clone | `drain/ops-herdr-jobs` | [ops#71](https://github.com/gorfednet/ops/pull/71) | 61 generated Herdr jobs; originals removed after byte compare. Plan 1.8 may prune it |
| papers `one-footer` | `drain/one-footer` | [papers#37](https://github.com/gorfednet/papers.4thcltr.com/pull/37) | Lockup, footer-css, vendor refresh |
| papers `wise-pondering-goblet` | `drain/wise-pondering-goblet` | [papers#38](https://github.com/gorfednet/papers.4thcltr.com/pull/38) | weekly-report spec-drift |
| gorfmusic `merry-bubbling-island` | `drain/merry-bubbling-island` | [gorfmusic#54](https://github.com/gorfednet/gorfmusic.com/pull/54) | healthcheck test, backlog |
| ssatcy `stateless-roaming-lighthouse` | `drain/stateless-roaming-lighthouse` | [ssatcy#46](https://github.com/gorfednet/ssatcy.com/pull/46) | navCurrent spec, content.ts |
| ask-collector-node clone | `drain/ask-collector-node` | [ask-collector#14](https://github.com/gorfednet/ask-collector/pull/14) | Dockerfile edit |
| assess-render2 clone | `drain/assess-render2` | [assess#77](https://github.com/gorfednet/assess/pull/77) | report-template vendor refresh |
| assess-eval-1031 clone | `drain/assess-eval-1031` | [assess#78](https://github.com/gorfednet/assess/pull/78) | eval runs 2026-10-31 |
| gorfed.net-onetree clone | `drain/gorfed.net-onetree` | [gorfed.net#146](https://github.com/gorfednet/gorfed.net/pull/146) | pretext bundle rebuild |
| gorfednet.github-kit0482 clone | `drain/gorfednet.github-kit0482` | [.github#149](https://github.com/gorfednet/.github/pull/149) | fleet-report edit |
| career-portfolio main clone | `drain/career-portfolio` | [career-portfolio#70](https://github.com/gorfednet/career-portfolio/pull/70) | 11 MB resume and LinkedIn docs |
| ACID2Reaper main clone | `drain/ACID2Reaper` | [ACID2REAPER#8](https://github.com/gorfednet/ACID2REAPER/pull/8) | Acid3 sample fixtures |
| bindercurve `shimmering-snacking-kitten` | `drain/shimmering-snacking-kitten` | see Open | catalog lookup edits (7 files) |

## Not saved: one-line reasons

| Worktree / clone | Reason |
|---|---|
| MoonMan `sim22`, `rel112` | `Package.swift` and `capacitor.settings.gradle` paths rewritten by `cap sync` for the worktree's depth; regenerated on every sync |
| MoonMan `rel112` `android/keystore` | symlink to the main clone's keystore; never committed |
| MoonMan, anal0g.org, blackpixelrecords, denseware, ssatcy, subrythm main clones; bindercurve `.claude/launch.json` | only untracked `.claude/` local config |
| assess main, `assess-live-resolver` | `*.tmp.ts` and `*.tmp.mjs` scratch scripts (pihole recheck, render-one); left in place, not committed |
| `promptboi-pr56` (9 files) | last commit 10 minutes before the drain: a live session's active work; left alone |
| wychwoodresort.com `dependabot.yml` | repository inactive, push returns 403; committed locally on `drain/wychwoodresort.com` only |
| 29 worktrees (assess, denseware, gorfed.net, gorfmusic, heuristics, promptboi, ssatcy) | dirty only by the `node_modules` symlink; nothing to save |

## Open

- [BinderCurve `drain/shimmering-snacking-kitten`: pre-push gate was still running when this was written; PR number added when the push lands.]
- Pruning (plan 1.9) can start once the PRs above are merged or closed: every worktree listed holds nothing that is not on a pushed branch, except the `promptboi-pr56` clone and the scratch scripts.

## Next

- [ ] merge this file once gates pass (ship-bot)
- [ ] Desk: decide the 4 full-page-baseline variants (4thcltr #263 to #266, keep one), then close the rest
- [ ] plan 1.9: prune drained worktrees after their PRs resolve
