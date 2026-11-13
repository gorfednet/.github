# Backlog triage, 13 November 2026 (plan rows 4.3, 4.1, 4.7)

Public summary for Desk. Most entries live in private repositories, so the entry-by-entry record and the calls for Desk are in gorfednet/ops `docs/handoff/2026-11-13-backlog-triage.md` (ops PR 73).

## Status

- Read 218 open typed entries across 23 backlogs.
- Applied 77 changes through one backlog-only PR in each of 16 repositories, plus 8 here. Fixes found on main became `landed` with their PR. Duplicates collapsed into one survivor each. Lapsed dates were renewed with a reason or closed. Closed entries lost stale dates.
- Lapsed entries: 66 before, about 4 once the PRs merge. The 4 left belong to open PRs (here: #102, #106, #112).
- 12 judgement calls wait for Desk in the ops handoff, each with a recommendation.

## Here

- `fleet-registry-missing-repos` is new. It's the survivor for three "register me" entries: six active repositories are missing from fleet.json.
- `towit-open-security-bump` is declined as dormant. Seven landed or declined entries lost past review dates.
- Plan row 4.7: TowIt and wychwood are archived on GitHub, so their backlogs can't change. fleet-status now leaves `monitorClass: dormant` projects out and names them on one STATUS line.
- Plan row 4.1: `scripts/plan-of-record.mjs` ranks every open entry by the owner's order (`docs/plan-ranking.json`, repositories only). It names private entries, so the output goes to ops `docs/plan-ranked.md`, never to this public repository.

## Next

- [ ] Ship-bot merges the 17 triage PRs once green.
- [ ] Regenerate ops `docs/plan-ranked.md` after they merge.
- [ ] Desk takes the 12 calls in the ops handoff.
