# Weekly lessons run (Friday 09:00 ET, cron `0 9 * * 5`, Opus)

You are a fresh session with no other context. Turn this week's incidents and owner corrections into one pull request in `gorfednet/.github` that changes the rules, briefs, skills or templates that would have prevented them. This automates the "Improve as you go" rule. Run `TZ=America/Toronto date` first and write every time in ET. This repository is public: no private names, paths under `$HOME` shown as `~`, no token or email.

## Budget and limits
- Read only this week's lines (the 7 days to today), never whole logs. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
- No `gh` loops. Check `gh api rate_limit` (free) before any bulk read. Wait on CI with `gh run watch <id> --exit-status --interval 60` in the background, never `gh pr checks --watch`.
- You never push to `main`, merge, tag or deploy. Ship-bot merges. Never change visibility or privacy anywhere.

## 1. Read (dated this week only)
- Every `docs/incidents.md`, `docs/INCIDENTS.md` or ledger line dated this week, in each fleet clone under `~/Developer/gorfednet` whose directory name is the repository's (not `wt-*`, `hx-*` or other worktrees). `git fetch -q` the clone, then `git show origin/main:<file>` and grep for this week's dates in both forms (`2026-11-14`, `14 Nov`).
- Owner corrections: `git show origin/desk-log:docs/desk/<date>.md` for each of the past 7 days. Take lines where the owner corrected, redirected or said "root cause", and Desk lines that begin "Lesson".
- Cost: the "Cost per PR, last 7 days" section of `STATUS.md` on the `status` branch (plan row 1.26), its 5 dearest PRs. If the section doesn't exist yet, say so in the digest and skip it. Never build a substitute from transcripts.
- Open leads: `git show origin/desk-log:briefs/github-replan-and-learnings.md`, section "Leads already seen". Check each lead against the live source before using it, and drop the ones already fixed.
- Before proposing anything, read the file it would change. A lesson already written there is dropped.

## 2. Rank (Fable `reviewer`, read-only)
Give the reviewer the candidate list with each evidence line, not your conclusion. It returns the top candidates ranked by: cost of the incident, chance it repeats, and whether a rule, brief, skill or template change would have stopped it. Cause before fix: a candidate with no established cause is a lead for a backlog entry, not a change.

## 3. Write (Sonnet `builder`, then Fable `editor`)
- Brief a `builder` with the ranked list and these rules. It starts with `git checkout -B weekly-lessons-<date> origin/main`, works in its own worktree, and never pushes.
- Each change names its incident (date and source line) and the exact rule, brief, skill, hook or template it alters. Rule, skill and agent files live in `~/.claude`, which isn't a repository: change the copy under `docs/claude-home/` in this PR. Don't edit `~/.claude` directly. For each such file, add a `## Next` line `- [ ] After merge, Desk copies docs/claude-home/<path> to ~/.claude/<path>` so the live copy matches what was reviewed.
- Drop any change that only restates an incident. A change must tell a future session what to do differently.
- Add no enforced check (CI step, hook, ship-bot or janitor rule) without a named defect that reached `main` or users and a watched failure from one deliberate break, shown in the PR (`shipping.md`, "Learning from an incident"). Otherwise write one dated line in the repository's incident file.
- A Fable `editor` reads every rule or brief wording change, since every session reads it. A Fable `reviewer` reads any change to what CI enforces.
- At most 5 changes, in one pull request under about 400 added lines. Run the repository's unit suite and lint.
- If nothing survives the drop rule, open no pull request and say so in the digest.

## 4. Open and report
- Open one draft PR titled `Weekly lessons <d Mon yyyy>`, mark it ready, and comment `claude review` on a line by itself. The body lists each change with its evidence and ends with `## Next`:
  - `- [ ] Merge once the gates are clean.`
- Gates: `assert-checks-started`, `review-status.mjs` clean or triaged, `check-closing-keywords`, the diff read. When they pass, add `ready-to-merge` yourself. There is no owner approval step, and the owner is never sent to GitHub.
- Add one line to the 07:00 ET digest source (the day's `docs/desk/<date>.md` on `desk-log`): `Weekly lessons: <n> changes, <short list>` or `Weekly lessons: nothing worth a change`. Say anything the owner must act on in the same line, in full.
- End the session when the PR merges.
