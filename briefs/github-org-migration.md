# Brief: move the fleet into one GitHub organization (assessment only)

Model: Opus 5.5 (judgement with no reviewer behind it yet; a Fable `reviewer` pass follows). Repo: gorfednet/.github. Plan: infra, priority 1.
Owner, 14 Nov 2026, 07:30 ET: "part of our plan is to make an org". 07:31 ET: "ensure no privacy/visibility changes throughout these changes- keep my stuff safe and secure".

## Hard rule (the owner's): no privacy or visibility change
- Every repo keeps its current visibility: 26 private, 3 public (`.github`, and the 2 others in `gh repo list gorfednet --json name,visibility`). Record that list as the baseline in the plan and diff it after every step.
- Nothing private becomes public or internal. No secret, Pages site, package, Actions log, fork or member list becomes more visible than it is now.
- Org settings start locked down: base permission none, members can't create public repos or change visibility, no forking of private repos, 2FA required, membership private, org secrets scoped to selected repos only.

## Objective
Write `docs/plans/github-org-migration.md`: compare (a) transforming the `gorfednet` account into an organization, with a new personal login for the owner, against (b) a new organization with another name and repo transfers. For each, list from GitHub's own docs and the live account (`gh api`, read only) what moves, breaks or must be redone: Pages custom domains, self-hosted runners on dapyllil, secrets and variables, webhooks, deploy keys, the ship-bot and Claude GitHub Apps, Actions budget and billing, Dependabot, `gh` auth on this Mac and dapyllil, ship-bot config and every `gorfednet/` reference in the fleet. Recommend one path, with each step's undo and where it checks the visibility baseline.

## Boundaries
Read only on GitHub: no org creation, transfer, rename, setting or visibility change, no terms accepted. Desk takes the plan to the owner after a Fable review. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.

## Done when
A draft PR to gorfednet/.github with the plan, the visibility baseline and a `## Next` whose first line is "Fable review, then Desk asks the owner". If a fact can't be checked from docs or the API, say so in the plan.
