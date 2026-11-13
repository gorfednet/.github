# Four blocked ship-bot deploys: root causes (plan rows 1.4 and 2.1)

13 November 2026. Every cause below comes from the deploy log in `~/.ship-bot/logs/deploys/`. Times are ET.

## One cause per repository

| Repo | PR | Log | Cause |
|---|---|---|---|
| gorfmusic.com | 49 | `2026-11-12T21-04-20-750Z-gorfmusic.com-pr49.log` (16:04 ET, 12 Nov) | The row has `setup: []`. The workspace clean removes `node_modules`. `make deploy` runs its `web3forms-preflight` prerequisite before its own `install`, and that script imports `vite`: `ERR_MODULE_NOT_FOUND: Cannot find package 'vite'`. The rollback redeployed the parent the same way and failed the same way. |
| papers.4thcltr.com | 33 | `2026-11-11T19-34-59-231Z-papers.4thcltr.com-pr33.log` (14:34 ET, 11 Nov) | Setup `make verify` failed 18 Playwright specs, all frame-timing (wordmark cut counts, median cut, hover laps) plus 3 filter specs on firefox. The agent ran under `ProcessType Background`. Reproduced on 13 Nov: the same two spec files under `taskpolicy -b` failed 27 of 87. At normal priority they passed 87 of 87 at a load of 7 on 10 cores, with both default and 2 workers. .github PR 128 removed the key. The installed plist (written 22:10 ET, 12 Nov) has no `ProcessType`, so `install.sh` was rerun. The brief said it wasn't. |
| MoonMan | 324 | `2026-11-13T03-14-59-833Z-MoonMan-pr324.log` (22:14 ET, 12 Nov) | The row has no `siblings`, so the bot never synced `work/gorfednet.github`. An earlier deploy had left it at f3eab3e. origin/main was fbee21f. `site-deploy.sh` refused: "The deploy helper itself is not the merged tip of its repository". Before that, the `infra` step had already gone live. PR 324 changed `infra/nginx/moonman.conf`, which was synced to dapyllil and nginx reloaded. The default rollback then re-ran `deploy:infra` from the parent e8bea5a, so the parent's nginx conf went back on. Then its game step was refused by the workspace guard ("HEAD e8bea5a is behind origin/main 7de708b"). So the live infra has the parent's nginx conf, and the game was never published. |
| ssatcy.com | 35 | `2026-11-13T03-25-47-166Z-ssatcy.com-pr35.log` (22:25 ET, 12 Nov) | PR 35 added `deploy/nginx-security-headers.conf` and a check in `verify-production.mjs` that the origin serves those headers. Installing the conf on dapyllil needs sudo, which the bot doesn't have. The release went live (`current -> 20261113T032555Z-5a58fb1`) and the header check then failed. The default rollback redeployed eba6e50, and `site-deploy.sh` refused it as "behind origin/main 5a58fb1". The 5a58fb1 release is still current. Checked through DoH at 09:05 ET, 13 Nov: `x-frame-options: SAMEORIGIN`, no `strict-transport-security`, so the conf isn't installed. |

## Hypothesis from the brief

- Confirmed for gorfmusic only. `prepareWorkspace` runs `git clean -ffdx`, and a row with `setup: []` relies on `make deploy` to install. ssatcy, MoonMan and papers all install in setup.
- Rejected: "rollback claims a previous build it no longer has". In all three rollback-failed logs the bot reported the rollback as failed. It never claimed success. `site-deploy.sh rollback` already dies when no older release exists, and it checks the live site after switching (`cmd_rollback`).
- The real rollback defect: the default rollback (no `rollback` list means redeploy the parent commit) can't get past `site-deploy.sh`'s merged-tip guard. The parent is never the tip. So after a publish, every site row that names no rollback has a rollback that is sure to fail. Fixing it per row means splitting `make deploy` into build, publish and live-check steps, so a `make rollback` step can run `onlyAfterFailureOf` the steps after the publish. That's follow-up plan work, not part of this change.

## Fixed where

- .github (ship-bot): a merge preflight for the node_modules class, and every deploy row now syncs the helper checkout. In the example config, gorfmusic setup gets `npm ci` and ssatcy gets `pausedIfChanged: ["deploy/"]`.
- After setup, in the workspace at the merge commit, ship-bot refuses (not-started, nothing deployed) when package.json declares packages, no `node_modules` exists, and a selected step needs them. The pre-merge check reads the owner's clone, which isn't always main.
- gorfmusic.com PR 51: `web3forms-preflight` depends on `install`, so `make deploy` works from a fresh clone. Incident line.
- MoonMan, papers.4thcltr.com, ssatcy.com: incident line. No repo code is at fault.

## Live config edits (Desk applies to `~/.ship-bot/config.json`; this session never read it)

Order matters. Make the gorfmusic edit before the new ship-bot is installed, or the bot refuses every gorfmusic PR, PR 51 included.

- gorfmusic.com row: `"setup": [{"name": "install", "command": ["npm", "ci"]}]`.
- ssatcy.com row: `"pausedIfChanged": ["deploy/"]`. An nginx conf change then merges, doesn't deploy, and blocks with a clear reason until a person installs it.
- MoonMan row: nothing needed once the ship-bot change is installed. But the next MoonMan deploy reapplies main's nginx conf. Until then the live infra runs the parent's. `"siblings": [{"dir": "gorfednet.github", "slug": "gorfednet/.github", "branch": "main"}]` makes it explicit either way.

## Separate from these causes

- Tailscale SSH check-mode hold on the docker host. Last logged at 22:12 ET, 12 Nov (MoonMan 324, denseware 33, ssatcy 42, anal0g 34 held). MoonMan 324 got past it at 22:14 ET, so it was approved then. At 09:04 ET, 13 Nov, the bot log shows GitHub API rate-limit 403s for most repos, which hide whether the hold came back.

## Known limits (reviewer read on PR 140)

- Detection is by program name: `npm`, `npx`, `pnpm`, `yarn` and `vite`, `sh -c`/`bash -c` with one of them, or `make` over a package.json with packages. `bash -lc`, `env X=1 npm`, `./deploy.sh` and `node script.mjs` aren't seen before the merge. The post-setup check catches only the `make` and node-tool ones. Any `make` setup step counts as an install.
- `preserve: ["node_modules"]` is accepted, as plan row 1.4 asked. It installs nothing in a fresh clone.
- The default rollback (redeploy the parent) can never get past site-deploy's merged-tip guard, and on MoonMan it reverted the infra first. Backlog `ship-bot-default-rollback-cannot-pass-tip-guard`.
