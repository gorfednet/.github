# Retired checks

A check taken out on purpose is a recorded decision, not a weakening
(`~/.claude/rules/shipping.md`, "When CI is red"). Each entry says what the
check caught, why it went, and what still catches that class. Newest first.

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
