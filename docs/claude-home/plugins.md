# Which plugins and tools are on, and where

Owner, 14 November 2026: switch them on and off as needed across projects. Every reply carries the tool and skill schemas of everything switched on, so a tool a repo never uses is a cost with no return. The global `~/.claude/settings.json` keeps only what every repo uses. A repo's own `.claude/settings.json` turns on the rest. A session's tool set is fixed when it starts, so nothing flips mid-session.

Evidence is real tool calls in 3,062 session transcripts (14 November 2026), plus the briefs and skills that name a plugin. Re-run the count before adding a line: `plugin-usage.py` beside this file counts them.

## Global (every repo)

| Item | Layer | State | Why |
|---|---|---|---|
| `security-guidance` plugin | `~/.claude/settings.json` | on | Security hooks run in every repo. A security setting, so it stays on. |
| Claude in Chrome, built-in browser, `ccd_*` app tools, `scheduled-tasks`, `terminal`, `claude-artifacts`, `visualize` | desktop app | on | Used in nearly every repo. The app offers no per-repo switch. |

## Per repo

A repo not listed uses no extra plugin.

| Repo | Plugin on in its `.claude/settings.json` | Why |
|---|---|---|
| `gorfednet/.github` | `hookify` | The rules-as-hooks lane (brief A4) mines transcripts for hook candidates with it. No other repo has hookify rules. |
| `MoonMan` | `claude-md-management` | The MoonMan house brief (C1) audits `CLAUDE.md` with it. The iOS Simulator tools are the app's, so they are on everywhere. |
| `4thcltr.com` | `frontend-design` | The one repo where a session called it (14 November 2026). |
| `bindercurve.com` | none | 119 sessions, no plugin skill or agent used. Its tracked `settings.json` holds a design-system hook only. |
| `heuristics.4thcltr.com`, `papers.4thcltr.com`, `gorfed.net`, `gorfmusic.com`, `ssatcy.com`, `promptboi.com`, `career-portfolio`, `ops`, `assess`, `ai-use-levels` and the rest | none | No plugin skill or agent in their transcripts. Their agents are `reviewer`, `editor`, `builder`, `runner` and `scout`, which are ours. |

Switched off everywhere (0 use in any repo): `pr-review-toolkit`, `session-report`, `code-simplifier`. They stay installed, so a repo can turn one on.

## What a repo cannot toggle

| Item | Controlled by | How to change it |
|---|---|---|
| `design` plugin (7 skills, MCP servers asana, atlassian, figma, intercom, linear, notion and slack, plus gmail and calendar entries that fail to start) | the claude.ai account, source `design@inline` | Owner: claude.ai, Customize, Plugins. No settings file or session tool reaches it. 0 uses; never signed in. |
| Claude Docs connector (8 tools) | the desktop app's connectors; `set_session_connector_enabled` sets it for this session and as the default | Switched off 14 November 2026 (11 calls in 1 session, last 3 November). Turn it back on from the composer's + menu, Connectors. |
| iOS Simulator tools | the desktop app | On everywhere. 707 calls in 21 sessions, nearly all MoonMan. No per-repo switch. |
| `easel` (built-in plugin) and `mcp-registry` | the desktop app | 0 calls ever. The app gives a session no toggle. |

## How a session turns one on

A brief that needs a plugin its repo hasn't switched on says so under `plugins:`. The session adds `"<name>@<marketplace>": true` to that repo's `.claude/settings.json` in its own pull request, with the grep evidence in the body, and starts a fresh session to use it. Repo setting changes ride one pull request per repo, or a release train.
