# Brief: 1.28 weekly lessons PR

Model: the task runs on Opus. A Fable `reviewer` ranks the learnings, a Sonnet `builder` writes, and a Fable `editor` reads the rule text, since every session reads it. Repo: `gorfednet/.github`. The owner approved this recurring task on 14 Nov 2026 at 12:45 ET.

## Objective
Every Friday at 09:00 ET, turn the week's incidents and corrections into one PR that changes the rules, briefs, skills or templates that would have prevented them. This automates the "Improve as you go" rule.

## Setup (this brief's session)
Write the task prompt as `docs/desk/weekly-lessons-prompt.md`, create the durable scheduled task `weekly-lessons` (cron `0 9 * * 5`) pointing at it, and run it once by hand to prove it.

## Each run
- Reads: every `INCIDENTS.md` and ledger line dated this week across the fleet, owner corrections in `docs/desk/<date>.md` on `desk-log`, 1.26's dearest PRs, and the `replan-and-learnings` brief's open leads.
- Writes one PR: each change names its incident and the rule, skill or check it alters, mirrored under `docs/claude-home/`. A change that only restates an incident is dropped. New enforced checks follow `shipping.md` (named defect, watched failure).
- Desk labels it when the gates pass. The owner gets one line in the digest, with no approval step.

## Done when
The first run (Fri 20 Nov 2026) merges with at least one rule or skill changed, and every change cites evidence.
