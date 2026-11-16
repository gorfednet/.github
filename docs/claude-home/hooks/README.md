# claude-home hooks

Record copies of the hooks in `~/.claude/hooks/`. The live files are there.

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

Install it as a copy of this file at origin/main, never from a working checkout: `git -C <.github clone>/.claude/worktrees/gates-main show HEAD:docs/claude-home/hooks/gh-poll-guard.py > ~/.claude/hooks/gh-poll-guard.py`. The entry goes in `~/.claude/settings.json`. fleet-status's "Installed tools behind main" row compares the installed copy with every committed version and reports how far behind it is.

## always-pr-remind.py

A `PostToolUse` hook on Bash. After a commit or push on a feature branch it reminds the session to open a PR when the branch has none.

- It reads the PR with `gh pr view --json url,state`. Only the "no pull requests found" message from gh means no PR. Any other gh failure says it could not check.
- Fixed 14 November 2026: the call was `--json url state`, gh took `state` as the PR selector, and open PRs were reported as missing.
- Tests: `test/alwaysPrRemind.test.mjs`, with a stub `gh` on PATH.
- It fails open.
- Install it the same way as gh-poll-guard.py: a copy of this file at origin/main.

## public-push-guard.sh and public-push-guard.mjs (plan row 1.30 f)

A `PreToolUse` hook on Bash. The `.sh` skips commands that can't be a push and fails closed; the `.mjs` does the work. It runs before a `git push` or a `gh` write that targets a public repository and refuses the call when it would publish private detail.

- **Reads the command as a shell would.** Quotes, line continuations, subshells, `$(...)`, `bash -c`, `eval`, `cd`, `pushd`, `-C`, `--git-dir`, `GIT_DIR=`, `command`, `env`, `time` and a full path to git are all resolved. A directory it can't work out is refused. A command it can't read that mentions `push` is checked as a push from the working directory.
- **Reads the repository as it is before the command runs.** A push that follows a commit, merge, checkout, clone or similar in the same command, to a public repository, is refused: commit in one call and push in the next. A ref that resolves to nothing is refused too.
- **Reads every ref the push sends.** Named refspecs, `--all`, `--mirror`, `--tags`, `--follow-tags`, `tag <name>`, globs, `push.default=matching` and a configured `remote.<name>.push`. `push.default=nothing` doesn't switch it off: `--all`, `--mirror`, `--tags` and a configured push still send. A `git fetch` with a destination refspec counts as a change, like a commit. A brace, a glob, a lone `:` or an unset variable reads every local branch. A delete publishes nothing and passes.
- **Reads every outgoing commit.** What counts as outgoing comes from `git ls-remote`, not from tracking refs, which go stale. Each commit's own diff and message are scanned, and the whole range once more for merge commits. A value added in one commit and removed in the next is refused. Annotated tag messages are read. A merge commit is read through its combined diff (what it adds beyond every parent), with the repository's exemptions applied. A root commit, or a push of more than 150 commits, is refused.
- **Reads text.** The command text and any `--body-file` of `gh pr create|edit|comment|review|merge|close`, `gh issue create|edit|comment|close`, `gh release create|edit`, `gh repo edit`, `gh label create|edit` and `gh api` writes (a write whose endpoint names no repository, such as a graphql mutation, is read as if the target were public), with the repository taken from `--repo`, `-R`, `GH_REPO`, a GitHub URL as the selector right after the action (never one inside a body) or the `repos/<owner>/<name>` endpoint, and any file named by `--body-file`, `--notes-file`, `--input` or `-F name=@file` (not `-f`) read too (stdin is refused). `gh pr create` also reads the push it may make.
- **Refuses to make a repository public:** `gh repo edit --visibility public`, `gh repo create --public`, and an api write that sets it.
- **Visibility:** `gh repo view`, cached for the session when public and for 5 minutes when private, under a hashed file name. If gh is down, a repository seen private within the hour passes; any other unknown is refused.
- **The guard:** `scripts/privacy-guard.mjs` from `gorfednet/.github` main, fetched to a temp file, syntax-checked and renamed into place, and re-read every 30 minutes. If main's copy is broken, the last good copy runs. The `.github` allowlist applies to `.github` only; another public repository uses its own copy at the nearest published commit, so an exemption added in the same push has no effect.
- **The private list:** `gh repo list gorfednet --visibility private` on each run. It is held in memory and passed to the guard in its environment, which the guard's git children inherit (same user only). Never written to disk. A finding names the rule and the place, never the value; a path that holds a value shows as a hash.
- **Fails closed.** Claude Code lets a call through when a hook exits 1, crashes or times out, so every failure ends in a deny decision, every outside call has its own timeout, and the whole run has a 150 s budget inside the 200 s hook timeout.
- The guard and allowlist overrides (`PUBLIC_PUSH_GUARD_SCRIPT`, `PUBLIC_PUSH_GUARD_ALLOW`) work only with `PUBLIC_PUSH_GUARD_TEST=1`, which tests set and a live session never does.
- Install: copy `public-push-guard.sh` and `public-push-guard.mjs` to `~/.claude/hooks/`, `chmod +x`, and merge `public-push-guard.settings.json` into `~/.claude/settings.json`. Needs `node` and a signed-in `gh`. `fleet-status` reports a stale or absent copy.
- Tests: `test/publicPushGuard.test.mjs`, with a stub `gh` and a local bare repository behind a fake GitHub URL.
- **Not covered:** a push from a script file or shell function, `git subtree push`, submodules, git aliases, extra push URLs, text posted through a variable it has no value for, `gh gist`, `gh release upload`, and any push made outside Claude Code. The pull request check still runs on those. Bare repository names in files (not `gorfednet/<name>`) are not caught until the guard learns them (a follow-up to the guard).
- Why: the pull request check runs after the push, when the branch is already world-readable. Force push and branch delete are denied on public repositories, so a push can't be taken back.
