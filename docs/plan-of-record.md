# Fleet plan of record (13 November 2026)

## Context

Owner asks, 13 November 2026: stop, re-assess every open agent and every piece of outstanding work, and produce one multi-agent plan that accounts for all of it (finish, commit, merge, deploy, close chat, auto-close after merge), with one remote control point of entry, following Anthropic's current guidance. Cost-aware with the higher tier by default ("lower level agents only when it makes no sense to use higher order ones"), root causes not symptoms, self-healing (skills, rules, tests updated as we go), all backlogs consolidated and re-assessed, workspace kept clean so nothing is forgotten over time, Herdr fixed, infrastructure (CI pool, dapyllil NUC, hosted runners, Docker, Plex, arrs, Homebridge) assessed for bottlenecks, and everything built here made reusable for future projects. Owner will provide any access required. Decisions taken in this session: Desk runs on Remote Control (owner accepted the transcript trade-off); BinderCurve's old planning docs are triaged item by item, not archived unread.

Six read-only scouts gathered the state (fleet PRs and sessions, automation map, operating-model files, backlogs, Anthropic docs, infrastructure). Findings are summarised here; the full scout reports are in this session's transcript and get copied into `docs/handoff/2026-11-13-fleet-reassessment.md` in `gorfednet/.github` as step 0.

## What is true today (13 Nov 2026)

**Fleet.** 70 open PRs, 2 red mains (4thcltr.com, ssatcy.com), 51 lapsed backlog entries, about 245 open typed backlog entries across 22 repos, 16 open issues, 22 open sessions (several stale since 10 and 11 Nov), hundreds of uncommitted files across worktrees (4thcltr 109/100/90/86, MoonMan brand-icon 102, ops 28, papers 21, dozens of small ones), 92 worktrees using 58 GB on the Mac.

**Ship-bot** is blocked in 4 repos after deploy and rollback both failed: gorfmusic.com (PR 49, `vite` missing, no `node_modules`), papers.4thcltr.com (PR 33 verify exit 2, cause fixed in .github 128 but `install.sh` not rerun), MoonMan (PR 324, step game exit 1), ssatcy.com (PR 35, step site exit 2). Four green labelled PRs wait on that (MoonMan 323, gorfmusic 50, ssatcy 42, papers 35). The draft rule (.github 119) is unmerged, conflicting, review round 7; 30 merge-ready drafts wait on a hand. Log shows a GitHub 403 rate limit and a Tailscale SSH approval prompt for the docker host.

**Automation gaps.** Desk brief (118), briefs dir (133), release loop 4 (129) are all stuck in labelled-but-unmergeable PRs (reviewer threads, conflicts). Janitor is still propose-only and never reached its session sweep. `FLEET_READ_TOKEN` exists (secret set 9 Nov, fleet-status read 21 repos on 13 Nov); several records still said it was missing, which is why it was asked for again. Gate scripts are not on PATH. .github 121 (apt DNS fix) was closed unmerged so `.github` 98 to 106 stay red. Six backlog entries have duplicate draft PRs.

**Herdr.** `hc wait` cannot see a turn end (Claude Code never answers OSC 7501), 16 jobs parked on untrusted folders, one builder job blocked, `hc ls` exits 1.

**Operating model drift.** Global `CLAUDE.md` says three rule files (there are four). Skills `self-heal`, `full-codebase-assessment`, `verification-bootstrap` and the `runner` agent still carry Cursor or Bugbot terms. MoonMan has no `CLAUDE.md`; 7 of 29 repos have one. Memory contradicts rules on model tier, deploy gating, who merges, coordinators, parallelism and worktree location; several entries are stale (Bugbot, "weekly limit 14%", PR 310). 10 backlog entries are still `in-review` for PRs that merged. BinderCurve has about 600 unchecked boxes in planning docs from May to September.

**Infrastructure.** dapyllil (the NUC: MSI Cubi, 12 threads, 61 GiB, no swap, Ubuntu 26.04) runs CI, 14 sites, MoonMan production, the model, Plex, Homebridge, ntfy, alerts: a single point of failure with a known warm-reboot hang. Load is 1.1 yet the CI pool queue is the real bottleneck: 4 shared slots for 17 repos, MoonMan median wait 46 min (max 182), 4thcltr e2e shards up to 103 min. gorfed.net, promptboi and ssatcy run fully hosted (gorfed.net pinned to `ubuntu-latest` because the pool image lacks rsync; ssatcy, denseware, gorfmusic have no pool token). Hosted minutes cannot be read without `admin:org` scope. The Mac has 262 MB free RAM with 24 `claude` and 13 Chromium processes, load 6.6 on 10 cores. NAS at 90% (63 of 70 TB), off-site copy never test-restored, no music off-site. Pi-hole runs on a 484 MiB SD-card board with no backup or monitoring. Plex, arrs, Homebridge are healthy; RED ratio watch parks 164 torrents until the owner restores download credit.

