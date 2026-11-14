# Brief: 1.26 cost per PR

Model: Sonnet 5.5 `builder`. A Fable `reviewer` reads the diff, since its numbers will drive tier and pacing decisions. Repo: `gorfednet/.github` (public: no private names, paths under `$HOME` shown as `~`, no token or email in output).

## Objective
Show what each pull request cost in tokens, by model, so Desk and the weekly lessons pass (1.28) can see which kinds of work cost more than they are worth.

## Done when
- A script (`scripts/pr-cost.mjs`, with tests) sums `usage` from every session and subagent transcript in `~/.claude/projects/*/*.jsonl` that worked a PR's branch (match by `cwd`, worktree path and branch), split by model: input, cache read, cache write, output.
- The janitor runs it when it closes a merged or closed PR's session and appends one line to `~/.desk/pr-cost.jsonl` (local, private).
- fleet-status adds "Cost per PR, last 7 days": by repository and kind, the 5 dearest PRs, and tokens per added line. Repository names and PR numbers only.
- Tokens that match no PR are counted as unattributed, never dropped. Under 10% for the first week, or the PR says why.
- One known PR checked by hand against its transcripts, and the check written up in the PR.

## Boundaries
Read transcripts only through the script, never into chat. No API spend. `## Next` on the PR, `claude review`, label when the gates are clean.
