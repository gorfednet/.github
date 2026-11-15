# Maintenance programme, November 2026

Approved 6 November 2026 by the owner. Source plan: `~/.claude/plans/maintenance-end-to-end-plan-to-compiled-tide.md`. This file is the plan of record from here on.

## Context

Four goals:
1. Every path, display and number on heuristics.4thcltr.com and papers.4thcltr.com proven correct, and kept that way.
2. Paid heuristics intake (`assess`) output at the level of the locally made deep studies.
3. CI that stops doing the same work several times.
4. Big asks broken into items that agents sequence, with the owner asked only at decisions.

The intake gap has no API limit behind it. `assess analyse` is one-shot calls on saved captures, with no live re-check, no voice pass and no independent reviewer. On TD, 31 findings were published and 11 held live.

## Owner decisions

- 6 November 2026: A6 parity eval API spend is approved, up to US$75 in all.
- 6 November 2026: E1 (weekly fleet health) and B5 (monthly findings re-check) are approved as scheduled agents on the Max plan.
- 6 November 2026: BinderCurve CI right-sizing (D) is in this programme, ahead of the pre-soak release of about 24 November.

## Milestones

| Milestone | Items | ETA (ET) |
|---|---|---|
| Sites guarded, verify merged | A1, B1 to B4, B6 to B8, C1 | Wednesday 11 November 2026, 5 PM ET |
| Intake at parity | A2 to A6, B5, C2 | Friday 13 November 2026, 5 PM ET |
| CI one run per PR, fleet task live | D1 to D6, E1 to E3, F2, G1, G2 | Wednesday 18 November 2026, 5 PM ET |

## Items

An item not yet started has no status. The session that starts an item adds its backlog entry in that repository as its first commit, and writes `backlog: <repo>#<id>` and its session link into the item's row here. From then on the backlog entry or pull request is the status. Each session's brief (30 lines or fewer) is written when it starts and kept in that repository's `docs/briefs/`. Every item's done-when is its pull request merged with its verification line below met; B4, B5 and E1 are done when their first report is posted and read. A6 is done only when its thresholds in its row are met; a first report short of them keeps A6 open and the intake milestone open.

