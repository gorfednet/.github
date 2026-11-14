# Working rules for every project

Times: give every time to the owner in Toronto local time (owner, 2026-10-19), never UTC, labelled ET. Convert with the system time-zone database (`TZ=America/Toronto date -d …`, or `date -j` / Intl with `America/Toronto`), never a hard-coded offset: Ontario may drop the daylight-time switch, and the database follows the law. Commit messages, PR bodies and logs may stay in UTC.

Improve as you go (owner, 2026-10-31: "we need to self improve all processes over time when we see opportunity"): when a session spots a better way or gets corrected, it changes the skill, brief, rule or template that runs next time, in that session, and says so in one line. New enforced checks still follow `shipping.md`.

Take it to completion (owner, 2026-10-31: "when I ask for somehting to be done take it to completion and work with other agents to coordinate"): an ask ends with the work finished, merged and reported, not with a question or a hand-back. Decide what can be decided, wait for what must be waited for in the background, and coordinate directly with other sessions and agents (check the session list, message the one that holds the context, agree who labels what) rather than relaying through the owner. Stop only for what the rules reserve to the owner. Do it efficiently, and arrange the sessions yourself (owner, 2026-10-31): split work into a new session from a brief when it stands alone or a chat has grown long, fold work into the session that already holds the context when a new one would have to rediscover it, and do either without being asked. `agents-and-cost.md` has the limits.

Reports to the owner (owner, 2026-10-31: "I just need statuses and to know when milestones ETA and done are", "and what's outstanding"): say the status, what's outstanding, the next milestone with its ETA in ET, and when it's done. A few lines at most. No gate tables, no explanation of how, no lists of what changed; those go on the pull request. Add detail only for something the owner has to act on, or when asked.

Commands only when they are ready to run (owner, 11 November 2026: "stop giving me commands until its time to run them i can't keep up"): never put a command, a "run this later" or a "once X is green, run Y" in a message to the owner. Say "nothing for you yet" and keep waiting. Give a command only when every gate has passed and running it is his next step, one at a time, in its own code block. Runbooks that must exist for later go in the repository, not in chat, until their moment. This qualifies the rule below: "in full in the chat" applies at that moment, not before. A command for another host carries its own hop (`ssh -t dapyllil "…"`), so it runs in whatever terminal he pastes it into (11 November 2026: a dapyllil sudo command went to his Mac). Applies to every session (owner, 13 November 2026: "all chats"). A session that Desk started puts no command in its report to Desk, only the status and what is outstanding in words. Desk gives him each command, through Remote Control, at the moment it is his next step (13 November 2026: the ops sweep's report listed the host commands before the pull request had merged).

Never send the owner to GitHub (owner, 11 November 2026: "i never want to have to go look at github"): GitHub is the record, not his inbox. Anything he must read, decide or run goes in the chat message itself, in full: the command in its own code block, the exact name or value, what it does and what to expect. Never write "see the PR body", "details on the PR" or "the runbook is in the PR" as the way he learns what to do; put the content in the chat and keep the PR copy for the record. When a session writes a runbook or `## Next` for him, it also puts the same steps in its final message.

Priority order (owner, 9 November 2026: "infra first, then 4thcltr, then gorfed, resumes then moonman, then bindercurve"): 1 infrastructure and the token-free automation (ship-bot, STATUS.md, janitor, pool, ops), 2 4thcltr.com with its subdomains (heuristics, papers, brief, intake, propose), 3 gorfed.net, 4 the resume and job engine, 5 MoonMan, 6 BinderCurve. When builders or the weekly limit compete, the lower number wins and BinderCurve waits.

Fleet status and handoffs (owner, 7 November 2026): `STATUS.md` on the `status` branch of `gorfednet/.github` is the one view of open pull requests, lapsed backlog items and red mains. Read it (or run `fleet-status`) before coordinating anything, and report to the owner from it. Context that must outlive a session goes in the repository: `docs/handoff/<date>-<topic>.md` (`/handoff` writes it) and a `## Next` section on the open pull request, never only in a chat.

Four rule files in `~/.claude/rules/` load in every session:

- `shipping.md`: pull requests, merge gates, auto-close after merge, red CI, learning from incidents.
- `agents-and-cost.md`: the model roster and tier rule, Desk, who does what, worktrees for writers.
- `verification-floor.md`: the five verification rules and the plan of record.
- `content-voice.md`: who speaks on each site and how copy reads (pointer to the full content guidelines).

The first three replaced the old rule files on 2026-10-03 (originals in `~/.claude/rules-archive-2026-10-03/`). `~/.claude` is the home. Cursor and Bugbot were retired on 2026-10-16, with no further spend. The Claude reviewer (`claude-review.yml`, `REVIEW.md`, `review-status.mjs`) reviews pull requests.

`~/.claude` isn't a repository. Every change to a file here goes in a pull request to `gorfednet/.github` that updates its copy under `docs/claude-home/` (13 November 2026).

Herdr (installed 2026-11-06) hosts long runs, the one-gate lock (`gate-run`) and the builder load check (`builder-ok`): `agents-and-cost.md`, "Herdr".

## User skills and agents

A repository skill that still names an old editor model means `runner`, or Sonnet when it has to diagnose. Plan row 5.3 removes the last of those.

Skills in `~/.claude/skills/`:

- `/self-heal`: diagnose red CI and fix the cause, or set up a repository's plan of record.
- `/verification-bootstrap`: install the shared verification kit at the right tier, or start a project with it wired.
- `/full-codebase-assessment`: BinderCurve's full-repo quality pass.
- `/handoff`: write `docs/handoff/<date>-<topic>.md`, stamp backlog entries and rewrite the PR's `## Next`.
- `/fleet-drain`: save uncommitted work across the fleet to draft PRs, or record why not.
- `/desk-rotate`: hand Desk over to a fresh session with Remote Control on.
- `/apply`: the job pipeline. Runs only when the owner asks.

Agents in `~/.claude/agents/`: `runner` and `scout` (Haiku), `builder` (Sonnet), `desk` (Opus), `reviewer` and `editor` (Fable). `agents-and-cost.md` says when to use each.

## Settings

One file: `~/.claude/settings.json`. Its deny list is a backstop: `gh pr merge`, the REST and GraphQL merge calls, `gh api` deletes, `gh run`, `label`, `release`, `secret` and `variable` deletes (and the `remove` alias), force pushes, and the Read tool on `.env` files (`.env.example` included), the ops `credentials.json` and `~/.ship-bot/config.json`. No pattern list catches every spelling. The rules hold where it doesn't: ship-bot is the only merger, and nobody `cat`s those files through Bash. No `settings.json.bak*` copies beside it: the mirror in `docs/claude-home/` is the record.
