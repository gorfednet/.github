# Ship bot

The ship bot merges your pull requests once they are ready, and then puts the
change live. It runs on your Mac every two minutes, uses no GitHub Actions
minutes, and needs nothing from you beyond the label you already use.

## What it does, in plain English

Every two minutes it looks at each of your repositories and, for every open
pull request, asks:

1. Did **you** open it, is it **not a draft**, does it carry the
   **`ready-to-merge`** label, and does it **not** carry **`hold`**?
2. Did **every check pass** on the latest commit, including the specific
   checks that repository is supposed to run? A check that is still running,
   failed, was cancelled, or never ran at all means "not yet".
3. Did the **Claude reviewer review the latest commit**, and either find
   nothing or have **every one of its comments answered**, with a reply
   written after the comment or by resolving it? It reads this with
   `review-status.mjs`. A latest commit the reviewer has not reviewed always
   waits, however many earlier commits it reviewed. The bot never asks for a
   review itself: whether a push needs one is a judgement (a clean merge of
   `main`, a regenerated file, a moved pin or a lint fix does not). After 15
   minutes without one it says so once per commit in a comment: comment
   `claude review` if the push changed code, or merge by hand after saying on
   the pull request which kind of push it was. A repository without the
   reviewer yet is held the same way, and a session merges it after reading
   the diff.
4. Does the description avoid phrases like "fixes #12" that would close an
   issue by accident?

If any answer is no, it waits, and when a person needs to do something it says
so in a comment on the pull request (once, not every two minutes).

If every answer is yes, it **merges** (always a merge commit) and then, depending
on the repository:

- **Deploys it** (MoonMan and the websites): it builds and publishes from its
  own copy of the code in `~/.ship-bot/work/`, never from your folders. The
  deploy checks the live site itself. If anything fails it **puts the previous
  version back**, comments on the pull request, shows a Mac notification, and
  **stops touching that repository** until someone has looked.
- **Merges only** (BinderCurve, 4thcltr, ACID2REAPER, .github): those ship
  through a release step in a session, so the bot just says "Merged; deploying
  is a session's job for this repo".
- **Off** (TowIt, wychwood): not looked at.

promptboi.com is special: the bot only ever publishes its website. If a merge
changes the API or the database (`server/`), the bot merges it but does **not**
deploy, says so, and leaves the deploy to a session.

## Watching first

After it is installed, the bot only **watches**. Every two minutes it works
out what it would merge and deploy and writes that to its log
(`~/.ship-bot/logs/ship-bot.log`, lines starting `OBSERVE`), but it changes
nothing: no merges, no comments, no deploys.

When the log looks right, let it act. There are two switches, and a repository
merges only when both are on: the global `live`, and that repository's own
`live` (every row ships with `false`):

```bash
node ~/.ship-bot/app/ship-bot.mjs --set-repo-live gorfednet/assess true   # one repository
node ~/.ship-bot/app/ship-bot.mjs --set-live true                          # the global switch
```

`--set-live` never touches the per-repository flags, so turning the global
switch on acts only in the repositories already switched on. Stage 1 of the
go-live (owner, 7 November 2026) is merge-only in `.github`, assess,
career-portfolio, heuristics.4thcltr.com and papers.4thcltr.com; ops waits for
pull-request CI (its row says why). In a live pass a repository whose own flag
is off is still read and logged, with `OBSERVE (repo not live)` on each line.

Before switching a repository on, check that its `expectedChecks` still match
what its CI posts (a renamed job would make the bot wait forever):

```bash
node ~/.ship-bot/app/ship-bot.mjs --validate                  # every repository that is not off
node ~/.ship-bot/app/ship-bot.mjs --validate --repo assess    # one
```

It reads the check names on the last 3 merged pull requests, prints what is
missing or unexpected per repository, and exits 1 when any differ.
`ignoredChecks` (default: `heavy-runner-preflight`, `review / trigger`,
`review / review`) names the checks every row leaves out on purpose.

To stop merges and deploys again, at once (from the next pass, within two
minutes):

```bash
node ~/.ship-bot/app/ship-bot.mjs --set-live false
```

A pass merges at most `maxMergesPerPass` pull requests (default 2) across all
repositories; the rest are logged `SKIP ... pass limit` and looked at again two
minutes later.

## How a change ships

1. A session finishes the work and adds the **`ready-to-merge`** label.
2. The bot waits until every check has passed and the Claude reviewer has
   reviewed the latest commit: clean, or with every one of its comments
   answered. It never merges a commit the reviewer did not review, and it
   never comments `claude review` (or `bugbot run`; Bugbot was retired on
   2026-10-16).
3. It merges the pull request.
4. For MoonMan and the websites, it first checks it can reach the NAS and the
   Docker host, then puts the change live and checks the live site.
5. It comments on the pull request saying what happened, and shows a Mac
   notification when something went live or went wrong. With `ntfy` in the
   config (`{ "url": "https://ntfy.gorfed.net", "topic": "ops-report",
   "tokenFile": "~/.ship-bot/ntfy.token" }`) the same message goes to your
   phone through ntfy as well; a failed send is one line in the log, never a
   stopped pass.

