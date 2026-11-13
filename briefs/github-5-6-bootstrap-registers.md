# Brief: plan row 5.6, one run registers a new repo everywhere

Model: Opus 5.5 (`builder`), `reviewer` Fable. Repo: gorfednet/.github (the `verification-bootstrap` skill lives in `~/.claude/skills/`; its reviewed copy is `docs/claude-home/`).

## Objective
`verification-bootstrap` registers a new repo in one run. That means a ship-bot config row (as a reviewed patch for `patch-config.mjs`, never a direct config edit), the reviewer workflow, `CLAUDE.md`, `REVIEW.md`, `backlog.json`, a fleet-status entry, a Herdr job (1.11's format, ops 76), the pool-token request line for the owner, and a plan-of-record pointer. A new repo then joins the autonomous loop in the same run.

## Done when
A scratch repo bootstrapped end to end appears in STATUS.md on the next fleet-status run. The scratch repo is deleted afterward only if the owner agrees (one line under `## Next`).

## Boundaries
- Coordinate with 1.11 (ops 76) for the job format, and don't edit its branch.
- A `~/.claude` change ships as a `docs/claude-home/` PR. Say on the PR when the live copy was updated.
- If a step waits, park it and keep going. Ship-bot merges. Label once clean. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
