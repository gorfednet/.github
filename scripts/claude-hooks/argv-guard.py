#!/usr/bin/env python3
"""Refuse the git and gh commands settings.json denies, in every argv spelling (plan row 5.14).

Claude Code user-level PreToolUse hook on Bash and Monitor. Live copy:
~/.claude/hooks/argv-guard.py. Record copy: scripts/claude-hooks/ in
gorfednet/.github.

Why: the deny list in settings.json is shell globs over the command text. A
glob can't express argv. `*` crosses spaces and flags, git accepts any unique
prefix of a long option (`--forc`, `--force-with-l`, `--upl=x`), flags cluster
(`-Af`), quote (`'-f'`) and split from their value (`--output /tmp/x`), and a
wrapper (`hc run ... --`, `gate-run <repo> '<cmd>'`, `bash -c`) hides the
command. The settings audit left those as residual cases. This hook splits the
command into simple commands, strips the quoting, finds `git` and `gh` behind
their global options and wrappers, and reads the arguments.

Refused (the classes settings.json already denies, nothing new):
  git push      force (`-f`, `--force*`, `+ref`), `--delete`/`-d`, `:ref`,
                `--mirror`, `--prune`, `--no-verify`, `--exec`,
                `--receive-pack`, and any `src:main` refspec. A plain
                `git push origin main` passes (release steps use it).
  git reset     `--hard`
  git clean     with force and no dry run
  git checkout, git switch   `-f`, `--force`, `--discard-changes`
  git add       `-f`, `--force`
  git worktree remove        `-f`, `--force`
  git fetch, pull, clone, ls-remote   `--upload-pack`
  git log, diff, show and kin         `--output`
  git -c core.hooksPath=..., --config-env=core.hooksPath=...
  gh pr merge; gh repo delete, rename, edit --visibility; gh run, release
  delete; gh label delete, edit, create --force; gh secret, variable delete
  or remove; gh pr close --delete-branch
  gh api        `--hostname`, method DELETE, a write to `pulls/N/merge` or
                `merges`, a merge mutation on `graphql`, `force` on `git/refs`

A long option counts when what was typed is a prefix of the refused name: that
is how git resolves it, and a prefix git finds ambiguous fails in git anyway.

Not refused: anything it can't read. A variable in flag position, an
unbalanced quote, an unknown wrapper or an internal error all pass, and the
settings deny list and the auto-mode classifier still read the command. A
false refusal blocks every session, so the hook never fails closed.
"""
from __future__ import annotations

import json
import re
import sys

DYN = "\x00"  # stands for text only the shell knows: $(...), `...`, ${...}
MAX_DEPTH = 6
# context-cap.py (plan row 1.61) loads this file for its parser and sets this to a list. parse() then
# appends each output redirection target (`> file`, `>> file`, `&> file`) to it. None here: this hook reads none.
REDIRECTS: list[str] | None = None

_HEREDOC = re.compile(r"<<(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|(\\?)([A-Za-z_][\w.-]*))")
_ASSIGN = re.compile(r"^[A-Za-z_]\w*\+?=")
_KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "fi", "done"}
_SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
_PREFIXES = {"env", "command", "exec", "nohup", "sudo", "builtin", "nice", "caffeinate", "noglob", "timeout"}
# options that take the next word as their value, per wrapper (the value is not the command)
_PREFIX_VALUES = {
    "env": {"-u", "-C", "-S", "--unset", "--chdir", "--split-string"},
    "nice": {"-n", "--adjustment"},
    "sudo": {"-u", "-g", "-C", "-h", "-p", "-r", "-t", "-D", "-T", "-U", "--user", "--group", "--host", "--chdir"},
    "timeout": {"-s", "-k", "--signal", "--kill-after"},
}


class Unparsed(Exception):
    """The command isn't shell this hook can read. The caller lets it pass."""


def _skip_heredoc(text: str, m: re.Match) -> int:
    """Index just past the body of the heredoc matched at `m`; raises when it never ends."""
    line_end = text.find("\n", m.end())
    if line_end < 0:
        raise Unparsed
    delim = m.group(2) or m.group(3) or m.group(5) or ""
    tabs = "\t*" if m.group(1) else ""
    end = re.compile(rf"^{tabs}{re.escape(delim)}$", re.M).search(text, line_end + 1)
    if not end:
        raise Unparsed
    return end.end()


