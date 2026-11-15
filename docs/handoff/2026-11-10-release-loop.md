# Release loop, 10 Nov 2026

Pass 1 (5:00-5:15 PM ET): merged MoonMan 296. Labelled ready-to-merge (required e2e checks run only with it): 4thcltr 253, 245; bindercurve 646, 647. MoonMan 321: fixed the Low finding, marked ready, review requested. Builder started for bindercurve `deps/train-2026-11-09` (620, 621, 622, 639; 639 had real red).
Requested `claude review` on first 6 of 34 worktree-* draft PRs on the static sites (no drip job found; ~6 per pass). Not mine: MoonMan 319 has a real Low finding (splash .platform-line order); rowanmcarthur.com and TowIt folders untrusted for Claude Code (owner, but those repos are inactive/not on the list).
Owner action pending: install pools.conf on dapyllil + restart bc-ci-runner (bindercurve 647 handoff) so 4thcltr 245's playwright decision passes.

Pass 6 (7:50 PM ET): static-site batch 2 merged (anal0g 29, blackpixelrecords 26, denseware 30, gorfmusic 46), MoonMan 321, bindercurve 646, heuristics 84. TELUS is already live (owner deployed 5:17 PM ET); main after 49a0122 only adds a docs file, so no redeploy and no owner ask. 4thcltr 245 got a second fix (title = aria-label) and waits on its gate; 253 follows. subrythm 23 conflict resolved (union), merges when green.

Pass 7 (8:40 PM ET): pool-gated PRs cannot move. bindercurve and 4thcltr `heavy-runner-preflight` fails: "heavy runner pool last reported 6112s ago (limit 900s)". CORRECTED 8:45 PM ET: pool healthy, queued (heartbeat variable current; earlier 6112s figure came from an old preflight log). No owner action for the pool. Waiting: 4thcltr 245 (then 253), bindercurve 647, 648 (all reviews clean). Wedged old 245 run force-cancelled. ssatcy 34 and 36 fail `Playwright smoke (webkit)` (toHaveCount timeout), cause not established. Merged tonight: MoonMan 321, bindercurve 646, heuristics 84, anal0g 28-30, bpr 25-26, denseware 29-30, gorfmusic 45-47, subrythm 22-23. Reviews requested: anal0g 31, gorfmusic 48, promptboi 57-60. Duplicates left open (close commands given to owner): bpr 27, denseware 31, subrythm 24.

## Handoff (11:50 PM ET, session at its token cap; loop stopped)

Merged tonight: MoonMan 296, 321; bindercurve 646, 647, 648 (train 620/621/622; main deploy-check green on 181e270); 4thcltr 245 (axe 4.14 a11y fixes + Playwright 1.64.1); heuristics 84 (TELUS already live, no redeploy); static sites: anal0g 28-30, bpr 25-26, denseware 29-30, gorfmusic 45-47, subrythm 22-23, promptboi 57-61.

Next (in order):
- [ ] 4thcltr 253: main merged in (clean update-branch, no review needed; say so, already commented). Full gate running on head 0350d856e (e2e 1,3,4,5,7,8 pending at 11:49 PM ET). When every check name has a success (check-runs API per head), run gates and merge.
- [ ] promptboi 63: new review shows 1 finding on 68d958063; triage before merging. 62 conflicts with main; 64, 65 reviews requested (check `review-status`). One promptboi merge per pass (backlog.json conflicts).
- [ ] anal0g 31, gorfmusic 48: reviewed clean, conflict with main (merge main, union backlog.json, no new review if only lists).
- [ ] ssatcy 34 (symlink fix pushed, re-review requested), 35 (2 findings), 36: webkit smoke `toHaveCount` timeout, cause not established.
- [ ] MoonMan 319 (real Low finding: splash .platform-line order), 291 (red, rebase on main). MoonMan deploy is ship-bot stage 4 Sun 15 Nov, needs green main Fri 14 Nov.
- [ ] bindercurve 639 (Playwright 1.64.1 bump): needs a runner image + Dockerfile ARG/digest rebuild first; bundle-budget cause unknown.
- [ ] Unreviewed worktree-* drafts remain: promptboi 66-67, ssatcy 37-38.
- Owner-only: close the three superseded drafts (bpr 27, denseware 31, subrythm 24) if wanted; classifier refused my `gh pr close`. Ship-bot takes over labelling on Thu 12 Nov (stages 2 and 3).

