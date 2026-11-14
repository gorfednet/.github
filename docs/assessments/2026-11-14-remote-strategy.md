# Remote strategy and Hermes: assessment, 14 Nov 2026

Owner ask (01:10 ET): "Assess it holistically as part of my infrastructure and other computer or device connection and remote strategy". Fable reviewer, read-only. [V] = read by the reviewer, [L] = lead. Desk checks after: Hermes has no process and no launchd job (verified 01:40 ET); the USB m.2 is encrypted APFS since 13 Nov 23:40 ET, so row 1.20's "unencrypted" is stale.

## Bottom line
Archive Hermes, no eval. One command path in (Remote Control to Desk), one machine path (Tailscale ssh through Herdr), one-way alerts out. Fix DNS failover, alert proof and the Mac-restart gap before adding anything.

## Inventory
- gorfpael (MacBook Pro): Desk, ship-bot (only merger and deployer), capacity, Herdr reconciler, janitor, Llama. FileVault on since 13 Nov, so a reboot stops all of it at the unlock screen until the owner types his password [L]. Caffeine keeps it awake [V]. Time Machine failing; Backblaze is the only backup [V].
- dapyllil (NUC): CI pool, 14 sites, MoonMan production, ntfy, Cloudflare tunnel, watches, Plex, Homebridge [V]. Warm-reboot hang (3.7); its alerts ride on itself.
- gorfednas (Synology): backup target, media, B2 off-site; ssh as `dev`; a Herdr machine [V]. 90% full, restore untested (3.9).
- Pi-hole (192.168.2.14): the only resolver, on an SD card, no backup, no monitor [V]. A DNS fault took both phones offline on 13 Nov [V].
- bindercurve-prod: a DigitalOcean droplet on the tailnet, missing from the Desk brief; its disk check is a manual entry [V].
- Apple TV: the only Tailscale exit node [V]. Phones: Remote Control, ntfy, Tailscale.
- Mac Pro 5,1 and Mac mini 2010: no role ("forget both for now") [V]. Keep credentials and the tailnet off them.
- USB m.2: models, builds, archives. Backblaze doesn't cover it yet [V].

Paths:
- Remote Control to Desk: the only command path. App starts and cards are refused on a phone turn [V], so Desk rotation waits for a Mac turn.
- Tailscale ssh to dapyllil: deploys and Herdr. A check-mode approval held deploys from 03:12 ET on 13 Nov [V]. No dapyllil entry in `~/.ssh/config`, so no LAN fallback [V].
- Herdr machines (dapyllil, gorfednas): same ssh underneath [V].
- Cloudflare tunnel: public sites, ntfy.gorfed.net (ntfy's own auth, no Access), post.gorfed.net (Access) [V]. ntfy Approve and Skip buttons call broadcast directly [V].
- ntfy.gorfed.net: digests and alerts, but it lives on dapyllil. ntfy.sh private topic: second push, unproven [V].
- healthchecks.io: dead-man. Email proven 13 Nov, push not [V]. Cause of the missing push found 14 Nov: the Mac had no ntfy sender token (ops PR 82).
- Hermes gateways: none connected [V].
- Not checked: Screen Sharing, Remote Login, open ports, `tailscale status`.

## Hermes verdict: archive
- Every job it offers is covered: phone chat by Remote Control and Desk, schedules by launchd, Herdr and scheduled tasks, remote shells by Herdr, alerts by ntfy and healthchecks, local models by plain `/v1` calls (1.19 a to d) and Claude Code's harness (1.19 e).
- Its one unique offer, a phone chat when Claude is down, means a shell on the merge machine driven by a weak model.
- Security: its own SECURITY.md says the OS is the only boundary against an adversarial LLM; config runs `terminal.backend: local`; a chat-bot token would be a second inbound command path to a Mac holding `gh` auth, the NAS key and Tailscale ssh; self-written skills make one injected message permanent; the default model `tencent/hy3:free` sends prompts to Nous's free tier; `hard_stop_enabled: false` [V]. Running it would also break "no other scheduled agents or automations unless the owner asks".
- Its checkout is at a 9 Jul commit (fetched main 22 Oct): a stale agent with shell access [V].
- Don't copy the clone to the USB (public repo). Keep `config.yaml`, `SOUL.md`, `kanban.db`. Revoke the Nous sign-in, then delete `auth.json` and `pairing/`.
- Order: 1.22(a) first (.github PR 179).

## Single points of failure, ranked
1. Pi-hole: house DNS on an SD card; takes the Mac, phones and dapyllil's outbound with it. No alert can leave the house.
2. The Mac after a reboot: FileVault unlock stops ship-bot, Desk, Herdr and the USB until he types his password. No restart drill yet.
3. dapyllil carries production and the alerts about production.
4. Alert proof: only email has reached him.
5. Tailscale check mode can hold deploys silently; no second route to dapyllil.
6. Remote Control can't do a desktop turn: Desk rotation, starts and trust clicks wait for him at the Mac.
7. ship-bot and capacity on Hermes's Node (1.22a, PR 179).
8. One backup of the Mac (Backblaze), none of the USB yet.
9. NAS restore untested (3.9).

## Strategy
- Phone to work: Remote Control to Desk only. No chat bots.
- Phone to a machine when Desk is dead: Tailscale plus Screen Sharing to the Mac (owner's call), Tailscale ssh to dapyllil.
- Other computers: claude.ai Remote Control. Mac Pro and Mac mini stay out.
- Machine to machine: Herdr `--on` over Tailscale ssh; the deploy ssh gets a rule that never waits on a check-mode approval.
- Alerts: healthchecks email is the floor; ntfy.gorfed.net for digests; ntfy.sh as the push when dapyllil is down; each proven by a planted stop.
- Doesn't fail safe today: DNS down, and dapyllil down.

## Plan rows changed or added (applied to the plan of record 14 Nov)
- 1.22 changed: (b) archive now, no eval.
- 1.13 changed: prove every alert path; dead-man checks for dapyllil, the Pi-hole and the NAS.
- 3.8 changed: DNS failover.
- 1.23 new: `docs/remote-access.md` in ops, break-glass path per machine, Mac restart drill under FileVault, deploy ssh free of check mode.

## Questions for the owner (asked in chat)
1. Archive Hermes now, no eval, and sign out of Nous? Recommended: yes.
2. Screen Sharing on the Mac, reachable only over Tailscale? Recommended: yes.
3. Fall back to a public resolver (9.9.9.9) when the Pi-hole is down? Recommended: yes now, a second Pi-hole later.
