---
name: fleet-drain
description: Save uncommitted and unpushed work across the fleet's worktrees to draft pull requests, or record why it isn't worth saving. Nothing is deleted. Use when fleet-status reports dirty clones or branches with no pull request.
---

# /fleet-drain

Work runs on Sonnet. Read the diff before deciding anything about it.

## 1. Inventory

- List every clone under `~/Developer/gorfednet/` and every worktree each one has (`git worktree list`). Count them, and check every listed worktree was read.
- In each, run `git status --porcelain` and `git log --branches --not --remotes --oneline`. A command that errors is a finding, never a clean result.
- Match each folder against `list_sessions` cwds. A live session owns its worktree.
- Skip `gates-main` and `desk-log`, and anything a brief names as off limits.

## 2. Decide each one

- **Owned by a live session, or last commit within the hour.** Message that session (`SendMessage`, its `local_…` id) to commit to its branch and open a draft PR with `## Next`. Don't touch its files.
- **Real work, no owner.** Branch `drain/<worktree name>` from the worktree's current HEAD. Commit the changes untouched, on their old base. Leave out any `.env` or credentials file and say so in the PR. Push and open a draft PR. Its `## Next` says what it holds and what decides its fate.
- **Not worth saving.** Leave it in place and write one line saying why. Typical reasons:
  - only the `node_modules` symlink
  - only untracked `.claude/` local config
  - files a tool regenerates (`cap sync` paths, build output)
  - scratch scripts (`*.tmp.*`)
- **Push refused** (a pre-push gate fails, the repository is inactive). Keep the local commit and never bypass the hook. Record it as open with the failing step.

Delete nothing. Pruning drained worktrees is plan row 1.9, after their pull requests merge or close.

## 3. Record

In a fresh worktree of `gorfednet/.github`, write `docs/handoff/<today>-worktree-drain.md` with three tables:
- saved: worktree, branch, PR, what it holds
- not saved: worktree, reason
- open: what's left and who does it

Open it as a docs-only draft PR whose first `## Next` line says merge.

Done: fleet-status's dirty-clone and branch-without-PR rows read 0 on the next run. Any that remain are in the open table with a reason.