## Loop 2 (11:20 PM ET Tue to 7:40 AM ET Wed)

Merged: 4thcltr 253 (carried Dependabot 244, which stays open until Dependabot closes it), promptboi 63, 64, 67, MoonMan 319 (CSS fix for the review finding plus a spec fix; e2e-webkit `cardText.spec.ts:118` at 320px failed twice and passed on one rerun: flaky, not ours), gorfed.net 138.
Superseded by main, left open for the owner to close: anal0g 31, gorfmusic 48, promptboi 65, 66.
Blocked: ssatcy 34-38 (webkit `toHaveCount(0)` on the Privacy dialog at the smoke spec fails on Playwright 1.64 Linux WebKit; ssatcy 38 also has a Medium finding: `verify-production.mjs` runs after the deploy switched live). BinderCurve 649 (runner image to Playwright 1.64.1) is review-clean and held until the owner runs `sudo infra/ci-runner/install.sh` on dapyllil from its branch (runbook in the PR body); then merge it and `@dependabot rebase` on 639. promptboi 56, ssatcy 33 and BinderCurve 639 wait on the same 1.64 WebKit issue. MoonMan 291 is a red draft needing a rebase. ai-use-levels 3 conflicts with main.

## Next
- [ ] Owner: run the 649 runbook on dapyllil, then merge 649 and rebase 639.
- [ ] Ship-bot stages 2 and 3 go live Thu 12 Nov: Wednesday evening, confirm `~/.ship-bot/config.json` rows and `--validate`.
- [ ] Find the cause of the Playwright 1.64 Linux WebKit failures (ssatcy smoke, promptboi 64's note) before the Dependabot bumps move.

## Loop 3 (Wed 11 Nov 2026, 9:05 AM to 3:00 PM ET; stopped at its token cap)

Done: ship-bot app reinstalled and the heuristics and papers deploy rows applied (live false, observation; `--validate` ok for heuristics, papers shows the known `derive` sampling gap; `preflight-launchd.sh` passes with the `site deploy host` step). .github main kit repaired by #123, #124, #122 (not mine); #116 (4thcltr tag-deploy, observation) merged and installed. BinderCurve WebKit 1.64 cause found (16 per-cell backdrop-filter layers on the owned header); #650 carried #649 as a train and both merged. ssatcy.com #39 (wide CSS blurs starve Linux WebKit; guard added) gates all passed, review clean on c4bbb60e8.

Next:
- [ ] ssatcy.com #39: owner runs `gh pr merge 39 --repo gorfednet/ssatcy.com --merge` (command given 2:25 PM ET); then merge main into ssatcy 33 to 38 and re-run; 35 had 2 findings, 38 a Medium (verify-production.mjs runs after the deploy switched live). promptboi 56: check the same blur class.
- [ ] BinderCurve #651 (replaces closed #639): bundle-budget fails, entry chunk 113,348 gzip vs 78,000; bisect the 23 updates. Never refresh the budget. Priority 6.
- [ ] MoonMan 291: red draft, rebase on main (main green). Deploy is ship-bot stage 4 Sun 15 Nov.
- [ ] Owner closes superseded drafts: `gh pr close 121 --repo gorfednet/.github`; ai-use-levels 3 is stale (kit 0.48.0, 49 files, conflicts): close and reinstall the kit at the current version.
- [ ] Owner removes the 1 GB repro leftover: `ssh dapyllil 'rm -rf ~/repro-owned'`.
- [ ] 6:00 PM ET Wed: `--validate` for the stage 2 and 3 repositories (9 of 18 differed at 11:08 AM ET), last 3 passes of `~/.ship-bot/logs/ship-bot.log`, 4thcltr row live flag and mode (tag-deploy session says deploy/release installed, rollback rehearsed); flip commands go to the owner only when ready. Reports to the owner 8:00 PM ET Wed and 8:00 AM ET Thu.
- [ ] Triage .github 117 to 120, ops 62, heuristics 85, and the static-site worktree-* drafts one per pass. Weekly usage was 88% (Herdr holds at 90%).

## Loop 4 (Wed 11 Nov 2026, 3:07 PM to 7:20 PM ET; stopped at the owner's 90% usage hold)

Merged: ssatcy.com 39 and 40 (40 pins `motion` at 13.4.4: 14.10.1 grows the main chunk 454.7 to 469.9 kB, past the 450 KiB budget), MoonMan 291 (lockfile-only; its red was a GitHub artifact-upload outage, 294 test files passed). Sessions handed the owner merge commands for these; that was wrong, labels are the route (rule restated 6:30 PM ET).

Labelled `ready-to-merge` at 7:15 PM ET (gates: checks started, review clean on the head, no closing keywords): ssatcy.com 34 (a351d06b) and 35 (1f5f1718). Both show `browser-compat / compat-success` QUEUED, a ghost job like promptboi's earlier stuck run; ship-bot waits for it. If it stays queued, push an empty commit to the branch for a fresh run. ssatcy is `live: false`, so the bot merges from Thu 12 Nov once stage 2/3 go live.

Open:
- ssatcy.com 36, 37, 38 are drafts with main merged (conflicts in `ci.yml` resolved by keeping both sides' verify commands). 38 has a Medium finding: `verify-production.mjs` runs after the deploy switched live. Mark ready one at a time, gates, label.
- promptboi 56 (Dependabot group, 45 updates): blocked on the bundle budget. Main plus Vite 8 and esbuild shrinks the bundle (896,079 to 881,221 raw). `@supabase/supabase-js` 2.91.1 to 2.118.0 alone adds about 55,000 raw / 14,800 gzip bytes; holding it and the radix group at main's versions still leaves 961,760 raw against the 902,491 ceiling, so another transitive bump is involved. WebKit timeouts (archive, chat-column, csp, feed specs) are not attributed. Split: Vite 8, esbuild and the test tools first, runtime deps one at a time. Never refresh the budget.
- BinderCurve 651 (entry chunk 113,348 vs 78,000 gzip): bisect the same way, main plus bumps in groups. Priority 6.
- Not touched: static-site worktree-* drafts, .github 117 to 120, ops 62, heuristics 85.
- Owner closes: `gh pr close 121 --repo gorfednet/.github`; ai-use-levels 3 is stale; `ssh dapyllil 'rm -rf ~/repro-owned'`.

Ship-bot stage 2/3 pre-flip evidence (6:03 PM ET, `--validate`, preflight-launchd passes including `site deploy host`):
- ok: anal0g, blackpixelrecords, rowanmcarthur, subrythm (3 recent merges each: 30/29/28, 26/25/24, 17/15/16, 23/22/21).
- differ: gorfed.net, gorfmusic, denseware, ssatcy, promptboi, bindercurve.com, 4thcltr.com, MoonMan (expected-check name differences; ssatcy and promptboi lists carry stale matrix names).
- Criterion 3 is NOT met for any static site: the log has no `would deploy from ...` line for a real pull request in them since observation began, and the last passes show only the 9 and 11 Nov rate-limit errors. Papers and heuristics do have such lines. No flip command was given.
- 4thcltr.com row in `~/.ship-bot/config.json` is `live: true`, mode `deploy`, `release.tagPrefix v` (file changed about 3:07 PM ET). The README plan says observation until Mon 23 Nov. The bot merged 4thcltr.com 256 at 4:03 PM ET with no deploy line. Confirm that was intended.

## Next
- [ ] Ship-bot merges ssatcy.com 34 and 35 once ssatcy is live (check `fleet-status` for their state as of 13 Nov); then label 36, 37, 38 in turn, one at a time.
- [ ] Decide the 4thcltr.com row (live deploy now, or back to observation until 23 Nov).
- [ ] Split promptboi 56 and bisect BinderCurve 651 after the usage reset (Fri 13 Nov 5 AM ET).
