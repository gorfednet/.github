# Retired checks

A check taken out on purpose is a recorded decision, not a weakening
(`~/.claude/rules/shipping.md`, "When CI is red"). Each entry says what the
check caught, why it went, and what still catches that class. Newest first.

## 2026-10-19: the ship bot's Bugbot gate

**Removed:** from `ship-bot/` (the merge bot on the owner's Mac), gate (d)'s
Bugbot half: running the kit's `bugbot-review-status.mjs`, the `bugbot run`
comment it posted once per unreviewed head, its wait timeout, its
usage-limit detection, and the filter that left Bugbot's check runs out of
the checks gate. The config keys `bugbot`, `scripts.bugbotReviewStatus`,
`bugbotGraceMinutes` and `bugbotWaitMinutes` went with it.

**What it caught:** a head Bugbot had not reviewed, or reviewed with
findings nobody had answered; the bot did not merge it. It also stopped a
Bugbot usage-limit error from reading as a wait nobody heard about.

**Why it went:** the owner retired Cursor and Bugbot on 2026-10-16. Every
repository then read `not-run`, so the gate either held every merge or
posted `bugbot run`, which nobody may comment any more. Its script came from
TowIt's dormant kit, and the entry below removes it from the kit.

**What catches that class now:** the same gate on the Claude reviewer. It
runs `review-status.mjs` (bindercurve.com `scripts/`) for the verdict on the
current head, merges on `clean`, or on `findings` once every thread the
reviewer opened is resolved or answered after its latest comment, and holds
a `not-run` head with one comment per head. It never asks for a review,
since shipping.md leaves whether a push needs one to a person. Renamed keys:
`claudeReview`, `scripts.reviewStatus`, `reviewGraceMinutes`; an old key is
refused with what replaced it. Check runs named for Bugbot are judged like
any other check.

## 2026-10-19: `bugbot-verdict.yml` and the kit's Bugbot status check

**Removed:** `.github/workflows/bugbot-verdict.yml`; from the kit (v0.46.0),
`bin/bugbot-review-status.mjs`, `lib/bugbotConclusion.mjs` and
`test/bugbotConclusion.test.mjs`; the canaries
`bugbot-neutral-read-as-skipped`, `bugbot-api-failure-reads-as-clean` and
`bugbot-timeout-reads-as-a-pass`; `.cursor/BUGBOT.md`.

**What it caught:** a Bugbot `NEUTRAL` check run, which the GitHub checks
panel prints in the same bucket as a clean pass, though Bugbot uses it for
*reviewed, and found things*. On 2026-09-08 that hid five findings across
three bindercurve.com pull requests (#177, #179, #182), and all three were
logged as never reviewed. It also failed closed when the review did not finish
or the API lookup failed, so neither could read as clean.

**Why it went:** the owner retired Cursor and Bugbot on 2026-10-16. With no
Bugbot check runs, the workflow could only answer `not-run`. A search of the
org on 2026-10-19 (`gh search code bugbot-verdict.yml --owner gorfednet`) found
no caller, and in the kit only this workflow called the status script.

**What catches that class now:** `review-status.mjs`, which ships with the
Claude reviewer (`claude-review.yml`, `REVIEW.md`). It reads the reviewer's
verdict on the current head as `clean`, `findings` or `not-run`, and is a
merge gate under `~/.claude/rules/shipping.md` and each adopting repository's
`AGENTS.md`. The unknown-flag canary that lived in the Bugbot status script
now mutates `assert-checks-started.mjs`, which has the same argument handling.

**Consumers:** each copy of the kit still holds the three files until its next
refresh. `check-kit-drift` reports a v0.45.0 copy as one minor behind (a
warning), and `refresh-kit.mjs` deletes files upstream no longer ships.
bindercurve.com's `src/lib/testing/bugbotConclusion.test.ts` imports the
vendored `lib/bugbotConclusion.mjs`, so that test goes in the same change as
its refresh.
