# Brief: heuristics.4thcltr.com clean captures for published findings

Started by Desk, 15 Nov 2026, in a Herdr `builder` terminal (Sonnet). Fable `reviewer` reads each diff before labelling. Priority 2. The owner lifted the pace hold until the Fri 20 Nov reset.

## Objective
Every published finding on heuristics.4thcltr.com rests on a clean capture: loaded through the assess engine's egress proxy and resolver, with the canary proof. A capture read through this Mac's Pi-hole doesn't count.

## Entries (`docs/backlog.json` in heuristics.4thcltr.com; Herdr holds them under a retired coordinator's claim)
1. Recapture the published jobs read through the Pi-hole (Herdr job bl-heuristics-4thcltr-com-26c6a6). Start here, because the rest depend on it.
2. "f<N> has no clean capture behind it": Amazon f8, Walmart f7 and f8, Costco f5 and f6, Gamestop f1, f3 and f8, Scotiabank f19.
3. Redo axe for the published Amazon and Walmart analyses.
4. "Bring the dapyllil runner pool back" is probably obsolete, since the pool runs now. Close it with evidence.
5. Ship release/deep-3 (`docs/handoff/2026-11-10-deep3-deploy.md`), if it still applies.
6. Last, and only once the captures are clean: publish the Telus, Bell and Canadian Tire deep studies.

## Read first
The repo's CLAUDE.md and REVIEW.md, `docs/audit/pihole-artefacts.md`, and assess's `docs/deep-study-brief.md` (the hand route stays until the engine's output is shown to match it).

## Rules that bind this work
- Never read a site through this Mac's DNS. Every load that feeds a finding goes through the engine's egress proxy. Each run first resolves the 6 canary hosts (`CANARY_HOSTS`, assess `src/net/canary.ts`) and stops on any 0.0.0.0, `::`, private or missing answer. Run `node tools/canary-audit.ts` in assess before the first capture, if none has run in the last week.
- API spend: before any API run for a public job, add up this calendar month's public `costUsd` (`assess/jobs/*` ledgers, API runs only) plus `assess estimate <ref>`. If the total would pass US$100, stop and write it under `## Next`.
- Each new or edited page carries its AI Use Levels tag in the same PR. Copy goes through `/copy`.
- One local gate at a time (`gate-run`). Run `builder-ok` before heavy runs. Run typecheck, lint and every e2e spec you touch.
- Batch related fixes into few PRs. Never merge or deploy, since ship-bot does both.

## Done when
Each entry is landed with evidence, or declined with a reason, through PRs whose `## Next` first line says merge once the gates are clean. Under `## Next`, ask Desk to set `owner` on the taken Herdr jobs (gorfednet/ops `hosts/gorfpael/herdr/jobs/`). Report only through the PRs.
