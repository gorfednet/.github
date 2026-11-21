#!/usr/bin/env python3
"""Hold three must-rules in code, not prose (assessment A4, backlog assess-1112-a4-must-rules-live-in-prose).

Claude Code user-level PreToolUse hook on Bash, Agent, Edit, Write and MultiEdit. Live copy:
~/.claude/hooks/must-rules-guard.py. Record copy: scripts/claude-hooks/ in gorfednet/.github.

Refused:
  1. A `claude review` trigger that is not on a line by itself. The reviewer matches whole
     lines, so "please claude review this" silently does nothing. Checked on `gh ... comment`,
     `gh pr review` and `gh api` commands whose body mentions it with no whole-line trigger.
  2. An Agent call to the `builder` subagent whose prompt lacks `git checkout -B` or
     `builder-ok` (agents-and-cost.md: a builder gets a fresh worktree with no node_modules).
  3. A newly added `.skip(`, `xit(`, `xtest(`, `xdescribe(` in a test file with no
     `backlog:<id>` on the same or the previous line.

Fails open: bad input or an internal error lets the call run.
"""
from __future__ import annotations

import json
import re
import shlex
import sys

TRIGGER = re.compile(r"claude\s+review", re.I)
WHOLE = re.compile(r"claude\s+review", re.I)
GH_COMMENT = re.compile(r"\bgh\b.*\b(comment|review|api)\b", re.S)
SKIP = re.compile(r"\b(?:it|test|describe|suite)\.skip\s*\(|\b(?:xit|xtest|xdescribe)\s*\(")
BACKLOG = re.compile(r"backlog:[A-Za-z0-9][\w.-]*")
TEST_FILE = re.compile(r"\.(test|spec)\.[cm]?[jt]sx?$|(^|/)(test|tests|e2e|__tests__)/")


def review_trigger(command: str) -> str | None:
    if not GH_COMMENT.search(command) or not TRIGGER.search(command):
        return None
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    bodies = [t for t in tokens if TRIGGER.search(t)]
    if not bodies:
        return None
    for body in bodies:
        if any(WHOLE.fullmatch(ln.strip()) for ln in body.splitlines()):
            return None
    return (
        "`claude review` must be a line by itself: the reviewer matches whole lines, so this "
        "comment would not trigger a review. Put it alone on its own line of the body."
    )


def builder_brief(tool_input: dict) -> str | None:
    if tool_input.get("subagent_type") != "builder":
        return None
    prompt = tool_input.get("prompt") or ""
    missing = [m for m in ("git checkout -B", "builder-ok") if m not in prompt]
    if not missing:
        return None
    return (
        "A builder brief must contain `git checkout -B <branch>-build <branch>` (a builder's "
        "worktree is made from the main checkout's HEAD) and `builder-ok` (the load check). "
        "Missing: " + ", ".join(missing) + "."
    )


def new_skips(path: str, old: str, new: str) -> str | None:
    if not TEST_FILE.search(path):
        return None
    old_lines = set(old.splitlines())
    lines = new.splitlines()
    for i, ln in enumerate(lines):
        if ln in old_lines or not SKIP.search(ln):
            continue
        if BACKLOG.search(ln) or (i > 0 and BACKLOG.search(lines[i - 1])):
            continue
        return (
            "A skipped test needs a backlog id: add `backlog:<id>` on the same line or the line "
            f"above (a docs/backlog.json entry). Skip without one: {ln.strip()[:100]}"
        )
    return None


def verdict(payload: dict) -> str | None:
    tool = payload.get("tool_name")
    ti = payload.get("tool_input") or {}
    if tool == "Bash":
        cmd = ti.get("command")
        return review_trigger(cmd) if isinstance(cmd, str) else None
    if tool in ("Agent", "Task"):
        return builder_brief(ti)
    path = ti.get("file_path") or ""
    if tool == "Write":
        return new_skips(path, "", ti.get("content") or "")
    if tool == "Edit":
        return new_skips(path, ti.get("old_string") or "", ti.get("new_string") or "")
    if tool == "MultiEdit":
        for e in ti.get("edits") or []:
            why = new_skips(path, e.get("old_string") or "", e.get("new_string") or "")
            if why:
                return why
    return None


def main() -> int:
    try:
        why = verdict(json.load(sys.stdin))
    except Exception:
        return 0
    if why:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": why,
                    }
                }
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
