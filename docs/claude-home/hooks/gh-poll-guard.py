#!/usr/bin/env python3
"""Refuse shell commands that poll GitHub in a loop (plan row 5.10).

Claude Code user-level PreToolUse hook on Bash and Monitor. Live copy:
~/.claude/hooks/gh-poll-guard.py. Record copy: docs/claude-home/hooks/ in
gorfednet/.github.

Why: on 13 November 2026 the owner's 5,000-an-hour GitHub quota hit 0 twice,
and the dapyllil pool started no runners. Default-interval watchers (`gh run
watch` polls every 3 s, `gh pr checks --watch` every 10 s) and three session
sleep loops drained it. One busy-wait spun a core for 3.5 hours. The rules
already banned all of these. This makes it a refusal instead of a reminder.

Refused, in code that runs (quoted text and data heredocs are not code; the
string after `bash -c`, `eval` or `ssh host` is):
  - a `while`/`until` loop whose condition or body calls `gh` or review-status;
  - a counted `for` loop (`seq`, `{1..N}`, `((...))`, 4+ integers) whose body
    calls `gh` or review-status and sleeps;
  - a `while`/`until` busy-wait whose body is empty, `:` or `true`;
  - `gh run watch` or `gh pr checks --watch` without `--interval` of 60+;
  - `watch ... gh ...`.
Not refused: `while read`/`while wait` loops, one-pass `for` loops over a list,
a single `gh` call, a plain `sleep N`, and loops that never touch GitHub.

Fails open: unreadable input or an internal error allows the command.
"""
from __future__ import annotations

import json
import re
import sys

_SHELLS = r"(?:bash|sh|zsh|dash|ksh)"
_KEYWORD = re.compile(
    r"(?:^|(?<=[;&|(){}\n`])|(?<=\bdo[ \t])|(?<=\bthen[ \t])|(?<=\belse[ \t]))"
    r"[ \t]*(for|while|until|do|done)\b(?![-=./\w])",
)
_GH = re.compile(r"(?<![\w.-])(?:[\w.~/-]*/)?gh[ \t]+[a-z]")
_REVIEW_STATUS = re.compile(r"review-status(?:\.mjs)?\b")
_SLEEP = re.compile(r"(?<![\w./-])sleep[ \t]+[\d.$\"']")
_ONE_PASS_COND = re.compile(r"^\s*(?:!\s*)?(?:IFS=\S*\s+)?(?:read|wait)\b")
_COUNTER = re.compile(r"\bseq\b|\{-?\d+\.\.-?\d+|^\s*\(\(")
_INTERVAL = re.compile(r"(?:--interval|-i)(?:=|[ \t]+)(\d+)")
_HEREDOC = re.compile(r"<<(-?)[ \t]*(['\"]?)([A-Za-z_][\w-]*)\2")
_SHELL_ARG = re.compile(
    rf"(?:(?:^|[\s/]){_SHELLS}(?:[ \t]+-\w+)*[ \t]+-\w*c\w*[ \t]+(?:-\w+[ \t]+)*"
    r"|\beval[ \t]+|\bssh(?:[ \t]+\S+)+[ \t]+|^[ \t]*(?:\S*/)?watch(?:[ \t]+\S+)*[ \t]+)$"
)
_CODE_HEREDOC_LINE = re.compile(
    rf"(?:^|[\s;|&(/]){_SHELLS}(?![\w.-])|>[ \t]*\S+\.(?:sh|bash|zsh)\b"
)
_WORD_START = set(" \t\n;&|()")

MESSAGE = (
    "gh-poll-guard (plan row 5.10) refused this command: {why}. "
    "Polling GitHub drains the owner's shared 5,000-an-hour quota "
    "(13 November 2026: it hit 0 twice and the runner pool stopped). "
    "Instead: start ONE `gh run watch <id> --interval 60 --exit-status` with "
    "run_in_background: true and act when it wakes you. For a review verdict, "
    "run review-status.mjs once on that wake. For a merge, add the label and "
    "let ship-bot merge; never wait on it. For a time wait, one `sleep N` in "
    "the background, never a spin loop. If the loop is text you are writing "
    "(a doc, a PR body, a search), write it with the Write tool or a file instead."
)


def _segment(out: list[str]) -> str:
    text = "".join(out)
    cut = max(text.rfind(c) for c in ";&|\n(")
    return text[cut + 1 :]


def _close_paren(text: str, i: int) -> int:
    """Index of the `)` closing the `(` at text[i-1]; len(text) if none."""
    depth, n = 1, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if text.startswith("<<<", i):  # a here-string, not a heredoc
            i += 3
            continue
        if c == "<" and text.startswith("<<", i):
            m = _HEREDOC.match(text, i)
            if m:
                # A heredoc body is opaque: its parentheses never close ours.
                line_end = text.find("\n", m.end())
                if line_end < 0:
                    return n
                tabs = "\t*" if m.group(1) else ""
                end = re.compile(rf"^{tabs}{re.escape(m.group(3))}$", re.M).search(text, line_end + 1)
                if not end:
                    return n
                i = end.end()
                continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return n


