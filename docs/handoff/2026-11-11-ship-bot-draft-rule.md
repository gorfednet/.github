# Handoff: ship-bot draft rule, 11 November 2026

## Goal
Fleet close-out plan item R6 / 1.1 (`docs/handoff/2026-11-11-fleet-close-out.md`): 30 `worktree-*` draft pull requests opened by Herdr builder jobs carry a `## Next` whose first line says merge, and nothing moves them. Add one rule to ship-bot so it marks such a draft ready and labels it once the gates are clean. One PR to gorfednet/.github, under 400 added lines, tests in `ship-bot/test/`, verification rule 4 on a real draft, README and `~/.claude/rules/shipping.md` updated.

## Done
- PR 119 (`claude/ship-bot-draft-rule-2fa386`): `ship-bot/lib/drafts.mjs`, a draft path in `lib/bot.mjs` (`processDraft`, `takeDraft`), `markReady` and `addLabels` in `lib/github.mjs` as guarded writes, `draftReady` per-repo opt-out in `lib/config.mjs`, a `draft` option on `evaluatePull` and `evaluateReview`, 16 tests in `test/drafts.test.mjs`, `check.sh` floor 197, README section "Drafts the bot marks ready itself". Heads: db9f174, 5591e10, c4c5f42, ddc3277, 5d77724, 7289f10 (merge of main after PR 116), df91a03, 5427cf8, a4d0c6f, 229dae1 (local, not pushed at the time of writing).
- 6 review rounds. Every finding fixed and answered in its thread. The last on a4d0c6f (a wait written as prose under `## Next` was ignored) is fixed in 229dae1.
- Scope cut on the coordinating session's call after round 5: the docs-only branch is out. Only an explicit `## Next` merge line takes a draft, and any live line under `## Next` with do not, don't, wait, hold, owner, needs a decision or decide refuses it.
- `~/.claude/rules/shipping.md` has the new line under "Ship-bot merges labelled pull requests" (outside the repository, on the owner's Mac).
- PR 123: the kit job's ripgrep install moved from apt to the pinned 14.1.1 release tarball with a sha256 check, because `ubuntu-latest` moved to the 26.04 image on 11 November and every kit run since 9:02 AM ET, main included, failed there. Green, review clean, labelled `ready-to-merge` for ship-bot.
- Verification rule 4, local half: with both claims in `draftClaim` replaced by `false` (on db9f174's `drafts.mjs`), 6 of the then 15 draft tests failed; restored, all pass. The dry-run half on PR 119 itself: the refusing line while checks ran is in the PR body; the review-not-run and accepting lines are still to be captured once the PR's kit run is green.

## Next
- [ ] Review round 7 finding on 8a274b6 (thread 4539845276), the one piece of code left: once the bot labels a draft, nothing re-reads `## Next`, so a wait written there after the label is ignored and a later head merges on the label alone. Fix: in `takeDraft` mark the head state (`labelledByBot: true`, with the sha); in `processPull`, for a pull request whose state says the bot labelled it, call `draftClaim(pr)` again before merging and refuse (log, and remove `ready-to-merge` live) when the claim is gone or the head moved. Test both. Then comment `claude review` on that head.
- [ ] Set the PR body's `## Next` first unchecked line to `- [ ] merge` (the dry run on 11 November at 11:36 AM ET read the rewritten `## Next` and said `draft left alone (no merge line under ## Next)`, which is the rule working, not the proof wanted). Then run `node ship-bot/ship-bot.mjs --dry-run --once --verbose --repo .github` twice: once while review-status says `not-run` on the head (expect `would comment: claude review`), once after it says `clean` (expect `would mark ready and add ready-to-merge`). Paste both lines into the PR body under "Dry-run proof".
- [ ] Read the gates: `scripts/gates/assert-checks-started.mjs --pr 119`, `scripts/review-status.mjs --pr 119`, `GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=gorfednet/.github scripts/gates/check-closing-keywords.mjs --pr 119`. Then `gh pr ready 119` and `gh pr edit 119 --add-label ready-to-merge`. Ship-bot merges.
- [ ] After the merge: `ship-bot/install.sh` so the launchd copy carries the rule (it runs `check.sh` first). Then plan step 0.5, the config rows.
- [ ] Later, its own PR if wanted: the docs-only branch, with the edge cases from rounds 2 to 5 (renames, `src/content/*.md`, a `docs/` route, a wait line beside a docs diff) as its tests.

## Open PRs
- gorfednet/.github#119: draft, head 8a274b6, kit green, review round 7 has 1 finding (above). Needs that fix, one review, the dry-run proof, gates, ready, label.
- gorfednet/.github#123: merged by ship-bot at about 10:55 AM ET.
- gorfednet/.github#121 (another session, draft): "no-smb-guard: no apt ripgrep install". Overlaps PR 123 in intent; whoever picks it up should rebase on PR 123's step or close it.

## Blockers
- None once PR 123 merges. Until then every kit run on `ubuntu-latest` in this repository fails at the ripgrep install.

## Decisions
- 11 November 2026: the bot comments `claude review` on a draft and marks it ready once clean, as the brief said. Marking ready fires a second review (`ready_for_review`), so a head the bot readied is held for `reviewGraceMinutes` and that review's check is waited on. The alternative, mark ready first and let `ready_for_review` be the only review, halves review spend and is for the owner to choose later.
- 11 November 2026: label before `markReady`, so a failed `markReady` leaves a labelled draft the next pass retries.
- 11 November 2026: the docs-only branch is cut from this PR (coordinating session, after 5 review rounds). The stop line in the brief was round 4; rounds 6 and 7 were taken to close Medium findings rather than merge a known hole, and the session stopped after round 7's finding as the coordinating session asked.
- 11 November 2026: the kit job stays on `ubuntu-latest`; ripgrep comes from the release tarball, pinned by version and sha256. A pin to `ubuntu-24.04` was tried first and sat in the same apt step.