**Anthropic guidance** (code.claude.com, read 13 Nov). Remote Control is the documented phone entry point; cloud scheduled tasks cannot see the Mac; orchestrator briefs workers with objective, done-when, tools and boundaries, keeps the plan outside context, has workers return references to files; subagents support `model`, `isolation: worktree`, `memory`, `maxTurns`; agent teams are experimental and a poor fit. Pricing per M tokens: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Fable 5.2 $8/$40 (it replaced Fable 5.1 at $10/$50; the owner wants the latest model, 14 Nov). The account is on the Ultra plan with both weekly windows at 0% today, resetting 20 Nov.

## Model and agent policy for this plan

Every item names its agent and model. The rule applied: the higher tier unless the lower one plainly loses nothing.

| Tier | Used for in this plan | Why |
|---|---|---|
| Fable 5.2 | `reviewer` on every builder diff, security assertions, ship-bot and janitor logic (what merges unattended), the one-time triage ratification of what gets retired | Mistakes here pass unnoticed by anyone else |
| Opus 5.5 | Desk (the standing control session), root-cause investigations (deploy failures, pool queue, Herdr), infra changes on dapyllil, backlog triage decisions | Judgement work with no reviewer behind it |
| Sonnet 5.5 | `builder` for well-trodden fixes with a test behind them (flaky spec, font check, PATH symlinks, CLAUDE.md from template), handoff writing | Reviewed by Fable before merge, so a slip is caught |
| Haiku 5.5 | `runner` for gate runs, reruns, label and archive sweeps; `scout` for inventories | Mechanical, checked by a compiler, test or the next pass |

The planning session ran Phase 0, started Desk and ended. Desk owns everything after that. Nothing else needs Fable except the reviewer and the items marked.

## Architecture: the one entry point

**Desk** is one long-lived desktop-app session in `~/Developer/gorfednet/gorfednet.github`, model Opus 5.5, auto permission mode, Remote Control on. The owner opens it from claude.ai on the phone or from the Mac. He talks only to Desk; Desk talks to everything else. It stays a desktop session (not a launchd `claude remote-control` server) because the session tools it needs (list, start, message, archive sessions) exist only in the app.

