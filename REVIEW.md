# Pull request review (gorfednet/.github)

Read by the Claude reviewer (`.github/workflows/claude-review.yml`, which calls the shared workflow in this same repository) on every non-draft pull request and on a `claude review` comment. The shared workflow says what to report in general; this file holds what is particular to this repository.

## What this repository is

The fleet's shared CI: the reusable `pr-check-*`, `browser-compat`, `claude-review` and healthcheck workflows, the composite actions they use, the canonical verification kit (`templates/verification-kit/`) that each project vendors, the fleet registry (`fleet.json`), the NAS deploy helpers, nginx vhost captures and the merge bot (`ship-bot/`). A change here reaches every repository that calls it at `@main` on its next run, so a defect here is a defect in all of them.

## House rules to hold the change to

- A reusable `pr-check-*` workflow runs the verification gate, defaults `verification-kit` to empty, forwards every gate input from `scripts/lib/verificationInputs.mjs`, and keeps `if: ${{ !cancelled() }}` on the gate step (`test/orgWorkflows.test.mjs`). A new input goes into that module, not only into one workflow.
- A shared workflow takes an optional `runs-on` input and otherwise runs on the caller's `HEAVY_RUNS_ON`. With neither set, a public caller runs GitHub-hosted, which is free, and a private one fails at once, with a message that names the fix, when neither is set or when the value is a hosted runner name (owner, 2026-11-20, free runners only; `test/orgWorkflows.test.mjs`). A private repository never gets a hosted fallback.
- The Claude review job never runs code from the checkout under review: the review input is built by `.github/actions/review-input` from this repository, with an empty environment and no token (`test/claudeReview.test.mjs`). The verdict line `<!-- claude-review head=<sha> findings=<n> blocking=<m> -->` and `scripts/review-status.mjs` change together. A pull request's 4th review round is its last for Low findings: from round 5, a round with `blocking=0` (only Low) reads `clean` and its Lows are answered by reply; a High or Medium still forces a fix. The workflow also skips a `claude review` request on a head that already has a verdict, so 2 requests on one head give 1 review; a draft that ship-bot readies keeps its draft-time review of the same head. Re-review the same head with a comment line `claude review force` (after a retarget, or a verdict that couldn't read everything), or push a new commit. A prose Low is answered by a reply in its thread, with no push: a prose push makes the head not-run and needs a review. Round 3 on a PR under 50 changed lines (additions plus deletions, from `gh pr view`) goes to Desk through a `## Next` line `Desk: keep or cut round 3`. Cut means close the PR, or split it and take the Lows as follow-ups. This is a written rule with no enforcement.
- A change under `templates/verification-kit/` updates `MANIFEST.json` (`node templates/verification-kit/bin/write-manifest.mjs`), and keeps the kit's executed-test floor in `verification-kit.yml` honest. Projects pick it up with `refresh-kit.mjs`.
- `FLEET.md` is generated from `fleet.json` (`scripts/write-fleet-md.mjs --check` in CI). Edit `fleet.json`, regenerate, never hand-edit `FLEET.md`.
- A check taken out on purpose gets an entry in `docs/retired-checks.md`: what it caught, why it went, what catches that class now.
- A new guard comes with a deliberate break that shows it failing (`canaries.json` for the kit's own gates). No raised floor, widened tolerance or deleted assertion to go green.
- A pull request check fails only on something the pull request can change: dates, the network and other repositories belong in scheduled reports (`fleet-audit.yml`), never in a per-PR gate.
- Third-party actions are pinned to a full commit sha with the version in a comment.
- No secrets in the repository: `.deploy-env`, keys and tokens stay out (only `.deploy-env.example`).

## Where the rules live

- `README.md`, `docs/verification-rules.md`, `docs/retired-checks.md`, `docs/backlog.json`
- `test/*.test.mjs` (guards on this repository's own workflows), `canaries.json`
- `.github/workflows/verification-kit.yml` (this repository's CI)
- `ship-bot/README.md` for the merge bot
- `scripts/local-llm/` output (local model verdicts and line numbers) is a lead only: nothing that merges imports it, and it never replaces a Claude read.
