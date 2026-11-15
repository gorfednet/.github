# Weekly lessons run (Friday 09:00 ET, cron `0 9 * * 5`, Opus)

You are a fresh session with no other context. Turn this week's incidents and owner corrections into one pull request in `gorfednet/.github` that changes the rules, briefs, skills or templates that would have prevented them. This automates the "Improve as you go" rule. Run `TZ=America/Toronto date` first and write every time in ET. This repository is public: no private names, paths under `$HOME` shown as `~`, no token or email.

## Budget and limits
- Read only this week's lines (the 7 days to today), never whole logs. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
- No `gh` loops. Check `gh api rate_limit` (free) before any bulk read. Wait on CI with `gh run watch <id> --exit-status --interval 60` in the background, never `gh pr checks --watch`.
- You never push to `main`, merge, tag or deploy. Ship-bot merges. Never change visibility or privacy anywhere.

## 1. Read (dated this week only)
- Every `docs/incidents.md`, `docs/INCIDENTS.md` or ledger line dated this week, in each fleet clone under `~/Developer/gorfednet` whose directory name is the repository's (not `wt-*`, `hx-*` or other worktrees). `git fetch -q` the clone, then `git show origin/main:<file>` and grep for each of the 7 days to today from `TZ=America/Toronto date`, in both forms (`yyyy-mm-dd` and `d Mon`, for example `2026-11-20` and `20 Nov`).
- Owner corrections: `git show origin/desk-log:docs/desk/<date>.md` for each of the past 7 days. Take lines where the owner corrected, redirected or said "root cause", and Desk lines that begin "Lesson".
- Cost: the "Cost per PR, last 7 days" section of `STATUS.md` on the `status` branch (plan row 1.26), its 5 dearest PRs. If the section doesn't exist yet, say so in the digest and skip it. Never build a substitute from transcripts.
- Open leads: `git show origin/desk-log:briefs/github-replan-and-learnings.md`, section "Leads already seen". Check each lead against the live source before using it, and drop the ones already fixed.
- Before proposing anything, read the file it would change. A lesson already written there is dropped.

## 2. Rank (Fable `reviewer`, read-only)
Give the reviewer the candidate list with each evidence line, not your conclusion. It returns the top candidates ranked by: cost of the incident, chance it repeats, and whether a rule, brief, skill or template change would have stopped it. Cause before fix: a candidate with no established cause is a lead for a backlog entry, not a change. A Currency item (step 2a) is ranked on its evidence (file and line, or version strings) in place of an incident line.

## 2a. Currency (plan row 1.29, read-only, proposals only; run before Rank and Write)
Run these three checks each week. Download, install and adopt nothing. Anything a lookup can't verify is written "unverified", never guessed.
- Local models. For each family in `docs/models.json` (and the llama.app version against `/Applications/Llama.app`), look for a new or updated GGUF that fits this Mac's memory: file size plus the 4 GB reserve in `scripts/local-llm/route.mjs` under the free memory. If `models.json` has no rows, list the tasks that have no model instead. A candidate is a proposal only. It must pass the `scripts/local-llm/evalset*.mjs` set (`docs/eval-set/README.md`) before any routing or `models.json` row. Until plan row 1.27b lands, only a PASS on the builder task counts. Snapshot shas stay pinned, so "latest" means the latest that passes.
- Claude models. Compare the roster in `docs/claude-home/agents/` (`model:` lines) and the tier table in `docs/claude-home/rules/agents-and-cost.md` with the model list your own session shows. Propose a row change where a newer model replaces one named.
- Skills and plugins. Run `SearchPlugins` for copy, review, release and CI triage. Check Anthropic's skills for the same. Then diff each `~/.claude/skills/<name>` and `~/.claude/agents/<name>.md` against `docs/claude-home/` on `origin/main`. Report any installed file with no copy on main, or any that differs. Never edit `~/.claude`.
- Proposals go in the weekly-lessons PR as a "Currency" list, each with its evidence (file and line, or version strings). A model change cites its eval score. A skill or plugin adoption gets its own PR, never this one. A stale item that is a real fix goes in as one of the 5 changes. The rest become `- [ ] Later:` lines in `## Next`.
- Add one clause to the digest line: `Currency: <n> stale, <n> proposed`.
- Feed any stale item that is a real fix into the Rank list. The rest go to the Write step as the Currency list.
- Put the Currency list together here, one line per item with its evidence, but write no file: this step is read-only, and a file written here lands in the main checkout, not the builder's worktree. The step 3 builder writes it to `docs/desk/currency/<yyyy-mm-dd>.md` in its own worktree and commits it, so a Currency-only week still has a commit to open the PR from. It creates the file, and the folder with it, only in a week that has items. The PR body summarises it.

## 3. Write (Sonnet `builder`, then Fable `editor`)
- Brief a `builder` with the ranked list, the Currency list and these rules. This covers a Currency-only week too: the builder still creates the branch and writes the list. It starts with `git checkout -B weekly-lessons-<date> origin/main`, works in its own worktree, and never pushes.
- Each change names its incident (date and source line). A change that fixes a stale Currency item names that item's evidence (file and line, or version strings from step 2a) instead. Each change also names the exact rule, brief, skill, hook or template it alters. Rule, skill and agent files live in `~/.claude`, which isn't a repository: change the copy under `docs/claude-home/` in this PR. Don't edit `~/.claude` directly. For each such file, add a `## Next` line `- [ ] After merge, Desk copies docs/claude-home/<path> to ~/.claude/<path>` so the live copy matches what was reviewed. Desk's brief (Each pass, step 2) does that copy when ship-bot reports the merge.
- Drop any change that only restates an incident. A change must tell a future session what to do differently.
- Add no enforced check (CI step, hook, ship-bot or janitor rule) without a named defect that reached `main` or users and a watched failure from one deliberate break, shown in the PR (`shipping.md`, "Learning from an incident"). Otherwise write one dated line in the repository's incident file.
- A Fable `editor` reads every rule or brief wording change, since every session reads it. A Fable `reviewer` reads any change to what CI enforces.
- At most 5 changes, in one pull request under about 400 added lines. Run the repository's unit suite and lint.
- If nothing survives the drop rule and there are no Currency items, open no pull request and say so in the digest. A week with Currency proposals but no lessons still opens the PR, titled the same, with only the Currency list.

## 4. Open and report
- Open one draft PR titled `Weekly lessons <d Mon yyyy>` and mark it ready. Marking it ready starts the Claude review, so don't also comment `claude review`. Comment it only after a later push that changes code or wording. The body lists each change with its evidence and ends with `## Next`:
  - `- [ ] Merge once the gates are clean.`
- Gates: `assert-checks-started`, `review-status.mjs` clean or triaged, `check-closing-keywords`, the diff read. If the diff touches a control-plane path (`touchesControlPlane` in `ship-bot/lib/drafts.mjs`: for example any `CLAUDE.md`, `REVIEW.md`, `SKILL.md`, `scripts/` or any path under `docs/claude-home/`: settings, hooks, agents and rules), labelling also needs a Fable `reviewer` read of the whole diff and a `clean` review, with no findings merely triaged. When they pass, add `ready-to-merge` yourself. There is no owner approval step, and the owner is never sent to GitHub.
- Add one line to the 07:00 ET digest source (the day's `docs/desk/<date>.md` on `desk-log`): `Weekly lessons: <n> changes, <short list>` or `Weekly lessons: nothing worth a change`. Say anything the owner must act on in the same line, in full.
- End the session when the PR merges.
