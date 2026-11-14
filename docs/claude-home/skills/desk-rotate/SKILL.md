---
name: desk-rotate
description: Hand Desk over to a fresh session. Writes the day's desk log, starts the successor from docs/desk/brief.md with Remote Control on, then retires and archives the outgoing Desk. Use when Desk passes 150k tokens.
---

# /desk-rotate

Desk is never forked. The owner must always have exactly one chat titled "Active Remote Control [Desk (<d Mon>)]".

1. Check the size with `get_usage`. Rotate past 150k tokens. At 02:00 ET Desk only writes the log (step 2).
2. In the `desk-log` worktree (`~/Developer/gorfednet/gorfednet.github/.claude/worktrees/desk-log`, branch `desk-log`), write or update `docs/desk/<today>.md`:
   - decisions taken since the last log
   - open threads, each with the session or pull request that holds it
   - the ship-bot blocked list, from `~/.ship-bot/state.json`
   - `docs/desk/checklist.md` ticked and current
   Commit and push. The draft PR for `desk-log` stays open.
3. Start the successor while an owner turn is live:
   - `start_session` with `user_asked`, `context: fresh`, model Opus, effort high, permission mode auto
   - title "Active Remote Control [Desk (<d Mon>)]"
   - prompt: `docs/desk/brief.md`, one line naming today's log, and one line saying to rotate with `/desk-rotate`
   With no owner turn live, the app refuses the start. Keep running and say so in the 07:00 ET digest.
4. The successor switches Remote Control on at its first turn. If that's refused, the outgoing Desk switches it on with the successor's id once that turn has run.
5. Check `list_sessions` once on the next turn for `remoteControlActive: true` on the successor. Don't poll in a loop.
6. Only once the successor shows `remoteControlActive: true`, retire the outgoing Desk. Until then it keeps running and checks again on its next turn. Never leave the owner with no Desk on Remote Control.
   - rename it "Retired Desk (<d Mon>, <n>)", where n counts the Desks retired that day, for example "Retired Desk (14 Nov, 2)"
   - switch its Remote Control off
   - archive it

Done: one live Desk with Remote Control on, today's log pushed on `desk-log`, the outgoing Desk archived.