def _close_dquote(text: str, i: int) -> int:
    """Index of the `"` closing the one at text[i-1]."""
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
        elif c == '"':
            return i
        elif c == "$" and text.startswith("$(", i):
            i = _close_paren(text, i + 2) + 1
        elif c == "`":
            i = _close_tick(text, i + 1) + 1
        else:
            i += 1
    raise Unparsed


def _close_tick(text: str, i: int) -> int:
    n = len(text)
    while i < n:
        if text[i] == "\\":
            i += 2
        elif text[i] == "`":
            return i
        else:
            i += 1
    raise Unparsed


def _close_paren(text: str, i: int) -> int:
    """Index of the `)` closing the `(` at text[i-1]. Quotes and heredoc bodies are opaque."""
    depth, n = 1, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise Unparsed
            i = j + 1
        elif c == '"':
            i = _close_dquote(text, i + 1) + 1
        elif c == "`":
            i = _close_tick(text, i + 1) + 1
        elif text.startswith("<<<", i):
            i += 3
        elif c == "<" and text.startswith("<<", i) and _HEREDOC.match(text, i):
            i = _skip_heredoc(text, _HEREDOC.match(text, i))
        elif c == "(":
            depth += 1
            i += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
            i += 1
        else:
            i += 1
    raise Unparsed


def _heredoc_substitutions(body: str, out: list, depth: int) -> None:
    """An unquoted heredoc body is data, except `$(...)` and backticks, which the shell runs (`\\` and `\\$` escape them)."""
    i, n = 0, len(body)
    while i < n:
        c = body[i]
        if c == "\\":
            i += 2
        elif c == "$" and body.startswith("$((", i):
            i = _close_paren(body, i + 2) + 1
        elif c == "$" and body.startswith("$(", i):
            k = _close_paren(body, i + 2)
            parse(body[i + 2 : k], out, depth)
            i = k + 1
        elif c == "`":
            k = _close_tick(body, i + 1)
            parse(body[i + 1 : k], out, depth)
            i = k + 1
        else:
            i += 1


