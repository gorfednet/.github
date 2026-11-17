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

## argv-guard.py (plan row 5.14)

A `PreToolUse` hook on Bash. It refuses the git and gh commands the settings deny list refuses, in spellings a glob can't see. The deny list matches the command text. This hook splits the command into simple commands, strips the quoting and reads the arguments.

- It reads through `git -C <dir>`, `git -c k=v`, a path to `git` or `gh`, `hc run ... --`, `gate-run <repo> '<cmd>'`, `bash -c`, `eval`, `env` and `ssh host "<cmd>"`.
- It reads every command in a chain (`&&`, `;`, `|`, a new line), a subshell, a `$(...)` and backticks. Backticks inside double quotes run, so they count.
- A long git option counts at any prefix (`--forc`, `--force-with-l`, `--upl=x`), which is how git resolves it. Short flags are read out of a cluster (`-Af`, `-fu`). A value glued to a flag (`-bfix`, `-o ci.skip`) is not a flag.
- `git push`: force (`-f`, `--force*`, `+ref`), `--delete`, `:ref`, `--mirror`, `--prune`, `--no-verify`, `--exec`, `--receive-pack`, and any `src:main` refspec (`HEAD:main`, `x:refs/heads/main`). A plain `git push origin main` passes: release steps use it.
- Other git: `reset --hard`, `clean` with force and no dry run, `-f` or `--force` on `checkout`, `switch`, `add` and `worktree remove`, `switch --discard-changes`, `--upload-pack`, `--output` on the log family, and `-c core.hooksPath=` in any case.
- gh: `pr merge`, `repo delete`, `repo rename`, `repo edit --visibility`, `run delete`, `release delete`, `label delete`, `label edit`, `label create --force`, `secret` and `variable` `delete` or `remove`, `pr close --delete-branch`, `auth token` and `auth status --show-token`. The last two pass inside `$(...)`, where the token is captured and never printed.
- `gh api`: `--hostname`, method DELETE, a write to `pulls/N/merge` or `merges`, a merge mutation on `graphql`, and `force` on `git/refs`. A mutation named inside a GraphQL string is text.
- Text is data. A PR body, a commit message, a heredoc written to a file, a search pattern and an `echo` can all name a refused command.
- It never fails closed. A variable in flag position, an unbalanced quote, an unknown wrapper or an internal error passes. The settings deny list and the auto-mode classifier still read that command.
- Settings entry: `argv-guard.settings.json`, merged into the `hooks` block of `~/.claude/settings.json`. The record of that file is in private ops `control/claude-home/`.
- Tests: `test/argvGuard.test.mjs`. `test/fixtures/argv-guard/cases.json` holds the residual and everyday commands from the settings case table and the 30 most common git and gh commands in the fleet's transcripts. Every residual one is refused. No everyday or fleet one is.
- Not covered: a script written to a file and run by name, a shell function or alias that wraps `git` or `gh`, `xargs git ...`, and a flag held in a variable.
- Install it the same way as gh-poll-guard.py: a copy of this file at origin/main.

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
- A repository on the local private list passes untouched. A remote that is a path on this machine (or `file://`) publishes nothing and passes. Any other remote, including one it has never heard of, counts as public. For a `gorfednet/` repository that isn't on the list yet, the hook asks `gh` for the whole list once more first: a repository made since the list was cut (`gh repo create --private --push`) is on it by then. Other owners are never looked up.
- The target repository's `.github/privacy-guard-allow.txt` is read from the remote's default branch tip, as `git ls-remote` reports it now (fetched when this clone is behind), never from the working tree, the push's own base or any commit the pusher sent. A change in the push can't clear itself, and a branch cut before an exemption landed still sees it. The file goes to `privacy-guard.mjs` with `--allow`. A name a `repo` line clears isn't flagged in ref names or tag messages.
- The list is `~/.claude/git-hooks/private-repos.txt`, one `owner/name` a line. It is refreshed from `gh repo list gorfednet` at install, at most once a day by the first push after it goes stale, and by the one extra ask above. A failed refresh is ignored (the list stands, retry in an hour). `gh` is only ever asked for the whole list, never about one repository. The list can't live in this public repository because it names private ones.
- Known limitation: the first push to an empty remote that is public, or not on the list after the extra ask, is refused whatever it holds. An empty remote has no published commit to diff against, so the hook can't tell outgoing commits from published ones, and it fails closed. Create the repository with its first commit by hand (the web UI or `gh repo create --add-readme`), then push. A private repository made since the list was cut is not caught by this: the extra ask puts it on the list first.
- Once the remote is public it fails closed: a missing or empty list, a missing guard script, a root commit with no published ancestor or a crash all refuse. Exit 1 blocks the push.

Install it (copies from origin/main, never a working tree):

```bash
bash scripts/claude-hooks/install-git-hooks.sh
```

It puts `hook` in `~/.claude/git-hooks` under every client hook name (`pre-commit`, `commit-msg`, `post-checkout`, `pre-push` and the rest of `git help hooks`) and the four receive-side names (`pre-receive`, `update`, `post-receive`, `post-update`, which fire only inside the repository being pushed to). A global `core.hooksPath` hides every repository's `.git/hooks`, so any name left out would stop running in every clone, wherever it lives and whenever its hook was added. `hook` runs the repository's own hook of the same name afterwards, with the same arguments and input, and leaves at once when there is none. That includes the receive-side hooks of any local repository you push to, bare or not, inside `AUDIT_ROOT` or not. Two names are the exception, because they fire on nearly every git command (`reference-transaction` on each ref update, `post-index-change` on each index write) and linking them slowed git-heavy suites several times over: they are linked only when a clone under `AUDIT_ROOT` (default `~/Developer/gorfednet`) has its own hook of that name, so a hook of either name added later needs a new install. Never linked: `push-to-checkout` (it would replace git's own working-tree update), `proc-receive` (a two-way protocol) and `fsmonitor-watchman` (git expects its output). The installer sets the global `core.hooksPath` and stops if it already points somewhere else. Every file is written through a temp file and renamed, so a failed install keeps the old hooks. The hook runs the Node the installer resolved (`scripts/lib/resolve-node.sh`, recorded in `node-path`).

- A clone with its own local `core.hooksPath` (husky, `.githooks`) skips the global hook. The installer lists those clones. For a public one, add `node ~/.claude/git-hooks/public-push-guard.mjs "$@"` to its own pre-push hook.
- `git push --no-verify` skips every git hook. Its deny entry goes in `control/claude-home/settings.json` in `gorfednet/ops`.
- Tests: `test/publicPushGuard.test.mjs` installs the hook into a throwaway HOME and pushes to a local bare repository through an insteadOf rewrite of a fake github.com URL. The values it plants are invented and built at run time.
