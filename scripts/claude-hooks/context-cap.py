#!/usr/bin/env python3
"""Hold new tool work once a session's context passes 200,000 tokens, until /handoff runs (plan row 1.61).

Claude Code user-level PreToolUse hook on every tool. Live copy:
~/.claude/hooks/context-cap.py, beside argv-guard.py, whose shell parser it
loads. Record copy: scripts/claude-hooks/ in gorfednet/.github.

Why: the rules cap a chat at about 200,000 tokens and nothing enforced it. In
the week of 13 to 19 November 2026, sessions past the cap processed 26% of all
tokens, and on 20 November three sessions passed 300,000. Every reply past the
cap re-reads the whole conversation, at over twice a fresh session's cost.

Context size is the newest main-chain assistant message's usage in the
transcript (`transcript_path`): input + cache read + cache creation tokens.
200,000 passes. 200,001 is past the cap.

Past the cap, before this session's handoff is committed:
  pass     Read, Grep, Glob; Edit and Write on `docs/handoff/*.md`,
           `control/handoff/*.md`, `docs/backlog.json` and temp files; shell
           commands that only read (cat, ls, grep, git status/log/diff, gh pr
           view/list ...) or publish the handoff (git add/commit/push, a new
           branch or worktree, gh pr create/edit/comment); every tool not
           named below (Skill, questions, session tools, MCP tools).
  refused  Agent, Task, Workflow, WebFetch, WebSearch; Edit and Write
           anywhere else; any other shell command; a shell redirection to any
           other file.
Once the handoff is committed (a `docs/handoff/` or `control/handoff/` file
dated today in Eastern time that this session wrote with Edit or Write, tracked
and unmodified in git), the read allowance ends too: only the handoff's own
files, git add/commit/push/pull/fetch/status/log/diff, gh pr view/list/create/
edit/comment and the filters they are piped through still run, so the session can publish it and end the turn. A handoff
written before the cap was passed doesn't count: it can't cover the work since.

Exempt: a subagent's calls (`agent_id` in the input: its context isn't this
transcript's, and Agent is refused past the cap, so none starts there), and
Desk. Desk is the session whose id is a line in ~/.desk/context-cap-exempt.
A session id belongs to one session. A child session inherits its starter's
environment, never its id, so no session is exempt by accident, which an
environment variable could not promise.

Fails open: a missing or unreadable transcript, no usage in it, bad input, an
unknown event, a shell command the parser can't read, a missing argv-guard.py,
an internal error and a 4-second alarm all let the call run. A refusal is exit
2 with the reason on stderr, and the only non-zero exit.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import time

CAP = 200_000
TAIL_START = 1 << 20
TAIL_MAX = 64 << 20
SCAN_MAX = 512 << 20

READ_TOOLS = {"Read", "Grep", "Glob", "LS", "NotebookRead"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "Monitor"}
WORK_TOOLS = {"Agent", "Task", "Workflow", "WebFetch", "WebSearch"}

_DEVICES = {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"}
_HANDOFF_DIRS = {("docs", "handoff"), ("control", "handoff")}

# Shell commands that read, wait or set up the shell. Open: before the handoff is committed.
_PLAIN_OPEN = {
    "cat", "head", "tail", "ls", "pwd", "date", "echo", "printf", "grep", "egrep", "fgrep", "rg", "wc", "sort",
    "uniq", "cut", "tr", "jq", "true", "false", "test", "[", "[[", "cd", "pushd", "popd", "basename", "dirname",
    "realpath", "readlink", "which", "type", "stat", "file", "tree", "mktemp", "mkdir", "diff", "cmp", "sleep",
    "wait", "read", "export", "set", "unset", "local", ":", "shasum", "md5", "nl", "column", "comm", "rev",
    "fold", "seq", "expr", "uname", "whoami", "id", "df", "du", "awk", "sed", "find", "cp", "tee", "touch", "rm",
    "less", "more", "exit", "return", "break", "continue", "shift", "hash", "umask", "mv",
}
# Closed: once it is committed, what publishing it still takes.
_PLAIN_CLOSED = {
    "cat", "pwd", "date", "echo", "printf", "true", "false", "test", "[", "[[", "cd", "pushd", "popd", "basename",
    "dirname", "mktemp", "mkdir", "sleep", "wait", "read", "export", "set", "unset", "local", ":", "tee", "touch",
    "rm", "cp", "mv", "exit", "return",
}
# A publishing command is piped through these (`git push 2>&1 | tail -5`, `gh pr view ... | jq`), so they stay.
_FILTERS = {"head", "tail", "jq", "grep", "egrep", "wc", "sort", "uniq", "cut", "tr", "sed", "awk"}
_PLAIN_CLOSED |= _FILTERS
_HEADERS = {"for", "select", "case", "esac", "function"}
_TEST_OPS = {"==", "=", "!=", "=~", "-eq", "-ne", "-lt", "-gt", "-le", "-ge", "-nt", "-ot"}

_GIT_OPEN = {
    "status", "log", "diff", "show", "rev-parse", "rev-list", "ls-files", "ls-remote", "ls-tree", "merge-base",
    "describe", "blame", "shortlog", "reflog", "cat-file", "name-rev", "for-each-ref", "show-ref", "grep", "fetch",
    "count-objects", "var", "version", "help", "diff-tree", "check-ignore", "whatchanged", "add", "commit", "push",
    "pull",  # a rejected push needs it before the handoff can be published
    "symbolic-ref", "diff-index", "diff-files", "cherry",
}
_GIT_CLOSED = {"status", "log", "diff", "rev-parse", "add", "commit", "push", "fetch", "pull", "symbolic-ref", "diff-index"}
_GH_OPEN = {
    "pr": {"view", "list", "edit", "comment", "create", "checks", "status", "diff"},
    "issue": {"view", "list", "comment", "status"},
    "run": {"view", "list"},
    "repo": {"view", "list"},
    "auth": {"status"},
    "label": {"list"},
    "release": {"view", "list"},
    "workflow": {"view", "list"},
    "search": None,
    "status": None,
    "api": None,
}
_GH_CLOSED = {"pr": {"view", "list", "edit", "comment", "create"}}
_GH_API_WRITES = re.compile(r"^(?:-X|--method|-f|-F|--field|--raw-field|--input)")
_BRANCH_CHANGES = ("--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description")

MESSAGE_OPEN = (
    "context-cap (plan row 1.61) refused this call: {why}. This session's context is {tokens:,} tokens, past the "
    "{cap:,} cap, and every further reply re-reads all of it. Run /handoff <topic> now, then end the turn: the work "
    "continues in a new session started from that handoff. Still allowed: reading files, Edit and Write on the "
    "handoff file (docs/handoff/ or control/handoff/), docs/backlog.json and temp files, git add, commit and push, "
    "a new branch or worktree for the handoff, and gh pr view, create, edit and comment."
)
MESSAGE_CLOSED = (
    "context-cap (plan row 1.61) refused this call: {why}. This session's context is {tokens:,} tokens, past the "
    "{cap:,} cap, and its handoff is committed: {handoff}. Push it, rewrite the PR's ## Next if that is still owed, "
    "then end the turn. Nothing else runs in this session: the work continues in a new one started from the handoff. "
    "If the handoff is out of date, edit it first, which reopens reading until it is committed again."
)


# ---- the transcript ----------------------------------------------------------


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


def today_et(now: float | None = None) -> str:
    # TZ is set only for this process, so the zone database does the conversion, never an offset.
    os.environ["TZ"] = "America/Toronto"
    time.tzset()
    return time.strftime("%Y-%m-%d", time.localtime(now))


_HANDOFF_NAME = re.compile(r"\d{4}-\d\d-\d\d-[^/]+\.md$")
_MEMORY = re.compile(r"/\.claude/projects/[^/]+/memory/[^/]+\.md$")


def is_handoff(path: str) -> bool:
    """`docs/handoff/<date>-<topic>.md` or `control/handoff/<date>-<topic>.md`, the file directly in that directory."""
    parts = path.split("/")
    return len(parts) >= 3 and (parts[-3], parts[-2]) in _HANDOFF_DIRS and bool(_HANDOFF_NAME.match(parts[-1]))


def _committed(path: str) -> bool:
    """True when `path` is a file git tracks with no uncommitted change."""
    if not os.path.isfile(path):
        return False
    base = ["git", "-C", os.path.dirname(path)]
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    try:
        log = subprocess.run(base + ["log", "-1", "--format=%H", "--", path], capture_output=True, timeout=2, env=env)
        status = subprocess.run(base + ["status", "--porcelain", "--", path], capture_output=True, timeout=2, env=env)
    except (OSError, subprocess.SubprocessError):
        return False
    return log.returncode == 0 and bool(log.stdout.strip()) and status.returncode == 0 and not status.stdout.strip()


def committed_handoff(transcript: str, today: str) -> str | None:
    """The handoff dated today that this session wrote with Edit or Write past the cap and that is committed, if any."""
    if os.path.getsize(transcript) > SCAN_MAX:
        return None
    seen: list[str] = []
    with open(transcript, "rb") as f:
        for line in f:
            if b"handoff/" not in line or b"tool_use" not in line or b"assistant" not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
                continue
            message = entry.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict) or block.get("type") != "tool_use" or block.get("name") not in WRITE_TOOLS:
                    continue
                target = (block.get("input") or {}).get("file_path") if isinstance(block.get("input"), dict) else None
                if not isinstance(target, str) or not os.path.isabs(target):
                    continue
                target = os.path.normpath(target)
                # Written past the cap: an earlier handoff doesn't cover the work done since.
                if is_handoff(target) and os.path.basename(target).startswith(today) and target not in seen and (_usage(line) or 0) > CAP:
                    seen.append(target)
    for target in reversed(seen):
        if _committed(target):
            return target
    return None


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


# ---- paths -------------------------------------------------------------------


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
    """True for a file a handoff writes: the handoff, docs/backlog.json, a temp file."""
    path = os.path.expanduser(path)
    absolute = os.path.normpath(path if os.path.isabs(path) else os.path.join(cwd or "/", path))
    if absolute in _DEVICES or is_handoff(absolute):
        return True
    if absolute.endswith("/docs/backlog.json") or _MEMORY.search(absolute):
        return True
    return any(absolute == root or absolute.startswith(root + "/") for root in _temp_roots())


def _shell_path_ok(word: str, cwd: str, dyn: str, moved: bool = False) -> bool:
    """A path in a shell command: one only the shell knows (a variable, a substitution, relative after a `cd`) passes unread."""
    if not word or dyn in word or "$" in word:
        return True
    if moved and not word.startswith(("/", "~")):
        return True
    return writable(word, cwd)


# ---- shell commands ----------------------------------------------------------


def load_parser():
    """argv-guard.py, which sits beside this file in both the repository and ~/.claude/hooks."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "argv-guard.py")
    spec = importlib.util.spec_from_file_location("argv_guard", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["argv_guard"] = module  # dataclass-free, but `from __future__ import annotations` resolves here
    spec.loader.exec_module(module)
    return module


class Shell:
    def __init__(self, ag, cwd: str, closed: bool):
        self.ag, self.cwd, self.closed = ag, cwd, closed
        self.moved = False  # the command changes directory, so a relative path is not under `cwd`
        self.arms = False  # the command has a `case`, so a lone word can be an arm's pattern

    def text(self, text: str, depth: int = 0) -> str | None:
        """Why the shell text is refused, or None."""
        if depth > self.ag.MAX_DEPTH:
            return None
        commands: list = []
        self.ag.REDIRECTS = []
        self.ag.parse(text, commands, depth)
        targets = self.ag.REDIRECTS
        moved_at = len(commands)  # index of the first `cd`: only what comes after it is relative to somewhere else
        for k, words in enumerate(commands):
            names = [w.rsplit("/", 1)[-1] for w in words if w not in self.ag._KEYWORDS]
            if names[:1] in (["cd"], ["pushd"]):
                moved_at = min(moved_at, k)
            self.arms = self.arms or names[:1] == ["case"]
        before = self.moved
        for target, k in targets:
            if not _shell_path_ok(target, self.cwd, self.ag.DYN, before or k > moved_at):
                return f"the command redirects into `{target[:80]}`, which isn't a handoff file"
        for k, words in enumerate(commands):
            self.moved = before or k > moved_at
            why = self.words(words, depth)
            if why:
                return why
        self.moved = before or moved_at < len(commands)
        return None

    def _operands_ok(self, name: str, args: list[str]) -> str | None:
        for a in args:
            if not a.startswith("-") and not _shell_path_ok(a, self.cwd, self.ag.DYN, self.moved):
                return f"`{name}` touches `{a[:80]}`, which isn't a handoff file"
        return None

    def words(self, words: list[str], depth: int = 0) -> str | None:
        ag = self.ag
        if depth > ag.MAX_DEPTH:
            return None
        i = 0
        while i < len(words) and (words[i] in ag._KEYWORDS or ag._ASSIGN.match(words[i])):
            i += 1
        words = words[i:]
        if not words or words[0] in _HEADERS:
            return None
        if words[-1] == "]]" and (words[0].startswith("-") or (len(words) > 2 and words[1] in _TEST_OPS)):
            return None  # the tail of `[[ a && -f b ]]`, which the parser split at `&&`
        if self.arms and len(words) == 1 and re.fullmatch(r"[\w.*?\[\]/-]+", words[0]) and not re.fullmatch(r"[a-z][a-z0-9-]*", words[0]):
            return None  # `*)` or `v1.*)`: a case arm's pattern, never a command name
        if ag.DYN in words[0] or "$" in words[0]:
            return None  # the command's name is only known to the shell
        name, args = words[0].rsplit("/", 1)[-1], words[1:]
        if name == "git":
            return self.git(args)
        if name == "gh":
            return self.gh(args)
        if name in ag._PREFIXES and name != "sudo":
            j = 0
            takes = ag._PREFIX_VALUES.get(name, ())
            while j < len(args) and (args[j].startswith("-") or ag._ASSIGN.match(args[j])):
                j += 2 if args[j] in takes else 1
            if name == "timeout":
                j += 1  # the duration
            return self.words(args[j:], depth + 1)
        if name in ag._SHELLS:
            j = 0
            while j < len(args):
                a = args[j]
                if a.startswith("-") and not a.startswith("--") and "c" in a:
                    return self.text(args[j + 1] if j + 1 < len(args) else "", depth + 1)
                if a[:1] in "-+" and not a.startswith(("--", "++")) and a[-1:] in "oO":
                    j += 1
                elif a[:1] not in "-+":
                    return f"`{name} {a[:60]}` runs a script"
                j += 1
            return f"`{name}` with no -c runs whatever its stdin holds"
        if name == "eval":
            return self.text(" ".join(args), depth + 1)
        if name not in (_PLAIN_CLOSED if self.closed else _PLAIN_OPEN):
            if self.closed and name in _PLAIN_OPEN:
                return f"`{name}` reads, and the handoff is already committed"
            return f"`{name}` isn't a command a handoff needs"
        if name == "sed" and any(re.match(r"-[A-Za-z]*i|--in-place", a) for a in args):
            return "`sed -i` edits a file in place"
        if name == "find" and any(a in ("-delete", "-exec", "-execdir", "-ok", "-okdir") or a.startswith("-fprint") for a in args):
            return "`find` with -exec or -delete changes files"
        if name == "sort" and any(a.startswith(("-o", "--output")) for a in args):
            return "`sort -o` writes a file"
        if name in ("tee", "touch", "rm", "mv") or (name == "cat" and self.closed):
            return self._operands_ok(name, args)
        if name == "cp":
            if any(a.startswith(("-t", "--target-directory")) for a in args):
                return "`cp -t` names its target where this hook doesn't read it"
            operands = [a for a in args if not a.startswith("-")]
            return self._operands_ok(name, operands[-1:])
        if name == "uniq":
            return self._operands_ok(name, [a for a in args if not a.startswith("-")][1:])  # the second operand is its output
        if self.closed and name in _FILTERS:
            # In a pipe a filter reads no file. An operand that is a file here is a read, unless it's the handoff's own.
            operands = [a for a in args if not a.startswith("-")]
            if name in ("grep", "egrep", "sed", "jq", "awk") and not any(a in ("-e", "-f") or a.startswith("--regexp") for a in args):
                operands = operands[1:]  # the pattern, script or filter, which can share a name with a file
            for a in [] if name == "tr" else operands:
                if self.ag.DYN in a or "$" in a or (self.moved and not a.startswith(("/", "~"))):
                    continue
                path = os.path.expanduser(a)
                path = path if os.path.isabs(path) else os.path.join(self.cwd or "/", path)
                if os.path.exists(path) and not writable(a, self.cwd):
                    return f"`{name}` reads `{a[:80]}`, and the handoff is already committed"
        return None

    def git(self, args: list[str]) -> str | None:
        ag = self.ag
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 2 if args[i] in ag._GIT_GLOBAL_VALUES or args[i] == "-c" else 1
        if i >= len(args):
            return None
        sub, rest = args[i], args[i + 1 :]
        if ag.DYN in sub or "$" in sub:
            return None
        if sub in (_GIT_CLOSED if self.closed else _GIT_OPEN):
            return None
        flags = [a for a in rest if a.startswith("-")]
        operands = [a for a in rest if not a.startswith("-")]
        if sub == "restore" and any(a == "--staged" or (a.startswith("-") and not a.startswith("--") and "S" in a) for a in flags):
            if not any(a.startswith("--w") or (not a.startswith("--") and "W" in a) for a in flags):
                return None  # unstaging keeps a file out of the commit and loses nothing
        if sub in ("branch", "remote", "config", "tag", "stash", "worktree") and not self.closed or sub in ("branch", "remote") and self.closed:
            if sub == "branch":
                short = "".join(a[1:] for a in flags if not a.startswith("--"))
                long = [a.split("=", 1)[0] for a in flags if a.startswith("--")]
                if not set(short) & set("dDmMcCfu") and not any(ag._is_prefix(a, n) for a in long for n in _BRANCH_CHANGES):
                    if not self.closed or not operands:
                        return None
            elif sub == "remote":
                if not operands or operands[0] in ("show", "get-url"):
                    return None
            elif sub == "config":
                if any(a in ("--get", "--get-all", "--get-regexp", "--list", "-l") for a in flags) or operands[:1] == ["get"] or operands[:1] == ["list"]:
                    return None
                if len(operands) == 1 and not any(a.startswith(("--unset", "--remove", "--rename", "--edit", "-e", "--add", "--replace")) for a in flags):
                    return None  # `git config user.name` reads one value
            elif sub == "tag":
                if not operands or any(a in ("-l", "--list", "-n") or a.startswith(("--points-at", "--contains", "--merged", "--sort")) for a in flags):
                    return None
            elif sub == "stash":
                if operands[:1] in (["list"], ["show"]):
                    return None
            elif sub == "worktree":
                if operands[:1] in (["add"], ["list"]):
                    return None
        if not self.closed and sub in ("switch", "checkout"):
            short = "".join(a[1:] for a in flags if not a.startswith("--"))
            if sub == "switch" and ("c" in short or "C" in short or any(ag._is_prefix(a.split("=", 1)[0], "--create") for a in flags if a.startswith("--"))):
                return None
            if sub == "checkout" and ("b" in short or "B" in short):
                return None
        if self.closed and sub in _GIT_OPEN:
            return f"`git {sub}` reads, and the handoff is already committed"
        return f"`git {sub}` in this form isn't part of a handoff"

    def gh(self, args: list[str]) -> str | None:
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 1 if "=" in args[i] or args[i] in ("--help", "--version") else 2
        if i >= len(args):
            return None
        group, rest = args[i], args[i + 1 :]
        table = _GH_CLOSED if self.closed else _GH_OPEN
        label = f"`gh {group}{' ' + rest[0] if rest and not rest[0].startswith('-') else ''}`"
        if group not in table:
            return f"{label} isn't part of a handoff"
        if group == "api":
            method = [rest[k + 1].upper() if a in ("-X", "--method") and k + 1 < len(rest) else a.split("=", 1)[-1].upper() if a.startswith("--method=") else a[2:].upper()
                      for k, a in enumerate(rest) if a in ("-X", "--method") or a.startswith("--method=") or (a.startswith("-X") and len(a) > 2)]
            if method == ["GET"] and not any(a.startswith("--input") for a in rest):
                return None  # with GET, fields are the query string
            if "graphql" in rest and not method and not any(re.search(r"\bmutation\b", a) or a.startswith(("--input", "-F", "--field")) for a in rest):
                return None  # a GraphQL query
            if any(_GH_API_WRITES.match(a) for a in rest):
                return "`gh api` with a method, a field or an input writes"
            return None
        subs = table[group]
        if subs is None or "--help" in rest:
            return None
        if group == "pr" and any(a.startswith(("--add-label", "--remove-label", "--label")) or re.match(r"-l", a) for a in rest):
            return "a label is a merge decision, and its gates can't run past the cap"
        while rest[:1] and rest[0] in ("-R", "--repo"):
            rest = rest[2:]
        sub = next((a for a in rest if not a.startswith("-")), None)
        if sub is None or sub in subs:
            return None
        return f"{label} isn't part of a handoff"


def shell_verdict(command: str, cwd: str, closed: bool) -> str | None:
    """Why a shell command is refused past the cap, or None. Anything unreadable passes."""
    try:
        ag = load_parser()
    except Exception:
        return None
    try:
        return Shell(ag, cwd, closed).text(command)
    except (ag.Unparsed, RecursionError, IndexError):
        return None


# ---- the decision ------------------------------------------------------------


def decide(payload: dict) -> str | None:
    """The refusal message, or None to let the call run."""
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse":
        return None
    if payload.get("agent_id"):
        return None
    tool = payload.get("tool_name")
    if not isinstance(tool, str) or tool not in READ_TOOLS | WRITE_TOOLS | SHELL_TOOLS | WORK_TOOLS:
        return None
    transcript = payload.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return None
    transcript = os.path.expanduser(transcript)
    if not os.path.isfile(transcript) or is_desk(payload):
        return None
    tokens = context_tokens(transcript)
    if tokens is None or tokens <= CAP:
        return None

    handoff = committed_handoff(transcript, today_et())
    closed = handoff is not None
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
    why = None
    if tool in WORK_TOOLS:
        why = f"{tool} starts new work"
    elif tool in READ_TOOLS:
        target = tool_input.get("file_path")
        if closed and not (tool == "Read" and isinstance(target, str) and writable(target, cwd)):
            why = f"{tool} reads, and the handoff is already committed"
    elif tool in WRITE_TOOLS:
        target = tool_input.get("file_path") or tool_input.get("notebook_path")
        if isinstance(target, str) and target and not writable(target, cwd):
            why = f"{tool} on `{target[-80:]}` isn't a handoff file"
    else:
        command = tool_input.get("command")
        if isinstance(command, str) and command.strip():
            why = shell_verdict(command, cwd, closed)
    if not why:
        return None
    if closed:
        return MESSAGE_CLOSED.format(why=why, tokens=tokens, cap=CAP, handoff=handoff)
    return MESSAGE_OPEN.format(why=why, tokens=tokens, cap=CAP)


def main() -> int:
    try:
        signal.signal(signal.SIGALRM, lambda *_: os._exit(0))  # out of time: let the call run
        signal.alarm(4)
        message = decide(json.loads(sys.stdin.read() or "{}"))
    except Exception:  # fail open: a broken guard must not block every session
        return 0
    if not message:
        return 0
    try:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
    except Exception:
        pass
    return 2


if __name__ == "__main__":
    sys.exit(main())