def parse(text: str, out: list, depth: int = 0) -> None:
    """Append the words of every simple command in `text` to `out`.

    Words have their quoting removed. Commands inside `$(...)` and backticks are
    appended too. Redirections and heredoc bodies are dropped;
    a heredoc fed to a shell is parsed as code.
    """
    if depth > MAX_DEPTH:
        return
    n = len(text)
    i = 0
    words: list[str] = []
    cur: list[str] | None = None
    skip_word = False  # the next word is a redirection target
    writes = False  # that redirection writes a file
    pending: list[tuple[str, bool, bool, bool]] = []  # heredocs opened on this line

    def end_word() -> None:
        nonlocal cur, skip_word, writes
        if cur is None:
            return
        if skip_word:
            skip_word = False
            if writes and REDIRECTS is not None:
                REDIRECTS.append("".join(cur))
            writes = False
        else:
            words.append("".join(cur))
        cur = None

    def end_command() -> None:
        nonlocal words, skip_word
        end_word()
        skip_word = False
        if words:
            out.append(words)
        words = []

    def substitution(inner: str) -> None:
        nonlocal cur
        parse(inner, out, depth + 1)
        cur = (cur or []) + [DYN]

    while i < n:
        c = text[i]
        if c == "\\":
            if i + 1 < n and text[i + 1] == "\n":
                i += 2
                continue
            cur = (cur or []) + [text[i + 1 : i + 2]]
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise Unparsed
            cur = (cur or []) + [text[i + 1 : j]]
            i = j + 1
        elif c == '"':
            end = _close_dquote(text, i + 1)
            cur = cur or []
            j = i + 1
            while j < end:
                d = text[j]
                if d == "\\" and text[j + 1 : j + 2] in ('"', "\\", "$", "`", "\n"):
                    if text[j + 1] != "\n":
                        cur.append(text[j + 1])
                    j += 2
                elif d == "$" and text.startswith("$((", j):
                    j = _close_paren(text, j + 2) + 1
                    cur.append(DYN)
                elif d == "$" and text.startswith("$(", j):
                    k = _close_paren(text, j + 2)
                    substitution(text[j + 2 : k])
                    j = k + 1
                elif d == "`":
                    k = _close_tick(text, j + 1)
                    substitution(text[j + 1 : k])
                    j = k + 1
                else:
                    cur.append(d)
                    j += 1
            i = end + 1
        elif c == "$" and text.startswith("$'", i):
            j = i + 2
            while j < n and text[j] != "'":
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise Unparsed
            cur = (cur or []) + [text[i + 2 : j]]
            i = j + 1
        elif c == "$" and text.startswith("$((", i):
            i = _close_paren(text, i + 2) + 1
            cur = (cur or []) + [DYN]
        elif c == "$" and text.startswith("$(", i):
            k = _close_paren(text, i + 2)
            substitution(text[i + 2 : k])
            i = k + 1
        elif c == "$" and text.startswith("${", i):
            k = text.find("}", i)
            if k < 0:
                raise Unparsed
            cur = (cur or []) + [DYN]
            i = k + 1
        elif c == "`":
            k = _close_tick(text, i + 1)
            substitution(text[i + 1 : k])
            i = k + 1
        elif c in " \t":
            end_word()
            i += 1
        elif c == "\n":
            end_command()
            i += 1
            for delim, strip_tabs, is_code, quoted in pending:
                body: list[str] = []
                closed = False
                while i < n:
                    j = text.find("\n", i)
                    j = n if j < 0 else j
                    line = text[i:j]
                    i = j + 1
                    if (line.lstrip("\t") if strip_tabs else line) == delim:
                        closed = True
                        break
                    body.append(line)
                if not closed:
                    raise Unparsed
                if is_code:
                    parse("\n".join(body), out, depth + 1)
                elif not quoted:
                    _heredoc_substitutions("\n".join(body), out, depth + 1)
            pending = []
        elif c == "#" and cur is None:
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif c == "&" and text.startswith("&>", i):
            end_word()
            i += 1  # the `>` branch below reads the redirection
        elif c in ";&|()":
            end_command()
            i += 1
        elif c in "<>":
            if cur is not None and "".join(cur).isdigit():
                cur = None  # a file descriptor: 2>file
            end_word()
            if text.startswith("<<<", i):
                i += 3
                skip_word = True
                writes = False
            elif text.startswith("<<", i) and _HEREDOC.match(text, i):
                m = _HEREDOC.match(text, i)
                first = words[0].rsplit("/", 1)[-1] if words else ""
                quoted = m.group(2) is not None or m.group(3) is not None or bool(m.group(4))
                pending.append((m.group(2) or m.group(3) or m.group(5) or "", m.group(1) == "-", first in _SHELLS, quoted))
                i = m.end()
            elif text[i + 1 : i + 2] == "(":
                i += 1  # <(cmd) or >(cmd): the `(` starts a command
            else:
                op = i
                while i < n and text[i] in "<>|":
                    i += 1
                writes = ">" in text[op:i]
                if i < n and text[i] == "&":
                    i += 1
                    m2 = re.compile(r"\d+|-").match(text, i)
                    if m2:
                        i = m2.end()  # 2>&1, >&2, >&-
                        continue
                skip_word = True
        else:
            if cur is None:
                cur = []
            cur.append(c)  # in place: a long bare word must stay linear
            i += 1
    if pending:
        raise Unparsed
    end_command()


# ---- reading arguments -------------------------------------------------------


def _is_prefix(typed: str, name: str) -> bool:
    """True when `typed` (a long option without its =value) is `name` or a prefix of it, as git resolves it."""
    return len(typed) > 2 and name.startswith(typed)


def scan(args: list[str], value_long: tuple[str, ...] = (), value_short: str = "") -> tuple[list[str], list[str], list[str]]:
    """Split arguments into long option names, short option letters and positionals.

    A value that belongs to an option (`-o v`, `--repo v`, `-bname`) is skipped, so it
    is never read as a flag. Everything after `--` is positional.
    """
    longs: list[str] = []
    shorts: list[str] = []
    positional: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional += args[i + 1 :]
            break
        if a.startswith("--"):
            name, eq, _ = a.partition("=")
            longs.append(name)
            if not eq and any(_is_prefix(name, v) for v in value_long):
                i += 1
        elif a.startswith("-") and len(a) > 1:
            for j, ch in enumerate(a[1:]):
                shorts.append(ch)
                if ch in value_short:
                    if j == len(a) - 2:
                        i += 1
                    break
        else:
            positional.append(a)
        i += 1
    return longs, shorts, positional


def _has(longs: list[str], *names: str) -> str | None:
    for typed in longs:
        for name in names:
            if _is_prefix(typed, name):
                return typed if typed == name else f"{typed} (git reads it as {name})"
    return None


