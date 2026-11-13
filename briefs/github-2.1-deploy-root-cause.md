# Brief: four failed ship-bot deploys, root cause (plan rows 1.4 and 2.1)

Model: Opus 5.5. Why: judgement work with no reviewer behind the diagnosis. Fixes go to a `reviewer` (Fable) before labelling.
Folder: `~/Developer/gorfednet/gorfednet.github`, own worktree. Repo fixes go in each repo's own worktree and PR.

## Objective
Ship-bot has four repos blocked because deploy and rollback both failed. Establish the cause of each from the logs, fix it at the cause, and add the 1.4 preflight so the class cannot recur.

| Repo | Blocked PR | Recorded reason |
|---|---|---|
| gorfmusic.com | 49 | deploy and rollback failed (hypothesis: `vite` missing, no `node_modules`) |
| papers.4thcltr.com | 33 | setup step `verify` exited 2 (cause fixed in .github 128 but `install.sh` not rerun; backlog `papers-deploy-verify-fails-under-load`) |
| MoonMan | 324 | deploy and rollback failed (step `game` exit 1) |
| ssatcy.com | 35 | deploy and rollback failed (step `site` exit 2) |

Evidence: `~/.ship-bot/logs/deploys/*`, `~/.ship-bot/state.json` (`repos.*.blocked`), `ship-bot/lib/` (`prepareWorkspace`), each repo's ship-bot config row. Never read `~/.ship-bot/config.json` secrets or any `*.env*`.

Hypothesis to confirm or reject: `prepareWorkspace` cleans untracked files, so repos with `setup: []` lose `node_modules` and rely on `make deploy` to install. Rollback claims a previous build it no longer has.

## Done when
- One cause line per repo, from the log, in `docs/handoff/2026-11-13-deploy-root-causes.md`, and a dated line in each repo's incident ledger.
- .github PR: deploy preflight refuses a deploy whose steps call npm or vite unless `setup` runs `npm ci` or `preserve` lists `node_modules`. Rollback verifies the previous build exists before claiming success. A `test-site-deploy.sh` case shows the npm-with-no-setup config failing validate (watched failing once, then green; say so on the PR).
- Per-repo config fixes in their own PRs where the fix is in the repo.
- Unblocking (`~/.ship-bot/state.json`) is NOT yours. Say in `## Next` which repos are ready to unblock; Desk does it.

## Boundaries
- Never `gh pr merge`, never deploy by hand, never edit `~/.ship-bot/state.json`.
- Live checks go through DoH, never this Mac's Pi-hole.
- If the docker host needs Tailscale SSH approval or sudo, stop and write it in `## Next`; Desk asks the owner.
- Every PR gets `## Next` with `- [ ]` lines. Comment `claude review` on the final head if it is a draft.

Return: PR links with `## Next`. No report to Desk beyond that.
