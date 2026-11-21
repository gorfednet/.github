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

A `PreToolUse` hook on Bash and Monitor. It refuses the git and gh commands the settings deny list refuses, in spellings a glob can't see. The deny list matches the command text. This hook splits the command into simple commands, strips the quoting and reads the arguments.

- It reads through `git -C <dir>`, `git -c k=v`, a path to `git` or `gh`, `hc run ... --`, `gate-run <repo> '<cmd>'`, `bash -c`, `eval`, `env`, `nice`, `sudo`, `timeout` and `ssh host "<cmd>"`. Options that take a value are skipped (`env -u X`, `nice -n 5`, `bash -o pipefail -c`). An unquoted heredoc has its `$(...)` and backticks read, because the shell runs them.
- **ssh reach is kept.** The remote command in `ssh host "..."` is judged like a local one, which the settings globs never did. `ssh -t host "git reset --hard"`, `git clean -fd` and `git checkout -f` are refused there too. It matches the `hc *git reset --hard*` policy in settings: a destructive command is refused on another host as it is on this one. Only a quoted remote command is read: `ssh host git reset --hard` (unquoted) and `ssh host bash -s <<EOF` are not.
- It reads every command in a chain (`&&`, `;`, `|`, a new line), a subshell, a `$(...)` and backticks. Backticks inside double quotes run, so they count.
- A long git option counts at any prefix (`--forc`, `--force-with-l`, `--upl=x`), which is how git resolves it. Short flags are read out of a cluster (`-Af`, `-fu`). A value glued to a flag (`-bfix`, `-o ci.skip`) is not a flag.
- `git push`: force (`-f`, `--force*`, `+ref`), `--delete`, `:ref`, `--mirror`, `--prune`, `--no-verify`, `--exec`, `--receive-pack`, and any `src:main` refspec (`HEAD:main`, `x:refs/heads/main`). A plain `git push origin main` passes: release steps use it.
- Other git: `reset --hard`, `clean` with force and no dry run, `-f` or `--force` on `checkout`, `switch`, `add` and `worktree remove`, `switch --discard-changes`, `--upload-pack`, `--output` on the log family, and `-c core.hooksPath=` in any case.
- gh: `pr merge`, `repo delete`, `repo rename`, `repo edit --visibility`, `run delete`, `release delete`, `label delete`, `label edit`, `label create --force`, `secret` and `variable` `delete` or `remove`, and `pr close --delete-branch`. `gh auth token` and `gh auth status --show-token` are not read here: where a captured token goes is data flow, which arguments don't show. Settings keeps the bare forms.
- `gh api`: `--hostname`, method DELETE, a write to `pulls/N/merge` or `merges`, a merge mutation on `graphql`, and `force` on `git/refs`. A mutation named inside a GraphQL string is text.
- Text is data. A PR body, a commit message, a heredoc written to a file, a search pattern and an `echo` can all name a refused command.
- It never fails closed. A variable in flag position, an unbalanced quote, an unknown wrapper or an internal error passes. The settings deny list and the auto-mode classifier still read that command.
- Settings entry: `argv-guard.settings.json`, merged into the `hooks` block of `~/.claude/settings.json`. The command is `python3 -I ~/.claude/hooks/argv-guard.py || true`: a deny is exit 0 plus JSON, so `|| true` hides nothing, and a missing hook file (settings copied before the hook) lets every command through instead of blocking all of them. Install the hook file first anyway. The record of that file is in private ops `control/claude-home/`.
- Tests: `test/argvGuard.test.mjs`. `test/fixtures/argv-guard/cases.json` holds the residual and everyday commands from the settings case table and the 30 most common git and gh commands in the fleet's transcripts. Every residual one is refused. No everyday or fleet one is.
- **Reach is frozen.** The wrapper list above is closed and best-effort. Every other way to reach `git` or `gh` passes by design, and the settings deny list is the backstop. A new wrapper is not a bug in this hook.
- Not covered: a script written to a file and run by name, a shell function or alias that wraps `git` or `gh`, `xargs git ...`, a flag held in a variable, `... | bash` and `bash -s <<EOF` with the command on stdin.
- Known passes, out of scope: `caffeinate -t`, `time -p`, `stdbuf`, `arch`, `find -exec`, `git -c alias.*`, `git rebase --exec`, `git submodule foreach` and `gh api graphql -F query=@file`.
- Install it the same way as gh-poll-guard.py: a copy of this file at origin/main.

## context-cap.py (plan row 1.61)

A `PreToolUse` hook on every tool. Once a session's context passes 200,000 tokens it refuses new work. The refusal tells the session to write `/handoff`, start its successor from it and end the turn.

