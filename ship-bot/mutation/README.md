# Nightly mutation run (plan row 1.35)

A report, never a gate. Stryker changes ship-bot's source one small way at a time and
reruns the unit tests. A change no test notices is a survivor: an assertion is missing
or can't fail.

- Runs on a self-hosted pool host from cron or launchd, not from Actions. This
  repository is public, so the pool refuses its jobs, and hosted minutes are capped.
  It is never a required check and never runs on a pull request.
- Run it with `node ship-bot/mutation/nightly.mjs --notify`. State lives in
  `~/.ship-bot/mutation/` (`state.json`, `report.json`, `digest.txt`). `--budget-min`
  sets the night's time (default 240).
- Resumable: source is cut into 300-line units. Each night runs the units never run,
  then changed ones (source or tests), then the oldest, until the budget is spent.
  Each result is saved as the unit finishes.
- The digest (at most 8 lines, posted to ntfy `ops-report` through
  `scripts/janitor-notify.sh`) has the score, the last 5 nights and the top 10
  survivors. `report.json` has the same.
- Canary: `fixtures/planted/` holds a dead assertion that can't fail. It runs first
  every night. If its `>=` mutant isn't listed as surviving, the digest says the
  run itself is broken.
- Stryker is pinned exactly in `package.json` and `package-lock.json`.
