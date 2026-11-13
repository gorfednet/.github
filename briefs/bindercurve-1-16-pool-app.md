# Brief: plan row 1.16, CI pool on its own GitHub App

Model: Opus 5.5 (`builder`), `reviewer` Fable. Repo: bindercurve.com (`infra/ci-runner/`). Ship-bot's App setup in gorfednet/.github `ship-bot/` is the model to copy.

## Why
13 Nov 2026, 15:01 ET: the owner's GitHub core limit hit 0/5000, and the supervisor logged "GITHUB API FAILING: starting no runners this pass". That's the third time today. The supervisor's queue reads share the owner's limit with every session's `gh`.

## Objective
The supervisor reads queues and mints runner registration tokens through an App installation token, so it has its own limit. Conditional requests (`If-None-Match`), back off under 500 remaining, and fail toward hosted (not silence) when the App can't be reached.

## Done when
Tests on a fake API: the pool starts runners while the owner token is planted at 0 remaining (watched failing once on the old path). One live pass on dapyllil reads every queue through the App. Ledger line.

## Boundaries
- The owner creates and installs the App, one browser step. Put the exact settings (name, permissions: Actions read, Administration read and write for self-hosted runners, Metadata read; repos) at the top of `## Next`. Build and test everything else first. Keys go to a file mode 600 that you never read back.
- Installs on dapyllil run as gorf through `infra/ci-runner/install.sh`. Any sudo step goes as one exact `ssh -t dapyllil "…"` line.
- Never poll `gh` in a loop (wait with `gh run watch <id> --interval 60`). Ship-bot merges. Label once clean. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