def code_view(text: str, extras: list[str] | None = None, depth: int = 0) -> str:
    """The parts of a shell command that run, with quoted data blanked.

    Strings handed to another shell are appended to `extras` as code.
    """
    top = extras is None
    extras = [] if top else extras
    out: list[str] = []
    pending: list[tuple[str, bool, bool]] = []  # (delimiter, strip_tabs, is_code)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            out.append(text[i : i + 2])
            i += 2
        elif c == "#" and (i == 0 or text[i - 1] in _WORD_START):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif c == "'":
            j = text.find("'", i + 1)
            j = n if j < 0 else j
            if _SHELL_ARG.search(_segment(out)) and depth < 4:
                extras.append(text[i + 1 : j])
            out.append("_q_")
            i = j + 1
        elif c == '"':
            j, parts, raw = i + 1, [], []
            while j < n and text[j] != '"':
                if text[j] == "\\":
                    raw.append(text[j + 1 : j + 2])
                    j += 2
                elif text.startswith("$(", j):
                    k = _close_paren(text, j + 2)
                    parts.append("$(" + code_view(text[j + 2 : k], extras, depth + 1) + ")")
                    raw.append(text[j : k + 1])
                    j = k + 1
                elif text[j] == "`":
                    k = text.find("`", j + 1)
                    k = n if k < 0 else k
                    parts.append("$(" + code_view(text[j + 1 : k], extras, depth + 1) + ")")
                    raw.append(text[j : k + 1])
                    j = k + 1
                else:
                    raw.append(text[j])
                    j += 1
            if _SHELL_ARG.search(_segment(out)) and depth < 4:
                extras.append("".join(raw))
            out.append("_q_" + "".join(parts))
            i = j + 1
        elif text.startswith("<<<", i):  # a here-string, not a heredoc
            out.append("<<<")
            i += 3
        elif c == "<" and text.startswith("<<", i):
            m = _HEREDOC.match(text, i)
            if not m:
                out.append(c)
                i += 1
                continue
            line_start = text.rfind("\n", 0, i) + 1
            line_end = text.find("\n", i)
            line = text[line_start : n if line_end < 0 else line_end]
            pending.append((m.group(3), m.group(1) == "-", bool(_CODE_HEREDOC_LINE.search(line))))
            out.append("_h_")
            i = m.end()
        elif c == "\n" and pending:
            out.append("\n")
            i += 1
            for delim, strip_tabs, is_code in pending:
                body: list[str] = []
                while i < n:
                    j = text.find("\n", i)
                    j = n if j < 0 else j
                    line = text[i:j]
                    i = j + 1
                    if (line.lstrip("\t") if strip_tabs else line) == delim:
                        break
                    body.append(line)
                if is_code and depth < 4:
                    extras.append("\n".join(body))
            pending = []
        else:
            out.append(c)
            i += 1
    code = "".join(out)
    if top:
        for extra in extras:
            code += "\n;\n" + code_view(extra, None, depth + 1)
    return code


def _loops(code: str):
    """Yield (keyword, condition, body) for each loop, nested ones included."""
    stack: list[list] = []  # [keyword, kw_end, do_end or None]
    for match in _KEYWORD.finditer(code):
        word = match.group(1)
        if word in ("for", "while", "until"):
            stack.append([word, match.end(), None])
        elif word == "do":
            for frame in reversed(stack):
                if frame[2] is None:
                    frame[2] = match.end()
                    break
        elif word == "done" and stack:
            # Pop frames that never saw `do` (a keyword used as a word).
            while stack and stack[-1][2] is None:
                stack.pop()
            if not stack:
                continue
            keyword, kw_end, do_end = stack.pop()
            yield keyword, code[kw_end : do_end - 2], code[do_end : match.start()]


def _counted(condition: str) -> bool:
    if _COUNTER.search(condition):
        return True
    words = condition.split()
    if len(words) >= 2 and words[1] == "in":
        items = [w.strip(";") for w in words[2:] if w.strip(";")]
        return len(items) >= 4 and all(w.isdigit() for w in items)
    return False


def _calls_github(scope: str) -> bool:
    return bool(_GH.search(scope) or _REVIEW_STATUS.search(scope))


def verdict(command: str) -> str | None:
    """Return why the command is refused, or None to allow it."""
    code = code_view(command)
    for keyword, condition, body in _loops(code):
        if keyword == "for":
            if _calls_github(body) and _SLEEP.search(body) and _counted(condition):
                return "a counted `for` loop calls GitHub and sleeps between calls"
            continue
        if _ONE_PASS_COND.match(condition):
            continue
        if re.sub(r"[\s;:]", "", body) in ("", "true"):
            return f"`{keyword} ...; do :; done` is a busy-wait that spins a core"
        if _calls_github(condition + "\n" + body):
            return f"a `{keyword}` loop calls GitHub until something changes"
    for segment in re.split(r"[;&|\n]", code):
        if re.match(r"[ \t(]*(?:\S*/)?watch[ \t]", segment) and _GH.search(segment):
            return "`watch` reruns a `gh` command on a timer"
        if re.search(r"\bgh[ \t]+run[ \t]+watch\b", segment) or re.search(
            r"\bgh[ \t]+pr[ \t]+checks\b.*--watch\b", segment
        ):
            m = _INTERVAL.search(segment)
            if not m or int(m.group(1)) < 60:
                return "a `gh` watcher without `--interval 60` polls every 3 to 10 seconds"
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if payload.get("tool_name", "Bash") not in ("Bash", "Monitor"):
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
