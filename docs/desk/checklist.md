# Fleet checklist (Desk keeps this current; posted to the owner on every pass and every deploy)

Updated 14 Nov 2026 (9th Desk rotation).

## Bottlenecks
- [x] Ship-bot API use cut from about 1,800 to about 100 calls an hour (.github 143, merged 10:35 ET; reinstall in progress)
- [x] Ship-bot on its own GitHub App (live 10:52 ET)
- [x] CI waits at 60-second checks in every session (rule changed 10:00 ET)
- [ ] CI pool resize (3.1/3.2, running)
- [x] Deploy root-cause fix (.github 140, merged)
- [x] Blocked deploys: patch applied, papers unblocked (19:16 ET)
- [x] Cloud start failure explained: an Anthropic overload (.github 142, labelled)

## Control plane
- [x] Gate commands on PATH (1.7, .github 141, merged 10:35 ET, installed)
- [ ] Briefs folder and handoff (1.1, .github 133)
- [ ] Rules drift guard (5.4, .github 144, final review requested)
- [x] Janitor live with auto-close (1.5, .github 148 merged; dry runs 14 to 16 Nov 07:00 ET)
- [x] Hygiene counts in STATUS (1.6, .github 147, merged)
- [x] Herdr fixes (1.8, ops 70 merged)
- [x] One queue and starter in Herdr (1.11, ops 76 merged 19:38 ET; done-when follow-up in 2.8)
- [x] Ship-bot unattended-merge guards (1.12 merged; follow-up in .github 169)
- [ ] Heartbeats and usage pushes (1.13 reopened: usage not wired, in 1.18; capacity dead-man: healthchecks.io email arrived, ntfy did not, cause open); detect and repair (1.14: .github 161, 167-169, ops 78)
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
- [ ] 14 Nov 10:07 ET: remind the owner about the 3.9 NAS backup steps (restore drill copy, music yes or no, key in the password manager). He asked; a cron is set in Desk 6, so a successor re-sets it if Desk has rotated.
- [ ] 14 Nov 10:12 ET: remind the owner to swap the Pi-hole SD card (high-endurance microSD or USB SSD). He asked; a cron is set in Desk 6.
- Mac mini (2010) as second Pi-hole: owner "one day not now". No dapyllil replica either (owner, 13 Nov). The Pi-hole board stays the only resolver until the Mac mini. Raise again only if he does.

## Added 13 Nov evening (Fable reviews)
- [x] PACE HOLD lifted by the owner, 14 Nov 01:20 ET (he can reset the week)
- [x] Backup keys in the password manager (owner, 19:50 ET)
- [ ] Installed tools track main (1.18, installed-drift)
- [ ] Papers deploy wordmark timing (card wordmark-timing); papers blocked
- [ ] Actions spend meter; ingress pin by digest; heuristics 95 and 93
- [x] Ship-bot back after the 20:16 ET outage (owner patch, 20:20 ET)
- [ ] Quota burn fix: bindercurve 659 (full gate rerunning), then the owner's dapyllil install
- [x] Settings: 5 allows, 21 delete denies (.github 177, applied live)
- [x] Reminders moved to durable scheduled tasks
- [ ] Local models (1.19) and encrypted m.2 (1.20): after the hold
- [x] FileVault on the Mac (on 13 Nov, 23:45 ET); fresh recovery key saved 23:47 ET
- [x] Backblaze: gorfkcits added, models excluded (owner, 14 Nov)
- [ ] Ship-bot and capacity off Hermes's Node (1.22a); Hermes keep or archive (1.22b)

## Added 14 Nov overnight (9th Desk)
- [x] FileVault on, recovery key rotated and saved
- [x] USB m.2 encrypted APFS (1.20); models redownloading, priority order
- [x] Phone-alert cause found and fixed (ops 82 merged); [x] ntfy installed on dapyllil (owner, 14 Nov); [x] token copy (06:49 ET); [ ] healthchecks ntfy integration, rerun the test
- [x] Ship-bot and capacity installers pick their own Node (.github 179 merged); [x] reinstalled onto /usr/local/bin/node (06:24 ET)
- [x] Weekly disk hygiene, dry run (ops 83, 84 merged)
- [x] Local-model harness (.github 180, 181 merged); [ ] fixtures (ops 85), baseline, first eval
- [ ] Hermes archive (yes; .github 182 running; owner revokes Nous); [x] Screen Sharing over Tailscale (works, RealVNC); 9.9.9.9 fallback: [x] lease 24h, [x] Tailscale DNS, [x] Pi-hole DHCP line (owner, 06:58 ET); Time Machine re-add tm_gorfpael (owner: later)
- [ ] Remote-access doc (1.23, ops 86, re-review)
- [ ] bc 659: conflict with main fixed 06:40 ET, full gate running
- [ ] bc 659 merge, then the supervisor install on dapyllil
- [ ] healthchecks.io has no ntfy integration (email only): ops session hc-ntfy-1-13, then owner pastes the token
- [ ] Egress canary edge.adobedc.net no longer blocked by the Pi-hole: session egress-canary (assess)
- [ ] MoonMan 2.0.0: 336 (plan, docs) review then label; wave 1 (S0, P1, D0) after it merges, by capacity

