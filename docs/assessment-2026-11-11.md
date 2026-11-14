# Assessment: 4 weeks on Claude Code (16 Oct to 11 Nov 2026) and the plan to make it run itself

## Context

You asked why you are still stopped for manual steps (merges, labels, branch deletion, GitHub chores) when the rules say the system should handle them, and how to give Claude more autonomous control, centralize your point of contact, fit Herdr in, and arrange agents in an "object oriented" way. Evidence: `~/.claude` settings and hooks, 345 session permission records, 156 transcripts since 8 Nov, ship-bot logs (1,801 runs), the janitor's 3 runs, Herdr's job registry, STATUS.md, the GitHub PR record since 15 Oct, and Anthropic's current docs and best-practice pages.

## What the evidence says

### 1. The stops have one root cause: auto mode's classifier, with nothing telling it what you already decided

- 321 of 345 sessions ran in `auto` mode. `~/.claude/settings.json` has 12 allow entries, none for `gh`, `git`, `node` or `hc`. No deny list, no `defaultMode`, no `PreToolUse` or `PermissionRequest` hook.
- So every merge, label, close, ready, push and comment goes to the classifier. Since 8 Nov it refused 14 "External System Writes", 11 "dangerous" (no reason), 7 "classifier unavailable", 5 "Self-Modification", 4 "Production Deploy", plus 2 each of 5 other classes. Blocked commands include `gh pr merge` (4 repos), `gh pr edit --add-label ready-to-merge` (twice), `gh pr ready`, `gh pr close` (3 repos), `git push --force-with-lease`, `git pull --ff-only`.
- Anthropic's docs say auto mode blocks "merging a pull request no human has approved" by default, and that allow rules resolve before the classifier. The fix is a rule, and the docs say so: "make must-always rules hooks, deny rules, or managed settings, not CLAUDE.md".
- `shipping.md:10` then turns every refusal into a hand-back: "If a permission prompt refuses a merge, tell the owner which one and why, then carry on." That sentence is why you see "ready for you to merge" in Fleet coordinator 6, Release loop 2, deep-3 and others, after you said on 31 Oct in 4 separate sessions to stop asking.
- Unattended runs make it worse: "the permission prompt timed out… the command was NOT run" appears in 4 sessions. A scheduled task that hits a prompt stalls until you open it.
- Per-repo `settings.local.json` files grew one click at a time (4thcltr 145 entries, many with stale paths; MoonMan 46; ai-use-levels 38). That is the allowlist you wanted, scattered and uncommitted.

### 2. The automation exists but is switched off where you work

