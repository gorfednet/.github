# Retired checks

A check taken out on purpose is a recorded decision, not a weakening
(`~/.claude/rules/shipping.md`, "When CI is red"). Each entry says what the
check caught, why it went, and what still catches that class. Newest first.

## 2026-10-20: the nginx vhost record and `check-vhost-capture.mjs`

**Removed:** `infra/nginx/vhosts/` and `infra/nginx/CAPTURE.json` (a hashed copy
of dapyllil's live nginx `conf.d`), `scripts/check-vhost-capture.mjs`,
`test/vhostCapture.test.mjs`, the workflow step "The vhost record has not been
edited or gone stale", and the `check-machine-paths` waiver that existed only
for `CAPTURE.json`'s host path. `infra/nginx/README.md` now points at the new
record; `infra/nginx/proposed/` (the security-header proposal) stays.

**What it caught:** an edit to the copy made as though it deployed something
(the copy's hash no longer matched `CAPTURE.json`), and a copy left past its
dated re-capture. It could not compare the copy with the host, since a runner
has no route to it.

**Why it went:** the copy was a record, not the configuration, so it drifted
within a week: on 2026-10-16 `gorfed.net.conf` differed from the host and two
live files were missing, while the check stayed green because it hashed the
copy against itself (backlog `vhost-capture-drift-gorfed-work-and-assist`).
gorfednet/ops#13 (merged 2026-10-20) made the record something that deploys:
`hosts/dapyllil/webserver/conf.d/` holds all twelve live files plus
`00-error-cache-control.conf`, and `webserver-conf` there diffs the record
against the host, applies a change with `nginx -t`, a reload and a rollback,
and pulls a change made on the host. That is backlog
`vhost-record-should-be-the-source`. A public repository was also the wrong
place for the host's full configuration.

**What catches that class now:** `webserver-conf diff` in gorfednet/ops, which
compares the record with the host itself. That is what the dated hash stood in
for. 4thcltr.com's scheduled `check-live-headers.mjs` still compares that
site's served headers with its repository's vhost.

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
