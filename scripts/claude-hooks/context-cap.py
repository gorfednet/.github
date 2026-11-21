#!/usr/bin/env python3
"""Hold new tool work once a session's context passes 200,000 tokens, until /handoff runs (plan row 1.61).

Claude Code user-level PreToolUse hook on every tool. Live copy:
~/.claude/hooks/context-cap.py. Record copy: scripts/claude-hooks/ in
gorfednet/.github.

Why: the rules cap a chat at about 200,000 tokens and nothing enforced it. In
the week of 13 to 19 November 2026, sessions past the cap processed 26% of all
tokens, and on 20 November three sessions passed 300,000.

Context size is the newest main-chain assistant message's usage in the
transcript (`transcript_path`): input + cache read + cache creation tokens.

  180,000  one warning as the session crosses it, as context for the model.
           Nothing is refused.
  200,001  refused: Agent, Task, Workflow, WebFetch, WebSearch, and Edit,
           Write, MultiEdit or NotebookEdit outside the handoff's files
           (`docs/handoff/<date>-*.md`, `control/handoff/<date>-*.md`,
           `docs/backlog.json`, a memory file, a temp file).
           Everything else passes: Read, Grep, Glob, Skill, session tools, MCP
           tools, and Bash and Monitor, which this version does not read. So
           git, gh, labels, cleanup and waits always run.

Exempt: a subagent's calls (`agent_id` in the input: its context isn't this
transcript's), and Desk up to 300,000. Desk is the session whose id is a line
in ~/.desk/context-cap-exempt. A session id belongs to one session. A child
session inherits its starter's environment, never its id, so no session is
exempt by accident, which an environment variable could not promise.

Fails open: a missing or unreadable transcript, no usage in it, bad input, an
unknown event, an internal error and a 4-second alarm all let the call run. A
refusal is exit 2 with the reason on stderr, and the only non-zero exit.
"""
from __future__ import annotations

import json
import os
import re
import signal
import sys

CAP = 200_000
DESK_CAP = 300_000
WARN = 180_000
TAIL_START = 1 << 20
TAIL_MAX = 64 << 20

WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
WORK_TOOLS = {"Agent", "Task", "Workflow", "WebFetch", "WebSearch"}

_HANDOFF_DIRS = {("docs", "handoff"), ("control", "handoff")}
_HANDOFF_NAME = re.compile(r"\d{4}-\d\d-\d\d-[^/]+\.md$")
_MEMORY = re.compile(r"/\.claude/projects/[^/]+/memory/[^/]+\.md$")

MESSAGE = (
    "context-cap (plan row 1.61) refused this call: {why}. This session's context is {tokens:,} tokens, past the "
    "{cap:,} cap, and every further reply re-reads all of it. Do these 3 things now. 1: write the handoff with "
    "/handoff <topic> and commit and push it with the branch. 2: start the successor session from that handoff, "
    "with the handoff's path and the PR in its brief. 3: end the turn. Still allowed: reading files, Edit and Write "
    "on the handoff file (docs/handoff/ or control/handoff/), docs/backlog.json and temp files, every shell command "
    "(git, gh, cleanup, waits already running), Skill and the session tools."
)
WARNING = (
    "context-cap (plan row 1.61): this session's context is {tokens:,} tokens. At {cap:,} new work is held: Agent, "
    "Workflow, web tools, and Edit or Write outside the handoff's files. Finish the step in hand, then write "
    "/handoff <topic> and start the successor session from it before the cap."
)


def _usage(line: bytes) -> int | None:
    """Context tokens of one transcript line when it is a main-chain assistant message with usage."""
    if b'"usage"' not in line or b"assistant" not in line:
        return None
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
        return None
    message = entry.get("message")
    if not isinstance(message, dict) or message.get("model") == "<synthetic>":
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    total = 0
    for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        value = usage.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            total += value
    return total or None


