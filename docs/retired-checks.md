# Retired checks

A check taken out on purpose is a recorded decision, not a weakening
(`~/.claude/rules/shipping.md`, "When CI is red"). Each entry says what the
check caught, why it went, and what still catches that class. Newest first.

## 2026-11-17: vendored-kit version and missing-kit failures in fleet-status (plan row 2.9)

**One failure removed, one check added.** `fleet-kit-versions` used to fail only on the vendored `verification-kit/` copy a repository carries. It now also fails on the gate ref the repository's workflows pin, because that ref is the kit the gate runs. The vendored-copy failure stays. The `missing` failure is the one retired.

**What the removed failure caught:** the `missing` gap, a repository at tier 1 or above with no vendored kit at all.

**Why it went:** the shared gate runs the kit at the pinned ref, not the vendored copy, so a repository with no copy but a current pin was reported red for nothing.

**What stays:** a vendored copy far behind, ahead of or unreadable against the canonical kit still fails, in any repository that carries one. The gate no longer runs that copy, but `production-healthcheck.yml` still runs `verification-kit/bin/check-live-og-image.mjs` and `verification-kit/bin/assert-tests-executed.mjs` from the caller's checkout, so a stale copy is old code in the live monitor. The failure can go once that workflow runs the kit from its own checkout.

**What catches that class now:**
- A repository whose workflows call the gate fails when the pin is far behind, ahead of canonical, unreadable, or at mixed refs.
- A tier 1 or above repository with no gate caller and no vendored kit run fails as an error row (`kitFailures` turns a `none` pin at tier 1 or above into `error`).
- A call of a `pr-check-*` reusable workflow counts as a gate caller only when it passes a non-empty `verification-kit` at `@main`. Without that input the workflow skips its gate step, so the call is no caller and the row above applies (the old `missing` case). At any other ref the row fails as an error: the gate a pr-check workflow runs at that ref can't be read from the caller, and before the gate step existed it ran none.
- A repository that runs its own `verification-kit/bin` is reported as `vendored` and still fails on its copy's gap.
- `check-kit-drift` compares a vendored copy with its own manifest.

## 2026-11-16: two Node checks narrowed for the user-owned Node (plan row 3.20k)

**Narrowed, not dropped.** Both stay in force. Each now has one exception, written so a patch needs no sudo and no reinstall of the agents. The ledger line is in `ship-bot/INCIDENTS.md` (16 November 2026, plan row 3.20k).

**1. The private-folder refusal** (`scripts/lib/resolve-node.sh`, and `privateInterpreters` in `scripts/lib/installed-tools.mjs`).
- **What it caught:** a LaunchAgent running on another tool's Node, the 14 November class: ship-bot's agent ran Hermes Agent's `~/.hermes/node/bin/node` through the shell's `~/.local/bin/node` link, so archiving Hermes would have stopped the only merger.
- **Why it changed:** the Node the owner now wants lives in `~/.local/share/node/`, a dot-folder of home, so the blanket refusal would reject the very install it exists to make patchable.
- **What it allows:** one candidate, spelled exactly `~/.local/share/node/<major>/bin/node`, that resolves to a `v<version>` directory there. A stable link into any other tool, a dangling link, a damaged install with no `bin/node` and a `..` spelling all still refuse (tests in `ship-bot/test/resolve-node.test.mjs` and `test/installedTools.test.mjs`, each watched failing with the exception widened).
- **What catches that class now:** the same refusal for every other path, including `~/.local/bin/node` (it points into the same folder and is still refused), and the "Installed tools behind main" row on fleet-status, which flags any agent whose program resolves into a private folder other than that exact link.

**2. The "Node version" drift row** (`nodeVersionDrift` in `scripts/lib/installed-tools.mjs`).
- **What it caught:** an agent running a Node that `check.sh` never passed on, because the recorded `app.node-version` and the running version differed (16 November 2026, plan row 1.22a).
- **Why it changed:** every patch of the user-owned Node would make the row fire until the installers were rerun, which taught the owner to ignore it.
- **What it allows:** on the stable link only, a patch or minor at or above the recorded version, within the same major. A different major, a downgrade, any other program path or no record still fires.
- **What catches a patch or minor now:** `node-update.sh` runs the new `node --version` before and after the link swap and puts the old link back on failure. A Node that can't run ship-bot or capacity stops their heartbeats and healthchecks.io emails the owner (ship-bot period 2 min, grace 10 min, `docs/heartbeats.md`). `scripts/node-update.sh <major> --check` reads installed against latest. `app.node-version` stays at the version `check.sh` passed on and the next installer run refreshes it.

## 2026-11-15: per-PR rules drift on the `~/.claude` copy, Desk's brief and handoffs

**Moved, not dropped:** plan row 1.30 moved `docs/claude-home/` (rules, agents, skills), `docs/desk/brief.md` and `docs/handoff/` to the private ops repository, under `control/`. This repository's CI ran `check-rules-drift.mjs` on them per PR. It can't now: the files are gone, and ops has no CI beyond its reviewer.

**What it caught:** a retired tool or an off-roster model written into a rule, skill, agent brief or handoff.

**What still catches it:** `check-rules-drift.mjs --profile ops --root <ops clone>`. It's the same guard with an ops scope, and it fails closed on a missing brief or CLAUDE.md. The weekly lessons run executes it every Friday, ops REVIEW.md asks each `control/claude-home/` PR to show it exiting 0, and the ops reviewer reads every rule change. The CI step here still covers everything this repository carries.

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