_LOG_FAMILY = {"log", "diff", "show", "whatchanged", "diff-tree", "diff-index", "diff-files", "range-diff", "format-patch"}
_LOG_VALUES = ("--grep", "--author", "--committer", "--since", "--until", "--after", "--before", "--max-count", "--skip", "--encoding")
_GIT_GLOBAL_VALUES = {"-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"}


def _scp_url(ref: str) -> bool:
    """`user@host:path`, the scp-style remote URL. `@:main` and `HEAD@{0}:main` are refspecs: `@` alone means HEAD."""
    return re.match(r"^[^@:/\s{}]+@[^@:/\s{}]+:", ref) is not None


def _push(args: list[str]) -> str | None:
    longs, shorts, positional = scan(args, ("--push-option", "--repo", "--recurse-submodules", "--exec", "--receive-pack"), "o")
    hit = _has(longs, "--force", "--force-with-lease", "--force-if-includes")
    if hit or "f" in shorts:
        return f"`git push {hit or '-f'}` is a force push"
    hit = _has(longs, "--delete")
    if hit or "d" in shorts:
        return f"`git push {hit or '-d'}` deletes a remote ref"
    for name, what in (("--mirror", "overwrites every remote ref"), ("--prune", "deletes remote refs"), ("--no-verify", "skips the pre-push guard")):
        hit = _has(longs, name)
        if hit:
            return f"`git push {hit}` {what}"
    hit = _has(longs, "--exec", "--receive-pack")
    if hit:
        return f"`git push {hit}` runs a program of the caller's choosing"
    for ref in positional:
        if ref.startswith("+"):
            return f"`git push {ref}` is a force push (the leading +)"
        if ref.startswith(":"):
            return f"`git push {ref}` deletes a remote ref (an empty source)"
        if ":" in ref and "://" not in ref and not _scp_url(ref):
            dst = ref.rsplit(":", 1)[1]
            for lead in ("refs/heads/", "heads/"):
                if dst.startswith(lead):
                    dst = dst[len(lead) :]
            if dst == "main":
                return f"`git push {ref.replace(DYN, '...')}` writes another ref onto main"
    return None


def _force_flag(sub: str, args: list[str], value_long: tuple[str, ...], value_short: str, *names: str) -> str | None:
    longs, shorts, _ = scan(args, value_long, value_short)
    hit = _has(longs, *names)
    if hit or "f" in shorts:
        return f"`git {sub} {hit or '-f'}` discards or overrides without asking"
    return None


def judge_git(args: list[str]) -> str | None:
    i = 0
    config: list[str] = []
    while i < len(args):
        a = args[i]
        if a in ("-c", "--config-env"):
            config.append(args[i + 1] if i + 1 < len(args) else "")
            i += 2
        elif a.startswith("--config-env="):
            config.append(a.split("=", 1)[1])
            i += 1
        elif a in _GIT_GLOBAL_VALUES:
            i += 2
        elif a.startswith("-"):
            i += 1
        else:
            break
    for entry in config:
        if entry.split("=", 1)[0].strip().lower() == "core.hookspath":
            return "`git -c core.hooksPath=...` swaps out the git hooks, the pre-push guard included"
    if i >= len(args):
        return None
    sub, rest = args[i], args[i + 1 :]
    if sub == "push":
        return _push(rest)
    if sub == "reset":
        hit = _has(scan(rest)[0], "--hard")
        return f"`git reset {hit}` discards uncommitted work" if hit else None
    if sub == "clean":
        longs, shorts, _ = scan(rest, ("--exclude",), "e")
        forced = _has(longs, "--force") or "f" in shorts
        dry = _has(longs, "--dry-run") or "n" in shorts
        return "`git clean` with force deletes untracked files" if forced and not dry else None
    if sub == "checkout":
        return _force_flag(sub, rest, ("--orphan", "--conflict", "--pathspec-from-file"), "bB", "--force", "--discard-changes")
    if sub == "switch":
        return _force_flag(sub, rest, ("--orphan", "--create", "--force-create", "--conflict"), "cC", "--force", "--discard-changes")
    if sub == "add":
        return _force_flag(sub, rest, ("--chmod", "--pathspec-from-file"), "", "--force")
    if sub == "worktree":
        if rest and rest[0] == "remove":
            return _force_flag("worktree remove", rest[1:], (), "", "--force")
        return None
    if sub in ("fetch", "pull", "clone", "ls-remote"):
        hit = _has(scan(rest)[0], "--upload-pack")
        return f"`git {sub} {hit}` runs a program of the caller's choosing" if hit else None
    if sub in _LOG_FAMILY:
        hit = _has(scan(rest, _LOG_VALUES, "SGnLO")[0], "--output")
        return f"`git {sub} {hit}` writes a file of the caller's choosing" if hit else None
    return None


