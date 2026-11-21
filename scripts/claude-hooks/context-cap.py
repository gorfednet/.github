#!/usr/bin/env python3
"""Hold new tool work once a session's context passes 200,000 tokens (plan row 1.61).

Claude Code user-level PreToolUse hook on every tool. Live copy:
~/.claude/hooks/context-cap.py. Record copy: scripts/claude-hooks/ in
gorfednet/.github.

Why: the rules cap a chat at about 200,000 tokens and nothing enforced it. In
the week of 13 to 19 November 2026, sessions past the cap processed 26% of all
tokens, and on 20 November three sessions passed 300,000.

Context size is the newest main-chain assistant message's usage in the
transcript (`transcript_path`): input + cache read + cache creation tokens.

  180,000  one warning, on the first tool call at or past it, as context for
           the model. Nothing is refused.
  200,001  refused: Agent, Task, Workflow, WebFetch, WebSearch, and Edit,
           Write, MultiEdit or NotebookEdit outside the handoff's files. From
           the file's repository root those are `docs/handoff/<date>-*.md`,
           `control/handoff/<date>-*.md` and `docs/backlog.json`. A memory
           file and a temp file count too.
           Everything else passes: Read, Grep, Glob, Skill, session tools, MCP
           tools, and Bash and Monitor, which this version does not read. So
           git, gh, labels, cleanup and waits always run.

Nothing lifts the hold. It lasts for the rest of the session, unless
compaction brings the context back under the cap. /handoff is what the session
is told to do with the calls it has left.

Exempt: a subagent's calls (`agent_id` in the input: its context isn't this
transcript's), and Desk up to 300,000, with its warning at 280,000. Past that
Desk is held too, is told to run /desk-rotate, and can still write what a
rotation writes: `control/desk/*.md` and `control/briefs/*.md`. Desk is the
session whose transcript id (the transcript's file name, which is also the
`session_id` hooks get) is a line in ~/.desk/context-cap-exempt. An id belongs
to one session. A child session inherits its starter's environment, never its
id, so no session is exempt by accident, which an environment variable could
not promise.

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
WARN_MARGIN = 20_000  # the warning goes out this far under the cap: 180,000, or 280,000 for Desk
TAIL_START = 1 << 20
TAIL_MAX = 64 << 20

WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
WORK_TOOLS = {"Agent", "Task", "Workflow", "WebFetch", "WebSearch"}

# Paths from the file's repository root.
_HANDOFF = re.compile(r"(?:(?:docs|control)/handoff/\d{4}-\d\d-\d\d-[^/]+\.md|docs/backlog\.json)$")
_ROTATION = re.compile(r"control/(?:desk|briefs)/[^/]+\.md$")
_STATE_NAME = re.compile(r"[A-Za-z0-9_-]{1,128}$")
_MEMORY = re.compile(r"/\.claude/projects/[^/]+/memory/[^/]+\.md$")

MESSAGE = (
    "context-cap (plan row 1.61) refused this call: {why}. This session's context is {tokens:,} tokens, past the "
    "{cap:,} cap, and every further reply re-reads all of it. The hold lasts for the rest of this session. Do these "
    "3 things now. 1: write the handoff with "
    "/handoff <topic> and commit and push it with the branch. 2: start the successor session from that handoff, "
    "with the handoff's path and the PR in its brief. 3: end the turn. Still allowed: reading files, Edit and Write "
    "on the handoff file (docs/handoff/ or control/handoff/), docs/backlog.json and temp files, every shell command "
    "(git, gh, cleanup, waits already running), Skill and the session tools."
)
MESSAGE_DESK = (
    "context-cap (plan row 1.61) refused this call: {why}. Desk's context is {tokens:,} tokens, past the {cap:,} cap "
    "it is exempt up to. The hold lasts for the rest of this session. Run /desk-rotate on the owner's next message "
    "and hand over to the successor. Still allowed: reading files, Edit and Write on control/desk/*.md, "
    "control/briefs/*.md and temp files, every shell command, Skill and the session tools."
)
WARNING_DESK = (
    "context-cap (plan row 1.61): Desk's context is {tokens:,} tokens. At {cap:,} new work is held: Agent, Workflow, "
    "web tools, and Edit or Write outside control/desk/, control/briefs/ and temp files. Run /desk-rotate on the "
    "owner's next message."
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


def context_tokens(path: str) -> int | None:
    """The newest assistant message's context size, read from the end of the transcript. None when unknown."""
    size = os.path.getsize(path)
    window = TAIL_START
    with open(path, "rb") as f:
        while True:
            start = max(0, size - window)
            f.seek(start)
            lines = f.read(size - start).split(b"\n")
            if start > 0:
                lines = lines[1:]  # the first piece is the end of a longer line
            for line in reversed(lines):
                tokens = _usage(line)
                if tokens is not None:
                    return tokens
            if start == 0 or window >= TAIL_MAX:
                return None
            window *= 4


