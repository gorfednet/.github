# Brief: gate scripts on PATH (plan row 1.7)

Model: Haiku `runner` for the edit, Desk reviews and opens the PR. Why: mechanical, checked by `which` and one run.
Folder: `~/Developer/gorfednet/gorfednet.github`, own worktree.

## Objective
`assert-checks-started`, `review-status` and `check-closing-keywords` are not on PATH, so every session runs them by path and forgets `GITHUB_REPOSITORY`. Add an `install-gates.sh` (or extend the existing install step) that symlinks thin wrappers into `~/.local/bin`. Each wrapper derives `GITHUB_REPOSITORY` from the cwd's `origin` remote when unset, and `GH_TOKEN` from `gh auth token` when unset.

## Done when
- `which assert-checks-started review-status check-closing-keywords` finds all three in a fresh shell.
- `check-closing-keywords --pr <n>` run from a MoonMan clone reports `gorfednet/MoonMan`.
- A test script asserts the derivation (fails when the remote is missing).
- PR with `## Next`.
