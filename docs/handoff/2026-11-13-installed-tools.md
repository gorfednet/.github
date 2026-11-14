# Installed tools off working checkouts (plan rows 1.18 and 1.13), 13 November 2026

PRs: gorfednet/.github#170 (this branch, `claude/amazing-antonelli-3db5da`) and gorfednet/ops#81 (`claude/tools-main-install`).

## Live on the Mac since 19:34 ET

- ops `.claude/worktrees/tools-main` is detached at origin/main. The Herdr links, the herdr-core templates and config, and the herdr-reconcile LaunchAgent all point there.
- 64 queued generated jobs were copied there, untracked. The ops main checkout was not touched.
- Capacity was reinstalled from gates-main. It had been 3 commits behind.
- herdr-reconcile passes from tools-main exit 0. The tools-main ping code got HTTP 200 from hc-ping.com.
- Until #170 merges and ship-bot is reinstalled, nothing advances tools-main. To advance it by hand, run `git -C ~/Developer/gorfednet/ops/.claude/worktrees/tools-main fetch origin` and then `checkout --detach origin/main` in the same worktree.

## What #170 adds

- `TOOL_WORKTREES`: ship-bot advances `gates-main` after .github merges and `tools-main` after ops merges. It clears an untracked file only when main adds it byte-identical.
- `ownInstallFreshness`: each pass warns when `~/.ship-bot/app` is behind the last origin/main commit that touched `ship-bot/` or `scripts/`. It notifies once per such commit (row 1.18 a).
- fleet-status row "Installed tools behind main" (`scripts/lib/installed-tools.mjs`). It went red on a deliberately stale link and read 0 after restoring.
- `install-gates.sh` and `capacity/install.sh` refuse any checkout except gates-main.
- The capacity job pings `capacity` (`/fail` when a run throws) and runs the 70%/90% usage check (row 1.13).

## Remaining, in order

1. Triage the Fable review of the ship-bot diff on #170, covering both commits 47bbde5 and 5dfe47a.
2. Comment `claude review` on #170's head. Label it `ready-to-merge` once `review-status` is clean and CI is green. Label ops 81 once its review is clean.
3. After #170 merges, reinstall ship-bot (`ship-bot/install.sh`) and capacity (`capacity/install.sh`), both from gates-main at origin/main.
4. Run row 1.13's proofs on the installed copies:
   - Stop the capacity job and watch for the healthchecks dead-man alert. It should come after about 25 min (period plus grace). Then reload the job.
   - Plant 90% usage and see the push. Copy `~/.herdr-jobs/state.json` aside, set `usage.pct` to 90, and let one capacity run fire. Restore the file and remove the 90 from `~/.desk/usage-alerts.json`. herdr-reconcile rewrites state.json every 5 min, so do this between its passes or hold it with `touch ~/.herdr-jobs/hold`.
5. Record the proofs on #170 and in `docs/heartbeats.md`.

Not covered: `~/.claude/hooks/always-pr-remind.py`, `context-handoff-nudge.py` and `~/.claude/scripts/statusline.py` have no copy in any repository.

## Lesson for plan row 1.18 (done-when)

An install validates the live config with the new code before it replaces the running copy. On refusal it leaves the running app and LaunchAgent untouched and names no patch, because a patch for a stricter validator can be refused by the running one. The 20:16 ET outage on 13 November 2026 came from swapping first.
