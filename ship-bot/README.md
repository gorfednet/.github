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
3. Did **Bugbot** review it and find nothing, or has **every Bugbot comment
   been answered**, either with a reply written after the comment or by
   resolving it? If Bugbot has not looked at the latest commit, the bot asks it
   once (`bugbot run`) and waits. It never asks twice on one pull request, which
   keeps Bugbot to two reviews per pull request.
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

## How a change ships

1. A session finishes the work and adds the **`ready-to-merge`** label.
2. The bot waits until every check has passed and Bugbot has reviewed the
   change, or until every Bugbot comment has an answer.
3. It merges the pull request.
4. For MoonMan and the websites, it first checks it can reach the NAS and the
   Docker host, then puts the change live and checks the live site.
5. It comments on the pull request saying what happened, and shows a Mac
   notification when something went live or went wrong.

To stop it: add the **`hold`** label to a pull request, or set `"live": false`
in `~/.ship-bot/config.json` to stop everything, or run
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
- **Everything, right now:** open `~/.ship-bot/config.json` and change
  `"live": true` to `"live": false`. The next run does nothing. Nothing else
  needs to change; set it back to `true` to resume.
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
```

A dry run reads GitHub (it runs the verification kit's read-only gate scripts)
but posts nothing, merges nothing and runs no deploy. `--live` refuses unless
the config says `"live": true`, and any repository whose config entry still has
a `todo` list is refused in live mode until each item is confirmed and removed.

The config lives outside this repository at `~/.ship-bot/config.json`;
[`config.example.json`](config.example.json) documents every field and the
per-repository settings. An unknown or misspelt key is an error, never ignored.

### The rules it follows

- Gates are evaluated on the pull request's current head commit, and the merge
  is pinned to that commit (`sha`), so a push in between makes GitHub refuse
  the merge instead of shipping unchecked code.
- At most one merge per repository per run, and one deploy at a time across
  all repositories (a lock file, `~/.ship-bot/run.lock`).
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
  logged, or passed on a command line.