| id | repo | item | tier | depends-on | owner-decision | backlog | session |
|---|---|---|---|---|---|---|---|
| A1 | assess | Land `feat/live-verify-pass` as 2 or 3 PRs (verify stage, gate, eval scorer) | Opus builder, Fable reviewer, main merges | none | no |  |  |
| A2 | assess | One rubric: findings carry no legal readings and no pitch; the pitch is in the cover letter only | Opus builder, Fable editor on prompt text | A1 | no |  |  |
| A3 | assess | Editor pass (Opus, high, `content-guidelines.md`) and blind reviewer pass (`claude-fable-5-2`) in the paid pipeline | Opus builder, main reviews | A2 | no |  |  |
| A4 | assess | Verify as a tool-use loop with Playwright tools (navigate, click, DOM, axe): no form submission, no sign-in, allowlisted host | Opus builder, main reviews the boundary | A1 | no |  |  |
| A5 | assess | Capture defects: `capture-exits-0-on-mostly-failed`, `blank-at-status-200`, `capture-check-misses-refused-data`, `capture-interaction-probes` | Sonnet builder | none | no |  |  |
| A6 | assess | Parity eval on TD and 2 sites with deep studies, scored by `tools/verify-score.ts`. Done when paid precision is at least the deep study's and recall is at least 0.6. A report, never a PR gate | main | A3, A4, A5 | approved, US$75 |  |  |
| B1 | kit, heuristics, papers | `check-links`: every internal href and src on every built page | Opus builder, main reviews | none | no | gorfednet/.github PR 88, heuristics PR 64, papers PR 27 | local_d414b064, then its finisher started from local_0018339b |
| B2 | kit, heuristics, papers | `check-html` (vnu.jar, offline) | Sonnet builder, main reviews | none | no | gorfednet/.github PR 88, heuristics PR 64, papers PR 27 | local_d414b064, then its finisher started from local_0018339b |
| B3 | heuristics, papers | WebKit and Firefox for the filter, facet and wordmark specs | Sonnet builder | none | no | heuristics PR 64, papers PR 27 | local_d414b064, then its finisher started from local_0018339b |
| B4 | heuristics, papers | Weekly report: outbound links, `check-live-release` on the full sitemap, headers. Opens backlog entries | Sonnet builder | none | no | heuristics PR 64, papers PR 27 | local_d414b064, then its finisher started from local_0018339b |
| B5 | heuristics | Monthly re-check of published findings live, through A4's loop, in a Max-plan session; results through the ledger | main sets up, Sonnet task runs | A4 | approved |  |  |
| B6 | papers | Unit floor in `verify.sh`, `check-live-release` in `make deploy`, `numbers-derived-from-spec`, `spec-drift-schedule` | Sonnet builder | none | no | papers#numbers-derived-from-spec, papers#spec-drift-schedule (papers PR 27) | local_d414b064, then its finisher started from local_0018339b |
| B7 | heuristics, papers | CI onto the pool (`ci-on-the-pool`) | Haiku runner, main checks | none | no | heuristics#ci-on-the-pool, papers#ci-on-the-pool | local_d414b064, then its finisher started from local_0018339b |
| B8 | heuristics | Stale `dash-g-papers` status, stale comment at `e2e/smoke.spec.ts:25` | Haiku runner | none | no | heuristics PR 64 | local_d414b064, then its finisher started from local_0018339b |
| C1 | intake | CI on the pool, `claude-review`, verification kit, executed-test floor | Sonnet builder | none | no |  |  |
| C2 | propose | End-to-end test brief to draft with the fake model; a 3-brief eval report | Sonnet builder, main judges | C1 | no |  |  |
| D1 | bindercurve.com | One full run per PR: the label run replaces the Chromium run for the SHA | main designs, Sonnet builder | none | no |  |  |
| D2 | bindercurve.com | One nightly: fold nightly-main axe and audit into deploy-check's nightly; skip a tree already gated green | main designs, Sonnet builder | D1 | no |  |  |
| D3 | bindercurve.com | `dependency-audit` once, in `pr-fast-check` | Sonnet builder | none | no |  |  |
| D4 | bindercurve.com | `production-monitor`: HTTP every 15 minutes, Playwright hourly | Sonnet builder | none | no |  |  |
| D5 | MoonMan | Drafts skip the heavy e2e | Sonnet builder | none | no |  |  |
| D6 | bindercurve.com | `infra/ci-runner/README.md:218` cap is 4; before and after queue numbers | Haiku runner | D1 | no |  |  |
| E1 | gorfednet.github | Weekly fleet health task: red mains, scheduled reports, lapsed backlog dates, kit drift, queue wait. Writes backlog entries, one 5-line push to the owner | main writes brief, Sonnet runs | F1 | approved |  |  |
| E2 | gorfednet.github | Red main: the alert opens an issue, the fleet run claims it and opens a `/self-heal` PR. Never merges over red, never retires a check | main designs | E1 | no |  |  |
| E3 | ~/.claude | `/self-heal`, `/verification-bootstrap`, `/full-codebase-assessment` off Cursor terms | Opus builder | none | no |  |  |
| F1 | gorfednet.github | This file and `docs/programme-template.md` | main | none | no |  |  |
| F2 | ~/.claude | Conductor workflow `programme.js`: reads a programme, runs ready items as worktree builders with a reviewer pass and a draft PR, stops at owner decisions, main merges. About 8 agents a run | main | F1 | no |  |  |
| G1 | gorfednet.github | Shipping, verification and agent rules into `docs/`, pointed to from each repository's `CLAUDE.md` | main | none | no |  |  |
| G2 | main repositories | `CODEOWNERS`, `CONTRIBUTING.md`, `enforce_admins` once a second person joins | Sonnet builder, main sets protection | G1 | no |  |  |

## Verification

- Every new guard is seen failing once (break, red, restore, green), and its PR says so.
- A6 publishes its parity numbers. The first B4, B5 and E1 reports are read by the main session.
- D: slot-minutes per PR and queue wait from the capacity report, the week before against the week after.
