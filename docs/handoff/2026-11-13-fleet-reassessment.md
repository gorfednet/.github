# Handoff: fleet reassessment and control plane, 13 November 2026

## Goal
Owner, 13 November 2026: "assess, account for, plan for finalization, closing, merging, deployment, closing chat, etc for all open agents and work outstanding. I want one big multi agent plan that accounts for all open, with one remote control point for entry." Also: higher-tier agents unless a lower one loses nothing, root causes not symptoms, self-heal skills and tests as we go, consolidate every backlog, keep the workspace clean, fix Herdr, assess CI, dapyllil, hosted runners, Docker, Plex, the arrs and Homebridge, and make it reusable for future projects. The approved plan is `docs/plan-of-record.md`.

## Done
- Six read-only scouts mapped the fleet: open PRs and sessions, the automation, the operating-model files, every backlog, Anthropic's current guidance, and the infrastructure. Their findings are summarised in the plan's "What is true today" section.
- Owner decisions: Desk runs with Remote Control on; BinderCurve's old planning docs are triaged item by item.
- `docs/desk/brief.md` written. Desk started from it (session "Desk", Opus 5.5).

## Next
- [ ] Merge this PR (docs only).
- [ ] Desk: close .github 118 and 120 as superseded by `docs/desk/brief.md` once this merges, after answering their reviewer threads or recording why they no longer apply (plan 1.1).
- [ ] Desk: start Phase 1 and Phase 2 rows by priority, two builders at a time.

## Open PRs
- Every open PR is accounted for in the plan's Phase 2 rows; none is left without an owner.

## Blockers
- Ship-bot has MoonMan, gorfmusic.com, ssatcy.com and papers.4thcltr.com blocked after failed deploys and rollbacks. They stay blocked until each cause is fixed (plan 2.1).
- Owner access, asked for on 13 November: Tailscale SSH approval for the docker host, a `FLEET_READ_TOKEN` PAT and `admin:org` read, folder trust for parked Herdr jobs, Mac sleep setting.

## Decisions
- 13 Nov: Desk is a desktop-app session with Remote Control, not a launchd `claude remote-control` server, because the session tools (list, start, message, archive) exist only in the app.
- 13 Nov: Desk runs on Opus 5.5. Its decisions have no reviewer behind them, so Sonnet is the wrong place to save. Fable stays for the reviewer, the editor and changes to what merges unattended.
- 13 Nov: blocked ship-bot repos stay blocked until the cause is fixed; unblocking first would repeat the failed deploy.
- Ruled out: cloud scheduled tasks for Desk (they cannot see the Mac), agent teams (experimental, one team per session).
