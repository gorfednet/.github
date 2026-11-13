# Brief: plan row 1.14, detect and repair loop

Model: Sonnet 5.5 (`builder`), `reviewer` Fable on the diff. Repo: gorfednet/.github (fleet-status workflow, ship-bot); the importer change goes in gorfednet/ops on its own PR.

## Objective
- fleet-status runs every 2 h (hosted, public repo; it is daily today).
- A ship-bot block writes a diagnosis Herdr job file, so a block no longer waits for an owner turn.
- Review findings left unanswered get a `needs-fix` label. The Herdr importer turns that label into a continue-this-PR job that pushes to the existing branch.

## Done when
A planted block and a planted finding each produce exactly one job (tests on a fake `gh` and state). Tests watched failing once. PRs with `## Next`.

## Boundaries
- Build on 1.11 (ops 76, Herdr reconciler: one queue, job file is the claim, continue-PR path). Read its PR first and don't duplicate its importer. If 76 isn't merged, branch from it and say so in `## Next`.
- Hosted minutes: every 2 h must stay seconds per run (the $50 a month ceiling). State the measured run time on the PR.
- Ship-bot is the only merger. Label `ready-to-merge` once gates are clean. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
