# Hosted Actions spend meter

Replan row N6. Hosted Actions minutes have a monthly cap set by the owner. A budget stop would halt the hosted Claude reviewer, and so every merge. Until this meter nothing measured the spend.

## Where it runs, and why not here

This repository is public. Its `status.json`, `STATUS.md`, workflow logs, run annotations, branch history and Activity page are all world-readable, and each of them leaks something about a spend meter that runs in a public workflow: a figure, a band, or the time a threshold was crossed. Review rounds 3 to 6 on the first version (which published a state and an opaque memo from `fleet-status`) found a new leak after each fix, so the meter was taken out of every public output. `scripts/lib/actionsSpend.mjs` is a library with tests, wired to nothing public. A test pins that: it fails if the status report, its renderers, its schema or its workflow mention the meter.

The wiring is its own change, run from the Mac's private job (the capacity job's pattern: a LaunchAgent, its log on the Mac, ntfy `ops-report` through `~/.ship-bot/ntfy.token`):

- reads the month's billing usage report with `readMeter` and `ghJson`;
- takes the cap from a private file (`loadCap`), never from this repository;
- keeps the memo in a private file (`readMemo`, `withMemo`, and the memo `applyAlert` returns);
- pushes one ntfy line at 70%, 90% and 100% of the cap (`applyAlert`, `alertText`);
- pushes the "meter is blind" line (`applyAlert`, `blindText`) and writes the memo `applyAlert` returns on every run, including a run whose reading is unknown: without it an expired token or a refused permission mid-month looks the same as "under 70%". The wiring must not skip the push or the write for an unknown reading;
- calls `ghJson`, whose 60 second ceiling kills a stalled `gh`, so the job always exits and the next run starts.

## What the library does

`meterFromReport` turns one billing usage report into hosted minutes, net dollars (after the included minutes, which is what a budget stop counts), whole percent of the cap, and a projection to month end.

The projection is "about", not exact. It runs on gross dollars, because net reads 0 for as long as the included minutes cover usage, so an early overflow would not move it. The rate for the days left is the larger of the month's average and the last 7 days', so a late spike counts. The discount applied so far is subtracted, and it is at most the whole allowance, so the figure leans high. The first day counts as a whole day.

Thresholds fire once each a month. A jump past several pushes only the highest and records them all. A push that fails records nothing and retries on the next run. A new calendar month starts with nothing fired, and a reading that falls back under a threshold re-arms it. A memo that cannot be read is not "nothing fired": the thresholds the reading has already passed are taken as sent, which can lose a line and never repeats one. That run also rewrites the memo from its reading, so the file is repaired and the thresholds still to come are not silenced. A threshold the reading has dropped under is written too, so the re-arm survives to the next run.

## Unknown is not zero

If the report cannot be read, or looks wrong (no `usageItems`, no Actions row, a non-numeric amount), the reading is `unknown` with a fixed reason and no numbers. The reason is never the call's own text, since a JSON error can quote part of the report: it names a status code (401 token not accepted, 403 permission or rate limit, 404 which GitHub also answers to a token without the permission), an over-large report, or a body that was not JSON. An empty report in the first day of a month is "not reported yet" (the report lags by hours), still unknown and never 0. An unknown reading pushes no threshold line and leaves the thresholds as they were. It does start a clock: the memo records `unknownSince`, and once the readings have been unknown for 24 hours one "meter is blind" line goes out, once a month (`blindSent`). It carries no figure, only that no threshold can fire until the meter reads again. A reading that works ends the run of unknowns, and a new month starts clean. The first day of a month is not counted, because an empty report is normal then. A `gh` call that stalls is killed at 60 seconds and reads as unknown, so a launchd job always exits.

No per-repository figure is kept anywhere, because the report lists a repository on every row.

## The token

The read is `GET /users/<owner>/settings/billing/usage` (the account is a user; the organization path is the fallback). It needs the classic scope `user`, or the fine-grained account permission "Plan: Read-only". GitHub answers 404 to a token without it. `BILLING_READ_TOKEN`, when set, is used for that one call in place of the usual token. The `gh` login on the Mac does not have the scope today.

## Overflow counts against the meter

Overflow (`shipping.md`, "Runners": pool heartbeat stale, or the oldest queued job over 15 minutes) sends priority 1 to 5 work to a hosted runner. A hosted runner bills the same minutes whatever sent the job there, so overflow is inside the meter's minutes and dollars from the moment the billing report shows them. There is no separate overflow counter.

- A pool outage shows as a higher projection and, if it is large enough, as a 70%, 90% or 100% line. That is the signal to put a repository back on the pool or hold BinderCurve, not a bill to read afterwards.
- The meter is month to date, so the pool setting coming back after the queue clears shows as the projection flattening.
- The billing report lags by hours, so the first minutes of an overflow show on a later run.
- To see how much of a month was overflow, compare the month's minutes with the steady-state estimate in the CI resourcing plan (private ops). No per-repository split is kept; read it from the billing page.

Changing the overflow switch itself (`HEAVY_RUNS_ON` and the heartbeat threshold) is a separate pull request.
