# Fleet checklist (Desk keeps this current; posted to the owner on every pass and every deploy)

Updated 13 Nov 2026, 10:50 ET.

## Bottlenecks
- [x] Ship-bot API use cut from about 1,800 to about 100 calls an hour (.github 143, merged 10:35 ET; reinstall in progress)
- [ ] Ship-bot on its own GitHub App (owner's one browser step, after 143)
- [x] CI waits at 60-second checks in every session (rule changed 10:00 ET)
- [ ] CI pool resize (3.1/3.2, running)
- [ ] 4 blocked deploys fixed: papers, MoonMan, gorfmusic, ssatcy (2.1/1.4, .github 140 labelled, 4 repo PRs gated at 10:25 ET)
- [x] Cloud start failure explained: an Anthropic overload (.github 142, labelled)

## Control plane
- [x] Gate commands on PATH (1.7, .github 141, merged 10:35 ET, installed)
- [ ] Briefs folder and handoff (1.1, .github 133)
- [ ] Rules drift guard (5.4, cloud session running)
- [ ] Janitor live with auto-close (1.5, running)
- [ ] Hygiene counts in STATUS (1.6, queued)
- [ ] Herdr fixes (1.8, running; ops 62 open)

## Repos
- [ ] Kit refresh to 0.61 across 10 repos (2.9): 3 merged (blackpixel, subrythm, gorfed.net), 6 labelled, bindercurve in CI
- [ ] gorfed.net font-preload check (3.4, gorfed.net 144)
- [ ] `.cursor/` leftovers removed (4thcltr, gorfed.net, gorfmusic 53)
- [ ] 4thcltr wordmark test (3.3), then 4thcltr 257 Swiss footer
- [ ] Backlog entries marked landed, plus reviewer added to 5 repos (4.2/5.3, 9 PRs, 1 labelled)
- [ ] MoonMan 325 tidy (evidence folders deleted)
- [ ] heuristics 75 content move, then Costco 76 and Verizon 77 (2.10, captures running); assess 72 closed with a reason (assess 76 labelled)
- [ ] Drain uncommitted worktrees (2.3, running)
- [ ] Close duplicate drafts (2.4, running)
- [ ] .github apt DNS red (2.5, running)
- [ ] ssatcy and 4thcltr mains green (3.5, running)
- [ ] Dependabot reds on WebKit 1.64: bindercurve 651, promptboi 56 (3.6, queued)

## Parked or later
- RED credit and the Lidarr fix: parked by the owner
- 4thcltr bot deploy: Mon 23 Nov
- dapyllil console reboot test (3.7): when convenient
- BinderCurve planning-doc triage (4.4): after the above

## Usage
Weekly 6% at 10:05 ET. Full speed, cost-aware. One line to the owner at about 90%, since he has a one-time reset.
