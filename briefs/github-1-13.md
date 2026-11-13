# Brief: plan row 1.13, heartbeats and usage pushes

Model: Sonnet 5.5 (`builder`), `reviewer` Fable on the diff. Repo: gorfednet/.github (ship-bot, capacity, janitor); the herdr-reconcile ping goes in gorfednet/ops on its own PR.

## Objective
Ship-bot, herdr-reconcile, capacity and janitor each ping an off-box dead-man check. Add a second push path that doesn't rely on dapyllil (ntfy runs there). `capacity.mjs` reads `usage.pct` from `~/.herdr-jobs/state.json` and pushes once at 70% and once at 90% weekly usage.

## Why
The janitor failed silently for 5 days. ntfy is on dapyllil, so a dapyllil outage hides every alert.

## Done when
- A stopped job alerts within 30 min (shown once with a deliberately stopped job).
- A planted 90% pushes exactly once (test on a fake state file).
- Tests watched failing once. PR with `## Next`.

## Boundaries
- If a dead-man service needs a sign-up or money, stop and put that one question at the top of `## Next` with your recommended service. Don't sign up.
- Coordinate with 1.9 (.github 152, capacity) and 1.11 (Herdr reconciler, ops). Don't edit their files on their branches; build on main and note the overlap.
- Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`. Never merge: label `ready-to-merge` once gates are clean.