## Added 14 Nov morning (11th Desk)
- [ ] Release cadence: big weekly releases, local test first (1.25, session release-cadence). Desk holds visitor-facing labels until it lands
- [ ] Security policy, key rotation, off-site copies (1.24, session security-1-24)
- [ ] CI pool: bc 659 jobs timed out at 06:35 ET (35 and 20 min limits); cause, 3.1 resize, land 659 (session ci-pool-fix)
- [ ] Local models: 7 of 27 served, redownload running; CI-triage fixtures merged (ops 85); baseline then first eval (1.19)
- [ ] MoonMan 336: 2 findings and quality red, triage next pass
- [x] Numbers in prose: cancelled by the owner, digits stay (14 Nov)
- [x] Over pace hold lifted: full steam until the owner uses his resets (14 Nov)
- [ ] Herdr BinderCurve backlog: 29 failed overnight; pause and root-cause
- [ ] Plugins: global minimum, per-repo on as needed (owner yes, 07:35 ET; session plugins-off)
- [ ] 1.17 orphan decisions due 15:29 ET
- [ ] GitHub: one organization for the fleet? (owner question 07:38 ET; Desk recommends one org, no account split)

## Added 14 Nov morning (13th Desk)
- [ ] GitHub org: plan (github-org-plan), Fable review, then the owner picks a path. No visibility change
- [ ] Replan plus learnings into rules and skills, after all 5 plans
- [x] Release cadence plan written (.github 187); [x] security plan (ops 88); [x] plugins trim (4thcltr 274)
- [ ] Phase 7 docs: .github 185, 4thcltr 273 (review, label)
- [ ] Local models first eval (1.19): next infra start, when load is under 10
- [x] Full steam until the owner's resets; reset timing in the brief

## Added 14 Nov morning (14th Desk)
- [x] .github 185, 187, 188 merged; ops 74, 86 merged
- [x] Ship-bot reinstall from origin/main 339cc0a (09:50 ET); papers unblocked, papers 40 merged
- [x] Papers 40 and heuristics 99 merged
- [ ] 4thcltr 273 (e2e timing flake, rerun) and 274 (full gate): labelled
- [x] 1.19 step 0: CI-log triage dropped (logs about 1% of reads); [ ] remeasure images in tokens
- [ ] AI Agent Check add-on: memo in 4thcltr 275; plan row after the Phase 7 forms

## Added 14 Nov late morning (15th Desk)
- [x] Plex check false failures fixed (ops 91 merged); [x] owner reran plex-check, clean (10:50 ET)
- [x] healthchecks.io: backup, Pi-hole export, Homebridge checks live
- [x] Pi-hole nightly export to NAS (10:25 ET); [x] restore-drill canary fix (ops 92 merged)
- [x] Model downloads unblocked (Full Disk Access for Herdr Core); [ ] pass 2 retry of ~20 failed models
- [x] Homebridge Ring back (Node 24 for Homebridge, new token)
- [x] ops 74 docker policy applied (10:54 ET: nginx 1.31-alpine and cloudflared 2026.11.0 pinned, arrs auto, 3.96 GB pruned); [ ] docker-policy counts in-use images as dangling (fix in ops)
- [x] Hyper Backup last runs ok (servers 06:04, archive 07:05 ET); [ ] DSM: servers task to 10:00, music task, #recycle decisions
- [ ] NAS restore-drill copy (owner, DSM): parked until Mon 16 Nov
- [x] career-portfolio pool PAT rotated (owner, 11:25 ET; works 11:31 ET); [ ] add it to the expiry watch
- [x] Desk goes idle between owner messages: 30-minute Desk timer (owner yes, 11:47 ET)

