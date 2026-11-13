# claude-home hooks

Record copies of the hooks in `~/.claude/hooks/`. The live files are there.

## gh-poll-guard.py (plan row 5.10)

A `PreToolUse` hook on Bash. It refuses a command that loops `gh` or `review-status.mjs` with `sleep`, and any `while`/`until` busy-wait (`do :; done`). The refusal tells the session to start one `gh run watch <id> --interval 60 --exit-status` with `run_in_background`.

- Why: on 13 November 2026 three session loops polled `gh` while the 5,000-an-hour quota sat at 0, and one busy-wait spun a core for 3.5 hours.
- Settings entry: `gh-poll-guard.settings.json`, merged into the `hooks` block of `~/.claude/settings.json`.
- Tests: `test/ghPollGuard.test.mjs`, run by the verification-kit workflow. The 3 real commands are in `test/fixtures/gh-poll-guard/`.
- It fails open. Bad input or an internal error lets the command run.

Install (the owner, after this merges):

1. Copy `gh-poll-guard.py` to `~/.claude/hooks/`.
2. Add the `PreToolUse` entry to `~/.claude/settings.json`.
