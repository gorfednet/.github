# Brief: finish the unfinished heuristics and assess PRs (plan row 2.10)

Model: Opus 5.5 for the migration and the study diffs. The `editor` (Fable) reads every visitor-facing word in 76 and 77, and a `reviewer` (Fable) reads 75's migration. Why: 75 moves about 19,500 lines of published content, and 76 and 77 are public analyses under the owner's name.
Folders: `~/Developer/gorfednet/heuristics.4thcltr.com` and `~/Developer/gorfednet/assess`, each in its own worktree. Owner decision, 13 Nov 2026: finish these, don't close them.

## The four PRs (all drafts, idle since 8 Nov)
- heuristics 75, `feat/data-p1`: migrates `content/reports` and `content/figures` to `content/analyses` (+19,567/-11,129). Do this first, because 76 and 77 probably write into the new layout.
- heuristics 76, `feat/deep-costco`: Costco deep study, 28 pages, job A-261030-AKX4.
- heuristics 77, `feat/deep-verizon`: Verizon deep study, 41 pages, 16 findings, job A-261030-SY3G.
- assess 72, `feat/explicit-pages-40`: a test that the explicit-page limit is 40. Its diff is empty (+0/-0), so either write the test or close it with a backlog note saying why.

## Done when
- 75: rebased or merged with main, every old URL redirects or still resolves, the sitemap passes `check-sitemap-pages`, CI is green, the reviewer is clean, and the PR is labelled.
- 76 and 77: rebuilt on 75's layout. Every capture and live check proves the engine's egress resolver (the `edge.adobedc.net` canary doesn't resolve to 0.0.0.0, `::` or a private address). A capture without that proof is recaptured. The findings follow the hand route in `assess/docs/deep-study-brief.md`, unless the engine side-by-side has passed. Each changed page carries its AI Use Levels tag (spec 1.2). The copy follows `gorfednet/.github` `docs/content-guidelines.md`, with Michael as "I", and the editor has passed it. CI is green and the PRs are labelled.
- 72: the test exists and fails when the limit is 39 or 41, or the PR is closed with the reason in assess's backlog.
- Spend: no API run for these unless the month's public-job total plus `assess estimate` stays under US$100. Otherwise stop and tell Desk.

## Boundaries
Ship-bot merges (never `gh pr merge`). One PR at a time in CI. Root causes for any red. Report on each PR's `## Next`. The GitHub REST quota is tight today, so use `gh run watch` and no polling.
