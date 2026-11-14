# Agents and cost

Applies in every repository. Rewritten 2026-10-03 from cost-aware-plans and parallel-agent-isolation (originals in `~/.claude/rules-archive-2026-10-03/`).

## Every plan item names who does it

Use the cheapest tier that does the task properly (owner, 13 November 2026: "be cost aware with agent and model selection… dont needlesssly spend"). A cheaper tier is wrong wherever its mistake would pass unnoticed. Tag each item with its agent and model, and say the assignment out loud when starting it.

| Tier | Use for | How |
|------|---------|-----|
| Fable | the `reviewer` on every builder diff, the `editor` on anything a visitor or every session reads, security assertions, design decisions, changes to what CI enforces, ship-bot and janitor logic (what merges unattended) | `reviewer`, `editor`, or a `builder` with `model: fable` |
| Opus 5.5 | Desk, root-cause investigations, infra changes on dapyllil, backlog triage decisions: judgement with no reviewer behind it | the `desk` agent, or a session started on Opus |
| Sonnet 5.5 | builders: features, first-draft tests, refactors that need diagnosis, handoffs. Fable reviews the diff, so a slip is caught | `builder` |
| Haiku 5.5 | gate runs, reruns, git, label and archive sweeps, mechanical edits a compiler or test checks, translations | `runner` |
| Haiku 5.5, read-only | inventories and broad searches where breadth beats judgement | `scout` |
| Explore | research that needs judgement | the built-in `Explore` agent |
| Main session | push, tag, bash that gates a deploy, anything irreversible | the session itself, never a subagent |

Every session starts on Sonnet unless its brief names another model. `start_session` inherits the caller's model when none is given, so Desk passes the brief's model every time. A pull request grows past about 400 added lines only when splitting it would break a gate. A builder on its fourth review round stops and hands back rather than iterating.

## Desk is the one control session (owner, 13 November 2026)

Coordinator sessions were retired on 2026-11-11 (owner, after the four-week assessment). On 7 November three of them ran on Fable at about 250k tokens each. With 10 Fable review rounds on one 1,194-line pull request, the weekly Fable window went from 63% to 75% in 12 hours.

- Desk replaces them: one long-lived Opus session in `gorfednet.github` with Remote Control on, briefed by `docs/desk/brief.md`. The owner talks only to Desk.
- Desk owns no code work. It reads `status.json`, ship-bot's state and `list_sessions`. It labels pull requests whose `## Next` says merge and whose gates pass, archives finished sessions, and starts one session per brief in `briefs/`.
- Results come back through artefacts only: the pull request's `## Next`, `status.json`, ship-bot's ntfy. No session relays another's notes.
- Desk rotates past 150k tokens with `/desk-rotate`, and writes its log at 02:00 ET. It's never forked.
- Status comes from STATUS.md, merges from ship-bot, housekeeping from the janitor, new work from briefs in the repository.

Spawn by role where one fits: `runner` for gate runs, `builder`, `reviewer` and `editor` (`~/.claude/agents/`).

A `builder` always gets a fresh worktree made from the main checkout's HEAD, with no `node_modules`. It cannot work in another worktree, and a resumed builder has lost its worktree. So every builder brief on an existing branch opens with `git checkout -B <branch>-build <branch>` and `ln -s ../../../node_modules node_modules`, and the main session merges `<branch>-build` back (12 November 2026: two builder spawns ended with no work after a brief pointed them at the session's worktree).

Scope test runs to the changed surface while iterating and run the full gate once before the PR. Do not spend main-session tokens re-reading what a subagent summarised, but treat a subagent's factual claim as a lead, not a finding: check any claim you are about to act on against the artifact itself.

Standing automation (owner, 7 November 2026, "automate as much as possible"): ship-bot (launchd, every 2 minutes, merges labelled pull requests: `shipping.md`), fleet-status (daily, hosted on the public `.github` repository, writes `STATUS.md` to the `status` branch and a digest to ntfy `ops-report`), and fleet-janitor (daily local scheduled task: labels docs-only pull requests that pass the gates and closes out merged work as `shipping.md` describes, proposes the rest). No other cloud agents, scheduled agents or automations unless the owner asks.

