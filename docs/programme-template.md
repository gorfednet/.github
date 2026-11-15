# Programme template

A programme is how a big ask becomes work that agents can run in sequence. It lives in this repository under `docs/programmes/`, never only in a chat. Copy the skeleton below.

## Rules

- **One item is one pull request and one session.** If an item needs two reviews or two rollbacks, it is two items.
- **Every item has a brief of 30 lines or fewer.** A fresh session must be able to start from the brief alone, plus the item's backlog entry. No "see the chat".
- **Every item names its tier** (`agents-and-cost.md`): main, Opus builder, Sonnet builder, Haiku runner, Fable reviewer or editor. Pick the cheapest tier that can't let a mistake pass unnoticed.
- **`depends-on` is explicit.** Items with no unmet dependency run in parallel, each in its own worktree. The conductor (`~/.claude/workflows/programme.js`, once it exists) reads this field.
- **`owner-decision` marks the only places the owner is asked.** Everything else is decided, recorded in the item and carried on.
- **Done-when is checkable.** It names a merged PR, a number or a report, never "looks good".
- **Status lives in the repository's backlog.** The programme points to backlog ids. It does not keep a second status column that can drift.
- **Owner reports are milestones only:** status, outstanding, next milestone with its ETA in ET.

## Skeleton

```markdown
# <Programme name>, <month year>

Approved <date> by the owner. Source plan: <path>.

## Context
<Why, in 3 to 6 sentences.>

## Owner decisions
- <date>: <decision>

## Milestones
| Milestone | Items | ETA (ET) |
|---|---|---|

## Items
### <id>: <title>
- repo: <name>
- tier: <tier>
- depends-on: <ids or none>
- owner-decision: <no, or the question>
- backlog: <repo>#<backlog id>
- session: <link once started>
- done-when: <checkable outcome>
- verification: <how it is proven, including a guard seen failing>
- plugins: <none, or the plugin the repo must switch on in its .claude/settings.json: docs/claude-home/plugins.md>
- brief:
  <30 lines or fewer>
```