## Added 14 Nov midday (17th Desk)
- [ ] CI pool stall: supervisor GitHub reads time out and retry (new bc PR), then 659, then 655, then the owner's one install on dapyllil
- [x] .github 190 merged (heartbeat 2 s timeout, owner email removed)
- [ ] ops 93: five ops 92 follow-ups
- [ ] Infra PR sweep: .github 175, 159, 154, ops 73
- [ ] 4thcltr 276 wordmark spec fix (3.3), then 273 shards 3 and 8
- [ ] 1.26 cost per PR (.github 191, review); [ ] 1.27 eval set (.github 193 + ops 95: 3 Lows, then a Fable read, then label both); [x] 1.28 weekly lessons (192 and 194 merged, task live, first Fri 20 Nov 09:00 ET)
- [x] Time Machine first backup to tm_gorfpael (copying since 12:43 ET)
- [ ] Models: retry llama-redownload4 (pass 1 had 23 of 41 files)
- [x] Tailscale back (owner reconnected, 11:56 ET)
- [x] 15 finished chats archived (12:38 ET)

## Added 14 Nov afternoon (18th Desk)
- [ ] Expiry-watch false alarms: ops 77 merged, not installed. rdap 403 and IPv6 cause with ops-92-followups. One batched owner install later
- [ ] Ship-bot REPO_EXTRA covers docs/claude-home/ (192 follow-up, Fable)
- [x] gh-poll-guard hook (175) and the 194 rule lines copied to ~/.claude

## Added 14 Nov afternoon (19th Desk)
- [ ] 1.27 eval set: 3 round-4 Lows fixed and pushed (.github ed105d4, ops 310f7b3); final Claude review and Fable read running, then label both
- [x] Ship-bot and janitor treat docs/claude-home/ as control plane: .github 195 merged, rule copied
- [ ] bc 659: failed jobs rerun after the 11:34 ET network drop; then 660, 655, then the owner's one dapyllil install
- [x] 1.17 orphan decisions (15:4x ET): 4 chats archived, lidarr-fix parked, 336 stays a MoonMan row
- [ ] Local models first eval tonight from 22:00 ET (3 candidates), scores Sun 15 Nov ~09:00 ET; reviewer and builder tasks first, copy and triage after 1.27b
- [ ] Model and skill currency (1.29): .github 196 in review; first run found 4 stale items
- [x] Always-PR hook fix: .github 197 merged, hook copied to ~/.claude (16:1x ET)

## Added 14 Nov evening (20th Desk)
- [x] .github 196 (1.29 currency) labelled; ops 96 builder-ok backup case merged and live
- [x] ops 94 merged by a stale ship-bot: root cause found; .github 200 fix merged; owner reinstalled 8e42797 (17:39 ET)
- [x] ops 98 (94 follow-ups) merged
- [x] 1.27b: .github 198 + ops 97 merged (18:00 ET); [ ] after-merge reference rerun and refreeze (card evalset-refreeze-1-27b)
- [x] .github 199 (janitor untrusted strings) merged 18:03 ET, before the 07:00 ET janitor run
- [ ] 3.10 BinderCurve gate class + rename-hole fix: bc 661 in review
- [ ] Local models first eval tonight 22:00 ET (builder task), scores Sun ~09:00 ET

## Added 14 Nov evening (21st Desk)
- [x] .github 196 merged (weekly lessons wording fix)
- [ ] Ship-bot behind origin/main af4e6dd (199 changed the gates lib): owner reinstall
- [ ] bc 655 and 657 nudged (CI pool order 655, then 660); 4thcltr 276 e2e (4) nudged

## Added 14 Nov evening (22nd Desk)
- [x] bc 661 Claude review clean (18:15 ET); [x] Fable read (1 Medium, 1 Low fixed, pushing); [ ] planted-PR proof; [ ] label
- [x] 1.27b after-merge reruns started (18:10 ET)
- [x] 199's 2 Lows: backlog entry, .github 201 merged
- [ ] Mac Pro Ubuntu CI host (ops-gowyllop 99): steps 3 and 5 running
- [ ] Local models first eval 22:00 ET, only with CPU idle at 40% or more
- [x] 4thcltr 276 merged (wordmark 3.3)
- [ ] 1.27b refreeze: .github 202 + ops 100, Fable read then label both
- [ ] bc 655 red on mutation-canary-success: cause being found

## Added 15 Nov overnight (23rd Desk)
- [ ] gowyllop 6a (owner's ssh check under the sandbox): result pending
- [ ] bc 662: merge of main pushing, ship-bot merges on green; then owner step 6b
- [ ] bc 661 (3.10): merge of main pushing; then ready and label
- [ ] 1.19: gemma FAIL 3/10, gpt-oss FAIL 2/10; Qwen rerun crashed (fetch 300 s header timeout). Harness fix PR, then rerun all 3
