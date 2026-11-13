# Ship bot

The ship bot merges your pull requests once they are ready, and then puts the
change live. It runs on your Mac every two minutes, uses no GitHub Actions
minutes, and needs nothing from you beyond the label you already use.

## What it does, in plain English

Every two minutes it looks at each of your repositories and, for every open
pull request, asks:

1. Did **you** open it, is it **not a draft** (a draft that says merge in its
   `## Next` is marked ready by the bot first: see "Drafts the bot marks ready
   itself"), does it carry the
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
career-portfolio, heuristics.4thcltr.com and papers.4thcltr.com, and ops since
11 November 2026 (its row says what its one check proves). In a live pass a repository whose own flag
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
`--validate` also leaves out a check whose runs were all `skipped` or `neutral`
on the sampled pull requests (it gated nothing), and any check matching a
repository's optional `coveredChecks`: exact names or name prefixes whose runs
another listed check gates, for example `["browser-compat / compat ("]` for
matrix children behind the `browser-compat / compat-success` aggregate. Both
only quiet `--validate`. For a repository with `requireChecksAfterLabel`, `--validate` samples the last merged pull requests that carried `ready-to-merge`, since an unlabelled merge never ran the full tier. An expected check that was skipped or neutral on a
sampled pull request shows as missing ("skipped or neutral on N"): the merge
gate accepts a skipped run as passing, so that check gated nothing there. The
merge gate still requires every `expectedChecks` entry as before.

To stop merges and deploys again, at once (from the next pass, within two
minutes):

```bash
node ~/.ship-bot/app/ship-bot.mjs --set-live false
```

A pass merges at most `maxMergesPerPass` pull requests (default 2) across all
repositories; the rest are logged `SKIP ... pass limit` and looked at again two
minutes later.

## Rollout schedule

Owner-compressed schedule (9 November 2026), extended 11 November 2026 ("deploy automation for all"):

- **Stage 1: live.** `.github`, assess, career-portfolio, heuristics.4thcltr.com, papers.4thcltr.com (merge-only).
- **Stages 2 and 3 together: Thursday 12 November.** bindercurve.com and 4thcltr.com merge-only, plus the static site deploys: gorfed.net, gorfmusic, denseware, ssatcy, anal0g, blackpixelrecords, rowanmcarthur, subrythm and the promptboi site.
- **Stage 4: Sunday 15 November.** MoonMan deploy.
- **Stage 5: the 4thcltr family** (heuristics, papers, 4thcltr.com), dated in "Deploy automation plan" below.

Rules for moving on:

- Each stage needs 3 clean merges in the current stage, no `SKIP` on a red check that should have merged, and no rollback.
- Before flipping, run `--validate` for the entering repositories and read the last 3 passes of the log.
- A wrong merge, or a failed deploy that needs a rollback, holds the stage until the cause is fixed and recorded.

## Deploy automation plan (11 November 2026)

Every site deploys through the bot, in observation first (`live` false: the log says what it would deploy and nothing runs). What each repository needs, and when it goes live:

| Repository | Row | Goes live | Why then |
|---|---|---|---|
| gorfed.net, gorfmusic, denseware, ssatcy, anal0g, blackpixelrecords, rowanmcarthur, subrythm, promptboi (site only) | in the example since 9 October | Thu 12 Nov (stages 2 and 3) | unchanged |
| MoonMan | in the example | Sun 15 Nov (stage 4) | unchanged |
| papers.4thcltr.com | `deploy`, observation | **Fri 13 Nov** | no private tests, static, the lowest-risk site on the shared engine; it is the one that proves the engine's rollback |
| heuristics.4thcltr.com | `deploy`, observation | **Mon 16 Nov** | needs papers live first (one real deploy, no rollback), and its gate reads the owner's assess jobs folder |
| 4thcltr.com | `deploy`, observation, release tags | **Mon 23 Nov**, if the release-tag change (below) lands by Thu 19 Nov | `make deploy` refuses any HEAD that is not on an exact release tag; the bot tags the merge commit of a pull request that declares a release |
| bindercurve.com | `merge-only`, no deploy | not before the 1.0 plan (week of 2 Feb 2027) | release hold; it deploys through its own release workflow |
| assess, career-portfolio, .github | `merge-only` | stay merge-only | not websites: assess is a command-line engine with no published site, career-portfolio a tool, .github the fleet's shared CI |
| intake, propose | no row yet | when each has a pull-request CI and a deploy command | services with no site-deploy path and no DNS yet; a row needs `expectedChecks`, and these two have no CI posted to sample |

Each flip needs all of this, read from the log and `--validate`, not remembered:

1. `--validate --repo <name>` clean (a named, known difference is acceptable only when the row's note names it; papers shows `derive` on 1 of 3 until two newer merges replace the older samples).
2. 3 clean merges in the repository (the stage-1 history counts for heuristics and papers: they have merged through the bot since 7 November) and no `SKIP` on a red check that should have merged.
3. The last 3 log passes after the row went into observation show no config or preflight error and, for at least one real pull request, a line `would deploy from ... setup [...] then [...]` with the steps you expect.
4. `ship-bot/preflight-launchd.sh` passes every step, including `site deploy host` (`ssh sitedeploy@dapyllil true`, the login the engine uploads as), from launchd's context.
5. For the first site only (papers): the rollback rehearsal below.
6. For each later site: the earlier site has deployed live at least once through the bot with no rollback.

**Rollback rehearsal (papers, before its first live deploy).** It proves the engine's rollback over the real key, with no code change and about 10 seconds on a static site. From the papers clone, after `make releases` shows at least two releases:

```bash
cd ~/Developer/gorfednet/papers.4thcltr.com
make releases          # note the current release id (top) and the one below it
make rollback          # switches current back one release and checks the live index.html
make rollback ID=<the id that was current>   # switches forward again, same check
```

Both must print `current -> releases/...` and pass the live check. The bot-side wiring (a rollback step that runs only after a failure past the upload; a failure it does not cover says nothing was rolled back; a failed setup rolls nothing back) is held by `test/bot.test.mjs`, watched failing with the filter removed.

**How the `heuristics` and `papers` rows run `make deploy`.** The bot cannot run `make deploy` as one step: a failure inside it after the upload would roll back the wrong thing, and a failure before the upload must roll back nothing. The rows split the same sequence in two:

- `setup` (a failure here deploys nothing and rolls nothing back): `make verify` (npm ci, the build, `verify.sh`; heuristics runs `verify.sh local`), `check-release.mjs`, `indexnow.mjs plan`.
- `deploy`: the shared engine's `deploy dist`, `indexnow.mjs ping` (its failure is reported in the log and does not undo the deploy, as the Makefile's leading dash), and for heuristics `check-live-release.mjs`.
- `rollback`: heuristics has `make rollback` marked `onlyAfterFailureOf` its `live check`, the one step that can fail after the release went live and be wrong about it. Papers has an explicit empty list: nothing after its upload can fail the release. The default rollback, a redeploy of the previous commit, cannot work with this engine (it refuses a HEAD behind `origin/main`), so both rows name a list. A failure in any step no rollback step covers (an upload that refused, an IndexNow ping that hung) is reported as **deploy failed and nothing was rolled back**, loudly, with the repository blocked until a person has checked the site.

No check is skipped. `make verify` runs the job-folder tests (`tests/*.local.test.ts`) that read the assess jobs; the heuristics row gives them `ASSESS_JOBS=~/Developer/gorfednet/assess/jobs` through its `env`, so the bot reads the owner's folder exactly as a hand deploy does, and the tests fail rather than skip when it is missing. If the sequence in a site's Makefile changes, change its row in the same pull request.

**4thcltr.com ships only from a release tag, so its row carries `release`.** `scripts/require-release-tag.sh` refuses any HEAD that is not on an exact tag, and a merge commit never is. By hand, a release is three things in order (DEPLOY.md): `npm run rates` committed, `npm run release -- X.Y.Z "One sentence."` (annotated tag, push, GitHub release), then `make deploy`. What the bot does alone and what it does not:

- **The bot tags and deploys only a pull request that declares a release**, with a line of its own in the description: `Release: 3.9.7 One sentence in the site's voice.` The sentence is editorial copy; the labelling session writes it (an editor pass for anything a visitor reads) and it is read in the pull request. The bot reads the description at merge time, so editing it after labelling changes what is tagged; only the owner's own pull requests are eligible (`allowedAuthors`), so the people who can edit it are the people who could label it. Do not edit the `Release:` line after labelling. A pull request with no `Release:` line is merged and nothing else, and says so in its comment. A `Release:` line that is wrong (a second one, no sentence, a version that is not a bare X.Y.Z, a tag that exists, or a version not higher than the newest tag) stops the merge with a comment saying why: a typo never becomes a quiet non-release.
- **After the merge** the bot checks the merge commit out in its workspace, creates the annotated tag on it with that sentence, pushes that one tag (never forced), confirms `git describe --exact-match HEAD`, then runs the row's setup and deploy steps (build, `deploy.sh`, `headers:live`) with the same rollback and block-on-failure rules as the other rows, and on success creates the GitHub release. A tag that cannot be pushed deploys nothing and blocks the repository. A tag the bot has pushed is never deleted, even if the deploy that follows rolls back; the next release then needs a higher version.
- **The bot does not run `npm run rates`** (a network fetch that rewrites a tracked file). The labelling session runs it and commits it in the pull request before labelling, as DEPLOY.md step 1 says. There is no version bump commit: the tag is the version.
- **Rollback.** The engine's `make rollback` is the same one papers rehearses on Fri 13 November (above); before 4thcltr.com goes live, run the same two commands from its clone once, because it is the main site: `make rollback`, then `make rollback ID=<the id that was current>` (`make releases` lists the ids), and read the live site after each. The bot-side wiring (tag pushed, deploy fails, `make rollback` runs after a `live check` failure only, the tag is kept, the repository blocks) is held by `test/bot.test.mjs` and was run once with real git against a local bare remote. A tag the remote refuses deploys nothing.
- **A `release` row cannot also use `pausedIfChanged` or `onlyIfChanged`** (config validation refuses it): a release deploys everything merged since the last one, but those keys look only at the release's own merge commit, so an earlier merge with no `Release:` line would slip past them.
- **The unavoidable human step** is writing the `Release:` line. Nothing else in the release needs the owner.

## Drafts the bot marks ready itself

Builder jobs open their pull requests as drafts and cannot run `gh pr ready` or
add a label, so 30 `worktree-*` drafts sat still until 11 November 2026. The
bot now takes a draft itself when **all** of these hold:

- its description has a `## Next` section whose first unchecked `- [ ]` line
  is an instruction to merge: it starts with "merge" or "open the PR" (any
  case) and does not say later ("merge once PR 118 lands" is not one), and no
  unchecked line under `## Next` hands the decision to a person (do not,
  don't, wait, hold, owner, needs a decision, decide). A diff that touches only
  documentation is **not** enough on its own: that branch was cut after five
  review rounds of edge cases and can be its own change later;
- every check is green on its latest commit, the same expected checks as for
  a labelled pull request;
- the Claude reviewer has reviewed that commit: `clean`, or with every one of
  its comment threads answered or resolved, the same reading as for a labelled
  pull request. A draft gets no automatic review, so when `review-status.mjs`
  says `not-run` the bot comments `claude review` once per commit, on a line
  by itself, and waits for the next pass. It never asks twice for the same
  commit. Findings with an unanswered thread keep the draft a draft; nothing
  is said on the pull request, the log says why;
- no `hold` label, no merge conflict, not opened by Dependabot, and the author
  is allowlisted;
- it changes no control-plane path (`CONTROL_PLANE_PATHS` and
  `CONTROL_PLANE_BASENAMES` in `lib/drafts.mjs`): anything under `.github/`,
  `.claude/`, `ship-bot/`, `scripts/gates/`, `scripts/lib/`, `janitor/` or
  `capacity/` or `verification-kit/`, `scripts/review-status.mjs`, any
  `REVIEW.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md` or `canaries.json`, and in
  `gorfednet/.github` all of `scripts/` and `templates/` and `fleet.json`.
  Matching ignores case, and a rename counts by its old name too. Such a draft
  changes what merges unattended, so the bot comments once per commit naming
  the paths and leaves it to the owning session (plan row 1.12);
- in a repository that deploys, its review is `clean`. Answered findings are
  not enough there: every session posts as the owner's login, so an answer
  proves no person read the finding. A deploy repository with no Claude
  reviewer never has a draft readied.

A pull request the bot readied stays under both guards on the merge path,
whoever owns its label: each later commit is checked for control-plane paths
again, and in a deploy repository merges only on a clean review. The bot
knows it readied one from its state file or, if that is lost, from its own
draft-ready comment. That holds even after the label comes off and goes back
on: every session labels as the owner, so a control-plane change that must
merge goes in a fresh pull request.

Then it comments once, "Ship-bot: gates clean, marking ready and labelling;
merges on the next pass", adds `ready-to-merge` and marks the pull request
ready. The ordinary merge path takes it after that, re-reading every gate.
Leaving draft fires `ready_for_review`, which starts a second Claude review of
the same commit, so the bot holds that commit for `reviewGraceMinutes` (15 by
default) and then waits for that review's check like any other; its verdict,
if it finds something, keeps the pull request from merging until each thread
is answered. A repository in observation (`live` false) logs `would mark ready
and add ready-to-merge` and does nothing.

The label the bot adds is its own, not a person's sign-off: before every
later pass merges such a pull request, the bot reads `## Next` again and
checks the head is the one it labelled. A wait written there afterwards, or a
new push, takes `ready-to-merge` off and leaves the pull request for a person.

When the bot runs as its GitHub App, its `claude review` comment posts as
`<slug>[bot]`. The shared `claude-review.yml` accepts that login only through
the org variable `SHIP_BOT_LOGIN` (set to `<slug>[bot]`), and the bot
recognises its own comments through `githubApp.slug` in the config; without
the slug, any `[bot]` login of type Bot counts as the bot's.

To keep a draft a draft, add the **`hold`** label or write the wait under
`## Next`. To keep a whole repository out of this, set `"draftReady": false`
on its row in `~/.ship-bot/config.json`.

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
- Mark a draft ready unless its `## Next` says merge and its gates are clean
  (above).
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

## GitHub quota (13 November 2026)

GitHub allows 5,000 REST calls an hour per account. Until the GitHub App
exists the bot calls GitHub as the owner, with `gh auth token`, so it shares
that quota with every session. It keeps its share small:

- **Conditional requests.** Every read carries the ETag of the last answer
  (`~/.ship-bot/read-cache.json`). GitHub answers an unchanged resource with
  304, which costs nothing.
- **Gate scripts reused.** A pull request that waits pass after pass (for a
  review, say) gets the same answer from the three gate scripts while its head,
  its last change (`updated_at`) and its checks are unchanged, for up to 10
  minutes. Before any merge every script runs again for real.
- **A floor.** Under 200 calls left, the bot stops the pass, logs
  `GitHub core quota low`, notifies once (Mac and ntfy `ops-report`), and makes
  no call until the quota resets.
- **One line per pass** says what it spent: `GitHub calls this pass: N (M
  answered 304, which cost nothing); gate scripts run K, reused J; core quota
  R of L left`.

**Its own quota: the GitHub App.** `github-app/manifest.json` describes a
private App with only what the bot needs (read metadata, checks, commit
statuses, Actions and issues; write contents, pull requests and workflow
files, since merging a pull request that changes a workflow needs it).
`node ~/.ship-bot/app/github-app/create.mjs` creates it in one browser step,
saves its private key to `~/.ship-bot/github-app.pem` (mode 600, outside every
repository) and adds `githubApp: { appId, privateKeyFile }` to the config.
Once the App is installed on the gorfednet account (a user account, so the script uses the user "new App" page), each pass mints an installation
token and the log's pass line ends `as GitHub App <id>`. If minting fails, the
pass logs an error and falls back to `gh auth token`.

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

**12 November 2026:** the agent runs at launchd's default process class. A
`ProcessType Background` throttled every child process, Playwright and its
browsers included, and failed 18 papers verify specs on 11 November 2026 (PR
128). To check an install, run
`plutil -extract ProcessType raw ~/Library/LaunchAgents/net.gorfed.ship-bot.plist`.
It should fail with "No value at that key path". If it prints `Background`,
re-run `ship-bot/install.sh` so the loaded plist matches this file. (`active
count` in `launchctl print` is no use here: the job is idle between runs.)

**13 November 2026:** a row whose steps need `node_modules` must install it.
That means an npm, npx, pnpm, yarn or vite step, or a `make` step over a
package.json that declares packages. It installs with a setup step (`npm ci`,
or any `make` target, which is trusted to install) or lists `node_modules` in
`preserve`. The workspace clean removes it before every deploy, and before the
default rollback (gorfmusic.com 49). The bot checks this before the merge,
against the owner's clone. It checks again after setup, against the merge
commit, before any deploy step runs. Every deploy row in the bot's work root
also syncs the `gorfednet.github` helper checkout to `origin/main`, listed in
`siblings` or not, as part of preparing the workspace after the merge.
`site-deploy.sh` refuses to run from a stale copy of itself (MoonMan 324). A
row with a custom `workDir` gets no implied sibling. `docs/handoff/2026-11-13-deploy-root-causes.md` has the four
causes.

A dry run reads GitHub (it runs the verification kit's read-only gate scripts)
but posts nothing, merges nothing and runs no deploy. `--live` acts only when
the config says `"live": true`; otherwise it observes, which is a dry run whose
decisions are logged as `OBSERVE` lines (only a missing or invalid config makes
it refuse), and any repository whose config entry still has
a `todo` list is refused in live mode until each item is confirmed and removed.

A deploy row can also carry `env` (name to value, a leading `~/` is the home directory; given to every setup, deploy and rollback step, never a GitHub token) and, on a rollback step, `onlyAfterFailureOf` (the deploy step names whose failure it undoes). A `rollback` list, even an empty one, replaces the default redeploy of the previous commit; a failure no listed step covers rolls nothing back, and the pull-request comment and the notification say exactly that (the site may be on the new release) and block the repository.

The config lives outside this repository at `~/.ship-bot/config.json`;
[`config.example.json`](config.example.json) documents every field and the
per-repository settings. An unknown or misspelt key is an error, never ignored,
and so is a `scripts.*` path with no file behind it: the three gate scripts
live in this repository (`scripts/review-status.mjs`, shared by every
repository's merge gate, and `scripts/gates/assert-checks-started.mjs` and
`scripts/gates/check-closing-keywords.mjs`, which only the bot and this
repository's own CI run), and the example points at the
`~/Developer/gorfednet/gorfednet.github` clone.

The bot does not run them from that clone, where a session can switch
branches (plan row 1.12). `install.sh` exports `origin/main`'s commit with
`git archive` (never the working tree), runs the suite from it, and copies the
three scripts and `scripts/lib/` into `~/.ship-bot/app/gate-scripts/` with the
commit in `SOURCE`, after `lib/gate-imports.mjs` confirms every import
resolves inside the copy. A fix to a bot too broken to merge it is merged by
the owner on GitHub, then installed the same way. While that copy exists the bot runs it and nothing else, and an
incomplete copy refuses the pass. Run from a checkout with no installed copy,
the bot checks that each configured script's clone is at `origin/main` and
clean, and otherwise refuses the pass: no gate runs, nothing is readied or
merged. Each pass logs `gate scripts from the ...` with the source.

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
- A deploy row with `"needsHeadroom": true` merges only while this Mac's
  1-minute load average is at or below its core count. Use it for a row whose
  setup or deploy steps are timing-sensitive, such as a local Playwright suite
  (papers.4thcltr.com). Above that, or when either number can't be read, the
  bot logs the load and looks again next pass. It posts nothing on the pull
  request and never blocks the repository for it. The default is false.
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

## Detect and repair (plan row 1.14)

- A repo block (`--unblock` territory) queues one diagnosis job: `lib/herdr-jobs.mjs` writes `blk-<repo>-<hash>.json` into the ops clone's Herdr jobs folder (`<sourceRoot>/ops/hosts/gorfpael/herdr/jobs`) with `wx`, so the file is the claim and later passes write nothing. No ops clone, no job; a dry run only says so. The reconciler starts it under its caps.
- A pull request whose reviewer threads have no answer gets the `needs-fix` label (removed once every gate passes). Herdr's importer turns that label into a continue-this-PR job.
