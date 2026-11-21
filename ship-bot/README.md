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
   written after the comment or by resolving it? (Exception: a pull request that changes control-plane paths and has a Medium or High thread merges only on a clean review of a new head; a reply never lifts it, and resolving lifts it only for a thread opened on an earlier commit, which then does not count.) It reads this with
   `review-status.mjs`. A latest commit the reviewer has not reviewed
   waits, however many earlier commits it reviewed, unless it only adds clean
   merges of `main` (redone with `git merge-tree`, no conflict, same tree) to a
   head whose newest review is clean: `review-status.mjs --clone` reads that as clean. The bot never asks for a
   review itself: whether a push needs one is a judgement (a clean merge of
   `main`, a regenerated file, a moved pin or a lint fix does not). After 15
   minutes without one it says so once per commit in a comment: comment
   `claude review` for any other push (code, a regenerated file, a moved pin or a lint fix). A repository without the
   reviewer yet is held the same way, and a session merges it after reading
   the diff.
4. Does the description avoid phrases like "fixes #12" that would close an
   issue by accident?

If any answer is no, it waits, and when a person needs to do something it says
so in a comment on the pull request (once, not every two minutes).

If every answer is yes, it **merges** (always a merge commit) and then, depending
on the repository:

- **Deploys it, but only for a release** (MoonMan and the websites): it
  builds and publishes from its own copy of the code in `~/.ship-bot/work/`,
  never from your folders. The deploy checks the live site itself. If anything
  fails it **puts the previous version back**, comments on the pull request,
  shows a Mac notification, and **stops touching that repository** until
  someone has looked. See "Releases, not every merge" below: an ordinary merge
  is not deployed.
- **Merges only** (BinderCurve, 4thcltr, ACID2REAPER, .github): those ship
  through a release step in a session, so the bot just says "Merged; deploying
  is a session's job for this repo".
- **Off** (TowIt, wychwood): not looked at.

promptboi.com is special: the bot only ever publishes its website. If a merge
changes the API or the database (`server/`), the bot merges it but does **not**
deploy, says so, and leaves the deploy to a session.

## Releases, not every merge (plan row 1.25)

Owner, 14 November 2026: "We need to slow down now. Big releases, not
incremental. More local testing before deploying live." So in every `deploy`
row merging and deploying are split (`deployOn`, default `"release"`;
`lib/deploy-plan.mjs`):

- **A plain merge is not deployed.** It goes live with the next release, and
  its comment says so.
- **Label `release`: a release.** Milestone releases (owner, 2026-11-18): no
  spacing between them, so one goes whenever it is labelled. The description needs a
  `## Release notes` section with at least one bullet, a `Local gate:` line
  (the full local gate through `gate-run` on this Mac, and where its log is) and
  a `Smoke:` line (the built site or app read on a local or preview host, and
  what was checked). A tag repo (4thcltr.com) also needs its `Release:` line,
  and a `Release:` line without the label stops the merge.
- **Label `hotfix`: an exemption**, said on its own line:
  `Exemption: security <why>` or `Exemption: outage <why>`. It deploys on merge
  only when main is still the commit last deployed, so a hotfix never carries
  undeployed merges live. Otherwise: cut a release, or deploy the fix by hand.
- **The release head must contain main** (GitHub's compare says `ahead` or
  `identical`). Otherwise main holds merges the gate and the smoke never saw:
  merge main in and run both again.
- **A forgotten label stops the merge.** Release notes, an `Exemption:` line or
  a `Release:` line with neither label is refused, so it never becomes a quiet
  merge that is not live. Labels match whatever their case.
- **`deployOn: "merge"`** keeps the old deploy on every merge, for a row whose
  deploy no visitor sees. It needs `deployOnMergeReason`. No row uses it today:
  the infra repositories (`.github`, `ops`) are `merge-only`.