- Context size is the newest main-chain assistant message's usage in the transcript (`transcript_path`): input plus cache read plus cache creation tokens. 200,000 passes and 200,001 is refused. A compacted session is under the cap again.
- Why: sessions past the cap processed 26% of all tokens in the week of 13 to 19 November 2026, and 3 sessions passed 300,000 on 20 November. The cap was a rule nothing enforced.
- At 180,000 it warns, as context for the model, on each tool call of the reply that crosses that line. Later replies get no warning. The hook keeps no state, so a reply with 3 tool calls gets it 3 times. It refuses nothing there.
- Refused past the cap: `Agent`, `Task`, `Workflow`, `WebFetch`, `WebSearch`, and `Edit`, `Write`, `MultiEdit` or `NotebookEdit` outside the handoff's files.
- The handoff's files: `docs/handoff/<date>-*.md`, `control/handoff/<date>-*.md`, `docs/backlog.json`, a memory file (`~/.claude/projects/*/memory/*.md`) and temp files (`/tmp`, `/private/tmp`, `$TMPDIR`).
- Every other tool passes: `Read`, `Grep`, `Glob`, `Skill`, session tools, MCP tools.
- `Bash` and `Monitor` aren't read in this version. So git, gh, labels (`--remove-label`, `--add-label hold`, `gh pr ready --undo`), cleanup (`hc kill`, `hc rm`, `kill`, `git worktree remove`), waits (`hc wait`) and gate scripts always run. A session can also still do work through the shell. Reading shell commands was cut from this version: each review round found new holes in the allowlist.
- A subagent's calls pass (`agent_id` in the input). Its context isn't this transcript's, and no `Agent` call starts past the cap.
- Desk is exempt up to 300,000, where it's held like any session. Desk is the session whose id is a line in `~/.desk/context-cap-exempt`. An id belongs to 1 session. A session Desk starts inherits Desk's environment and never its id, so none is exempt by accident.
- It fails open. A missing or unreadable transcript, no usage in it, bad input, an unknown event, an internal error and a 4-second alarm all let the call run.
- A refusal is exit 2 with the reason on stderr, the only non-zero exit. So the settings command has no `|| true`. It starts with `[ -r ~/.claude/hooks/context-cap.py ] || exit 0`, because `python3` also exits 2 on a missing script.
- Install order: 1, Desk writes its session id to `~/.desk/context-cap-exempt`, and `/desk-rotate` gains that step for each successor. 2, copy this file at origin/main to `~/.claude/hooks/`, the same way as gh-poll-guard.py. 3, merge `context-cap.settings.json` into the `hooks` block of `~/.claude/settings.json`. Settings before the file lets every call through. Settings before the Desk id holds Desk at 200,000.
- Tests: `test/contextCap.test.mjs`. Test overrides: `CONTEXT_CAP_EXEMPT_FILE`, `CONTEXT_CAP_TEMP_ROOTS`.
- Not covered: work done through `Bash`, `SendMessage` to a subagent that is still running, a skill that forks, and MCP tools that do work. The warning relies on `additionalContext` in a `PreToolUse` hook's output. A client that ignores it loses the warning and keeps the hold.

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

## desk-event.py (plan row 1.56)

A hook on `Stop`, `StopFailure`, `Notification` and `PermissionRequest`. It appends one JSON line to `~/.desk/events.jsonl`, so a control session reads one file instead of polling terminal screens.

- Line: `{"session","cwd","event","kind","at","ts"}` (`ts` is epoch seconds), plus `background_tasks` or `session_crons` (a count) on a `Stop` that arrives with background tasks or scheduled wakes pending (a pause, not a finish; the `session_crons` field is read when present and I haven't seen it in the docs, so a reader treats its absence as no information), plus `permission_mode` on a `PermissionRequest`, plus a `message` (first 200 characters) on a `Notification`. `event` is `turn-ended` (a `Stop`, or a `StopFailure` with `kind` `StopFailure`) or `waiting-on-prompt` (`kind` `permission_request`, `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` or `agent_needs_input`). `at` is Toronto time with its EST or EDT label, from the system zone database.
- `session` is `DESK_SESSION_NAME` when the starter set it (`desk-start` does), else the session id. The hook input has no session name on these events.
- `PermissionRequest` fires when the dialog opens. `Notification` `permission_prompt` follows about 6 seconds later, so a prompt can appear twice. Readers take the first. On a `PermissionRequest` line, tool input and tool name are never copied (a test plants a command and checks the whole line). The `Notification` `message` is copied as it comes, cut at 200 characters: it can name the tool ("Claude needs your permission to use Bash") or carry text an MCP server sent, so treat `events.jsonl` as holding tool names.
- `PermissionRequest` also fires when a call that can't prompt is auto-denied. The hook input has no field that tells that apart from a real dialog (`permission_mode` is recorded as the only hint, and it can't settle it). A real dialog is the one followed, about 6 seconds later, by a `permission_prompt` line from the same session. A `permission_request` with no such line and a later event of another kind was not a dialog.
- It only writes that line. It prints nothing, exits 0 on any error and changes no tool call.
- Docs it rests on (code.claude.com/docs/en/hooks): Stop "runs when the main Claude Code agent has finished responding", API errors fire `StopFailure`. Notification exit code and stderr are ignored. `permission_prompt` fires "about six seconds after Claude asks for permission". `PermissionRequest` ignores exit 2.
- Dialogs with no event: folder trust (hooks wait until it's accepted) and the autocompact size dialog. A read outside the working directory is a permission prompt, so it does report.
- Limits: nothing marks a prompt answered (the next `turn-ended` or later line from that session does), a user interrupt fires no `Stop`, a session started from another session's shell inherits `DESK_SESSION_NAME`, and the file has no rotation yet.
- Settings entry: `desk-event.settings.json`, merged into the `hooks` block of `~/.claude/settings.json`. Install the file the same way as gh-poll-guard.py.
- Tests: `test/deskEvent.test.mjs`.
