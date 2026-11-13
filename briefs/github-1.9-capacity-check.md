# Brief: 1.9 Mac headroom, a capacity check Desk reads every pass

Owner ask, 13 Nov 2026 about 11:25 ET: "can we assess load every so often to either split or execute more tasks- is there an effecient and best practice way to do that.? should we do this as a rule- schedule?"

Model: Sonnet `builder`. Fable `reviewer` on the diff, because this changes what runs unattended.
Repo: gorfednet/.github, next to `ship-bot/` (new folder `capacity/`).

## Objective
A token-free launchd job, every 15 minutes, that writes `~/.desk/capacity.json` and pushes ntfy only when the state changes.

## Inputs (all local, no Claude tokens, no `gh` loops)
- 1-minute load against `sysctl -n hw.ncpu`
- free memory (`vm_stat`, free plus inactive pages, in GB)
- working Claude sessions, read from the app's session store the same way 1.6's hygiene rows do
- CI pool queue depth: one call to the pool's queue endpoint or a single cached `gh api` read per run, never per repo
- weekly usage, only if a local source exists. Otherwise null, and say so in the README.

## States
- `headroom`: load under 0.7 x cores, at least 4 GB free, fewer than 5 working sessions. Report N free slots (5 minus working, capped by the 2-builder rule).
- `hold`: load over cores, or under 4 GB free.
- `steady`: anything between.
ntfy topic `ops-report`, sent only when the state changes: "headroom for N, M queued" or "overloaded, hold".

## Done when
- unit test with fake inputs covers each state and the change-only push, and is watched failing once
- `install.sh` loads the plist, and `launchctl list` shows it
- a README in `capacity/` documents the thresholds
- `docs/desk/brief.md` pass step 1 says: read `~/.desk/capacity.json` first, and fill free slots from the ranked plan
- a PR with `## Next` (first line: merge)

## Boundaries
Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`. Never merge. `--interval 60` on any `gh` watch.
