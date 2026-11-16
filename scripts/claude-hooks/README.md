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

## public-push-guard.sh and public-push-guard.mjs (plan row 1.30 f)

A `PreToolUse` hook on Bash. The `.sh` is a fast first filter that fails closed; the `.mjs` does the work. It runs before a `git push` or a `gh` write and refuses the call when it would publish private detail to a public repository.

- **One plain command, or refused.** If a command could push or write to GitHub anywhere in it (a `push` word, a `gh` write verb, `gh api` with a write method or `-f`/`-F`/`--input`, in any spelling), it is checked only when it is one plain command read in full: `git` or `gh` as the first word, a literal directory, no pipe, `;`, loop, `if`, `case`, wrapper (`time`, `sudo`, `xargs`, `command`, `bash -c`, `eval`), variable, command substitution, glob, brace or `--work-tree`. Anything else is refused, whatever the repository: run the push or gh write as one plain command from the target directory, with a literal `--body-file`. A leading `cd <existing directory> &&` is allowed, since a failed cd stops the rest. A commit and a push go in separate calls. A git subcommand that isn't a push is refused too when its arguments mention `push` or `gh`, or hold `git` behind an expansion (`rebase -x 'git push …'`, `bisect run`, `submodule foreach`, `-c alias.p=push`); commit, log, status and the other subcommands that run no command pass, whatever their message says. A here-document with an unquoted delimiter is refused when its body holds `$`, a backtick or `git`, since the shell expands it before the text is posted: quote the delimiter (`<<'EOF'`).
- **Pushes.** Every ref the push sends (named refspecs, `--all`, `--mirror`, `--tags`, `--follow-tags`, `tag <name>`, globs, `push.default=matching`, a configured `remote.<name>.push`; `push.default=nothing` doesn't switch it off), minus what the remote already holds (`git ls-remote`, not stale tracking refs). Each outgoing commit is scanned on its own, so add-then-remove is seen, and the whole range once more. A merge commit is read through its combined diff, with the repository's exemptions applied. Annotated tag messages and branch and tag names are read. A root commit, or more than 150 commits, is refused. A push option it doesn't know is refused. `git -c key=value` settings are applied when reading the target. A delete passes.
- **Text.** The command text, a `--body-file` (also from a here-document), `--notes-file`, `--input` or `-F name=@file` (not `-f`), for `gh pr create|edit|comment|review|merge|close|reopen`, `gh issue create|edit|comment|close|reopen`, `gh release create|edit`, `gh repo edit`, `gh label create|edit` and `gh api` writes (`-X GET` is a read). The repositories checked are the working directory's GitHub remotes plus `--repo`, `GH_REPO`, any github.com URL in the arguments, and the `repos/<owner>/<name>` endpoint; `{owner}/{repo}` is the working directory's. A write that names no repository, from a directory that isn't one, is read as public. `gh pr create` also reads the push it may make.
- **Refuses to make a repository public:** `gh repo edit --visibility public`, `gh repo create --public`, an api write that sets it.
- **Visibility:** `gh repo view`, cached for the session when public and for 5 minutes when private, under a hashed file name. If gh is down, a repository seen private within the hour passes; any other unknown is refused.
- **The guard:** `scripts/privacy-guard.mjs` from `gorfednet/.github` main, fetched to a temp file, syntax-checked, renamed into place and re-read every 30 minutes; if main's copy is broken, the last good copy runs. The `.github` allowlist applies to `.github` only; another public repository uses its own copy at the nearest published commit. The guard and allowlist overrides work only with `PUBLIC_PUSH_GUARD_TEST=1`, which tests set and a live session never does.
- **The private list:** `gh repo list gorfednet --visibility private` on each run, held in memory and passed to the guard in its environment (same user only). Never written to disk. A finding names the rule and the place, never the value; a path or name that holds a value shows as a hash.
- **Fails closed.** Claude Code lets a call through when a hook exits 1, crashes or times out, so every failure ends in a deny decision, each outside call has a timeout, and the run has a 150 s budget inside the 200 s hook timeout.
- Install: copy `public-push-guard.sh` and `public-push-guard.mjs` to `~/.claude/hooks/`, `chmod +x`, and merge `public-push-guard.settings.json` into `~/.claude/settings.json`. Needs `node` and a signed-in `gh`. `fleet-status` reports a stale copy.
- Tests: `test/publicPushGuard.test.mjs`, with a stub `gh` and a local bare repository behind a fake GitHub URL.
- **Not covered:** `git subtree push`, submodules, git aliases, extra push URLs, text posted through a variable it can't resolve (those commands are refused instead), `gh gist`, `gh release upload`, a graphql mutation sent from a private repository to a public one by node id, and any push made outside Claude Code. The pull request check still runs on those. Bare repository names in files (not `gorfednet/<name>`) are the guard's job.
- Why: the pull request check runs after the push, when the branch is already world-readable. Force push and branch delete are denied on public repositories, so a push can't be taken back.
