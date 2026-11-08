# Handoff: fleet self-management coordination, 7 November 2026

## Goal
The owner (7 November 2026) asked that the repositories track themselves, store context outside chats, and merge and deploy without him, with standing authority to inspect, fix, merge, deploy and automate. Plan of record: `~/.claude/plans/something-is-wrong-and-cheeky-bunny.md` (parts A to G). Triage decisions: `docs/triage-2026-11-07.md`; worktree prune: `docs/triage-2026-11-07-worktrees.md`.

## Done (by the first coordinator session, 7 November, 9 PM to 11 PM ET)
- A1 data rescue: resume working copies backed up to `~/Developer/_archive/career-portfolio-resume/docs-resume-2026-11-07.tgz`; 7 branches pushed; drafts heuristics 75 to 78 and assess 72 opened.
- A2 triage: merged ops 33; closed bindercurve 601, 4thcltr 228, assess 38 and 44, heuristics 8; labelled 4thcltr 212 and 227 `ready-to-merge` (a background wait in the old session merges them on green; check they merged); drafted MoonMan 291 and 296; `## Next` on 4thcltr 200/213, assess 51, career-portfolio 50.
- A3 prune: 167 worktrees removed, 97 GB to 52 GB; 27 refused (untracked content), listed in the worktree table.
- G rules: `~/.claude/rules/shipping.md` (ship-bot exception, `## Next`, fleet-status), `agents-and-cost.md` (standing automation), `~/.claude/CLAUDE.md` (status and handoffs line).
- Sessions running: `ci-to-pool` (4thcltr 180/220, gorfed.net 90) and `jobs-housekeeping` (career-portfolio backlog, handoff, audit gate, PR 50).

## Next (in order)
- [ ] Owner clicks Trust for `gorfednet.github`; then start the three fleet sessions, each in its own worktree of `/Users/gorf/Developer/gorfednet/gorfednet.github`, briefs in the plan file parts B, C+E, D: ship-bot go-live preconditions PR (Fable, medium; also owns the Dependabot review-job fix in `.github/workflows/claude-review.yml`: skip on `pull_request` when actor is `dependabot[bot]`, keep the `issue_comment` path), fleet-status script + workflow + janitor prompt (Sonnet), handoff template + `/handoff` skill + `created`/`updated` backlog fields + CLAUDE snippet + seeded backlogs for bindercurve and MoonMan (Sonnet). Commit `docs/triage-2026-11-07*.md` and this file in the handoff session's PR.
- [ ] When the ship-bot PR merges: copy the new config to `~/.ship-bot/config.json`, run `--validate`, `--set-live true` with stage-1 rows live only; watch the first merge in the log; stage 2 to 4 per the plan.
- [ ] Remaining F sessions, at most 3 running at once, each from a 30-line brief: bindercurve 531 rebuild or close; ops (DNS for `brief.4thcltr.com` and `propose.4thcltr.com`, `intake.4thcltr.com` 404 against its vhost, `cta-watch-install`); assess parity (4 gaps as backlog ids, plus the 4 defects from PR 51's review and the `complete-blocked-pages` entry quoted on PR 44, then merge 51); MoonMan 291/296 self-heal and 319 review triage; Dependabot batches per repo (bindercurve, 4thcltr, gorfed.net, promptboi, ssatcy, denseware) after the review-job fix; 4thcltr 200/213 rebase.
- [ ] Verify end to end per the plan: `fleet-status --local` lists every open PR; ship-bot log shows a MERGE and a SKIP; `STATUS.md` on `origin/status` within 24 h; the owner's reports quote it.

## Open PRs touched tonight
See `docs/triage-2026-11-07.md`.

## Blockers
- Trust click for `gorfednet.github` (owner).
- Dependabot PRs cannot pass the review gate until the workflow fix lands.

## Decisions
- `queue.tsv` and the other resume working copies stay out of git by the owner's 6 November decision; back up, never commit.
- Ship-bot is the merge path once live; the label is the decision. Staged rollout, merge-only repositories first.
- Status reports come from `fleet-status`, never hand counts.