A release deploys everything merged since the commit last deployed
(`lastDeployedSha` in `~/.ship-bot/state.json`): changed paths,
`pausedIfChanged` and `onlyIfChanged` count from there, and the default
rollback redeploys that commit. With no deploy on record, every tracked path
counts as changed, and the default rollback has nothing safe to redeploy, so
it reports "nothing was rolled back" rather than redeploying the merge's first
parent, which may never have been live. A paused deploy's block remembers its
commit: deploy that exact commit by hand, then
`ship-bot --unblock <repo> --deployed <sha>` records it as deployed (and, for a
release, records its time), so the next release diffs from there
instead of pausing again. A plain `--unblock` is refused for that block. On a
failed deploy's block `--deployed <sha>` is optional but works the same way:
it records the commit (a prefix of the failed deploy's merge commit, which the block
keeps, or a full 40-character sha on a block that has none: one from a crash
before the merge, an unknown merge outcome, or before this change) so the next deploy doesn't re-take old work. A
release or hotfix pull request is looked at before the plain ones, so a plain
merge does not land ahead of it and push its head behind main. A
hotfix also checks, after the merge, that the merge's first parent is the last
deploy. The comment and the phone say "as a release" or "as a hotfix".
HTML comments and fenced code in the description are ignored, and a
placeholder such as `n/a` or `<log>` is no line. The bot reads labels and lines; it cannot prove the gate or
the smoke ran. The session that labels the release runs them and names the log.

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

## Adding a repository to a live config

`install.sh` never overwrites `~/.ship-bot/config.json`, and sessions never read it. A new
repository reaches it as a row patch that `patch-config.mjs` applies:

```bash
node ~/.ship-bot/app/patch-config.mjs <patch.json>
```

It backs the config up, refuses a slug the config already has, validates the result and prints
slugs and key names only. A patch's row should set `live: false`; `--set-repo-live` turns it on.

A top-level key such as `ntfy` goes in the patch's `"set": {"ntfy": {...}}`, with `null` to remove
one. `set` refuses `repos` and `live`: rows go through `add` and `repos`, and `--set-live` turns
merging on or off. A key a public patch sets must match `config.example.json` (a test fails when
the two differ).

A public repository's patch lives in `patches/` beside an identical row in `config.example.json`
(a test fails when the two differ). A row for a private repository outside the privacy guard's
allowlist never goes in this public repository: the guard fails the pull request.
Its patch lives in the private ops repository (`control/ship-bot-patches/`) and the same
command takes it from there.

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
7. Before the row's first live deploy, rehearse it once by hand in the bot's own workspace. Prepare it as the bot does: `git clean -ffdx`, then only the row's `env`, `envFiles`, `siblings`, `copyFromSource`, `preserve` and setup. Run the setup steps, then the deploy steps up to the upload. Don't deploy live by hand outside a release (`shipping.md`, "Releases"). No ship-bot flag does this without a merge. `--dry-run` only prints `would deploy from ... setup [...]`. A fresh clone isn't enough because it hides a stale sibling. On 12 and 13 November 2026, 4 deploys failed on what the owner's clone had and the workspace lacked. Each rollback failed too. gorfmusic.com 49 had no `node_modules` (12 November, 16:04 ET). MoonMan 324 ran a stale helper sibling (22:14 ET that day). blackpixelrecords.com 29 had no `envFiles` and gorfed.net 140 had no `WORK_CONTENT_DIR` (13 November). Source: `docs/handoff/2026-11-13-deploy-root-causes.md`.
8. Check the row's rollback. The default redeploys the last deployed commit, and the shared engine refuses any HEAD behind `origin/main`. With no deploy on record it rolls nothing back. A row on the shared engine names its own `rollback` list, as papers and heuristics do (below).

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
  `gorfednet/.github` all of `scripts/`, `templates/`, `fleet.json` and the old
  `docs/claude-home/`, and in `gorfednet/ops` `control/claude-home/` (the
  reviewed copy of `~/.claude`, which Desk copies into it after merge), `control/ship-bot-patches/` (rows the owner
  applies to the live ship-bot config) and everything an install puts on a host: `hosts/`,
  `infra/`, `scripts/`, `inventory-patches/`, `credentials.json`, `rotations.json`, `crawler-policy.json` and `cta-sites.json`
  (plan row 3.20f).
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

### A change to the bot itself

The bot installs merged `main` itself (replan row N2). A hand reinstall is no
longer the usual step.

- Each live pass checks whether `main` changed what an install copies. That
  means the code in `ship-bot/`, the gate scripts (`scripts/review-status.mjs`,
  `scripts/gates/`, `scripts/lib/`), `ship-bot/install.sh` and
  `ship-bot/launchd-load.sh`.