def context_tokens(path: str) -> tuple[int | None, int | None]:
    """(newest, the one before it that differs): assistant context sizes read from the end of the transcript."""
    size = os.path.getsize(path)
    window = TAIL_START
    with open(path, "rb") as f:
        while True:
            start = max(0, size - window)
            f.seek(start)
            lines = f.read(size - start).split(b"\n")
            if start > 0:
                lines = lines[1:]  # the first piece is the end of a longer line
            newest = None
            for line in reversed(lines):
                tokens = _usage(line)
                if tokens is None:
                    continue
                if newest is None:
                    newest = tokens
                elif tokens != newest:  # one reply is written as several lines with the same usage
                    return newest, tokens
            if start == 0 or window >= TAIL_MAX:
                return newest, None
            window *= 4


def is_desk(payload: dict) -> bool:
    session = payload.get("session_id")
    if not isinstance(session, str) or not session.strip():
        return False
    path = os.environ.get("CONTEXT_CAP_EXEMPT_FILE") or os.path.expanduser("~/.desk/context-cap-exempt")
    try:
        with open(path, encoding="utf-8") as f:
            return session.strip() in [line.strip() for line in f.read(8192).splitlines()]
    except (OSError, ValueError):
        return False


def _temp_roots() -> list[str]:
    override = os.environ.get("CONTEXT_CAP_TEMP_ROOTS")  # tests: their own files live under the system temp directory
    if override:
        return [os.path.normpath(r) for r in override.split(":") if os.path.isabs(r)]
    roots = ["/tmp", "/private/tmp"]
    tmp = os.environ.get("TMPDIR")
    if tmp and os.path.isabs(tmp):
        roots += [os.path.normpath(tmp), os.path.realpath(tmp)]
    return roots


def writable(path: str, cwd: str) -> bool:
    """True for a file a handoff writes: the handoff, docs/backlog.json, a memory file, a temp file."""
    path = os.path.expanduser(path)
    absolute = os.path.normpath(path if os.path.isabs(path) else os.path.join(cwd or "/", path))
    parts = absolute.split("/")
    if len(parts) >= 3 and (parts[-3], parts[-2]) in _HANDOFF_DIRS and _HANDOFF_NAME.match(parts[-1]):
        return True
    if absolute.endswith("/docs/backlog.json") or _MEMORY.search(absolute):
        return True
    return any(absolute == root or absolute.startswith(root + "/") for root in _temp_roots())


def decide(payload: dict) -> tuple[str | None, str | None]:
    """(refusal, warning): at most one is set. Neither lets the call run in silence."""
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse":
        return None, None
    if payload.get("agent_id"):
        return None, None
    tool = payload.get("tool_name")
    transcript = payload.get("transcript_path")
    if not isinstance(tool, str) or not isinstance(transcript, str) or not transcript:
        return None, None
    transcript = os.path.expanduser(transcript)
    if not os.path.isfile(transcript):
        return None, None
    tokens, before = context_tokens(transcript)
    if tokens is None or tokens < WARN:
        return None, None
    cap = DESK_CAP if is_desk(payload) else CAP
    if tokens <= cap:
        # Once, as the session crosses the line: the reply before this one was still under it.
        if cap == CAP and (before is None or before < WARN):
            return None, WARNING.format(tokens=tokens, cap=cap)
        return None, None
    why = None
    if tool in WORK_TOOLS:
        why = f"{tool} starts new work"
    elif tool in WRITE_TOOLS:
        tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
        target = tool_input.get("file_path") or tool_input.get("notebook_path")
        cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
        if isinstance(target, str) and target and not writable(target, cwd):
            why = f"{tool} on `{target[-80:]}` isn't a handoff file"
    return (MESSAGE.format(why=why, tokens=tokens, cap=cap) if why else None), None


def main() -> int:
    try:
        signal.signal(signal.SIGALRM, lambda *_: os._exit(0))  # out of time: let the call run
        signal.alarm(4)
        refusal, warning = decide(json.loads(sys.stdin.read() or "{}"))
        if warning:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": warning}}))
    except Exception:  # fail open: a broken guard must not block every session
        return 0
    if not refusal:
        return 0
    try:
        sys.stderr.write(refusal + "\n")
        sys.stderr.flush()
    except Exception:
        pass
    return 2


if __name__ == "__main__":
    sys.exit(main())
