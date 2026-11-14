# Brief: replan, and turn this week's learnings into rules and skills

Starts only once all 5 plans are written (owner, 14 Nov 2026: "wait for all plans then replan"): org move (github-org-plan), release cadence 1.25, Phase 7 (.github 185, 4thcltr 273), plugins map (plugins-off), security 1.24 (ops 88).
Owner, 14 Nov 2026: "update any learnings from all plans and apply to new rules or skills to better our workflows and automation and costs - considering all new models on usb drive etc".

## Who
1. `reviewer` (Fable), read only: reads the 5 plans, `docs/plan-of-record.md`, `docs/desk/2026-11-13.md` and `2026-11-14.md` and `docs/desk/brief.md` (desk-log), every `INCIDENTS.md`/ledger line since 7 Nov, `docs/models.json` and the 1.19 harness, and live state (`status.json`, `~/.ship-bot/state.json`, `~/.herdr-jobs/STATE.md`). It returns ranked findings: plan errors (order, owner, model, waits, stale status), and learnings, each with its evidence.
2. `builder` (Sonnet) writes 2 PRs to gorfednet/.github: (a) the replan to `docs/plan-of-record.md`; (b) rule, skill, brief and template changes, mirrored under `docs/claude-home/`. An `editor` (Fable) pass on (b), since every session reads it. Changes to what CI enforces get the `reviewer` again.

## What (b) must cover
- Cost: each recurring task's cheapest tier that does it properly. Local models (USB m.2, 1.19/1.20): name the tasks to route there (CI-log triage first, then digests and inventories) and the eval each must pass. Until `docs/models.json` adopts a model, no rule may route work to one. Local output stays a lead only.
- Automation: what Desk or a session did by hand more than twice this week and could be a script, a ship-bot or janitor step, or a Herdr job.
- Each learning cites its incident. A new enforced check follows `shipping.md`, with one named defect and a watched failure.

## Leads already seen (check before using)
- A fresh Desk opens near 110k tokens. Rotation at 120k/150k meant one every 20 minutes. The brief now says 200k; the `desk-rotate` skill still says 150k.
- The always-PR hook says `desk-log` has no PR on every push, while draft PR 139 is open on it.
- claude-review finished green on .github 185 and 4thcltr 273 heads with no verdict posted (14 Nov, 07:3x ET): a check that passes without reviewing.
- Times in handoffs and Desk log lines were written without `date` (14 Nov: a session reported "about 9:00 am ET" at 07:30 ET).
- The owner declined scheduled-task wakes for Desk passes (14 Nov).

## Boundaries
No visibility or privacy change anywhere (owner, 14 Nov 2026). Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`. Ship-bot merges. Each PR carries `## Next`.
