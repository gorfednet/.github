# Brief: plan row 1.17, one generated inventory of everything in flight

Model: Sonnet 5.5 (`builder`), `reviewer` Fable. Repo: gorfednet/.github (fleet-status, `scripts/`).

## Objective
fleet-status writes an "Inventory" section to `STATUS.md` daily. Every open PR, local Claude session (from the app's session store, read-only, on the Mac run), worktree, Herdr job and open backlog entry across the fleet maps to a plan row, a backlog id or "orphan". Use row 4.1's generator (`scripts/plan-of-record.mjs`, if landed: check the backlog-triage session's PR) for the plan mapping. Desk reads orphans each pass and decides within 24 h.

## Also, once, now
Run it by hand and put the first orphan list in the PR body. That list is the "everything accounted for" answer for 13 Nov.

## Done when
A planted orphan PR and an orphan session each show once, then clear when attached. GitHub reads stay cheap: one GraphQL search per pass, cached, and refused under a 1,500 reserve.

## Boundaries
Never poll `gh` in a loop. Ship-bot merges. Label once clean. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