# gh uses pflag: long options are exact, short ones cluster, and a value may follow as `=v`, the next word, or (short) the rest of the cluster.
_GH_DENIED = {
    ("pr", "merge"): "ship-bot is the only merger",
    ("repo", "delete"): "it deletes a repository",
    ("repo", "rename"): "it renames a repository",
    ("run", "delete"): "it deletes a run's record",
    ("label", "delete"): "labels are what ship-bot reads",
    ("label", "edit"): "labels are what ship-bot reads",
    ("release", "delete"): "it deletes a release",
    ("secret", "delete"): "it deletes a secret",
    ("secret", "remove"): "it deletes a secret",
    ("variable", "delete"): "it deletes a variable",
    ("variable", "remove"): "it deletes a variable",
}
# (path): (long flag, short letter, short letters that take a value, long flags that take a value, why)
_GH_FLAGGED = {
    ("pr", "close"): ("--delete-branch", "d", "cR", ("--comment", "--repo"), "it deletes the branch"),
    ("label", "create"): ("--force", "f", "cdR", ("--color", "--description", "--repo"), "it overwrites an existing label"),
    ("repo", "edit"): ("--visibility", "", "dh", ("--description", "--homepage", "--add-topic", "--remove-topic", "--default-branch"), "it changes who can see a repository"),
}
_API_VALUE_SHORT = "XHfFqtp"
_API_VALUE_LONG = ("--method", "--header", "--raw-field", "--field", "--jq", "--template", "--preview", "--input", "--hostname", "--cache")
# A mutation is a call: its name, then `(`. The same name inside a GraphQL string (a review reply quoting a rule) is text.
_GQL_STRING = re.compile(r'"""[\s\S]*?"""|"(?:\\.|[^"\\])*"')
_MERGE_MUTATION = re.compile(r"\b(?:mergePullRequest|\w*AutoMerge|enqueuePullRequest|mergeBranch)\s*\(")
_MERGE_ENDPOINT = re.compile(r"(?:^|/)pulls/[^/]+/merge/?(?:\?.*)?$|(?:^|/)merges/?(?:\?.*)?$")


def _gh_flags(args: list[str], value_short: str, value_long: tuple[str, ...]) -> tuple[dict[str, list[str]], list[str]]:
    """Flags (long name or short letter -> values, "" for a bare flag) and positionals."""
    flags: dict[str, list[str]] = {}
    positional: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional += args[i + 1 :]
            break
        if a.startswith("--"):
            name, eq, value = a.partition("=")
            if not eq and name in value_long and i + 1 < len(args):
                i += 1
                value = args[i]
            flags.setdefault(name, []).append(value)
        elif a.startswith("-") and len(a) > 1:
            for j, ch in enumerate(a[1:]):
                if ch in value_short:
                    value = a[j + 2 :].lstrip("=")
                    if not value and i + 1 < len(args):
                        i += 1
                        value = args[i]
                    flags.setdefault(ch, []).append(value)
                    break
                flags.setdefault(ch, []).append("")
        else:
            positional.append(a)
        i += 1
    return flags, positional


def _gh_api(args: list[str]) -> str | None:
    flags, positional = _gh_flags(args, _API_VALUE_SHORT, _API_VALUE_LONG)
    if "--hostname" in flags:
        return "`gh api --hostname` sends the token to another host"
    methods = [m.strip().upper() for m in flags.get("X", []) + flags.get("--method", [])]
    if "DELETE" in methods:
        return "`gh api` with method DELETE deletes through the REST API"
    fields = flags.get("f", []) + flags.get("F", []) + flags.get("--raw-field", []) + flags.get("--field", [])
    method = methods[-1] if methods else ("POST" if fields or "--input" in flags else "GET")
    endpoint = positional[0] if positional else ""
    if method != "GET" and _MERGE_ENDPOINT.search(endpoint):
        return "`gh api` on a merge endpoint merges without ship-bot"
    if endpoint.strip("/") == "graphql":
        for field in fields:
            key, _, value = field.partition("=")
            if key == "query" and _MERGE_MUTATION.search(_GQL_STRING.sub('""', value)):
                return "`gh api graphql` with a merge mutation merges without ship-bot"
    if method != "GET" and "git/refs" in endpoint:
        for field in fields:
            key, _, value = field.partition("=")
            if key == "force" and value.strip().lower() not in ("false", "0", ""):
                return "`gh api` on git/refs with force is a force push"
    return None


