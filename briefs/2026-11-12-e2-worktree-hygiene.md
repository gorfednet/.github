# Brief: List, then prune, idle worktrees and loose scripts.

Model: Sonnet runner. One session, one pull request, ends when it merges. Never more than 3 sessions at once; run builder-ok before a builder.

Read lane E2. List first, prune on a second pass at least a day later.

## Steps
- List worktrees in ~/Developer/gorfednet with no commit in 14 days, merged and clean; write the list to docs/triage-2026-11-12-worktrees.md.
- On the second pass remove only those still merged and clean; never touch a dirty one.
- Move loose .log and .sh files into ops/scripts/local/.

## Done
List reviewed by main session before any removal.