To stop it: add the **`hold`** label to a pull request, or run
`node ~/.ship-bot/app/ship-bot.mjs --set-live false` to stop everything, or run
`ship-bot/install.sh --uninstall` to remove it from the Mac.

## What it never does

- Upload anything to the App Store or Google Play.
- Anything that needs a password typed in. If the Mac cannot reach the NAS or
  the Docker host on its own (for example, Tailscale wants you to log in
  again), it merges nothing that would need a deploy and tells you, at most
  once an hour.
- Merge a pull request without the `ready-to-merge` label, or one with `hold`.
- Retry a deploy that failed. It puts the previous version back and waits for
  a person.

## How to stop it

- **One pull request:** add the label **`hold`**. Remove it to let the bot
  carry on.
- **Everything, right now:** run
  `node ~/.ship-bot/app/ship-bot.mjs --set-live false` (or change `"live"` to
  `false` in `~/.ship-bot/config.json`). From the next run it only watches and
  logs. `--set-live true` resumes.
- **Remove it from the Mac:** `ship-bot/install.sh --uninstall`.

## Where to look

- **What it decided and why:** `~/.ship-bot/logs/ship-bot.log` (one line per
  decision, newest at the bottom).
- **Each deploy's full output:** `~/.ship-bot/logs/deploys/` (one file per
  deploy, named by time, site and pull request). The comment on the pull
  request has the last lines.
- **What it remembers:** `~/.ship-bot/state.json`.

Passwords, keys and tokens are blanked out (`[REDACTED]`) in all of these and
in every comment.

## After a failed deploy

The bot comments on the pull request, notifies you, and stops merging in that
repository. Once someone has checked the live site:

```bash
node ~/.ship-bot/app/ship-bot.mjs --unblock MoonMan
```

## For a session (not the owner)

```bash
node ship-bot/ship-bot.mjs --dry-run --once            # what would it do? (default; makes no changes)
node ship-bot/ship-bot.mjs --dry-run --once --verbose  # also why each PR was ignored
node ship-bot/ship-bot.mjs --dry-run --once --repo MoonMan
ship-bot/check.sh                                      # the bot's tests (no network); install.sh runs this first
ship-bot/install.sh                                    # install or update the LaunchAgent (refuses if check.sh fails)
ship-bot/protect-branches.sh --dry-run                 # print the branch-protection calls
node ship-bot/ship-bot.mjs --validate                  # expectedChecks against the last 3 merged PRs (read-only; exit 1 on a difference)
node ship-bot/ship-bot.mjs --check-preflight           # run the config's preflight steps once, pass or fail per step
ship-bot/preflight-launchd.sh                          # the same, inside a one-shot LaunchAgent with the installed agent's environment
node ship-bot/ship-bot.mjs --set-repo-live <slug> true|false
```

`preflight-launchd.sh` answers the question a terminal cannot: does the ssh to
the NAS and the Docker host work from launchd's context, where the keychain-held
key and a terminal's Tailscale login may be missing? It never touches the real
agent; run it before switching any deploy-mode repository on.

A dry run reads GitHub (it runs the verification kit's read-only gate scripts)
but posts nothing, merges nothing and runs no deploy. `--live` acts only when
the config says `"live": true`; otherwise it observes, which is a dry run whose
decisions are logged as `OBSERVE` lines (only a missing or invalid config makes
it refuse), and any repository whose config entry still has
a `todo` list is refused in live mode until each item is confirmed and removed.

The config lives outside this repository at `~/.ship-bot/config.json`;
[`config.example.json`](config.example.json) documents every field and the
per-repository settings. An unknown or misspelt key is an error, never ignored,
and so is a `scripts.*` path with no file behind it: the three gate scripts
live in this repository's `scripts/` (`assert-checks-started.mjs`,
`check-closing-keywords.mjs`, `review-status.mjs`), and the example points at
the `~/Developer/gorfednet/gorfednet.github` clone.

### The rules it follows

- Gates are evaluated on the pull request's current head commit, and the merge
  is pinned to that commit (`sha`), so a push in between makes GitHub refuse
  the merge instead of shipping unchecked code.
- At most one merge per repository per run, at most `maxMergesPerPass` (default
  2) per run across all repositories, and one deploy at a time across all
  repositories (a lock file, `~/.ship-bot/run.lock`).
- A repository merges only when the global `live` and its own `live` are both
  true; otherwise a live pass observes it (reads, no writes, lines marked
  `OBSERVE (repo not live)`, nothing remembered in the state file).
- Before the first merge in a deploy-mode repository each run, the config's
  `preflight` steps (ssh to the NAS and to the Docker host) must succeed; if
  not, only merge-only repositories merge that run.
- When a check name appears more than once on a commit (a re-run), only its
  latest run counts.
- `~/.ship-bot/logs/ship-bot.log` moves to `ship-bot.log.1` once it passes 5 MB.
- A deploy that fails is rolled back (the repository's `rollback` steps, or a
  redeploy of the previous commit) and never retried. A run interrupted in the
  middle of a deploy blocks that repository on the next run.
- The GitHub token comes from `gh auth token` each run and is never stored,
  logged, or passed on a command line. A failed read is tried again twice, about two
  seconds apart; if all three fail the pass does nothing and the log gives each
  attempt's exit code, stderr and the length (never the content) of stdout.
