# ~/.claude hooks

Record copies of the hooks in `~/.claude/hooks/`, and `plugin-usage.py`. The live files are there. They're code with tests, so they stayed in this repository when plan row 1.30 moved the rest of the `~/.claude` copy (rules, agents, skills, settings) to private `gorfednet/ops` `control/claude-home/`. They were in `docs/claude-home/` until then.

## gh-poll-guard.py (plan row 5.10)

A `PreToolUse` hook on Bash and Monitor. It refuses GitHub polling in code that runs:

- a `while`/`until` loop that calls `gh` or `review-status.mjs`;
- a counted `for` loop (`seq`, `{1..N}`) that calls them and sleeps;
- a `while`/`until` busy-wait (`do :; done`);
- `gh run watch` or `gh pr checks --watch` without `--interval 60`, and `watch … gh`.

Quoted text and heredocs written to a doc are data, so writing up or searching for a loop isn't refused. A string passed to `bash -c`, `eval` or `ssh`, and a heredoc fed to a shell or a `.sh` file, are code.

The refusal tells the session to start one `gh run watch <id> --interval 60 --exit-status` with `run_in_background`.

- Why: on 13 November 2026 the 5,000-an-hour quota hit 0 twice. Default-interval watchers and 3 session poll loops drained it, and one busy-wait spun a core for 3.5 hours.
- Settings entry: `gh-poll-guard.settings.json`, merged into the `hooks` block of `~/.claude/settings.json`.
- Tests: `test/ghPollGuard.test.mjs`, run by the verification-kit workflow. The 3 real commands are in `test/fixtures/gh-poll-guard/`.
- It fails open. Bad input or an internal error lets the command run.
- Not covered: a script written with the Write tool and run by name, a shell function that wraps `gh`, zsh `repeat`, and `curl` to api.github.com.

Install it as a copy of this file at origin/main, never from a working checkout: `git -C <.github clone>/.claude/worktrees/gates-main show HEAD:scripts/claude-hooks/gh-poll-guard.py > ~/.claude/hooks/gh-poll-guard.py`. The entry goes in `~/.claude/settings.json`. fleet-status's "Installed tools behind main" row compares the installed copy with every committed version and reports how far behind it is.

## always-pr-remind.py

A `PostToolUse` hook on Bash. After a commit or push on a feature branch it reminds the session to open a PR when the branch has none.

- It reads the PR with `gh pr view --json url,state`. Only the "no pull requests found" message from gh means no PR. Any other gh failure says it could not check.
- Fixed 14 November 2026: the call was `--json url state`, gh took `state` as the PR selector, and open PRs were reported as missing.
- Tests: `test/alwaysPrRemind.test.mjs`, with a stub `gh` on PATH.
- It fails open.
- Install it the same way as gh-poll-guard.py: a copy of this file at origin/main.

## public-push-guard.mjs: a git pre-push hook (plan row 1.30g)

Keeps private detail (private addresses, session ids, tailnet and internal host names, private repository names, owner quotes) out of pushes to public repositories. It replaces the shell-text parser of .github 216, which refused everyday commands.

- Git runs it, so the shell spelling of the push doesn't matter. It reads the remote URL and the refs and shas git is about to send: branches, tags, `--all`, `--mirror`, a push from a worktree.
- Outgoing commits are those reachable from the sent shas and not from anything the remote holds now. The hook asks the remote with `git ls-remote` (tracking refs go stale, or point at another repository after a `set-url`) and refuses the push when it can't. `scripts/privacy-guard.mjs` reads them (messages, every commit's diff, the net diff). The hook itself reads ref names and annotated tag messages. A delete sends no commits and passes.
- A repository on the local private list passes untouched. A remote that is a path on this machine (or `file://`) publishes nothing and passes. Any other remote, including one it has never heard of, counts as public, after one `gh` refresh of the list: a repository made since the list was cut (`gh repo create --private --push`) is on it by then.
- The target repository's `.github/privacy-guard-allow.txt` `repo` lines are read the way the CI guard reads them: from a published base (the push's, then `origin`'s default branch), never the working tree, so a push can't clear itself. A name a line clears isn't flagged in ref names, tag messages or gh text.
- The list is `~/.claude/git-hooks/private-repos.txt`, one `owner/name` a line. It is refreshed from `gh repo list` at install and, at most once a day, by the first push after it goes stale. A failed refresh is ignored (the list stands, retry in an hour). A push asks `gh` only for that refresh of the whole list, never about a single repository. It can't live in this public repository because it names private ones.
- Once the remote is public it fails closed: a missing or empty list, a missing guard script, a root commit with no published ancestor or a crash all refuse. Exit 1 blocks the push.

Install it (copies from origin/main, never a working tree):

```bash
bash scripts/claude-hooks/install-git-hooks.sh
```

It puts `hook` under every client hook name in `~/.claude/git-hooks` and sets the global `core.hooksPath` there. `hook` runs the repository's own hook of the same name afterwards, with the same arguments and input, because a global `core.hooksPath` hides `.git/hooks`. That includes the receive-side hooks of a local repository you push to. `proc-receive` (a two-way protocol) isn't chained. It stops if `core.hooksPath` already points somewhere else. `push-to-checkout` isn't linked: it would replace git's own working-tree update. Every file is written through a temp file and renamed, so a failed install keeps the old hooks. The hook runs the Node the installer resolved (`scripts/lib/resolve-node.sh`, recorded in `node-path`).

- A clone with its own local `core.hooksPath` (husky, `.githooks`) skips the global hook. The installer lists those clones. For a public one, add `node ~/.claude/git-hooks/public-push-guard.mjs "$@"` to its own pre-push hook.
- `git push --no-verify` skips every git hook. Its deny entry goes in `control/claude-home/settings.json` in `gorfednet/ops`.
- Tests: `test/publicPushGuard.test.mjs` installs the hook into a throwaway HOME and pushes to a local bare repository through an insteadOf rewrite of a fake github.com URL. The values it plants are invented and built at run time.

## public-gh-text-guard.mjs: a best-effort PreToolUse hook

Reads the literal text of `gh pr|issue|release create|edit|comment|review`: quoted `--body`, `--title` and `--notes`, heredoc bodies in the same command, and a literal `--body-file`. It refuses only when it finds a private value in text it could read, and only when the repository it posts to isn't on the private list. That is `-R`/`--repo` from gh's own words (never one inside a quoted body), else `GH_REPO` set in the command, else the clone: the directory of the last leading `cd <dir> &&`, or the hook's. A `cd` target it can't read lets the command run. `gh` picks the upstream, github or origin remote, so a clone counts as private only when all its GitHub remotes are. A command it can't parse, a body from a variable or a script and any error let the command run. A repository it can't classify (an ssh host alias, no clone) is read like a public one, as the push hook reads it. Text can be edited after posting, so this is a first line, not a gate. Settings entry: `public-gh-text-guard.settings.json`. It is installed by the same script.