- When it did, the installed bot fetches `origin/main`. It builds that commit
  as `~/.ship-bot/versions/<sha>/`.
- The installed bot checks the new version before anything running changes.
  It runs the new `check.sh`, the gate import check and the live config
  through the new `loadConfig`. Then it runs the new `--self-test` and one
  full dry pass over every repository.
- If all of that passes, it renames the link `~/.ship-bot/app` onto the new
  version. That one rename is the whole swap. The pass ends there, before any
  repository.
- The next pass runs the new version on probation. A healthy pass ends the
  probation. An unhealthy one puts the link back on the version before it.
- The log says `validate OK, swap OK`. The next pass says `health OK`.

The new version never merges or deploys before it passes those checks. The
bot never writes the LaunchAgent plist and never calls `launchctl`.

Some commits are refused. A refused commit is never tried again, and the
refusal sends one loud message. Each of these needs a hand install
(`ship-bot/install.sh`, from any clone):

- A change to `ship-bot/install.sh`, `ship-bot/launchd-load.sh` or
  `scripts/lib/resolve-node.sh`. The LaunchAgent or the install itself changes.
- A new version that fails a check. A failed `check.sh` gets one retry first.
- A new version whose dry pass fails, or stops on a repository the installed
  one handles. The dry pass gets one retry first too.
- A new version that a health check found unhealthy and rolled back.

## Node

Target: the agents run the user-owned Node 24 at `~/.local/share/node/24/bin/node`, a stable link that
`scripts/node-update.sh 24` moves to each new patch with no sudo (plan row 3.20k). The installers record that
link, not a versioned directory, so a patch needs no reinstall and no LaunchAgent reload: ship-bot starts a
fresh process every 2 minutes and picks the new binary up on its next start. Until the owner has run
`scripts/node-update.sh 24` and rerun the three installers by hand (`resolve-node.sh` is a hand-install path),
the plists still name `/usr/local/bin/node`, which stays the resolver's fallback until the `.pkg` is removed.
`scripts/node-update.sh 24 --check` reads the installed and the latest patch without changing anything.
fleet-status treats a newer patch or minor of the recorded major as current only on that stable link; a new
major, a downgrade or any other program path is still drift. Only a candidate named exactly
`~/.local/share/node/<major>/bin/node` is exempt from the private-folder refusal: the shell's
`~/.local/bin/node` points into the same folder and stays refused.

"Handles" is read from the last 3 complete live passes. A repository counts
as already broken only when it stopped on an error in each of them.

A hand install clears every refusal.

The bot defers when it can't decide. Examples are no GitHub token, a quota
pause, or `main` moving during the install. A deferral is quiet and is tried
again. One that came after `check.sh` started waits before the next try. The
waits are 1, 2, 4 and 8 passes. After that it's 15 passes, which is 30 minutes. A new commit
starts again with no wait. After 30 passes of waiting on one commit the bot
sends one message. An error from the lock, the marker or the version
directory is a deferral too. The pass warns and carries on to the
repositories.

Some skips aren't a normal wait. The link names a version other than the one
running. Or the marker says a version is on probation and the link doesn't
name it. The bot warns every pass and counts those toward the same message.
From the second such pass in a row it also sends the "behind origin/main"
message. One pass can be a hand install that just moved the link. A `probation` marker whose
link is back on the old version is an interrupted rollback. The next pass
finishes its record.

A pass on probation can also end undecided, for the same reasons. A new
repository error on one probation pass is undecided too. On a second
probation pass it's unhealthy. After 30 undecided passes in a row the bot
rolls the version back. That takes about an hour. That rollback doesn't
refuse the commit. The bot sends one message and tries it again 30 minutes
later. A second such rollback of the same commit refuses it. The 30 counts
every probation pass that started, including one that died.

A pass that can't read GitHub is undecided, even with new repository errors.
That covers no token and a freshness the bot can't read.

A pass can die before its health check. A crash or a kill does that. The bot
records each probation pass as it starts. After 3 starts in a row with no
health check, the next pass rolls the version back first and refuses the
commit. That pass then ends without touching a repository.

