#!/usr/bin/env python3
"""Refuse Bash commands that poll GitHub in a shell loop (plan row 5.10).

Claude Code user-level PreToolUse hook on Bash. Live copy:
~/.claude/hooks/gh-poll-guard.py. Record copy: docs/claude-home/hooks/ in
gorfednet/.github.

Why: on 13 November 2026 three session loops polled `gh` and review-status.mjs
with `sleep` while the owner's 5,000-an-hour GitHub quota sat at 0, so the
dapyllil pool started no runners. One `until ...; do :; done` busy-wait spun a
core for 3.5 hours. shipping.md and agents-and-cost.md already said "no gh
loops"; this makes it a refusal instead of a reminder.

Refused:
  - a `for`/`while`/`until` loop whose body (and, for while/until, condition)
    calls `gh` or review-status.mjs and also sleeps;
  - a `while`/`until` loop whose body is empty, `:` or `true` (a busy-wait).
Passed: everything else, including a single `gh run watch --interval 60`,
a plain `sleep N`, and loops that sleep without touching GitHub.

Fails open: unreadable input or an internal error allows the command.
"""
from __future__ import annotations

import json
import re
import sys

# A shell keyword counts only at a command position: start of text, or after
# a separator, an opening group, or another keyword that starts a command.
_KEYWORD = re.compile(
    r"(?:^|(?<=[;&|(){}\n`])|(?<=\$\()|(?<=\bdo)\s|(?<=\bthen)\s|(?<=\belse)\s)"
    r"\s*(for|while|until|do|done)\b(?![-=./\w])",
)
_GH = re.compile(r"(?<![\w./-])gh\s+[a-z]")
_REVIEW_STATUS = re.compile(r"review-status(?:\.mjs)?\b")
_SLEEP = re.compile(r"(?<![\w./-])sleep\s+[\d$\"']")
_BUSY_BODY = re.compile(r"^[\s;:]*(?:true)?[\s;:]*$")
# `while read line; do :; done` drains its input and ends: not a busy-wait.
_READ = re.compile(r"^\s*(?:IFS=\S*\s+)?read\b")

MESSAGE = (
    "gh-poll-guard (plan row 5.10) refused this command: {why}. "
    "Polling GitHub in a loop drains the owner's shared 5,000-an-hour quota "
    "(13 November 2026: it hit 0 twice and the runner pool stopped). "
    "Instead: start ONE `gh run watch <id> --interval 60 --exit-status` with "
    "run_in_background: true and act when it wakes you. For a review verdict, "
    "check review-status.mjs once on that wake. For a merge, add the label and "
    "let ship-bot merge; never wait on it. For a time wait, one `sleep N` in "
    "the background, never a spin loop."
)


def _loops(text: str):
    """Yield (keyword, condition, body) for each loop, nested ones included."""
    stack: list[list] = []  # [keyword, kw_end, do_end or None]
    for match in _KEYWORD.finditer(text):
        word = match.group(1)
        if word in ("for", "while", "until"):
            stack.append([word, match.end(), None])
        elif word == "do":
            for frame in reversed(stack):
                if frame[2] is None:
                    frame[2] = match.end()
                    break
        elif word == "done" and stack:
            keyword, kw_end, do_end = stack.pop()
            if do_end is None:
                continue
            yield keyword, text[kw_end : do_end - 2], text[do_end : match.start()]


def verdict(command: str) -> str | None:
    """Return why the command is refused, or None to allow it."""
    for keyword, condition, body in _loops(command):
        if keyword in ("while", "until") and _BUSY_BODY.match(body) and not _READ.match(condition):
            return f"`{keyword} ...; do :; done` is a busy-wait that spins a core"
        scope = body if keyword == "for" else condition + "\n" + body
        if _SLEEP.search(scope) and (_GH.search(scope) or _REVIEW_STATUS.search(scope)):
            what = "review-status.mjs" if not _GH.search(scope) else "`gh`"
            return f"a `{keyword}` loop calls {what} and sleeps between calls"
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if payload.get("tool_name", "Bash") != "Bash":
            return 0
        command = (payload.get("tool_input") or {}).get("command") or ""
        why = verdict(command) if isinstance(command, str) else None
    except Exception:  # fail open: a broken guard must not block every session
        return 0
    if why:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": MESSAGE.format(why=why),
                    }
                }
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
