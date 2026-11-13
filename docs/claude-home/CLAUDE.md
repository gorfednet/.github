# Working rules for every project

Times: give every time to the owner in Toronto local time (owner, 2026-10-19), never UTC, labelled ET. Convert with the system time-zone database (`TZ=America/Toronto date -d …`, or `date -j` / Intl with `America/Toronto`), never a hard-coded offset: Ontario may drop the daylight-time switch, and the database follows the law. Commit messages, PR bodies and logs may stay in UTC.

Improve as you go (owner, 2026-10-31: "we need to self improve all processes over time when we see opportunity"): when a session spots a better way or gets corrected, it changes the skill, brief, rule or template that runs next time, in that session, and says so in one line. New enforced checks still follow `shipping.md`.

Take it to completion (owner, 2026-10-31: "when I ask for somehting to be done take it to completion and work with other agents to coordinate"): an ask ends with the work finished, merged and reported, not with a question or a hand-back. Decide what can be decided, wait for what must be waited for in the background, and coordinate directly with other sessions and agents (check the session list, message the one that holds the context, agree who merges what) rather than relaying through the owner. Stop only for what the rules reserve to the owner. Do it efficiently, and arrange the sessions yourself (owner, 2026-10-31): split work into a new session from a brief when it stands alone or a chat has grown long, fold work into the session that already holds the context when a new one would have to rediscover it, and do either without being asked. `agents-and-cost.md` has the limits.

Reports to the owner (owner, 2026-10-31: "I just need statuses and to know when milestones ETA and done are", "and what's outstanding"): say the status, what's outstanding, the next milestone with its ETA in ET, and when it's done. A few lines at most. No gate tables, no explanation of how, no lists of what changed; those go on the pull request. Add detail only for something the owner has to act on, or when asked.

Commands only when they are ready to run (owner, 11 November 2026: "stop giving me commands until its time to run them i can't keep up"): never put a command, a "run this later" or a "once X is green, run Y" in a message to the owner. Say "nothing for you yet" and keep waiting. Give a command only when every gate has passed and running it is his next step, one at a time, in its own code block. Runbooks that must exist for later go in the repository, not in chat, until their moment. This qualifies the rule below: "in full in the chat" applies at that moment, not before. A command for another host carries its own hop (`ssh -t dapyllil "…"`), so it runs in whatever terminal he pastes it into (11 November 2026: a dapyllil sudo command went to his Mac).

Never send the owner to GitHub (owner, 11 November 2026: "i never want to have to go look at github"): GitHub is the record, not his inbox. Anything he must read, decide or run goes in the chat message itself, in full: the command in its own code block, the exact name or value, what it does and what to expect. Never write "see the PR body", "details on the PR" or "the runbook is in the PR" as the way he learns what to do; put the content in the chat and keep the PR copy for the record. When a session writes a runbook or `## Next` for him, it also puts the same steps in its final message.

Priority order (owner, 9 November 2026: "infra first, then 4thcltr, then gorfed, resumes then moonman, then bindercurve"): 1 infrastructure and the token-free automation (ship-bot, STATUS.md, janitor, pool, ops), 2 4thcltr.com with its subdomains (heuristics, papers, brief, intake, propose), 3 gorfed.net, 4 the resume and job engine, 5 MoonMan, 6 BinderCurve. When builders or the weekly limit compete, the lower number wins and BinderCurve waits.

Fleet status and handoffs (owner, 7 November 2026): `STATUS.md` on the `status` branch of `gorfednet/.github` is the one view of open pull requests, lapsed backlog items and red mains. Read it (or run `fleet-status`) before coordinating anything, and report to the owner from it. Context that must outlive a session goes in the repository: `docs/handoff/<date>-<topic>.md` (`/handoff` writes it) and a `## Next` section on the open pull request, never only in a chat.

Three rule files in `~/.claude/rules/` load in every session:

- `shipping.md`: pull requests, merge gates, red CI, learning from incidents.
- `agents-and-cost.md`: the model roster, who does what, worktrees for writers.
- `verification-floor.md`: the five verification rules and the plan of record.

They replaced the five Cursor rule files on 2026-10-03 (originals in `~/.claude/rules-archive-2026-10-03/`). `~/.claude` is the home. Cursor, Bugbot included, was retired on 2026-10-16 with no further spend; the Claude reviewer (`claude-review.yml`, `REVIEW.md`, `review-status.mjs`) reviews pull requests.

Herdr (installed 2026-11-06) hosts long runs, the one-gate lock (`gate-run`) and the builder load check (`builder-ok`): `agents-and-cost.md`, "Herdr".

## Translating Cursor terms in project skills

Some repositories' skills still live in `.cursor/skills` and name Cursor models. Until those are moved, read them as:

| Cursor | Claude Code |
|--------|-------------|
| `composer-2.5-fast` + `shell` | `runner` |
| `composer-2.5-fast` + `generalPurpose` | `runner` for mechanical work, Sonnet when it has to diagnose |
| `explore` | `Explore`, or `scout` for cheap breadth |
| `best-of-n-runner` | a subagent with `isolation: worktree` |
| Bugbot | retired 2026-10-16: the Claude reviewer |

## User skills

`~/.claude/skills/` holds `/self-heal`, `/verification-bootstrap` and `/full-codebase-assessment`, moved from `~/.cursor/skills/` on 2026-10-15 unchanged, so they still use Cursor terms (read them with the table above). They are rewritten after the shared kit change lands (right-sizing plan items F3 and F5), because both describe the kit as it is copied today.
