<!-- Copied from ~/.claude/plans/review-all-open-chats-clever-book.md on 11 November 2026, 9:40 AM ET. The plan of record for the fleet close-out; update here, not in the chat. -->

# Fleet close-out plan, 11 November 2026

## Context

27 open chats, 50 open pull requests (37 drafts), 14 parked and 56 "queued" Herdr jobs, 1 red main (BinderCurve, a monitor), 3 red Dependabot bumps. The owner asked for every open piece of work to sit in one plan that takes it to merged and deployed, stale chats archived, and the plan to run in tandem with the workflow-optimization chat (its plan: `~/.claude/plans/assess-our-work-over-glittery-brook.md`, Phases A to D). Cost-aware tiers on every item; lower tiers only where a higher one adds nothing. Fix causes, not symptoms; fold each cause into a rule, skill, check or test.

Usage: weekly at 82% (Fable 79%), reset Fri 13 Nov 5:00 AM ET. Owner decision (11 Nov, this plan): builders start now; Herdr's 90% hold is the brake. Order within the builders still follows priority (infra R2/R1 first, then R5, then deep-4), at most 2 builders at once, `builder-ok` before each. Must-ship dates hold regardless: ship-bot flips Thu 12 Nov, papers flip Fri 13 Nov. The plan runs on a Sonnet driver after approval; this Fable session starts it and hands over. Owner decision (11 Nov): Costco and Verizon finish as a deep-4 train.

What the optimization chat has already done (verified in `~/.claude/settings.json`): `defaultMode: auto`, 49 allows for the gh/git/hc verbs, deny on `gh pr merge` and the destructive git verbs; rules rewritten 11 Nov (ship-bot the only merger, coordinators retired). Not done from its Phase A: label-gate hook, ship-bot live in product repos (rows exist, all `observe`), janitor unblocked (`~/.fleet-janitor` now exists, run counter still 0), the inactive-repo archive. Owner-only items it listed are done (FLEET_READ_TOKEN works, trust accepted for heuristics and rowanmcarthur).

## Root causes found in this review (each gets a fix and a guard, not a workaround)

