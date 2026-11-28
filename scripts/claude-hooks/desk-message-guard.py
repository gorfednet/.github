#!/usr/bin/env python3
"""Refuse a session message to Desk from a turn the owner didn't start (plan row 1.62).

Claude Code user-level PreToolUse hook on the session-message tools. Live copy:
~/.claude/hooks/desk-message-guard.py. Record copy: scripts/claude-hooks/ in
gorfednet/.github.

Why: Desk is one long-lived control session, and every message to it starts a
turn that re-reads its whole context. In the week of 13 to 19 November 2026,
turns the owner didn't start cost Desk 1,270M processed tokens, 46% of its
total, and on 20 November 33 of its 170 turns were messages from other
sessions. The rule already said results go to the PR's `## Next`. Nothing
enforced it.

Read: `SendMessage`, `send_message` and any `mcp__*__send_message`. Nothing
else is read, so a shell command that reaches Desk another way passes.

The target is Desk when a target field of the call (any top-level string, or
list of strings, other than the message's own text) is one of:
  - a title that starts "Active Remote Control [Desk", with no letter, digit,
    hyphen or underscore straight after it;
  - an app session id (`local_...`) whose record in the desktop app's session
    store carries such a title;
  - an id listed in Desk's id file, ~/.desk/context-cap-exempt.

Then the call passes when one of these holds, and is refused otherwise:
  - the sender is Desk: its id is in the id file, or its own record in the
    session store carries the Desk title (a handover to the successor);
  - the owner started this turn: the newest prompt in the transcript is his
    (`origin.kind` is `human`) and it isn't the session's first prompt, which
    is the session's brief whoever pasted it;
  - a scheduled task started this turn (`origin.subkind` is
    `scheduled-trigger`): the Desk timer and the owner's reminders are such
    sessions, and each exists to send Desk one message.

Fails open: bad input, another event, no string target, a missing or
unreadable transcript, a transcript with no prompt in it, a missing or corrupt
session record, an internal error and a 4-second alarm all let the call run. A
refusal is exit 2 with the reason on stderr, and the only non-zero exit.

Test overrides: DESK_MESSAGE_GUARD_SESSIONS_DIR, DESK_MESSAGE_GUARD_DESK_FILE.
"""
from __future__ import annotations

import glob
import json
import os
import re
import signal
import sys

# The lookahead keeps "[Desktop", "[Desk-top" and "[Desk2" out. A date, a bracket, a space or the end may follow.
DESK_TITLE = re.compile(r"Active Remote Control \[Desk(?![A-Za-z0-9_-])")
_APP_ID = re.compile(r"local_[A-Za-z0-9-]{1,80}$")
# The message's own words are never a target, whatever they quote.
TEXT_KEYS = {"message", "summary", "content", "body", "text", "subject", "description", "prompt"}
RECORD_MAX = 8 << 20
HEAD_MAX = 8 << 20
TAIL_START = 1 << 20
TAIL_MAX = 64 << 20

MESSAGE = (
    "desk-message-guard (plan row 1.62) refused this call: {tool} to Desk from a turn the owner didn't start "
    "({why}). Every message wakes Desk, and Desk re-reads its whole context to learn one fact. Desk reads results "
    "from the repository on each pass. Put this one in the PR's `## Next` as a `- [ ]` line (start a question for "
    "Desk with `Desk:`), then end the turn. With no PR yet, open a draft that has a `## Next`. Don't reach Desk "
    "another way. A message the owner asks for passes on a turn his own message starts, after the session's first "
    "prompt."
)
WHY = {
    "brief": "it began with this session's first prompt, which is its brief",
    "task-notification": "it began with a background-task notice",
    "peer": "it began with a message from another session",
    "other": "it began with a prompt that wasn't the owner's",
}


def is_message_tool(tool: object) -> bool:
    if not isinstance(tool, str):
        return False
    return tool in ("SendMessage", "send_message") or (tool.startswith("mcp__") and tool.endswith("__send_message"))


def targets(tool_input: object) -> list[str]:
    """Every short top-level string the call could address a session with."""
    if not isinstance(tool_input, dict):
        return []
    found = []
    for key, value in tool_input.items():
        if key in TEXT_KEYS:
            continue
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str) and 0 < len(item.strip()) <= 512:
                found.append(item.strip())
    return found


def _store() -> str:
    return os.environ.get("DESK_MESSAGE_GUARD_SESSIONS_DIR") or os.path.expanduser(
        "~/Library/Application Support/Claude/claude-code-sessions"
    )


def _record(path: str) -> dict | None:
    try:
        with open(path, "rb") as f:
            record = json.loads(f.read(RECORD_MAX))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def _titled_desk(record: dict | None) -> bool:
    title = record.get("title") if record else None
    return isinstance(title, str) and bool(DESK_TITLE.match(title.strip()))