## Parallel agents do not share a working tree

Two writers in one clone race over one HEAD, and git resolves it by silently stashing the loser's uncommitted work, which then looks like your own mistake.

- Every agent that writes files gets its own worktree (`isolation: worktree`, or the repository's worktree script). Read-only agents may share the clone.
- Commit a checkpoint before delegating; anything uncommitted is at risk.
- Re-read or diff after an agent finishes; do not trust a file read before delegating.
- Never `git stash` in a shared clone. If work vanished: `git stash list`, then `git reflog`.
- At most one full local gate at a time on this Mac. More than two builders may run at once only while the Mac has headroom (owner, 2026-10-16: "more than two builders when the Mac has headroom; still one local gate at a time"): check the 1-minute load average against the core count (`sysctl -n hw.ncpu`) before starting another, and hold new builders while load is above the core count.
- Read contact sheets, visual diffs and full-page screenshots in a subagent, at reduced size. An image stays in context for the rest of a session; 721 MB of PNG was read in the 30 days to 2026-10-30.
- While the Mac is loaded, run the local visual matrix with `--workers=2`: on 2026-10-21 a builder's default-worker run on a loaded Mac reported 27 false visual failures that matched on a two-worker rerun.
- A builder's handback is not done until it has run, besides the unit suite: `typecheck:test` (vitest strips types), lint, and every e2e spec it added or edited, on that spec's own project (touch specs on the touch project the repository names, if it has one: MoonMan has none and drives touch through `e2e/finger.ts`). The local gate runs none of the e2e specs; on 2026-10-09 a builder's spec edit that never loaded the app passed the gate and was caught only by the PR reviewer. Every builder brief says so.

## Herdr for long runs and the local locks (owner, 2026-11-06)

Herdr (`hc`, Herdr.app) is installed on this Mac. Setup and install: `gorfednet/ops` `hosts/gorfpael/herdr/README.md`.

- Anything slow runs in a named hc terminal: gates, `gh run watch`, captures, dev servers, device builds and scrapes. Use `hc run --bg --name <n> --cwd <repo> -- <cmd>`, then `hc wait <n>`, so it outlives the turn and the app. The command gets the login environment, so put any CI variable in the command line.
- Full local gates go through `gate-run <repo> '<command>'`. Exit 75 means another gate holds the lock: wait on it (`hc wait gate`), don't start a second.
- Run `builder-ok` before starting each builder. Exit 1 means hold.
- Start roster templates (`hc run --bg --name <n> --cwd <repo> <role> "<task>"`) only when the owner should watch or take over. Each one is a full session, so the Agent tool stays the default for delegation.
- `hc exec --on dapyllil …` for the pool host. It doesn't change the Pi-hole rule.
- Clean up what you started (`hc kill`, `hc rm`). Never stop or restart the hc core or the Herdr app.

## New task or this session (owner, 2026-10-30)

Assess every ask before starting it: is this a new task of its own? A long session is the expensive place to work, because every reply re-reads the whole conversation. Suggest a new session, with a complete brief, when the ask stands on its own, will take more than a handful of tool calls, or ends in its own pull request or repository, and whenever a session has grown long and its next work doesn't depend on what's only in that conversation. Say so at the start of the turn, in one line, before doing the work. Quick asks, corrections and work that leans on this conversation stay here. Keep shared briefs and logs in the repository, not in a scratchpad, so a new session can read them.

## Keeping chats small (owner, 2026-10-30)

On 2026-10-30 the week reached 36% in about 12.5 hours, with chats of up to 6,290 messages being woken over and over.

- Do not wake a long chat when a short one will do. Start new work as a separate chat from a brief, and send results to the pull request or a repository file instead of back to a parent. A chat with side sessions gets woken each time one finishes a turn, so a long chat starts none.
- Cap a chat at about 200,000 tokens (`get_usage` reports it). Auto-compact only starts at 97% of a 1M window, so it will not do this for you. At the cap, write a handoff into the repository and continue in a new chat.
- Never wake a chat to check CI or to say CI is green. Let merges wait and do them together in one sitting, or leave them for that chat's next run.
- Run Chrome form work in a fresh chat per 4 or 5 forms, and read pages as text, not screenshots.
- On 6 November 2026, a MoonMan planning chat started 5 side sessions and became their relay. Every note and every owner question went through a chat of over 200,000 tokens. Once the briefs are out, detach the side sessions (`detach_session`). Their questions go in the pull request's `## Next`, where Desk reads them. Then end the parent. Never start more than 3 at once: 5 sessions and their builders pushed this Mac to a load of 78 on 10 cores.
- A session started from another session gets that session's tools, and macOS permissions such as Accessibility go to the Claude Code helper, not Claude.app. Computer-use and device checks run from a session the owner opens from the sidebar.

A new chat starts at about 80,000 tokens before any work, so a quick ask stays in a chat that is already small.

## API spend: paying customers, plus US$100 a month for our own analyses (owner, 2026-10-30; changed 7 November 2026)

The Anthropic API is billed money. The account has US$200 of credit a month (owner, 7 November 2026). Paying customers' assessment runs come first. Up to US$100 a month goes to our own public analyses for heuristics.4thcltr.com (owner, 7 November 2026: "let's use 100 of that for our own analysis for our website").

- The engine (`withkeys assess run <ref>`: analyse, verify and the gate) becomes the route for public analyses and deep studies only once its output is shown to match the hand route's (owner, 7 November 2026: "we need to ensure the outputs are the same"). The test is a side-by-side on the same captures: the engine's gated report against the hand route's gated report, finding by finding (same defect, same page, same level, same counts), with every difference explained in the comparison's write-up. Until a study passes it, the hand route in `assess/docs/deep-study-brief.md` stays. After that, the engine is the route, and the brief is rewritten to say so.
- Before each API run for a public job, add up this calendar month's spend on public jobs (`costUsd` in the ledgers of `assess/jobs/*` whose job.json has `public`, from API runs only, not `--answers` estimates) and add `assess estimate <ref>`. If the total would pass US$100, stop and ask the owner.
- Everything else stays on the Max plan: pull request reviews, copy work, agents. Before any other command that calls the API for unpaid work, stop and ask.

## One session per pull request (owner, 2026-10-30)

On 2026-10-30, 36% of the weekly limit went in the first 13 hours of the week. A session starts at about 82,000 tokens, and every reply re-reads it all. These keep sessions short:

- A session ends when its pull request merges. The next pull request starts a fresh session, even when the work is related.
- A session starts from a brief of about 30 lines in the repository, plus its backlog entry. It reads only that item, never a whole plan or an earlier conversation. Use `fork` only while the parent session is still short.
- Deep studies get one session per site: capture, review, import, merge, end.
- Split or fold by what the next reply costs (owner, 2026-10-31). Every reply re-reads the session it lands in, so send work to the smallest session that can do it. A new session starts at about 80,000 tokens plus whatever it takes to rediscover the context. So fold into a session under about 120,000 tokens that holds the context, where that gap is smaller than the rediscovery. Past about 200,000, split from a brief: each reply there costs over twice a fresh session's. Never fork a long session: it copies the whole cost.
- Never spend a turn in a long session on something not ready. PR 50's session spent 3 replies at about 250,000 tokens each finding CI still running, when one background wait would have replaced them all.
- Read the part of a file you need, and let a subagent read what you only need the conclusion of. A whole-file read stays in context for every later reply.
- A plan fits on one screen. Open work goes in the repository's backlog as typed entries; finished work leaves the plan.
- No session exists to relay another's notes, because each note costs the parent a full turn. Side sessions report on their pull request, and the owner opens them from the sidebar.
- Waits run in the background. No turn is spent checking CI or a queue.
- Wait on CI with `gh run watch <id> --interval 60 --exit-status` (its default polls every 3 seconds), never `gh pr checks --watch` or a tight `gh api` loop (13 November 2026). Every session's `gh` and the dapyllil pool's queue reads share the owner's 5,000-an-hour GitHub limit. That morning the limit hit 0 twice in an hour, and the pool started no runners until it reset. Check `gh api rate_limit` (free) before any bulk read.