| # | Symptom | Cause (established / to confirm) | Fix | Tier |
|---|---|---|---|---|
| R1 | heuristics #85 `check` red | On GitHub-hosted `ubuntu-latest` runners (runner names "GitHub Actions N", checked in the API at 10:15 AM ET), `apt-get install ripgrep` cannot resolve security.ubuntu.com. It started 9:02 AM ET and was still failing at 10:05 AM ET on .github main and PR runs, heuristics 85 included. The dapyllil reboot at about 9:55 AM ET is unrelated, and dapyllil resolves the name. An earlier note in this file called it pool DNS; that was wrong. The `check` and kit jobs run hosted, against the runner rule, and a network install inside a PR gate breaks verification rule 5. | Move `check` and the kit job to the pool (`HEAVY_RUNS_ON`; papers #29 is the same move) and bake ripgrep into the runner image so no gate installs over the network; until then skip the install when `rg` is already on the image (the ship-bot session is trying that for .github). Rerun red runs once the hosted mirror resolves again; do not fix them per PR. | Sonnet builder (.github kit), runner for the rerun |
| R2 | Herdr: 56 "queued", 0 running, reconciler says "nothing to do" | Hypothesis from STATE.md: the 56 are once-jobs that already ran on 9 Nov (`Last result ok`, each produced one of the 30 worktree-* draft PRs). The registry never moved them to `done`, so the board and the optimization chat read a stall. The activation rule "chooses" them every pass and the start step skips them because `lastStart` is set. | Confirm by diffing job ids against the draft PRs' branches. Then: a job that opened a PR moves to `done` with `next` = the PR URL; STATE.md counts only startable jobs as queued; a unit test in `test/herdrReconcile.test.mjs` for "once-job with a PR is done, not queued". | Sonnet builder (ops) |
| R3 | 14 parked on "folder not trusted" after trust was accepted | `folderTrusted()` reads `~/.claude.json` correctly (both folders now `true`), but a parked job is only retried through `herdr-unpark`; the reconciler never re-reads trust for parked jobs. | Reconciler re-checks trust for parked-on-trust jobs each pass and unparks them itself; test. TowIt's 2 jobs are removed with the repo archive (R8). | same builder as R2 |
| R4 | Janitor stuck in propose-only after 4 runs | Run counter file never written because `~/.fleet-janitor` did not exist and the allowlist refused `mkdir`. Folder now exists (08:44 ET today). | Confirm run 4 (tomorrow 7:01 AM ET) writes the counter; if not, janitor creates its home itself. Then enable prune and archive phases. | runner, then main-session read of the diff |
| R5 | ssatcy 34-38, promptboi 56, BinderCurve 639: WebKit smoke `toHaveCount(0)` on the Privacy dialog fails on Playwright 1.64 Linux WebKit | Not established (two sessions noted it, none traced it). | One Sonnet builder, one repo (ssatcy, smallest), reproduces on the pool image with 1.64 vs 1.63, finds the behaviour change (likely dialog `open` attribute timing or `toHaveCount` on detached nodes), fixes the spec or the dialog, writes the near-miss negative case, and posts the cause on every blocked PR. The Dependabot bumps move only after. | Sonnet builder, Fable reviewer once |
| R6 | 30 worktree-* drafts across 10 repos with `## Next: Main session: open the PR, merge` | Herdr builder jobs end at a draft because the classifier refused `gh pr ready` and the label; that permission is now allowed, but ship-bot ignores drafts. | Ship-bot rule from Phase A item 4: a draft whose `## Next` first unchecked line is "merge" (or docs-only diff) and whose gates are green and review clean gets marked ready and labelled by ship-bot, with one comment. Guard: a fixture draft with a finding must stay draft (watch it fail once). | Fable (changes what merges unattended), small PR to `gorfednet/.github` |
| R7 | `gorfed.net` `production-healthcheck` red on 2 Mondays; denseware same pattern | Not established. | Runner pulls both runs' logs; Sonnet diagnoses (shared weekly workflow; likely the Monday schedule hits a NAS or Cloudflare window). Fix the workflow or document the window; never widen the check. | runner, then Sonnet |
| R8 | TowIt, wychwood, WhyWait keep generating Dependabot red, fleet rows and Herdr jobs | Never archived on GitHub (owner decided 11 Nov). | `gh repo archive` for the 4 repos (allowed now), remove their Herdr jobs, ship-bot and fleet-status rows; keep clones. | runner |
| R9 | 712 hand `claude review` comments | Reviewer runs only on open/ready or on a comment. | Phase C 9a: run on `synchronize` for non-draft PRs when the push changed code (merge-base compare). | Fable (what merges unattended depends on it) |
| R10 | Three Fable coordinator chats at 250k to 690k tokens | Model came from the picker; no Desk session yet. | Phase B 7: a pinned Sonnet "Desk" session from `.github/docs/desk-brief.md`, Remote Control on; this plan's driver is that session. | main session creates (one call), Sonnet runs it |

## Execution plan, in priority order

Tiers: **H** = Haiku `runner`/`scout`, **S** = Sonnet `builder` (own worktree), **F** = Fable (`reviewer`/`editor`/security/unattended-merge changes), **M** = this driver session reads a diff or labels. Every PR: branch, draft, `claude review` on the head, gates read, mark ready + `ready-to-merge`; ship-bot merges. No session merges.

### Track 0: today (Wed 11 Nov), token-free or Haiku, before the usage ceiling