- **Ship-bot** is live in 5 repos (.github, assess, career-portfolio, heuristics, papers). It is watch-only in 4thcltr, BinderCurve, MoonMan, gorfed.net and every site, and off in ops. 7 live merges since 8 Nov, none in a product repo. It hit GitHub's rate limit on 10 Nov (403 on 3 repos). It never deletes branches.
- **Drafts never move.** 13 draft PRs in .github carry `## Next: Main session: merge`, and ship-bot ignores drafts. Nothing marks a draft ready, so "main session" means you opening a chat.
- **The janitor is stuck in rehearsal.** 3 runs, each 49 minutes, all "succeeded", but `~/.fleet-janitor/` was never created, so its run counter is at 0 and it stays in propose-only forever. It has labelled, pruned and archived nothing.
- **Herdr** has 69 jobs: 0 running, 56 queued, 14 parked, 7 paused. 12 of the 14 parked are waiting on a folder-trust dialog (heuristics 8, rowanmcarthur 2, TowIt 2). `herdr-reconcile` has run 737 times and logged "nothing to do" with 56 jobs queued; that is a stall to diagnose, not a quiet queue. `hc wait` cannot see a Claude turn end on Claude Code 2.1.299, so role templates half-work.
- **The reviewer runs hosted** (`claude-review.yml` on `ubuntu-latest`), against the runner rule.
- **Two items are genuinely yours** and have been for days: the `FLEET_READ_TOKEN` fine-grained PAT (.github #99, #111), and the trust dialogs above.

### 3. Coordination is done by expensive chats pretending to be a manager

- 200 sessions in the last 12 days (31 Oct to 11 Nov), 93 of them started by another session, 21 titled coordinator or release loop. Fleet coordinators 3, 4, 5, 6, Release loop 1 and 2 all ran on Fable. The rule says coordinators run on Sonnet; nothing enforces it, because the model comes from the picker.
- The weekly limit is at 81% with 1 day 20 hours left (Fable 78%). Herdr holds at 90%, so the queue will stop before the week resets.
- Every new session starts at about 100k tokens before work: 34k system tools, 27k MCP tool schemas, 13k system prompt, 11k memory, 6k skills. Every reply in every session re-reads that. The figma-desktop MCP server fails to connect in every session and still costs its schema.
- `prompt_suggestions` is on: one extra model request after every reply, in every session.

### 4. The GitHub record says the merges are not the problem; three other chores are

- 855 PRs since 15 Oct, 766 merged (90%), median 2.7 hours open to merge, p90 43 hours. In a sample of 40 recent merges, the session merged and said so in about 30, and asked you in 0. Across all 766, about 4 asked you to approve (career-portfolio skills approval, by design) and about 15 said "main session: merge" in `## Next`. So the hand-backs you feel are in chats (section 1), plus:
- **Hand-triggered reviews.** `claude-review.yml` reviews once on open or ready, then only on a `claude review` comment. 712 such comments on 430 of 855 PRs (50%); BinderCurve 88%. Every one is a session or you asking for a re-review by hand.
- **Branches.** `delete_branch_on_merge` is off in 9 repos (heuristics, ops, papers, assess, career-portfolio, ai-use-levels, ask-collector, intake, propose, broadcast): about 340 stale branches, growing one per merge. The 15 repos with it on have left 0 since the switch; their 530 stale branches are Cursor-era leftovers.
- **Dependabot.** Median 7 days to merge against 2.7 hours for everything else; 3 open now at 4 to 10 days, 2 red, each with an 8 Nov triage comment and nothing since.
- **Drafts.** 45 open PRs, 37 drafts, 30 of them backlog PRs opened 9 and 10 Nov with no review (drafts are not reviewed) and no `## Next` except one.
- **Size.** 35% of PRs added over 400 lines (the rule's ceiling), 181 over 1,000; BinderCurve's median is 722.
- **Protection.** heuristics, assess, ops, papers, career-portfolio and the small repos have no required checks on main. `allow_auto_merge` is off everywhere, which matches your rule.
- Main is green: 8 failures in about 470 recent main runs, all monitors or healthchecks.
- Weekly PR volume: 111, 313, 261, 86, 84 for weeks 42 to 46. The fall from week 44 is the limit and the coordinator cost, not less work to do.

### 5. What is working

- The rule set is unusually good: verification floor, shipping gates, cost tiers, voice. Anthropic's own best-practice page recommends most of it (auto mode, short CLAUDE.md, evidence not "tests pass", subagents for investigation, worktrees for parallel work).
- Ship-bot, fleet-status, STATUS.md, ntfy `ops-report`, the Herdr job registry and `gate-run` are the right shape. They are under-wired, not wrong.
- The reviewer workflow, `review-status.mjs`, `assert-checks-started` and `check-closing-keywords` are real gates with incidents behind them.

## Answers to your questions

**What you are doing that is suboptimal.** Approving one prompt at a time instead of writing the rule once. Opening coordinator chats to do what a cron job should. Letting the picker choose Fable for coordinators. Leaving drafts for a "main session" that is you. Reading STATUS.md through sessions instead of a push.

**What you are not doing.** Granting standing permissions in `~/.claude/settings.json`. Running ship-bot live in your priority repos. Turning on the Claude GitHub App's auto-fix on PRs (it subscribes to CI failures and review comments and pushes fixes, no prompt involved). Archiving the 3 inactive repos on GitHub so they stop generating dependabot red, fleet rows and Herdr jobs. Doing the 2 owner-only items (PAT, trust).

**How to make it fit, heal and iterate itself.** Put every must-rule in code: a `PreToolUse` hook that runs the three gate scripts and allows or denies `gh pr merge` itself, a deny list for the destructive commands, a Stop hook or `/goal` that refuses to end a shipping session before its PR is labelled. Then the prose rules describe the hooks, not the other way round. Incidents change the hook, and the hook changes every session at once.

**How to give Claude more autonomous control, safely.** `defaultMode: auto` at user level plus narrow allows for the GitHub and git verbs the rules already permit, denies for force-push, hard reset and repo deletion. Keep merges behind the gate hook, not behind you. Unattended work runs `claude -p --permission-mode auto --permission-prompts none --allowedTools …` or a cloud scheduled task, never a desktop task that can stall on a prompt.

**One point of contact, token-cheap.** One pinned "Desk" session on Sonnet, Remote Control on, with the Telegram channel plugin so you can type "ship X" from your phone. It owns no work: it reads STATUS.md and the Herdr registry, starts detached sessions from briefs, and answers in a few lines. Children never report to it (detached), they report to ntfy `ops-report` and their PR. You already run ntfy; inbound push to your phone is one `Notification` hook away. One remote session: no, because your filesystem, Herdr and runners are on this Mac. Remote Control on the Desk session gives you the phone view of the same thing.

**Herdr.** You never drive Herdr for routine work. It is the agents' substrate: locks, long runs, the job registry, the pool host. You touch it for three things: a one-time trust accept per folder, `hc ls` or STATE.md when you want to see load, and `hc kill` on a runaway. Everything else goes through the Desk session or ship-bot labels. The current stall (56 queued, 0 running, "nothing to do") is a bug for a session to fix, not a reason to drive it by hand.

**Object-oriented agents.** Model the fleet as objects with state and methods, not as roles copied from an agency:

| Object | State | Methods (who owns them) |
|---|---|---|
| PullRequest | draft, reviewed, ready, merged, deployed | review (reviewer workflow), ready+label (the session, via allow rule), merge (ship-bot), fix (auto-fix), deploy (deploy workflow) |
| Repo | kit tier, runner var, `make gate / deploy / smoke` targets | same method names in every repo, so any agent calls them without reading the repo |
| Job | backlog entry → Herdr job → session → PR | dispatcher creates, reconcile runs, janitor closes |
| Policy | allow, deny, gate hook, Stop hook | changed by PR in `.github`, applied to every session |
| Owner | inbox: ntfy + Desk | decides only what the rules reserve |

Encapsulation: policy lives in hooks and settings, not in each session's memory. Inheritance: `.github` workflows and the verification kit are the base class; a repo overrides with variables. Polymorphism: `make deploy` means deploy everywhere. Events, not meetings: GitHub events trigger review and auto-fix, labels trigger merges, a schedule triggers the dispatcher. The coordinator role is deleted.

**What Anthropic's teams do that you should adopt.** Start in auto mode. Keep CLAUDE.md under 200 lines and path-scope the rest. Give Claude a way to check its own work and refuse to stop without evidence (`/goal`, Stop hooks). Use `/autofix-pr` so CI and review comments fix themselves. Use `claude -w` or `/batch` for parallel worktrees, subagents for investigation and review. Use `/clear` between tasks. Cloud scheduled tasks for anything that does not need the Mac. Claude Tag and Slack are Team and Enterprise only, so Channels (Telegram) is the phone path on Ultra.

**Tools and plugins worth adding.** `ralph-loop` (autonomous loop with a completion check), `commit-commands`, the Telegram channel plugin, `/goal`, `/autofix-pr` (needs the Claude GitHub App on each repo), `/fewer-permission-prompts` to seed the allowlist from your own transcripts, `/skill-doctor` to measure skill context cost. Not needed: Claude Tag, Managed Agents, a second review bot.

**Things you may not be thinking about.**
- 49 lapsed backlog items and 4 dependabot-red repos are noise the janitor should clear weekly (group dependabot, auto-label green patch bumps).
- 70 loose worktree folders and stray scripts in `~/Developer/gorfednet`, 7.3 GB of session files: janitor work once it is live.
- The reviewer on hosted runners is spending the $50 ceiling you set.
- Memory: 11k tokens of memory load in every session; run `/consolidate-memory` monthly.
- Inactive repos (TowIt, towit.io, wychwoodresort.com, whywa.it): archive on GitHub, drop their Herdr jobs and janitor rows, keep the clones.

## The plan (in priority order; tier per `agents-and-cost.md`)

### Phase A: stop the stops (today, main session, one PR to `gorfednet/.github` plus the user-level settings file)

1. **User-level permissions** in `~/.claude/settings.json` (main session; not a repo file, so written directly and copied into `.github/docs/claude-settings.md` for the record):
   - `permissions.defaultMode: "auto"`.
   - allow: `Bash(gh pr view *)`, `Bash(gh pr checks *)`, `Bash(gh pr list *)`, `Bash(gh pr ready *)`, `Bash(gh pr edit *)`, `Bash(gh pr comment *)`, `Bash(gh pr close *)`, `Bash(gh pr merge *)`, `Bash(gh run *)`, `Bash(gh api *)`, `Bash(gh label *)`, `Bash(git push *)`, `Bash(git fetch *)`, `Bash(git pull *)`, `Bash(git worktree *)`, `Bash(git branch *)`, `Bash(hc *)`, `Bash(gate-run *)`, `Bash(builder-ok *)`, `Bash(node scripts/*)`, `Bash(npm run *)`, `Bash(make *)`, `Bash(mkdir -p ~/.fleet-janitor*)`, the `ccd_session_mgmt` and `scheduled-tasks` tools.
   - deny: `Bash(git push --force *)`, `Bash(git push -f *)`, `Bash(git reset --hard *)`, `Bash(git clean -fd*)`, `Bash(gh repo delete *)`, `Bash(gh api -X DELETE *)`, `Bash(rm -rf /*)`.
   - Write the allow in the space form the docs show (`Bash(cmd *)`), not the colon form.
2. **Decision taken (owner, 11 Nov): sessions never merge; ship-bot is the only merger.** So `Bash(gh pr merge *)` goes in `deny`, not `allow`. The gate stays a hook, but on the label: `.github/hooks/label-gate.mjs` as `PreToolUse` on Bash matching `gh pr edit * --add-label ready-to-merge` runs `assert-checks-started`, `review-status.mjs` (must be `clean` or triaged on the PR), `check-closing-keywords`, checks no `hold` and a `## Next` section exists; returns `allow` or `deny` with the reason. Watch it fail once on a PR with findings and say so on the PR (verification rule 4). The 4 one-time deploy and release flows that merge on `main` by design (BinderCurve `/ship`, store builds) keep their own documented exception.
3. **Rule edits** (main session, `~/.claude/rules/shipping.md`, `agents-and-cost.md`): "the main session merges" becomes "the session labels; ship-bot merges"; delete "If a permission prompt refuses a merge, tell the owner which one and why"; add "no session reports a merge or a label as the owner's"; add "coordinator sessions do not exist: the Desk session, ship-bot, janitor and dispatcher do that work"; add "sessions start on Sonnet unless the brief says Fable".
4. **Ship-bot live everywhere active** (main session, `~/.ship-bot/config.json` plus `ship-bot/README.md`): live in 4thcltr, gorfed.net, MoonMan (merge-only; deploys stay with their workflows), BinderCurve (merge-only, respecting its three-browser gate), all site repos; off for TowIt, wychwood, ACID2REAPER. Add `delete_branch_on_merge` via `protect-branches.sh` to every active repo and record which. Add conditional requests or an app token to stop the 403s. Add a "draft with `## Next` saying merge and all gates green" rule: ship-bot comments once and marks ready, then merges on the next pass.
5. **Janitor unblocked** (runner): make the run counter a file in the repo-adjacent `~/.fleet-janitor` the allowlist now permits, or move it to `.github/janitor/runs.log` on the `status` branch; verify run 4 leaves propose-only; then enable its prune and archive phases.
6. **Owner-only, in chat with the exact command**: create the `FLEET_READ_TOKEN` PAT and add it as a secret; accept trust in the 12 parked folders (or approve a session editing `~/.claude.json` `hasTrustDialogAccepted` for the listed paths).

### Phase B: one point of contact (this week)

7. **Desk session** (main session creates; runs on Sonnet): pinned, Remote Control on, titled "Desk", opened from the Claude mobile app when away. Decision taken (owner, 11 Nov): Remote Control plus ntfy, no Telegram. Its brief: read STATUS.md and `~/.herdr-jobs/STATE.md`, answer status in the owner's report format, start detached sessions from briefs, never do the work itself, never be woken by children. Its brief lives at `.github/docs/desk-brief.md` so it can be restarted when it grows past 150k tokens.
8. **Outbound pushes** (runner): a `Notification` hook that posts `permission_prompt` and `idle_prompt` events to ntfy `ops-report` with the session title; fleet-status digest already posts there. Turn `prompt_suggestions` off. Set `inputNeededNotifEnabled` so the mobile app also gets it.
9. **Model defaults** (main session): Code tab default model Sonnet; Fable only for `reviewer`, `editor`, security assertions and ship-bot changes. Scheduled tasks and `claude -p` jobs name their model.

### Phase C: self-healing loops (next week)

9a. **Review re-runs itself** (main session, `.github/workflows/claude-review.yml` in the shared kit): also run on `synchronize` for non-draft PRs when the push touched code paths and is not a clean merge of main (compare the merge-base, skip when the diff against the previous head is empty after excluding derived files). Keeps the Max-plan budget by skipping doc-only and merge-only pushes. Removes the 712 hand comments.
9b. **Repo settings in one script** (runner, `ship-bot/protect-branches.sh`): `delete_branch_on_merge` on in the 9 repos; required checks on main for heuristics, assess, ops, papers, career-portfolio; record the result per repo in `docs/`. Then one janitor pass deletes the 870 stale branches whose PR is merged or closed (list first, delete in a second pass after a day).
9c. **Dependabot lane** (runner): group updates weekly; ship-bot labels a green Dependabot patch or minor bump `ready-to-merge` itself; red ones get one auto-fix attempt, then close with a comment and a backlog entry.
10. **Auto-fix on PRs** (main session): install the Claude GitHub App on the 6 priority repos and turn on auto-fix per PR from the session that opens it; keep the self-hosted `claude-review.yml` as the gate; move its `runs-on` to `${{ vars.HEAVY_RUNS_ON }}`.
11. **Dispatcher** (builder, Sonnet): a Herdr job every 2 hours that reads `backlog.json` across repos and STATUS.md, picks the top item by the priority order, checks `builder-ok` and usage, and starts one `claude -p` session from the item's brief with `--permission-mode auto --permission-prompts none --max-budget-usd`. Never more than 2 at once. This replaces coordinator chats.
12. **Herdr stall** (builder, Sonnet, ops repo): why reconcile says "nothing to do" with 56 queued; fix the `hc wait` turn-end gap or route Claude jobs through `claude -p` so the job ends when the process ends.
13. **Stop hook / `/goal` for shipping sessions** (runner): a Stop hook that blocks ending a session whose PR exists, is not draft, is green and clean, and is not yet labelled; reason text names the label.

### Phase D: hygiene (janitor, once live)

14. Decision taken (owner, 11 Nov): archive TowIt, towit.io, wychwood, WhyWait on GitHub (`gh repo archive`, reversible); remove their Herdr jobs (2 parked TowIt jobs), ship-bot and fleet-status rows; keep local clones. Moves to Phase A as item 6a since it needs no other change.
15. Dependabot: weekly grouping, auto-label green patch and minor bumps `ready-to-merge`.
16. Lapsed backlog: weekly digest proposing close or keep for each of the 49; the owner answers in the Desk session with one word per item.
17. Session startup cost: remove the failing figma-desktop MCP server from the default set; load Google Docs only in sessions that need it; `/consolidate-memory`.
18. Worktree and file cleanup under `~/Developer/gorfednet`; 7.3 GB of session files older than 30 days.

## Verification

- Phase A: open a draft PR with a deliberate finding, let the reviewer run, label it; confirm the gate hook denies `gh pr merge` with the finding as the reason; fix, re-review, confirm allow; confirm ship-bot merges it and the branch is deleted; confirm no session message says "ready for you to merge" for 48 hours (grep transcripts).
- Janitor: run 4's digest shows labels or prunes applied, and `~/.fleet-janitor/runs` has 4 lines.
- Desk: a message from the phone through Telegram starts a session and the reply arrives in under 2 minutes; a permission prompt in any session produces an ntfy push.
- Herdr: queued count falls below 56 within one reconcile cycle after the fix.
- Cost: weekly usage growth per day, read from `get_usage`, after a week of Sonnet defaults; target under half the current rate.

## What stays yours

The PAT, the trust dialogs, store submissions, DNS and billing, and anything the rules reserve. Everything else in this plan is a session's job.

## Appendix: GitHub record since 15 Oct, per repo

PRs / merged / open(drafts) / median hours to merge / median added lines / auto-delete / stale branches / hand `claude review` comments:

| repo | PRs | M | O(d) | p50 h | add p50 | autoDel | stale | cr-man |
|---|---|---|---|---|---|---|---|---|
| bindercurve.com | 164 | 144 | 2(0) | 17.3 | 722 | on | 263 | 145 |
| 4thcltr.com | 104 | 90 | 9(9) | 4.8 | 174 | on | 53 | 43 |
| heuristics.4thcltr | 84 | 76 | 3(3) | 0.2 | 208 | off | 79 | 31 |
| assess | 73 | 70 | 1(1) | 2.8 | 190 | off | 72 | 24 |
| ops | 61 | 61 | 0 | 0.1 | 95 | off | 52 | 34 |
| .github | 60 | 46 | 14(13) | 0.4 | 60 | on | 8 | 19 |
| gorfed.net | 51 | 49 | 1(1) | 1.3 | 34 | on | 13 | 19 |
| MoonMan | 46 | 44 | 1(1) | 7.4 | 389 | on | 182 | 23 |
| career-portfolio | 36 | 34 | 1(1) | 0.5 | 125 | off | 49 | 14 |
| papers.4thcltr | 30 | 27 | 3(3) | 0.2 | 41 | off | 27 | 4 |
| promptboi.com | 22 | 18 | 2(1) | 27.4 | 27 | on | 21 | 16 |
| ssatcy.com | 18 | 10 | 6(5) | 2.4 | 82 | on | 2 | 12 |
| 7 small sites | 72 | 66 | 1(1) | 1 to 3 | 27 to 64 | on | 17 | 45 |
| ai-use-levels, propose, ask-collector, intake, broadcast | 32 | 29 | 1(0) | 0 to 0.5 | 37 to 18,580 | off | 34 | 1 |

Inactive: TowIt (last push 30 Sep), wychwood (14 Sep), WhyWait / whywa.it (22 Mar). None archived on GitHub yet.
