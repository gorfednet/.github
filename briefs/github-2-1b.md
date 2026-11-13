# Brief: plan row 2.1 (second pass), the 4 deploys still blocked in ship-bot

Model: Opus 5.5 (root cause, no reviewer behind the diagnosis). `reviewer` Fable on any code diff. Repo: gorfednet/.github (ship-bot), plus each site repo as needed.

## Objective
Ship-bot `~/.ship-bot/state.json` still blocks 4 repos (13 Nov, 12:00 ET):
- papers.4thcltr.com: deploy of #35 did not start, step "verify" exited 2 (16:36 UTC 13 Nov, after .github 140 merged; earlier lead: .github 128 fixed the cause but `install.sh` wasn't rerun)
- gorfed.net: deploy of #140 failed and the rollback failed too (14:41 UTC 13 Nov)
- gorfmusic.com: deploy of #49 failed, rollback failed (lead: `vite` missing, no `node_modules`)
- blackpixelrecords.com: deploy of #29 failed, rollback failed (14:35 UTC 13 Nov)
ssatcy.com was unblocked by Desk at 12:00 ET 13 Nov after the ops 72 headers were applied and checked.

## Done when
For each repo: cause established from ship-bot's log and the deploy output, fix on a PR (or the bot reinstalled from main, said why), live site checked through DoH (not the Mac's Pi-hole DNS), then `node ~/.ship-bot/app/ship-bot.mjs --unblock <repo>`. A ledger line per distinct cause. If one shared cause: one fix, one guard watched failing once.

## Boundaries
- Ship-bot is the only merger. Label `ready-to-merge` once gates pass. Never deploy by hand on dapyllil. If a host step needs the owner (sudo, Tailscale approval), put the exact one-line command at the top of `## Next` and stop on that repo.
- Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
- The prior session (.github 140, merged) has the history in `docs/handoff/` if it wrote one. Read that, not its chat.