0.1 **Archive the finished chats** (M, one approval card each; app asks). List at the end of this file.
0.2 **Close the superseded PRs** (H): anal0g 31, gorfmusic 48, promptboi 65, 66, bpr 27, denseware 31, subrythm 24 (superseded by main per the 10 Nov handoff), .github 99 and 111 (FLEET_READ_TOKEN now works). Each gets a one-line comment naming the merged PR that replaced it. Confirm with `gh pr view` that each is superseded before closing.
0.3 **Label the ready ones** (M after H reads gates): .github 114 (docs handoff, green), assess 74 (docs, needs green + clean), ai-use-levels 3 (merge main first, union conflicts, H). heuristics 85: rerun `check` once (R1 flake), then label.
0.4 **BinderCurve 649 → 639** (M): 649 carries `ready-to-merge` and is on its full gate now; ship-bot merges on green. Then `@dependabot rebase` on 639 (H), which still waits on R5.
0.5 **Ship-bot Thursday flip prep** (M, Wednesday evening, per the release-loop handoff): `~/.ship-bot/config.json` rows for 4thcltr, gorfed.net, MoonMan, BinderCurve, sites set to live from Thu 12 Nov; `--validate`; `preflight-launchd.sh`; papers row stays observation until Fri 13 Nov (its rollback rehearsal passed today). Deploy rows for heuristics and papers land with .github #115 (review clean; waits on `kit`, which the Thursday session labels).
0.6 **Archive inactive repos** (H, R8) and drop their Herdr/ship-bot/fleet rows (one small ops PR + one .github PR).

### Track 1: infrastructure (priority 1), builders start today in this order: 1.2, 1.3, then R5 (sites), then deep-4

