# Brief: 1.10 headless starter, so work starts without an owner tap

Owner, 13 Nov 2026 about 11:40 ET: "yes I thought that's what we were always trying to do", then "can we do this asap".
Model: Sonnet `builder`, Fable `reviewer` on the diff (it spends the weekly limit unattended). Repo: gorfednet/.github, next to `capacity/` (row 1.9). Open a separate PR, stacked on 1.9's branch if 1.9 isn't merged yet.

## Why
The desktop app starts sessions only on an owner turn, so the fleet stalls between his messages. Herdr can already start a full Claude session headless (`hc run --bg --name <n> --cwd <repo> <role> "<task>"`, `agents-and-cost.md`, "Herdr").

## Objective
Each 15-minute capacity tick, start the next queued Sonnet or Haiku brief in Herdr when `~/.desk/capacity.json` says `headroom`.

## Design
- Queue: `~/.desk/queue.json`, written only by Desk. Each entry has `id`, `repo` (absolute path), `brief` (path in the repo, or `git show` ref), `role` (`builder` or `runner`), `model` (`sonnet` or `haiku` only), `priority`.
- Per tick, at most 1 start. At most 3 headless sessions live, counted from `hc ls`. Stop at weekly usage of 90% or more, if readable. If it isn't, cap at 12 starts a day.
- Refuse any entry whose model is Opus or Fable, or whose repo isn't in ship-bot's repo list (read the slugs only, through `validateConfig`'s loader or `config.example.json`, never printing the live file).
- The task text is a fixed template: "Read your brief at <brief> and nothing else first, then do it. Return a PR with `## Next`. Never `gh pr merge`. `--interval 60` on any gh watch." The queue entry supplies no other free text.
- Mode file `~/.desk/starter.mode`: absent means dry run, which logs what it would start. `live` starts sessions.
- Log `~/.desk/starter.log`, ntfy `ops-report` on each start: "started <id> (<model>) in <repo>".
- On a turn end (the Herdr `Stop` hook from 1.8), mark the entry done in `~/.desk/queue-done.json`.

## Done when
- Unit tests with a fake `hc` and fake capacity cover: headroom starts 1, hold starts 0, a Fable entry is refused, the cap is reached, dry run starts nothing. Each is watched failing once.
- A dry run against a real queue of 2 entries logs both decisions correctly.
- `docs/desk/brief.md` step 4: Desk writes queue entries for Sonnet and Haiku rows, and starts only Opus and Fable rows through the app.
- PR with `## Next`, first line merge. Then Desk writes `live` after one correct dry-run tick.

## Boundaries
Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`. Never merge.