A version on probation can read as behind `origin/main` for two reasons. If
the commit it's behind is the one it was installed for, it's unhealthy. If
`main` has moved to a newer commit since, the rest of the pass decides. A
later pass installs the newer commit.

An unhealthy version can't be rolled back while a hand install holds
`install.lock`. The bot sends one loud message and tries again every pass.

Until the new version is installed, the bot is behind `origin/main`. It says
so every pass and merges no pull request that changes control-plane paths. It
comments once on each one it holds. It does the same when it can't read how
fresh its install is. That happens when GitHub's `main` can't be read. It
also happens when the clone's `origin/main` differs from it after a fetch, or
when `gates-main` was not advanced. Other pull requests still merge
(INCIDENTS.md, 14 November 2026, ops 94). The loud "behind origin/main"
message is sent only when self-install is off, stuck or has refused that
commit.

This hold is in the bot's own code, so it starts with the first install that
includes it. A bot installed from an older commit still merges control-plane
pull requests while it is behind.

Sometimes a new `origin/main` can't be installed at all, because `check.sh`
or the import check fails. The fix is itself a `ship-bot/` pull request, and
the installed bot holds it. The owner merges that fix on GitHub, then runs
`ship-bot/install.sh`. Both routes install only from `origin/main`.

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
- **Only the self-install:** run `touch ~/.ship-bot/self-install.off`. The bot
  then never installs a new version of itself. It still holds control-plane
  pull requests while it is behind, and `ship-bot/install.sh` still works.
  Delete the file to turn the self-install back on.
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
- **Every open pull request it saw:** `~/.ship-bot/board.json` (plan row 1.55).
  A live or observing pass over every repo replaces it at the end. A hand dry
  run and a `--repo` pass leave it alone. `ship-bot.mjs --board` prints the rows
  that need a decision, longest-standing first, in at most 40 lines.

### The board

The board costs no GitHub call. Each row is built from reads the pass makes
anyway, and its `reason` is the pass's own log lines for that pull request.

- **Top level:** `at` (when it was written), `installedSha`, `mode`, `skipped`
  (repositories the pass never listed, each with why) and `rows`.
- **A row:** `repository`, `number`, `title`, `head`, `draft`, `labels`,
  `checks` (passing, failing, pending or unread), `review` (review-status's
  verdict), `mergeable`, `next` (the first unchecked `## Next` line, or empty),
  `controlPlane`, `state`, `since` and `reason`.
- **Null means not read.** The bot ignores most pull requests from the list
  alone, so their `checks`, `review`, `mergeable` and `controlPlane` are null.
- **`state`:** `merged`, `ready`, `waiting`, `held`, `not-reached`,
  `in-progress` or `needs-decision`.
- **`in-progress`** is a working draft: no `hold`, no `ready-to-merge`, and
  its first unchecked `## Next` line is a session's own step. A draft is not
  one when that line says merge, ship-bot or Fable, names Desk or a person,
  addresses anyone but the session, or is a label, ready or approval step. Nor is a draft with no
  unchecked line. `--board` gives these one count line, not rows.
- **Stalled rows join the list.** `--board` also lists a row that has been
  `waiting` for over 6 hours and an `in-progress` draft not updated for over
  3 days, each marked `stalled`. It judges that when it prints.
- **`since`:** for a head the bot gated, when it first saw that head or
  GitHub's `updated_at`, whichever is older. For any other pull request,
  `updated_at`. An observing pass keeps no memory, so it has only `updated_at`.
- **A moved head.** `head` is the commit the row describes. When a later read
  in the same pass saw another, `headMovedTo` names it.
- **A stale board says so.** `--board` prints `STALE` in its first line when
  `at` is over 6 minutes old, about 3 passes. The passes since then ended
  early, or could not build or write it; the log says which.
- **It can be 3 minutes old.** Anything that writes (a label, a ready, a
  resolve) checks the head it acts on first.
- **A failed write** logs `could not write the board` and changes nothing else.
- **A pass that ends early** (a quota pause, before the first repo or partway
  through, or a self-install) writes no board. The last whole one stays, and
  `at` shows its age.

Passwords, keys and tokens are blanked out (`[REDACTED]`) in all of these and
in every comment.

### Sites on Cloudflare Pages

