# Hosted Actions spend meter

Replan row N6. Owner rule: hosted Actions minutes have a hard cap of US$100 a month (`shipping.md`, "Runners"). A budget stop would halt the hosted Claude reviewer, and so every merge. Until this meter nothing measured the spend.

## What it does

`fleet-status` (every 2 hours, hosted, one run at a time through a `concurrency` group so two runs cannot push the same line) reads the month's billing usage report and builds a private reading: hosted minutes, net dollars (after the included minutes, which is what a budget stop counts), whole percent of the cap, and a projection to month end.

The projection is "about", not exact. It runs on gross dollars, because net reads 0 for as long as the included minutes cover usage, so an early overflow would not move it. The rate for the days left is the larger of the month's average and the last 7 days', so a late spike counts. The discount applied so far is subtracted, and it is at most the whole allowance, so the figure leans high. The first day counts as a whole day.

**Nothing with a figure is published.** The public `status` branch gets a state only: `ok` under 70% of the cap, `alert` from there, `unknown` when unread, plus `fired`, the thresholds already pushed this month. The figures go to two private places:

- ntfy `ops-report`, which is authenticated: one line at 70%, 90% and 100% of the cap (a jump past several pushes the highest, and records them all), and the daily digest's second line.
- a local run of `fleet-status` (`--include-private`), in its own view, when that Mac's login can read billing. When it cannot, the local run falls back to the published state, if that is a known reading of this month under a day old. A hosted run never falls back: its unknown stays unknown.

The full reading is written to a file on the runner (`--spend-out`) and never into `status.json`. `scripts/actions-spend-alert.mjs` reads it, posts the lines and records them in `actions.fired`.

Order matters. The alert runs after Publish, and only when Publish succeeded, so a failed Publish cannot repeat a line every 2 hours. It then records what it pushed with a second small commit to the `status` branch; if that push fails the next run pushes the line once more (noise, not a lost alert). A push that fails records nothing and retries on the next run. A new calendar month starts with nothing fired, and a reading that falls back under a threshold re-arms it.

The last published `status.json` is the memo. A `status` branch that does not exist yet is a first run. One that exists but cannot be fetched, or reads as damaged, is not "nothing fired": the run publishes nothing, skips the alerts and fails.

No per-repository figure is kept anywhere, because the report lists a repository on every row and a private repository's name must not leave it.

## Unknown is not zero

If the report cannot be read, or looks wrong (no `usageItems`, no Actions row, a non-numeric amount), the block carries `unknown` with a fixed reason and no numbers. STATUS.md says "unknown, and not zero". The reason is never the call's own text, since a JSON error can quote part of the report: it names a status code (401 token not accepted, 403 permission or rate limit, 404 which GitHub also answers to a token without the permission), an over-large report, or a body that was not JSON. An unknown reading pushes nothing and leaves `fired` as it was, so a bad read neither fires an alert nor re-arms one. It warns in the log and does not turn the job red.

A `--from` run keeps the earlier file's block and reads no billing.

## The token

The read is `GET /users/<owner>/settings/billing/usage` (the account is a user; the organization path is the fallback). It needs the fine-grained permission **Plan: Read** (account permissions), or a classic token with the `user` scope. GitHub answers 404 to a token without it, so a refusal reads as "unknown ... needs the Plan permission".

The workflow uses `BILLING_READ_TOKEN` for that one call when the secret exists, and `FLEET_READ_TOKEN` otherwise. Adding Plan: Read to `FLEET_READ_TOKEN` is enough.

## The cap

`scripts/lib/actions-cap.json` holds the monthly cap. The 70%, 90% and 100% lines and the percentages are against it. November 2026 may reach US$150 by the owner's allowance; the aim, and the meter's base, stays US$100.

## Overflow counts against the meter

Overflow (`shipping.md`, "Runners": pool heartbeat stale, or the oldest queued job over 15 minutes) sends priority 1 to 5 work to a hosted runner. A hosted runner bills the same minutes whatever sent the job there, so overflow is inside the meter's minutes and dollars from the moment the billing report shows them. There is no separate overflow counter.

What this means in practice:

- A pool outage shows as a higher projection in the private digest on the next daily run, and as a 70%, 90% or 100% line if it is large enough. That is the signal to put a repository back on the pool or hold BinderCurve, not a bill to read afterwards.
- The meter is month to date, so the pool setting coming back after the queue clears is visible as the projection flattening.
- The billing report lags by hours, so the first minutes of an overflow show on a later run.
- To see how much of a month was overflow, compare the month's minutes in the private digest with the steady-state estimate in the CI resourcing plan (private ops). A per-repository split is kept nowhere by design; read it from the billing page.

Changing the overflow switch itself (`HEAVY_RUNS_ON` and the heartbeat threshold) is a separate pull request.