**Desk owns no code work.** Each pass, every 4 hours 06:00 to 22:00 ET plus whenever the owner messages it:
1. Read, never recompute: `status.json` from the `status` branch, `~/.ship-bot/state.json` (blocked map), `~/.herdr-jobs/STATE.md`, `docs/plan-of-record.md`, `list_sessions`, today's `docs/desk/<date>.md` from the `desk-log` branch (`git show origin/desk-log:docs/desk/<date>.md`).
2. Reconcile: PRs whose first `## Next` line says merge with clean gates get labelled (until ship-bot's draft rule lands); sessions idle over 24 h with a merged or closed PR get archived; unanswered reviewer threads that block a labelled PR get a `reviewer` (Fable) answer; blocked repos get a root-cause session if none exists.
3. Decide: pick at most 3 items from `plan-of-record.md` by priority (infra, 4thcltr, gorfed, resume engine, MoonMan, BinderCurve); require `builder-ok` green and at most 2 builders live; hold while the Mac's 1-minute load exceeds 10 or free memory is under 4 GB.
4. Fan out: write `briefs/<repo>-<id>.md` (objective, done-when, model, files, boundaries, "return a PR with `## Next`"), `start_session` per brief with `user_asked`, detach at once. Subagents only for Desk's own reads (`scout`, Haiku). Never a relay.
5. Results return only through artefacts: PR `## Next`, `status.json`, ship-bot ntfy. Desk reads them next pass.
6. Write one line to `docs/desk/<date>.md` in the `desk-log` worktree (`.claude/worktrees/desk-log`) and push. Ntfy `ops-report` only when the owner must decide something.

**Rotation.** At 02:00 ET daily (after STATUS lands at 01:30 ET) and whenever Desk passes 150k tokens (a `PreCompact` hook writes the file early), Desk writes `docs/desk/<date>.md` (decisions, open threads, blocked list) on the `desk-log` branch. Until the janitor can start a session (1.5), Desk does not stop: past 150k it starts its successor from `docs/desk/brief.md` with `user_asked`, titled "Remote Control [Desk (<d Mon>)]" with Remote Control on at its first turn, and archives itself only once the successor shows `remoteControlActive: true`. Once 1.5 lands, the janitor's 07:00 ET run starts the successor the same way. Desk is never forked.

**Guards on Desk.** Deny rules for `*.env*`, `credentials.json`, `~/.ship-bot/config.json`; no `gh pr merge` (already denied); no deploys (ship-bot deploys). Desk reads `status.json`, not live `gh` loops, so it cannot reintroduce the rate limit.

**Owner interface.** One ntfy digest at 07:00 ET, at most 8 lines: shipped (n), blocked (repo: cause, fix in flight y/n), red mains (n), started and finished (n), retired this week (n), then "Needs you:" with the exact item or "Nothing needs you". Decisions that reach him: irreversible actions outside ship-bot's rules (domains, payments, deleting a repo, store submissions), retiring an item he named, spend past 50% of the weekly window by Wednesday.

## Phases and workstreams

Each row: owner agent and model; root cause to verify (hypothesis, not finding); proof it is done; access needed. ETA is in calendar days from approval (day 0 is Fri 13 Nov). Everything lands as a branch and PR with `## Next`; ship-bot merges labelled PRs; Desk labels.

### Phase 0: record and unblock (day 0, this session, Fable)

| # | Item | Agent / model | Root cause to verify | Proof | Access |
|---|---|---|---|---|---|
| 0.1 | Write `docs/handoff/2026-11-13-fleet-reassessment.md` in `.github` with the six scout reports condensed, this plan's table, and the access list; draft PR | this session | n/a | PR open, `## Next` says merge, docs-only so the janitor labels it | none |
| 0.2 | Access list to the owner in one message: Tailscale SSH approval for the docker host from ship-bot's launchd context; optional org Plan and Self-hosted runners read added to the existing `FLEET_READ_TOKEN` for billing; folder trust for the parked Herdr jobs; Mac Energy setting "prevent sleep when display off"; GitHub org runner read; RED upload credit decision | this session | n/a | each granted item recorded in the handoff | owner |
| 0.3 | Unblock the four ship-bot repos only after 2.1 proves each cause fixed; until then leave them blocked (a blocked repo is correct behaviour) | Desk (Opus) via `runner` | see 2.1 | `~/.ship-bot/state.json` has no `blocked`; the next labelled PR in each repo deploys green | 0.2 Tailscale |
| 0.4 | Start Desk from a 30-line brief (`docs/desk/brief.md`, landed by this PR; 118 and 120 close as superseded) with Remote Control on, then end this session | this session | n/a | `list_sessions` shows Desk with `remoteControlActive: true`; owner opens it on the phone | owner accepted RC |

### Phase 1: control plane and hygiene (days 1 to 3)

| # | Item | Agent / model | Root cause to verify | Proof | Access |
|---|---|---|---|---|---|
| 1.1 | Land the briefs dir and release-loop handoff: answer the reviewer threads on 133, resolve 129's conflicts; close 118 and 120 as superseded by `docs/desk/brief.md` | `reviewer` Fable answers threads; `runner` Haiku rebases | threads are real findings or not; 129 conflicts with merged loop-3 text | 133 and 129 merged by ship-bot, 118 and 120 closed with a note; `briefs/` and `docs/desk/brief.md` on main | none |
| 1.2 | Ship-bot draft rule: finish PR 119 at reduced scope (label and ready when first `## Next` line says merge, gates clean, no human hand-off line; `draftReady` per repo; the round-7 finding fixed by re-reading `## Next` after labelling). One more review round max, else close and Desk keeps the rule in prose | `builder` on Fable (changes what merges unattended) | round-7: a wait line added after labelling is never re-read | 16+ tests green, `check.sh` floor raised, dry-run log shows one draft readied, `install.sh` rerun | none |
| 1.3 | Ship-bot rate limit: conditional requests (`If-None-Match`), read `X-RateLimit-Remaining` and back off under 200, one GraphQL query per pass for PR lists | `builder` Fable | `lib/github.mjs` polls 21 repos every 120 s with uncached REST | unit test with fake fetch asserting the 304 path and the backoff; 7 days of log with no 403 | none |
| 1.4 | Ship-bot deploy preflight: refuse a deploy whose steps call npm or vite unless `setup` runs `npm ci` or `preserve` lists `node_modules`; rollback must verify the previous build is still present before claiming success | `builder` Fable, root-cause read by Opus first | `prepareWorkspace` cleans untracked files; repos with `setup: []` rely on `make deploy` to install | `test-site-deploy.sh` case: npm step with no setup fails validate; the four blocked repos redeploy green on their next merge | none |
| 1.5 | Janitor to live mode with auto-close: on a merged PR archive its session, delete the branch, prune its worktree; idle session with uncommitted work gets a handoff file and draft PR then archives; lapsed backlog entries get a `retire?` tag for Desk; read the whole status file; ntfy token set; restart Desk after rotation | `builder` Fable (unattended), `editor` Fable for the prompt text | sweep never ran because the run stopped on an unreadable repo (token exists since 9 Nov, so verify the real cause) | 3 consecutive runs with correct proposals, then live; after a test merge the session is archived and the worktree gone within one run | none |
| 1.6 | Hygiene rows in fleet-status: dirty clones, branches with no PR, worktrees older than 7 days, PRs idle over 3 days, sessions idle over 24 h, backlog entries past `reviewBy`, duplicate PRs per backlog id, clones behind origin. Counts in STATUS.md, lists in `status.json` | `builder` Sonnet, `reviewer` Fable | n/a (new guard; watch it fail once on a planted dirty clone) | each row shows the planted case then clears | none |
| 1.7 | Gate scripts on PATH: `install.sh` in `.github` symlinks `assert-checks-started`, `review-status`, `check-closing-keywords` into `~/.local/bin`, with `GITHUB_REPOSITORY` derived from the cwd | `runner` Haiku | never installed | `which` finds all three in a fresh shell; `check-closing-keywords` run from MoonMan reports MoonMan | none |
| 1.8 | Herdr: Claude Code `Stop` hook writes `~/.herdr-jobs/turns/<session>` so `hc wait` returns; drop TowIt and wychwood jobs; trust the active folders; make `hc ls` exit 0 on success (ops PR to Herdr config or upstream issue if it is the binary) | `builder` Opus in ops | OSC 7501 never answered; registry holds defunct repos | `hc wait` returns within 2 s of a turn end; 0 parked jobs; `hc ls; echo $?` prints 0 | folder trust (owner clicks once per folder) |
| 1.9 | Mac headroom: Desk holds new starts while 1-minute load is over 10 or free memory under 4 GB; janitor archives sessions idle over 24 h; cap live sessions at 12; prune the 92 worktrees that have merged or no PR (after 2.3 drains them) | `runner` Haiku, policy by Desk | 24 `claude` processes with 262 MB free | `vm_stat` free over 4 GB at the 07:00 report for 5 days; worktree count under 30 | none |
| 1.10 | GitHub org: move the 29 repositories from the `gorfednet` personal account into one organization, with no visibility or privacy change (owner, 14 November 2026: "Yes, plan it"). Plan and move order: `docs/plans/github-org-migration.md`. Recommended path: a new org plus transfers in waves, `.github` last | assessment Opus; Fable `reviewer` on the plan before anything moves; step 0 PRs `builder` Sonnet; checks and remote sweep `runner` Haiku; transfers and org settings by the owner | the 82 `uses: gorfednet/.github` lines don't follow redirects; the private ship-bot and pool Apps install only on their owner | `scripts/visibility-baseline.sh` OK after every step (26 private, 3 public, against the private baseline in `ops`); one runner smoke per pool repository; ship-bot live again | owner picks the path, the org name, Team at US$4 a month, and the cutover sitting; he creates the org, sets its budget and transfers |

### Phase 2: drain everything open (days 1 to 5, in parallel with phase 1, Desk-driven)

| # | Item | Agent / model | What done looks like | Access |
|---|---|---|---|---|
| 2.1 | Four failed deploys, root cause each: gorfmusic (no `node_modules` on deploy host: who installs?), papers (plist fix merged, rerun `install.sh`, then verify step under load, backlog `papers-deploy-verify-fails-under-load`), MoonMan (step game exit 1: read `~/.ship-bot/logs/deploys/`), ssatcy (step site exit 2). Fix the cause in each repo's deploy config, add the 1.4 preflight, then unblock | one `builder` Opus session per repo, `reviewer` Fable | each repo's next labelled PR deploys green; live check through DoH, not the Pi-hole; incident line in each repo's ledger | 0.2 Tailscale; sudo on dapyllil if nginx reload needed |
| 2.2 | Labelled PRs through: MoonMan 323, gorfmusic 50, ssatcy 42, papers 35 (after 2.1); 4thcltr 257 (after 3.3); ops 62 (comment `claude review` so the required check runs) | Desk, `runner` Haiku | all merged; sessions archived | none |
| 2.3 | Drain uncommitted work: for each dirty worktree, the session that owns it (if alive) commits to its branch and opens a draft PR with `## Next`, else a `builder` Sonnet reads the diff and either opens the PR or records a one-line discard reason in `docs/handoff/2026-11-1x-worktree-drain.md`. Nothing is deleted unread. Order: 4thcltr (4 large), MoonMan brand-icon, ops main (28), papers one-footer, then the small ones | `builder` Sonnet per repo, 2 at a time | `fleet-status` dirty-clone row reads 0; branch-without-PR row reads 0 | none |
| 2.4 | Duplicate draft PRs: close the older of each pair (.github 98/110, 99/111, 100/105, 101/113; 4thcltr 248/250; papers 30/31) after confirming the newer carries the work | `runner` Haiku, Desk confirms | 6 PRs closed with a comment naming the survivor | none |
| 2.5 | .github 98 to 106 red on apt DNS: move the `kit` job off apt (node-only toolchain) or onto the pool; open the PR for `fix/no-apt-in-no-smb-guard` or delete the branch | `builder` Sonnet, `reviewer` Fable | 5 consecutive green `kit` runs on main; the 9 drafts green | none |
| 2.6 | 22 open sessions: for each, archive (PR merged or nothing to continue), message once with its exact blocker (alive, PR open), or write its handoff and archive (stale). Retired-pattern coordinators (Open chats review, Repository tracking, Desk 11 Nov) archive after their handoffs merge | Desk, `runner` Haiku | `list_sessions` shows Desk plus active builders only | none |
| 2.7 | Dependabot reds: bindercurve 651, promptboi 56; red mains 4thcltr and ssatcy; gorfed.net 139 to 142 | see 3.4 to 3.6 | all green, STATUS shows 0 red mains | none |
| 2.8 | Owner-only items grouped into one message when their moment comes: 4thcltr bot deploy decision (23 Nov), MoonMan 327 iPhone check, ai-use-levels 23 two sentences, career-portfolio 60 Scotiabank relation, assess 72 and heuristics 75 to 77 finish or close (Desk recommends close with a note unless a brief exists), MoonMan 325 evidence folders (recommend: delete, the kit regenerates them), qBittorrent RED credit | Desk | each decided or scheduled with a date in `plan-of-record.md` | owner |
| 2.9 | Kit drift: bindercurve, 4thcltr, gorfed.net and subrythm are on kit 0.49.0 against 0.61.0, the only red in the 13 Nov 06:41 ET fleet-status run (43380425357) | `builder` Sonnet per repo, `reviewer` Fable | each repo's kit-version row green in fleet-status | none |

### Phase 3: root causes behind the reds (days 2 to 7)

| # | Item | Agent / model | Root cause to verify | Proof |
|---|---|---|---|---|
| 3.1 | CI pool queue: 4 slots for 17 repos on a host at load 1.1 with 50 GiB free. Resize to 6 slots on CPUs 2 to 11 with 1.5 CPUs and 6 GB each, or keep 4 and give MoonMan and 4thcltr dedicated second pools; make per-repo caps real (separate slot sets); measure before and after | Opus investigation in bindercurve `infra/ci-runner`, `reviewer` Fable; owner runs `sudo install.sh` on dapyllil | slot count is the limit, not CPU; MoonMan walks and 4thcltr shards block each other | median pool wait under 10 min and p90 under 30 min across 48 h, measured by the same script the scout used, committed as `scripts/pool-wait-report.mjs` and added to fleet-status |
| 3.2 | Hosted drift: gorfed.net on `ubuntu-latest` (pool image lacks rsync), ssatcy, denseware, gorfmusic, promptboi with no pool token; 25 hard-coded `ubuntu-latest` in bindercurve, 6 in 4thcltr, 3 in MoonMan. Add rsync to the pool image, register the tokens, move the jobs; keep only the liveness preflight hosted; `HEAVY_RUNS_ON` drift guard already noted in memory becomes a fleet-status row | `builder` Sonnet per repo, tokens by owner | image and tokens | fleet-status "hosted jobs last 7 days" under 5% per repo; monthly hosted-minutes report reads the figure through `admin:org` |
| 3.3 | 4thcltr wordmark e2e timing (`wordmark-fours.spec.ts:275`) | `builder` Sonnet | assertion runs before `document.fonts.ready` or before the CI bottom-bar offset (memory: CI bar 7 px higher) | `--repeat-each 20` green on the pool project; the spec waits on a state, not a timeout |
| 3.4 | gorfed.net font-preload check red on every PR | `builder` Sonnet | check compares to a stale preload list or hashed names | green on an empty PR; the check moves to a scheduled report if it depends on the live site (verification-floor rule 5) |
| 3.5 | ssatcy main red; 4thcltr main `claude-review` red | `runner` Haiku reads `gh run view --log-failed`, then `builder` Sonnet | likely 3.4-class drift or the reviewer secret | both mains green, STATUS 0 red |
| 3.6 | Dependabot reds (bindercurve 651: e2e, bundle budget; promptboi 56: WebKit 1.64 compat), with ssatcy 43 and R5 on the same WebKit 1.64 cause | `builder` Opus (cross-repo cause), `reviewer` Fable | Playwright 1.64 WebKit change (R5's `/mtg/cards` rAF starvation lead) | one cause comment on ssatcy 34 to 38, promptboi 56, BC 639; green or pinned with reason |
| 3.7 | dapyllil warm-reboot hang (backlog `dapyllil-warm-reboot-hang`) | `builder` Opus in ops, owner at the console once | boot mounts or TCO watchdog ordering | two warm reboots complete unattended, recorded in `hosts/dapyllil/boot/README.md` |
| 3.8 | Pi-hole: add to ops (config export nightly to the NAS, healthchecks ping, Tailscale) | `builder` Sonnet in ops | none today | restore drill from the export on a scratch container |
| 3.9 | NAS at 90%: report largest trees; music off-site backup; test-restore the B2 copy (backlog entries exist) | `runner` Haiku report, `builder` Opus for the restore drill | n/a | restore drill log in `hosts/dapyllil/backup/RESTORE.md`; owner decides what to delete from the top-10 list |

### Phase 4: one plan of record (days 3 to 8)

| # | Item | Agent / model | Done |
|---|---|---|---|
| 4.1 | `docs/plan-ranked.md` in `.github` (generated; this file stays hand-written and links to it): ranked list, one line per item, pointer to `<repo>:backlog.json#id`, owner-only items with dates. Generated by `scripts/plan-of-record.mjs` from every repo's `backlog.json` plus a hand-kept ranking file, so it cannot drift | `builder` Sonnet, `reviewer` Fable | file on main; fleet-status "Plan" section shows top 5, blocked count, retired this week |
| 4.2 | Reconcile backlogs with reality: 10 `in-review` entries whose PRs merged go `landed` (MoonMan 291/296/319/320, gorfed.net 63, heuristics 1, TowIt 5, wychwood 4, anal0g 33, denseware 32, ssatcy 41); blackpixel sampler entry gets its PR number; `towit-open-security-bump` closes | `runner` Haiku, each change on a branch per repo | `check-backlog --verify-prs` green in each repo |
| 4.3 | Triage all 245 open typed entries and 51 lapsed: `scout` Haiku builds the sheet (entry, repo, age, PRs, duplicates), `builder` Opus proposes keep / retire / merge-into with a one-line reason each, Desk ratifies, `reviewer` Fable spot-checks 10%. Duplicates collapse to one entry (Pi-hole recapture, Canadian Tire, CI to pool ×8, fleet registry ×3, weekly monitor ×7, security headers ×3, sitemap 301 ×5, FLEET_READ_TOKEN ×3, WebKit 1.64 ×3) with the survivors in the owning repo | as stated | every entry has `reviewBy` in the future or status `declined` with a reason; lapsed count 0 |
| 4.4 | BinderCurve planning docs, triaged item by item (owner's choice): `CURSOR_PLANS_MIGRATED_BACKLOG.md` (266), `MULTI_TCG_ROADMAP.md` (106), `ANALYTICS.md` (77), `ROADMAP_AUDIT_PLAN.md` (33), `SECURITY_ENHANCEMENTS_REPORT.md` (28), the 12 smaller ones, `shippable-program-2026-09-checklist.md`. Each box becomes done (evidence link), a `backlog.json` entry, or retired with a reason; docs move to `docs/archive/` with a header pointing at the entries | `builder` Opus in batches of about 100 boxes, 3 sessions, `reviewer` Fable samples each batch | 0 unchecked boxes outside `docs/archive/`; a `check-no-stray-checklists` guard in BinderCurve's gate |
| 4.5 | Handoff files, memory threads and `~/.claude/plans`: checkboxes that refer to merged PRs get ticked; stale memory entries (PR 310, dashboard end state, weekly limit, Bugbot, coordinators, "Opus builds", one-fell-swoop vs BC 653 deploy line) corrected or deleted; 70 plan files older than 30 days moved to `~/.claude/plans/archive/` | `runner` Haiku for mechanical ticks, Desk for memory edits | memory `consolidate-memory` pass run once; no memory contradicts a rule file |
| 4.6 | Issues: BinderCurve 61, 62, 63, 127, 258, 355 (September) get a decision; ci-alert issues 419, 585, 589, 604, 642, 645 close when 3.x lands; ai-use-levels 9 and 24 become entries | Desk | 16 open issues become 0 or linked to an entry |
| 4.7 | Dormant repos (TowIt, towit.io, wychwood): close their backlog entries as `declined: dormant`, turn off ship-bot rows (already off), archive the clones' worktrees | `runner` Haiku | STATUS stops listing them |

### Phase 5: self-heal the operating model (days 2 to 8)

| # | Item | Agent / model | Done |
|---|---|---|---|
| 5.1 | Rules: `agents-and-cost.md` gains the owner's tier rule (higher unless lower loses nothing) with today's roster and the Desk pattern, retires the coordinator paragraphs; `shipping.md` gains auto-close after merge and the draft rule; `CLAUDE.md` says four rule files and lists all skills | this session drafts, `editor` Fable reads | rule files consistent; drift guard (5.4) green |
| 5.2 | Skills and agents: strip Cursor and Bugbot from `self-heal`, `full-codebase-assessment`, `verification-bootstrap`, `runner`; add `desk` agent (Opus, `memory: project`); add a `fleet-drain` skill (what 2.3 does) and a `desk-rotate` skill | `editor` Fable | `grep -ri cursor ~/.claude/skills ~/.claude/agents` returns only the history table in CLAUDE.md |
| 5.3 | Repos: MoonMan `CLAUDE.md` from the kit template; `REVIEW.md` plus `claude-review.yml` for propose, ai-use-levels, intake, broadcast, ask-collector; delete `.cursor/` leftovers in 4thcltr, gorfed.net, gorfmusic | `builder` Sonnet | every active repo has both files and the workflow; fleet-status "kit" row green |
| 5.4 | Drift guard `scripts/check-rules-drift.mjs` in the `kit` job: fails on retired terms (Cursor, Bugbot, coordinator) or models outside the roster in rules, skills, agents and memory indexes; watched failing once on a planted term | `builder` Sonnet, `reviewer` Fable | red on the plant, green after |
| 5.5 | Settings: remove `settings.json.bak*`; decide `ENABLE_CODE_SECURITY_REVIEW=0` vs the security plugin (recommend: enable the review, drop the plugin); add deny rules for Desk's secrets | this session | one settings file, documented in CLAUDE.md |
| 5.6 | Future projects: `verification-bootstrap` registers a new repo everywhere in one run: ship-bot config row, reviewer workflow, `CLAUDE.md`, `REVIEW.md`, `backlog.json`, fleet-status entry, Herdr terminal and job, pool token request line in the owner message, plan-of-record pointer. Kit bump with the hygiene rows | `builder` Opus, `reviewer` Fable | a scratch repo bootstrapped end to end appears in STATUS.md the next morning |
| 5.7 | Scheduled tasks: remove the 3 orphaned `~/.claude/scheduled-tasks/` folders and the never-run `deep3-thursday-merge-deploy`; keep janitor, hosted-minutes monthly, 4thcltr reminder (to 23 Nov), BC research weekly | `runner` Haiku | `scheduled-tasks.json` matches the folders |

### Phase 6: media and home stack (days 5 to 10, lowest priority, after infra)

| # | Item | Agent / model | Done |
|---|---|---|---|
| 6.1 | Plex: move transcode temp off the NAS path if it is there; confirm hardware transcode; nothing else, it is healthy | `builder` Sonnet in ops | one evening with a transcode and pool at 4 busy shows no load spike over 8 |
| 6.2 | arrs and qBittorrent: nothing to fix until the owner restores RED download credit; then the `lidarr-fix` FIX-PLAN steps 6 and 7 (164 rebuilds, 20 length matches) run as one Opus session from `~/Developer/lidarr-fix` | Opus session | FIX-PLAN all steps ticked; moved into ops `hosts/dapyllil/arrs/` |
| 6.3 | Homebridge: healthy; add it to the restic include list and a healthchecks ping | `runner` Haiku | restore drill includes `/opt/homebridge` |
| 6.4 | Docker engine: watchtower policy (pin the production images: moonman, nginx, cloudflared; auto-update only the arrs), `docker system prune` weekly with the backup; incident ledger `~/incidents` moved into ops | `builder` Sonnet in ops, `reviewer` Fable for the pin list | `docker images` dangling 0 at the Sunday report; pinned images listed in ops |

### Phase 7: 4thcltr.com forms, chat intake, design (priority 2; owner ask 14 November 2026)

Plan: `gorfednet/4thcltr.com` `docs/plans/2026-11-forms-chat-design.md`. One brief per row in that repo's `docs/briefs/` (start with its `README.md`). The planning reports are in `docs/handoff/2026-11-14-forms-chat-design.md`. Each row is one session; a row with several pieces reviews them as drafts and carries them in one train.

| # | Item | Repo | Session model | Brief | After |
|---|---|---|---|---|---|
| 7.0 | Record: plan, handoff, briefs, backlog entries, these rows | 4thcltr.com, .github | planning session, Fable | n/a | done when both docs pull requests merge |
| 7.1 | Organisation optional on the brief, end to end | propose, intake | Opus | `7.01-organisation-optional.md` | 7.0; reviewer rollout (5.3) or a stated Fable read |
| 7.2 | Forms groundwork: request descriptions, in-memory draft, vendored contract, CI send tests | 4thcltr.com | Opus | `7.02-forms-groundwork.md` | 7.0 |
| 7.3 | Sheets with the form first, then release | 4thcltr.com | Opus | `7.03-sheets-form-first.md` | 7.2; 7.1 deployed |
| 7.4 | Order link at the top of the heuristics site | heuristics | Sonnet | `7.04-heuristics-order-link.md` | 7.0 |
| 7.5 | The chat collects and sends a brief or an assessment, then release | 4thcltr.com | Opus | `7.05-chat-collects-and-sends.md` | 7.3 released |
| 7.6 | Assist service: table rebuild (any time), then the two offers | ask-collector | Opus | `7.06-assist-offers.md` | offers only after 7.5 is released |
| 7.7 | Capture harness and contact sheets; settle 4thcltr 263 to 266 | 4thcltr.com | Sonnet | `7.07-capture-harness.md` | 4thcltr 257 merged |
| 7.8 | Design and tooling assessment. Owner checkpoint 1 | 4thcltr.com | Fable | `7.08-design-assessment.md` | 7.7's run on disk |
| 7.9 | Three flagship concepts. Owner checkpoint 2 | 4thcltr.com | Fable | `7.09-flagship-concepts.md` | owner's yes at checkpoint 1 |
| 7.10 | `Home.tsx` into sections, pure move | 4thcltr.com | Sonnet | `7.10-home-sections-split.md` | 4thcltr 255, 268, 269 merged or closed |
| 7.11 | Flagship model at `?design=studio`, with guards | 4thcltr.com | Opus | `7.11-flagship-model.md` | 7.10 |
| 7.12 | Flagship fonts, open licence, self-hosted | 4thcltr.com | Sonnet | `7.12-flagship-fonts.md` | checkpoint 2 |
| 7.13 | Flagship hero and sections, released dark | 4thcltr.com | Fable composes, Opus builders | `7.13-flagship-build.md` | 7.11, 7.12 |
| 7.14 | Flagship launch. Owner checkpoint 3 | 4thcltr.com, heuristics, papers | Opus | `7.14-flagship-launch.md` | owner's go, on his phone |

Start order as slots free: 7.2, 7.7, 7.1, 7.4, 7.8, 7.3, 7.6 (table rebuild), 7.5, 7.9, 7.10, 7.11, 7.12, 7.6 (offers), 7.13, 7.14. Infra rows still win a slot. Never start a row before its "After".

Also for Desk: 4thcltr 202 (the brief-to-proposal plan, draft since 23 October) lands as docs before 7.2, since it holds decision 19's text. The 4thcltr.com main checkout sits on `drain/4thcltr.com`, 155 commits behind `origin/main`: count it under "Clones behind origin". Rows 7.9 to 7.14 start only on the owner's yes at checkpoint 1.

Owner checkpoints (the only things that reach him from this phase): 1 the assessment's recommendation and whether to build a flagship; 2 the concept and typeface, from pictures; 3 the go to make it the default, and how Shuffle alternates.

Estimates (ET, subject to slots and the pool): assessment and recommendation Tuesday 17 November; forms live Wednesday 18 November; concepts Friday 20 November; chat sends briefs and assessments Monday 23 November; flagship dark Friday 27 November.

## Owner decisions and access (the only things that reach him)

1. Access, once, in one message with exact items: Tailscale SSH approval (docker host), optional billing read on the existing token (never ask again for the token itself), folder trust clicks for Herdr jobs, Mac sleep setting, dapyllil `sudo install.sh` for the pool resize (command given only when 3.1 is ready).
2. RED upload credit: yes or park (6.2 waits on it).
3. The dated items in 2.8, each at its moment.
4. Deletions from the NAS top-10 list (3.9).
5. The GitHub org move (1.10): path, org name, Team plan and the cutover sitting, after the Fable review is clean.

Everything else is decided by Desk under the rules.

## Verification

- Every workstream above names its proof; none closes on "completed" alone.
- End state, read from STATUS.md, not from chat: 0 red mains, 0 blocked ship-bot repos, 0 dirty clones, 0 branches without PR, 0 lapsed backlog entries, under 30 worktrees, under 12 live sessions, pool median wait under 10 min, hosted jobs under 5% per repo, drift guard green, Desk `remoteControlActive: true`, janitor live for 3 runs.
- Guards added (1.4 preflight, 1.6 hygiene rows, 4.4 stray checklists, 5.4 drift) are each watched failing once on a planted case before they count, per verification-floor rule 4.
- A fix for a deploy counts only after the next real labelled PR in that repo deploys and the live check goes through the engine's resolver, not the Pi-hole.

## Milestones (ET)

- Day 0 (today, 13 Nov): handoff PR open, access list sent, Desk running on Remote Control, this session ended.
- Day 3 (Mon 16 Nov): control plane live (1.1 to 1.9), four repos unblocked, labelled PRs merged, dirty worktrees drained.
- Day 7 (Fri 20 Nov, the weekly reset): red mains green, pool resized and measured, backlogs reconciled, drift guard in CI.
- Day 10 (Mon 23 Nov): BinderCurve triage done, plan of record generated daily, bootstrap-for-new-repo proven, media stack items done except RED.

## Cost estimate

Desk on Opus: about 30k tokens a pass, 5 passes a day, about 1M tokens a week. Builders: about 25 sessions over 10 days, Sonnet or Opus, about 150k each. Fable: reviewer on each diff plus the ship-bot and janitor items, about 15 runs. Fits inside the week's window with the Fable share under 20%; Desk reports the window percentage in the 07:00 digest and holds new starts past 70% before Thursday.