A site whose `fleet.json` row has a `pages` key deploys to Cloudflare Pages, to
dapyllil, or to both. The deploy engine (`scripts/site-deploy.sh`) does the
upload; its header has the details. The bot's part is two files in
`~/.ship-bot/`:

- `cloudflare-pages.token`: the Cloudflare API token, alone, mode 600. Only the
  engine uses it, and only to start wrangler. Nobody needs to open it, and no
  session should. The bot reads it at the start of each pass for one purpose:
  to blank it out wherever a deploy might print it.
- `cloudflare-pages.env`: `PLAUSIBLE_ORIGIN=https://<analytics host>` and,
  if wanted, `CLOUDFLARE_ACCOUNT_ID=<id>`. Not secret, but not public either,
  so the bot blanks these values out too.

The bot looks for both in its state directory, which is `~/.ship-bot` unless
the config moves `stateDir`. The engine always reads `~/.ship-bot`, so leave
`stateDir` where it is on a machine that deploys to Pages.

With both targets, dapyllil goes first. If Pages then fails, the deploy fails
and its last lines say that dapyllil has the new release and Pages doesn't.
Pages has no automatic rollback: the message says how to roll back in the
Cloudflare dashboard.

The row's `live` says which of the two serves the domain now: `nginx` until the
domain points at Pages, `pages` from the change that moves it. Only the one that
serves the domain is checked there. While `live` is `pages`, the upload to
dapyllil is switched but not checked, and the deploy says so.

`rollback` (a site's `make rollback`, and the bot's default rollback) switches
dapyllil only. Once `live` is `pages`, that changes nothing a visitor sees. To
take visitors back then:

- roll back on Pages: in the Cloudflare dashboard, the previous production
  deployment, or
- point the domain's CNAME back at the tunnel, after rolling dapyllil to the
  release you want if it isn't on it already. Then set `live` back to `nginx`.

The engine installs its pinned wrangler under `~/.cache/gorfednet-site-deploy/`,
outside every clone, the first time a Pages deploy runs. That one install needs
`npm` on the bot's `PATH`.

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
node ship-bot/ship-bot.mjs --self-test                 # read-only: can this copy start? One JSON line {ok, stateVersion, source}
node ship-bot/ship-bot.mjs --dry-run --once --summary-json  # end a dry pass with one JSON line {passOk, authOk, repoErrors, undecided}
```

**Self-install (15 November 2026, replan row N2).** `lib/install.mjs` owns
the files below, and `install.sh` and the bot both build a version with it.

- `~/.ship-bot/versions/<sha>/` is one installed copy, with the commit in
  `gate-scripts/SOURCE`. The bot keeps the current one, the one before it and
  one more.
- `~/.ship-bot/app` is a link to the current version. The plist names
  `app/ship-bot.mjs`, so it never changes with a version.
- `~/.ship-bot/self-install.json` is the marker. Its phase is `swapping`,
  `probation`, `healthy`, `rolled-back` or `hand`. It also holds the refused
  commits and any message ntfy has not accepted yet.
- `~/.ship-bot/install.lock` is held by whichever install is running. A lock
  left by a process that is gone is taken over. So is one over 30 minutes old
  whose process id now belongs to another process. So is an empty or
  unreadable one that hasn't been written for over 60 seconds.
- `~/.ship-bot/self-install.off` is the off switch.

A session never edits those files and never moves the link. After a merge
that changes the bot, watch `~/.ship-bot/logs/ship-bot.log` for
`validate OK, swap OK` and then `health OK`. A `refused` line names the step
and the reason, and the fix is a new pull request plus a hand install. The
first install of this layout is a hand install. It moves the old `app`
directory to `versions/<its SOURCE>` and makes the link.

`preflight-launchd.sh` answers the question a terminal cannot: does the ssh to
the NAS and the Docker host work from launchd's context, where the keychain-held
key and a terminal's Tailscale login may be missing? It never touches the real
agent; run it before switching any deploy-mode repository on.

**14 November 2026:** the agent runs as `ProcessType Interactive`. Both
`Background` (18 papers verify specs failed on 11 November 2026, PR 128) and
launchd's default class with no key (10 of 24 wordmark specs failed, papers PR
40) throttle every child process, Playwright and its browsers included. To
check an install, run
`plutil -extract ProcessType raw ~/Library/LaunchAgents/net.gorfed.ship-bot.plist`.
It should print `Interactive`. Anything else, or "No value at that key path",
means re-run `ship-bot/install.sh` so the loaded plist matches this file. (`active
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
row with a custom `workDir` gets no implied sibling. `control/handoff/2026-11-13-deploy-root-causes.md` in ops has the four
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
three scripts and `scripts/lib/` into the new version's `gate-scripts/`
(reached as `~/.ship-bot/app/gate-scripts/`) with the commit in `SOURCE`.
`lib/gate-imports.mjs` confirms every import resolves inside the copy before
the swap. The bot's self-install does the same steps. A fix to a bot too broken to merge it is merged by
the owner on GitHub, then installed the same way. While that copy exists the bot runs it and nothing else, and an
incomplete copy refuses the pass. The gate commands on PATH (`~/.local/bin/review-status` and its siblings,
plan row 1.7) are a different copy: symlinks into the detached worktree
`.claude/worktrees/gates-main` of the .github clone. The Herdr commands, the
herdr-core templates and the herdr-reconcile agent link into
`.claude/worktrees/tools-main` of the ops clone. After the bot merges a pull
request into `gorfednet/.github` or `gorfednet/ops` it runs `git fetch origin`
and `git checkout --detach origin/main` in that repository's worktree
(`lib/gates-worktree.mjs`, `TOOL_WORKTREES`). A worktree with uncommitted
changes to tracked files is left alone, logged as an error and sent to the
phone. Untracked files stay (Herdr's importer writes generated jobs into
`tools-main`), except one that main now adds with the same bytes, which is
cleared so the checkout can run. An untracked file that main adds with
different bytes stops the advance the same way.