def session_ids(payload: dict, transcript: str) -> list[str]:
    """The transcript's file name, then `session_id`. They are the same id today; the file name is the one on disk."""
    stem = os.path.basename(transcript)
    stem = stem[: -len(".jsonl")] if stem.endswith(".jsonl") else ""
    session = payload.get("session_id")
    return [i.strip() for i in (stem, session) if isinstance(i, str) and i.strip()]


def is_desk(ids: list[str]) -> bool:
    path = os.environ.get("CONTEXT_CAP_EXEMPT_FILE") or os.path.expanduser("~/.desk/context-cap-exempt")
    try:
        with open(path, encoding="utf-8") as f:
            listed = [line.strip() for line in f.read(8192).splitlines()]
    except (OSError, ValueError):
        return False
    return any(i in listed for i in ids)


def _marker(ids: list[str]) -> str | None:
    if not ids or not _STATE_NAME.match(ids[0]):
        return None
    return os.path.join(os.environ.get("CONTEXT_CAP_STATE_DIR") or os.path.expanduser("~/.desk/context-cap-warned"), ids[0])


def first_warning(ids: list[str]) -> bool:
    """True once per session: this call created the session's marker. Nowhere to record it means no warning."""
    path = _marker(ids)
    if not path:
        return False
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        return True
    except OSError:
        return False


def forget_warning(ids: list[str]) -> None:
    """Under the line again (a compacted session): the next climb is warned afresh."""
    path = _marker(ids)
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except OSError:
        pass


def _temp_roots() -> list[str]:
    override = os.environ.get("CONTEXT_CAP_TEMP_ROOTS")  # tests: their own files live under the system temp directory
    if override:
        return [os.path.normpath(r) for r in override.split(":") if os.path.isabs(r)]
    roots = ["/tmp", "/private/tmp"]
    tmp = os.environ.get("TMPDIR")
    if tmp and os.path.isabs(tmp):
        roots += [os.path.normpath(tmp), os.path.realpath(tmp)]
    return roots


def repo_relative(absolute: str, cwd: str) -> str | None:
    """The path from its repository root (the nearest directory above it with a `.git`), else from `cwd`."""
    parent = os.path.dirname(absolute)
    while parent and parent != "/":
        if os.path.exists(os.path.join(parent, ".git")):
            return absolute[len(parent) + 1 :]
        parent = os.path.dirname(parent)
    cwd = os.path.normpath(cwd) if cwd and os.path.isabs(cwd) else ""
    return absolute[len(cwd) + 1 :] if cwd and absolute.startswith(cwd + "/") else None


def writable(path: str, cwd: str, desk: bool = False) -> bool:
    """True for a file a handoff writes (for Desk, a rotation): matched from its repository root, never by its ending."""
    path = os.path.expanduser(path)
    absolute = os.path.normpath(path if os.path.isabs(path) else os.path.join(cwd or "/", path))
    relative = repo_relative(absolute, cwd)
    if relative and (_HANDOFF.match(relative) or (desk and _ROTATION.match(relative))):
        return True
    if _MEMORY.search(absolute):
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
    tokens = context_tokens(transcript)
    if tokens is None:
        return None, None
    ids = session_ids(payload, transcript)
    if tokens < CAP - WARN_MARGIN:
        forget_warning(ids)
        return None, None
    desk = is_desk(ids)
    cap = DESK_CAP if desk else CAP
    if tokens <= cap:
        if tokens >= cap - WARN_MARGIN and first_warning(ids):
            return None, (WARNING_DESK if desk else WARNING).format(tokens=tokens, cap=cap)
        return None, None
    why = None
    if tool in WORK_TOOLS:
        why = f"{tool} starts new work"
    elif tool in WRITE_TOOLS:
        tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
        target = tool_input.get("file_path") or tool_input.get("notebook_path")
        cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
        if isinstance(target, str) and target and not writable(target, cwd, desk):
            why = f"{tool} on `{target[-80:]}` isn't a {'rotation' if desk else 'handoff'} file"
    return ((MESSAGE_DESK if desk else MESSAGE).format(why=why, tokens=tokens, cap=cap) if why else None), None


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