def judge_gh(args: list[str]) -> str | None:
    path: list[str] = []
    i = 0
    while i < len(args) and len(path) < 2:
        a = args[i]
        if a in ("-R", "--repo"):
            i += 2
            continue
        if not a.startswith("-"):
            path.append(a)
            if a == "api":
                break
        i += 1
    rest = args[i + 1 :] if path and path[-1] == "api" else args[i:]
    if path[:1] == ["api"]:
        return _gh_api(rest)
    key = tuple(path)
    if key in _GH_DENIED:
        return f"`gh {' '.join(key)}`: {_GH_DENIED[key]}"
    if key in _GH_FLAGGED:
        long_flag, short, value_short, value_long, why = _GH_FLAGGED[key]
        flags, _ = _gh_flags(rest, value_short, value_long)
        on = [v for v in flags.get(long_flag, []) + (flags.get(short, []) if short else []) if v.lower() != "false"]
        if on:
            return f"`gh {' '.join(key)} {long_flag}`: {why}"
    return None


def judge(words: list[str], depth: int = 0) -> str | None:
    """Why one simple command is refused, or None."""
    if depth > MAX_DEPTH:
        return None
    i = 0
    while i < len(words) and (words[i] in _KEYWORDS or _ASSIGN.match(words[i])):
        i += 1
    words = words[i:]
    if not words:
        return None
    name, args = words[0].rsplit("/", 1)[-1], words[1:]
    if name == "git":
        return judge_git(args)
    if name == "gh":
        return judge_gh(args)
    if name in _PREFIXES:
        j = 0
        takes = _PREFIX_VALUES.get(name, ())
        while j < len(args) and (args[j].startswith("-") or _ASSIGN.match(args[j])):
            j += 2 if args[j] in takes else 1
        if name == "timeout":
            j += 1  # the duration
        return judge(args[j:], depth + 1)
    if name in _SHELLS:
        j = 0
        while j < len(args):
            a = args[j]
            if not a:
                break
            if a.startswith("-") and not a.startswith("--") and "c" in a:
                return judge_text(args[j + 1] if j + 1 < len(args) else "", depth + 1)
            if a[:1] in "-+" and not a.startswith(("--", "++")) and a[-1:] in "oO":
                j += 1  # -o pipefail, -euo pipefail, -O extglob: the next word is the option's value
            elif a[:1] not in "-+":
                break
            j += 1
        return None
    if name == "eval":
        return judge_text(" ".join(args), depth + 1)
    if name == "ssh":
        for a in args[1:]:
            if re.search(r"\s", a):
                why = judge_text(a, depth + 1)
                if why:
                    return why
        return None
    if name == "hc":
        if args[:1] and args[0] in ("run", "exec") and "--" in args:
            inner = args[args.index("--") + 1 :]
            if len(inner) == 1 and re.search(r"\s", inner[0]):
                return judge_text(inner[0], depth + 1)  # hc run -- 'git push -f ...'
            return judge(inner, depth + 1)
        return None
    if name == "gate-run":
        inner = args[1:]
        if len(inner) == 1:
            return judge_text(inner[0], depth + 1)
        return judge(inner, depth + 1)
    return None


def judge_text(text: str, depth: int = 0) -> str | None:
    commands: list = []
    parse(text, commands, depth)
    for words in commands:
        why = judge(words, depth)
        if why:
            return why
    return None


def verdict(command: str) -> str | None:
    """Return why the command is refused, or None to let it pass. Anything unreadable passes."""
    try:
        return judge_text(command)
    except (Unparsed, RecursionError, IndexError):
        return None


MESSAGE = (
    "argv-guard (plan row 5.14) refused this command: {why}. "
    "settings.json denies this class of command, and the guard reads the parsed "
    "arguments, so an abbreviated, clustered, quoted or wrapped spelling counts too. "
    "Instead: push a branch, open a PR and add the label; ship-bot is the only merger. "
    "To drop local work, say what would be lost and let the owner decide. "
    "If this was text you were writing (a PR body, a doc, a search pattern), keep it "
    "inside quotes as an argument, or write it with the Write tool and pass the file."
)


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