1.1 **Ship-bot draft rule** (F, R6) in `gorfednet.github/ship-bot/`: unblocks the 30 drafts without a human. Watch it refuse a fixture draft with a finding, say so on the PR.
1.2 **Herdr registry fix** (S, R2 + R3) in `gorfednet/ops hosts/gorfpael/herdr`: once-jobs with a PR go `done`; parked-on-trust re-check; tests. Then STATE.md shows the true queue. Friday.
1.3 **`check` and the reviewer onto the pool** (S, R1): kit workflows take `runs-on: ${{ vars.HEAVY_RUNS_ON }}` with the hosted fallback only for `heavy-runner-preflight`; runner image gains ripgrep. papers #29 (token + variable) is the first repo. Friday.
1.4 **The 13 .github backlog drafts** (98, 100, 101, 102, 105, 106, 107, 110, 112, 113 plus handoff 103): after 1.1 the docs-only ones (103, 105, 107, 113, 101, 100) ride ship-bot. The code ones (98 cards, 102 build-rewrites, 106 NAS deploys, 110 social cards, 112 paths) each get `claude review` (H comments), then F triage. Batch 110 and 98 into one train (same subject: card URLs). 106 and 112 are deploy-path changes: F reads the diff.
1.5 **Branches ahead with no PR** in .github (`kit/v0.27.0`, `v0.28.0`, `v0.29.0`, `kit/rules-doc-drift`, `chore/recapture-promptboi-api-vhost`): H lists what each adds against main; the three `kit/v0.2x` are wip and superseded by kit 0.48 (ai-use-levels #3 is on 0.48), so delete after the list is in a backlog note; `rules-doc-drift` and the vhost recapture get a draft PR each (S).
1.6 **Janitor live** (H confirms run 4 at 7:01 AM ET Thu, R4; M enables prune and archive).
1.7 **Reviewer on `synchronize`** (F, R9), one PR to the kit. Friday.
1.8 **`delete_branch_on_merge`** in the 9 repos plus required checks on main for heuristics, assess, ops, papers, career-portfolio (H runs `protect-branches.sh`; M reads the per-repo record).
1.9 **Desk session** (M creates, Sonnet runs, R10) from `.github/docs/desk-brief.md`. From then on the owner asks the Desk, not this plan's session.
1.10 **Session startup cost** (H): remove the failing figma-desktop MCP server from the default set; `prompt_suggestions` off; `/consolidate-memory` once (M). Measured by `get_usage` before and after.

### Track 2: 4thcltr.com (priority 2)

2.1 Drafts 247 (docs), 249 (test, docs), 252 (docs after `check-backlog.mjs --verify-prs` confirms PR 89 merged): H runs the named check, marks ready, ship-bot merges once 1.1 lands; before that, M labels.
2.2 248 + 250 (`backlog-claims` CI check): same subject, one train (S builds, F reviews because it changes what CI enforces). Watch it go red once against an unmerged-PR claim.
2.3 251 (legal-entity cascade): docs now, 13-locale change waits on incorporation; mark the backlog entry `waiting-owner` with the date and close the draft with a note (nothing to merge until then).
2.4 254 (Stripe door events): needs stats.gorfed.net; H reads the three events, S decides resolved or Stage B. 255 (bottom-bar 6rem): S tries the font recipe; declined if unprovable, with the spec change.
2.5 202 (plan: brief to proposal, 23 Oct): stale planning PR; M reads, folds any still-true item into `docs/backlog.json`, closes.
2.6 AI Use Levels contract on 4thcltr's sister sites: already merging via heuristics 85, assess 74, papers 31 (importer requires a tag). Costco 76 and Verizon 77 fail CI until tagged (see 6.1).

### Track 3: gorfed.net

3.1 135 (counts from data files): S finishes the two unchecked items, F-free (no CI change), review by the workflow, label.
3.2 R7 Monday healthcheck (shared with denseware).

### Track 4: resumes and the job engine (paused by the owner)

4.1 career-portfolio 60 waits on the owner's Scotiabank decision: put the exact question in the Desk's next report; close the four job-run chats (work merged in 66/67/68).
4.2 The job pipeline's `audit_search.py` gate stays; nothing else moves until the owner says start.

### Track 5: MoonMan

5.1 291 (dev-dependency advisories, red draft): H rebases on main, S fixes what is red, label. Must be green on main by Fri 14 Nov for the Sun 15 Nov ship-bot stage 4 deploy.

### Track 6: BinderCurve (lowest; waits when builders compete)

6.1 649 (runner image) → 639 (22 updates) in that order (0.4), both behind R5.
6.2 "re-search capability gaps" chat (interrupted, 21 messages): archive; the fortnightly task re-creates it.
6.3 Red main is `production-monitor` flapping (failure 13:09, success 13:21, cancelled 13:50 today): S reads the three runs, fixes the monitor's cause or its cancellation overlap (concurrency group), never its threshold.

### Sites and the 4thcltr subdomains (ride Track 1 once 1.1 and R5 land)

- heuristics 75 (content migration), 76 Costco, 77 Verizon: all say "Decide: finish, fold, or close". Decision for approval: Costco and Verizon finish as one deep-4 train after the Friday reset (S per study, one F review on the train; tag both under AI Use Levels at import). 75 is folded into that train only if its migration is a prerequisite; otherwise closed with a backlog note. Bell (`deep-3 step g` chat) never produced a branch: close the chat, Bell goes on the backlog.
- papers 29 (pool move: R1), 30 and 31 (importer: already written, H pushes and opens, review, tag required): 30 and 31 are the same feature, train them.
- ssatcy 34, 35, 36, 37, 38: unblocked by R5; 38 also has a Medium finding (verify runs after the live switch; S fixes the order) and an nginx include on the host (H via `hc exec --on dapyllil`, then verify). One train for 34 to 37 after R5; 38 alone.
- promptboi 62 (monitor, docs), 56 (45 updates, R5).
- anal0g 32 (CSP, report-only first): ops PR by S; live compare as a scheduled report, not a gate.
- assess 72 (explicit-page limit 40): S finishes the test or closes with a note.
- MoonMan 291, ai-use-levels 3: above.

### Improve as you go (lands in the same PRs)

- `shipping.md`: add "a hosted apt install is not a gate failure; rerun once, then move the job to the pool" (R1) and "a draft with a merge-only `## Next` is ship-bot's" (R6).
- `agents-and-cost.md`: "Herdr `queued` means startable; a job that opened a PR is `done`" (R2).
- Herdr job template: builders mark their PR ready themselves now that `gh pr ready` is allowed; brief text updated.
- `/handoff` skill: a handoff on a merged PR loses its `## Next`; the skill copies unchecked lines into the repo backlog (gap noted 9 Nov).
- `verification-floor.md`: R5's finding, once established, as one dated line.

## Chats: archive or keep

Archive now (work merged, moved to a PR, or superseded):
- Release loop (PR 646 merged), Fleet coordinator 6 (73 merged), career-portfolio housekeeping (68 merged), Recover unpushed Herdr branches (handoff 103 open, nothing else held), Job coordinator (6 Nov), Job run batch 6a, 6b, Job run Chrome sitting, Resume application agent (all on PR 60/66/67; 60 waits on the owner, not a chat), Jobs to hosted runners (BinderCurve back on the pool; MoonMan/4thcltr/gorfed.net runner vars are a Track 1.3 item), Postiz API key setup (its follow-ups are ops PRs, merged), Homebridge-ring (fixed; last proof is a doorbell press), Network traffic irregularities (answered: leave), Synology hardlink fix (done; the one-mount chat continues it), deep-3 step g Bell (no branch; backlog), BinderCurve capability gaps (interrupted; recurring task re-creates), Fleet janitor daily chats 9 and 10 Nov (today's stays), 4thcltr design iteration and Gorfed.net design iteration (canvases live as artifacts; the next step is the owner's "carry it into the repo", recorded as a backlog entry in each repo).
- Repository tracking and automation (690k tokens): after it starts nothing more. Its `## Next` is in the 11 Nov handoff (PR 114); archive once 114 merges.
- Release loop 2: same; archive once 649 merges and 114 is in.

Keep:
- Claude workflow optimization assessment (236k): the source of Phases A to D; this plan's Track 1 executes them. Archive after the Desk session exists and its brief points at the assessment file in the repo (copy `assess-our-work-over-glittery-brook.md` to `gorfednet.github/docs/assessment-2026-11-11.md` first, H).
- heuristics-ai-tags (PR 85), deploy-automation (PR 115), AI Usage tag token budget (holds the contract until 85, 74 and 31 merge), One-mount fix (waits on the owner's RED ratio step), today's janitor chat.

## Verification

- Each PR: `assert-checks-started`, `review-status.mjs` clean or triaged, `check-closing-keywords`, diff read by the tier named, then ready + label; ship-bot log shows the merge; `delete_branch_on_merge` leaves no branch.
- R1: heuristics `check` passes on the pool with no apt step in the log.
- R2/R3: STATE.md after one reconcile shows queued = startable only, parked = 0 for trusted folders, and `test/herdrReconcile.test.mjs` has the two new cases failing before the fix.
- R4: `~/.fleet-janitor` run counter reads 4 after Thu 7:01 AM ET; run 5's digest lists an applied label or prune.
- R5: the WebKit spec fails on 1.64 before the fix and passes after, with the near-miss negative case; ssatcy 34 to 37, promptboi 56, BinderCurve 639 go green on the same image.
- R6: the fixture draft with a finding stays draft; a clean docs draft is labelled by ship-bot within one pass.
- Cost: `get_usage` daily growth after the Friday reset under half of this week's rate; no chat over 200k except the two being archived.
- Owner report format: status, outstanding, next milestone with ET, done. Next milestones: Thu 12 Nov 7:01 AM ET janitor run 4; Thu 12 Nov ship-bot live in product repos; Fri 13 Nov 5:00 AM ET reset, then R5, R2, deep-4 builders; Fri 13 Nov papers flip; Sun 15 Nov MoonMan deploy.

## What stays the owner's

Scotiabank relation for career-portfolio 60; RED ratio step for the NAS chat; a doorbell press to prove Homebridge; the incorporation date for 4thcltr 251. Nothing else in this plan waits on him.

## Execution log

- 11 Nov, 9:40 AM ET: plan approved by the owner (builders start now under Herdr's 90% hold; Costco and Verizon finish as a deep-4 train). Chat archives blocked: auto mode cannot review `archive_session` because an app hook appends a `session` field after review; the janitor archives merged-PR sessions once live (R4), and the owner can archive the rest from the sidebar. Sessions started: Herdr registry fix (ops), ship-bot draft rule (.github), Desk.
