# Brief: Turn must-rules into hooks, each shown failing once.

Model: Fable (changes what merges unattended). One session, one pull request, ends when it merges. Never more than 3 sessions at once; run builder-ok before a builder.

Read lane A4 and 11 Nov assessment item 2 (label-gate hook, not yet landed).

## Steps
- Start with .github/hooks/label-gate.mjs: PreToolUse on gh pr edit --add-label ready-to-merge runs assert-checks-started, review-status, check-closing-keywords, no hold, ## Next present.
- Then: claude review only on its own line, no .skip without a backlog id, builder brief must contain git checkout -B and builder-ok.
- Use hookify on transcripts for candidates; every hook a PR with its deliberate failing run and a near-miss negative case.
- Update shipping.md to describe the hooks, not ask sessions to remember.

## Done
Hooks live; prose rules point at them.