def desk_ids() -> list[str]:
    """Desk's transcript ids, one a line: the file context-cap.py reads, kept by /desk-rotate."""
    path = os.environ.get("DESK_MESSAGE_GUARD_DESK_FILE") or os.path.expanduser("~/.desk/context-cap-exempt")
    try:
        with open(path, encoding="utf-8") as f:
            return [line.strip() for line in f.read(8192).splitlines() if line.strip()]
    except (OSError, ValueError):
        return []


def target_is_desk(target: str, listed: list[str]) -> bool:
    if DESK_TITLE.match(target) or target in listed:
        return True
    if not _APP_ID.match(target):
        return False
    # The id is letters, digits and hyphens only, so it holds no glob character and no path part.
    return any(_titled_desk(_record(path)) for path in glob.glob(os.path.join(_store(), "*", "*", target + ".json")))


def sender_ids(payload: dict) -> list[str]:
    """The transcript's file name, then `session_id`. They are the same id today."""
    transcript = payload.get("transcript_path")
    stem = os.path.basename(transcript) if isinstance(transcript, str) else ""
    stem = stem[: -len(".jsonl")] if stem.endswith(".jsonl") else ""
    session = payload.get("session_id")
    return [i.strip() for i in (stem, session) if isinstance(i, str) and i.strip()]


def sender_is_desk(ids: list[str], listed: list[str]) -> bool:
    if not ids:
        return False
    if any(i in listed for i in ids):
        return True
    # The sender's own record: the one whose `cliSessionId` is the id hooks get. Newest first, since Desk is live.
    paths = glob.glob(os.path.join(_store(), "*", "*", "local_*.json"))

    def mtime(path: str) -> float:
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0.0

    needles = [i.encode() for i in ids]
    for path in sorted(paths, key=mtime, reverse=True):
        try:
            with open(path, "rb") as f:
                raw = f.read(RECORD_MAX)
        except OSError:
            continue
        if not any(n in raw for n in needles):
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if isinstance(record, dict) and record.get("cliSessionId") in ids:
            return _titled_desk(record)
    return False


def _prompt(line: bytes) -> dict | None:
    """One transcript line when it is a prompt that starts a main-chain turn, else None."""
    if b'"user"' not in line:
        return None
    if b'"origin"' not in line and b'"promptSource"' not in line and b'"turnOrigin"' not in line:
        return None
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    if not isinstance(entry, dict) or entry.get("type") != "user" or entry.get("isSidechain"):
        return None
    # Tool results and a skill's companion text carry none of the three fields.
    if not (isinstance(entry.get("origin"), dict) or entry.get("promptSource") or entry.get("turnOrigin")):
        return None
    return entry


def newest_prompt(path: str) -> dict | None:
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
                entry = _prompt(line)
                if entry is not None:
                    return entry
            if start == 0 or window >= TAIL_MAX:
                return None
            window *= 4


def first_prompt(path: str) -> dict | None:
    read = 0
    with open(path, "rb") as f:
        for line in f:
            read += len(line)
            entry = _prompt(line)
            if entry is not None:
                return entry
            if read > HEAD_MAX:
                return None
    return None


def turn_start(path: str) -> str | None:
    """What started the turn in hand: owner, scheduled-task, brief, task-notification, peer or other. None when unknown."""
    newest = newest_prompt(path)
    if newest is None:
        return None
    origin = newest.get("origin") if isinstance(newest.get("origin"), dict) else {}
    kind = origin.get("kind")
    if kind == "human":
        first = first_prompt(path)
        if first is not None and first == newest:
            return "brief"
        return "owner"
    if kind == "task-notification":
        return "scheduled-task" if origin.get("subkind") == "scheduled-trigger" else "task-notification"
    return "peer" if kind == "peer" else "other"


def decide(payload: object) -> str | None:
    """The refusal, or None to let the call run."""
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse":
        return None
    tool = payload.get("tool_name")
    if not is_message_tool(tool):
        return None
    found = targets(payload.get("tool_input"))
    if not found:
        return None
    listed = desk_ids()
    if not any(target_is_desk(t, listed) for t in found):
        return None
    if sender_is_desk(sender_ids(payload), listed):
        return None
    transcript = payload.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return None
    transcript = os.path.expanduser(transcript)
    if not os.path.isfile(transcript):
        return None
    start = turn_start(transcript)
    if start in (None, "owner", "scheduled-task"):
        return None
    return MESSAGE.format(tool=tool, why=WHY.get(start, WHY["other"]))


def main() -> int:
    try:
        signal.signal(signal.SIGALRM, lambda *_: os._exit(0))  # out of time: let the call run
        signal.alarm(4)
        refusal = decide(json.loads(sys.stdin.read() or "{}"))
    except Exception:  # fail open: a broken guard must not block every message
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
