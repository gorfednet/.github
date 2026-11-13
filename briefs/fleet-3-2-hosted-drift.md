# Brief: plan row 3.2, hosted CI drift back onto the pool

Model: Sonnet 5.5 (`builder`), `reviewer` Fable on workflow diffs. Repos: bindercurve.com (`infra/ci-runner`, pool image), gorfed.net, ssatcy.com, denseware.com, gorfmusic.com, promptboi.com, 4thcltr.com, MoonMan.

## Objective
- Add rsync to the pool image (bindercurve.com `infra/ci-runner`). gorfed.net 142 already has the steps under `## Next`. Finish it.
- Move each hosted job to the pool and keep only the liveness preflight hosted. That covers bindercurve's 25 hard-coded `ubuntu-latest`, 4thcltr's 6 and MoonMan's 3.
- ssatcy, denseware, gorfmusic and promptboi have no pool token. Prepare their workflows, and list the exact owner step to register each under `## Next` (one line each, run when due).
- `HEAVY_RUNS_ON` drift becomes a fleet-status row.

## Done when
Each repo's PR is green on the pool, with first-run runner names recorded. fleet-status shows hosted jobs over 7 days under 5% per repo, or the reason it can't yet.

## Boundaries
- One PR per repo, batched where small. Image rebuilds and runner restarts on dapyllil run as gorf through the repo's own scripts. Anything needing sudo goes as one exact `ssh -t dapyllil "…"` line under `## Next`.
- Don't saturate the pool: at most one heavy run at a time from this work.
- If a step waits on CI or a token, park it with a background `gh run watch --interval 60` and move to the next repo.
- Ship-bot merges. Label `ready-to-merge` once gates are clean. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
