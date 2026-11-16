#!/usr/bin/env python3
"""Remind the agent to open a GitHub PR after git commit/push so review and PR CI can run.

Claude Code user-level PostToolUse hook on Bash (ported 2026-10-15 from the
Cursor afterShellExecution hook in ~/.cursor/hooks). Fail-open. Does not create
the PR. See ~/.claude/rules/shipping.md.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

DEFAULT_BRANCHES = {"main", "master"}
TAG_PUSH = re.compile(
    r"(?:^|\s)(?:--tags\b|refs/tags/|origin\s+v\d+(?:\.\d+){2,}\b)",
    re.IGNORECASE,
)
GIT_COMMIT_OR_PUSH = re.compile(r"\bgit\b.*\b(commit|push)\b", re.IGNORECASE)
NO_PR_FOUND = re.compile(r"no pull requests? found", re.IGNORECASE)
CD_PREFIX = re.compile(r"^\s*cd\s+([^\s;&]+)\s*&&")


def _ok(message: str | None = None) -> int:
    if message:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": message}}))
    return 0


def _run(args: list[str], cwd: str, timeout: float = 4.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _cwd(payload: dict, command: str) -> str | None:
    for key in ("cwd", "working_directory", "workingDirectory"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    match = CD_PREFIX.match(command)
    if match:
        return os.path.expanduser(match.group(1).strip("\"'"))
    return None


def _git_root(cwd: str) -> str | None:
    try:
        proc = _run(["git", "rev-parse", "--show-toplevel"], cwd)
    except (OSError, subprocess.TimeoutExpired):
        return None
    root = proc.stdout.strip()
    return root if proc.returncode == 0 and root else None


def _branch(cwd: str) -> str | None:
    try:
        proc = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd)
    except (OSError, subprocess.TimeoutExpired):
        return None
    name = proc.stdout.strip()
    if proc.returncode != 0 or not name or name == "HEAD":
        return None
    return name


def _has_open_pr(cwd: str) -> bool | None:
    """True if this HEAD already has a PR. None if we cannot tell."""
    try:
        proc = _run(
            ["gh", "pr", "view", "--json", "url,state"],
            cwd,
            timeout=5.0,
        )
    except FileNotFoundError:
        return None
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        # Only gh's own "no pull requests found for branch" means no PR. Any other
        # failure (auth, network, rate limit) is "cannot tell", never a false "no PR".
        if NO_PR_FOUND.search(proc.stderr or ""):
            return False
        return None
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    state = str(data.get("state") or "").upper()
    return bool(data.get("url")) and state in {"OPEN", "DRAFT", ""}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return _ok()

    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command") or "" if isinstance(tool_input, dict) else ""
    if not isinstance(command, str) or not GIT_COMMIT_OR_PUSH.search(command):
        return _ok()

    if TAG_PUSH.search(command):
        return _ok()

    cwd = _cwd(payload, command)
    if not cwd or not os.path.isdir(cwd):
        return _ok()

    root = _git_root(cwd)
    if not root:
        return _ok()

    branch = _branch(root)
    if not branch:
        return _ok()

    if branch.lower() in DEFAULT_BRANCHES:
        message = (
            "Always-PR: HEAD is {branch}. Feature work belongs on a branch with "
            "`gh pr create` (draft is fine). If this is a "
            "release step on main after the feature PR merged (e.g. /ship), ignore."
        ).format(branch=branch)
        return _ok(message)

    has_pr = _has_open_pr(root)
    if has_pr:
        return _ok()
    if has_pr is None:
        message = (
            f"Always-PR: committed/pushed on `{branch}` but could not check for "
            "an open GitHub PR. If none exists, run `gh pr create`."
        )
        return _ok(message)

    message = (
        f"Always-PR: `{branch}` has no open GitHub PR. Run `gh pr create` (draft "
        "is fine) so the Claude reviewer and PR CI can run. Do not push this to "
        "main. Never comment `bugbot run`: Cursor is retired (2026-10-16)."
    )
    return _ok(message)


if __name__ == "__main__":
    raise SystemExit(main())