Install rule (13 November 2026): every tool on this Mac installs from one of
these ship-bot-advanced worktrees, never a working checkout. `install-gates.sh`,
`capacity/install.sh` and ops' Herdr `install.sh` refuse anything else.
fleet-status's "Installed tools behind main" row flags a link into a working
checkout, a worktree behind origin/main, and an installed copy that differs from
main (this bot and its gate-scripts copy, the capacity app, the hooks from
`scripts/claude-hooks/`, and the rules, agents, skills, `CLAUDE.md` and
`settings.json` mirrored in ops `control/claude-home/` since plan row 1.30;
`scripts/lib/installed-tools.mjs`). A stale mirror there means ops main is ahead
of the live `~/.claude`. The published STATUS.md
runs on GitHub and cannot read this Mac, so that row reads "not measured" there.
The capacity job (every 15 minutes, `scripts/lib/installedDrift.mjs`) fetches the
two clones, runs the same check and sends one ntfy the first time each finding has been seen on two runs in a row
(memo `~/.desk/installed-drift.json`; a push nobody received retries, a finding that
goes away re-arms, and a check that cannot measure for 3 runs says so once, with no path or
repository name in the text). A copy that matches no committed version (a rule edited before its
mirror pull request) is shown as ahead or unmirrored and never notified. The ship-bot copy is compared as
code only: a README or example-config merge is not a stale bot. Each wrapper also prints one warning line on stderr when its
checkout is not at the last fetched `origin/main`. The fetch also moves
`origin/main` for the whole .github clone, so a bot run from a checkout with no
installed gate-scripts copy (the fallback above) would see its clone's HEAD
behind and refuse passes until that clone is pulled. The installed copy is the
normal mode and is unaffected.

Run from a checkout with no installed copy,
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
- A pull request gets the `needs-fix` label when its review gate blocks it: unanswered reviewer threads, a review that is not clean, or findings with no thread to answer. The label comes off once every gate passes, and a pull request the bot skips (hold, no ready label, conflicts) keeps none. Herdr's importer turns the label into a continue-this-PR job.

Stall and unblock details (row 1.14): a labelled pull request refused for the same failing reason for over 2 hours queues one `stl-…` Herdr job, which pushes to that PR's branch (waits such as pending checks never count, nor do refusals no push can fix, such as review-required or review-not-run). `needs-fix` also comes off a PR that is on hold, lost `ready-to-merge` or conflicts. `--unblock` acts at once only when no pass is running; otherwise it queues a request that the next pass applies, and a block set after the request was written survives it.
