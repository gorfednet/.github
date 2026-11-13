# Brief: expiry-watch false alarms (13 Nov 2026 report: 1 expired, 23 unknown, 1 warn)

Model: Sonnet 5.5 (`builder`), `reviewer` Fable on the unit-file diff. Repo: gorfednet/ops (`infra/expiry-watch/`).

## What Desk found (14:05 ET, 13 Nov)
- All 5 "job-*" items are false: every timer is live in `systemctl list-timers` as root. The unit runs with `DynamicUser=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, so its `systemctl` calls fail ("Transport endpoint is not connected").
- `reboot-watch.timer` is `OnBootSec=10min` only, so "no next run" is expected. The check must treat boot-only timers as healthy if they last ran after the last boot.
- `apitcg-api-key` EACCES: the key file isn't readable by the dynamic user.
- `nginx-capture-recapture` points at `infra/nginx/CAPTURE.json` in gorfednet/.github, which doesn't exist (moved to ops `hosts/dapyllil/webserver/`?).
- 17 items are "no expiry date recorded". Fill every date a session can find itself (domain RDAP for towit.io and whywa.it, `gh api` where a token's expiry shows). Leave only the owner-only ones (card expiries, Apple membership, MFA review, PAT replacement), and send them as ONE weekly digest line, not 17 daily alerts.

## Done when
A rerun on dapyllil reports 0 false UNKNOWNs, and the owner-only list is short and dated. Fix the job check (e.g. read timer state through `systemctl show` with the right access, or a root-written state file), test it with a planted dead timer (watched failing once), and record a ledger line. Any sudo install step goes as one exact `ssh -t dapyllil "…"` line at the top of `## Next`.

## Boundaries
Never read `credentials.json` or any key file contents. Edit `credentials.json` only through the repo's own tooling, if it exists, and set only `check.expiresOn` dates. If there's no tooling, list the dates under `## Next` for the owner.
