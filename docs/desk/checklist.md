# Fleet checklist (Desk keeps this current; posted to the owner on every pass and every deploy)

Updated 13 Nov 2026, 11:49 ET.

## Bottlenecks
- [x] Ship-bot API use cut from about 1,800 to about 100 calls an hour (.github 143, merged 10:35 ET; reinstall in progress)
- [x] Ship-bot on its own GitHub App (live 10:52 ET)
- [x] CI waits at 60-second checks in every session (rule changed 10:00 ET)
- [ ] CI pool resize (3.1/3.2, running)
- [x] Deploy root-cause fix (.github 140, merged)
- [ ] Blocked deploys: fix merged (.github 158), owner applies the config patch, then papers unblocks
- [x] Cloud start failure explained: an Anthropic overload (.github 142, labelled)

## Control plane
- [x] Gate commands on PATH (1.7, .github 141, merged 10:35 ET, installed)
- [ ] Briefs folder and handoff (1.1, .github 133)
- [ ] Rules drift guard (5.4, .github 144, final review requested)
- [x] Janitor live with auto-close (1.5, .github 148 merged; dry runs 14 to 16 Nov 07:00 ET)
- [x] Hygiene counts in STATUS (1.6, .github 147, merged)
- [x] Herdr fixes (1.8, ops 70 merged)
- [ ] One queue and starter in Herdr (1.11, running)
- [ ] Ship-bot unattended-merge guards (1.12, running)
- [ ] Heartbeats and usage pushes (1.13, running); detect and repair loop (1.14) next
- [x] Capacity check (1.9, .github 152 merged)
- [ ] Rules, skills, settings sweep (5.x, .github 153, re-review running)
- [x] ssatcy security headers live, ssatcy unblocked (11:51 ET)

## Repos
- [ ] Kit refresh to 0.61 across 10 repos (2.9): 3 merged (blackpixel, subrythm, gorfed.net), 6 labelled, bindercurve in CI
- [ ] gorfed.net font-preload check (3.4, gorfed.net 144)
- [ ] `.cursor/` leftovers removed (4thcltr, gorfed.net, gorfmusic 53)
- [ ] 4thcltr wordmark test (3.3), then 4thcltr 257 Swiss footer
- [ ] Backlog entries marked landed, plus reviewer added to 5 repos (4.2/5.3, 9 PRs, 1 labelled)
- [ ] MoonMan 325 tidy (evidence folders deleted)
- [ ] heuristics 75 content move, then Costco 76 and Verizon 77 (2.10, captures running); assess 72 closed with a reason (assess 76 labelled)
- [ ] Drain uncommitted worktrees (2.3, running)
- [x] Close duplicate drafts (2.4)
- [ ] .github apt DNS red (2.5): 105, 106 merged; 98 kit red
- [x] ssatcy and 4thcltr mains green (3.5)
- [ ] Dependabot reds on WebKit 1.64: bindercurve 651, promptboi 56 (3.6, running)

## Parked or later
- RED credit and the Lidarr fix: parked by the owner
- 4thcltr bot deploy: Mon 23 Nov
- dapyllil console reboot test (3.7): when convenient
- BinderCurve planning-doc triage (4.4): after the above

## Usage
Weekly 9% at 11:21 ET. Full speed, cost-aware. One line to the owner at about 90%, since he has a one-time reset.
- [ ] Expiry-watch false alarms fixed; owner-only dates sent as one weekly line (ops sweep session)
- [x] GitHub Actions budget at US$150, stop at limit (owner, 13 Nov 18:20 ET)
- [ ] 1 Dec morning: remind the owner to set the Actions budget to US$100
