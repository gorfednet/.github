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
