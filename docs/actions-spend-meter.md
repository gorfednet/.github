# Hosted Actions spend meter

Replan row N6. Owner rule: hosted Actions minutes have a hard cap of US$100 a month (`shipping.md`, "Runners"). A budget stop would halt the hosted Claude reviewer, and so every merge. Until this meter nothing measured the spend.

## What it does

`fleet-status` (every 2 hours, hosted, one run at a time through a `concurrency` group so two runs cannot push the same line) reads the month's billing usage report and writes an `actions` block to `status.json`:

- hosted minutes, net dollars (after the included minutes, which is what a budget stop counts), and whole percent of the cap;
- a projection to month end, "at most": the gross run rate (usage before the included minutes) to month end, less the discount already applied, and never below what is already billed. Net dollars would read 0 for as long as the included minutes cover usage, so an early overflow would not move it. The discount so far is at most the whole allowance, so this never comes out under the true bill. The first day counts as a whole day;
- `fired`: the thresholds already pushed this month.

`STATUS.md` shows it under "Hosted Actions spend". The daily digest carries it as its second line. `scripts/actions-spend-alert.mjs` posts one line to ntfy `ops-report` at 70% of the cap and one at 90%. A jump past both posts only the 90% line. A push that fails records nothing and retries on the next run. A new calendar month starts with nothing fired, and a reading that falls back under a threshold re-arms it.

The numbers are totals only. The report lists a repository on every row, and a private repository's name must not reach the public `status` branch, so nothing per repository is kept.

## Unknown is not zero

If the report cannot be read, or looks wrong (no `usageItems`, no Actions row, a non-numeric amount), the block carries `unknown` with the reason and no numbers. STATUS.md and the digest say "unknown, not zero". An unknown reading pushes nothing and leaves `fired` as it was, so a bad read neither fires an alert nor re-arms one. It warns in the log and does not turn the job red: the report says so itself, and a red job every 2 hours would teach everyone to ignore it.

A `--from` run (the local `fleet-status` wrapper) reads no billing: it keeps the earlier file's block.

## The token

The read is `GET /users/<owner>/settings/billing/usage` (the account is a user; the organization path is the fallback). It needs the fine-grained permission **Plan: Read** (account permissions), or a classic token with the `user` scope. GitHub answers 404 to a token without it, so a refusal reads as "unknown ... needs the Plan permission".

The workflow uses `BILLING_READ_TOKEN` for that one call when the secret exists, and `FLEET_READ_TOKEN` otherwise. Adding Plan: Read to `FLEET_READ_TOKEN` is enough.

## The cap

`scripts/lib/actions-cap.json` holds the monthly cap. The 70% and 90% lines and the percentages are against it. November 2026 may reach US$150 by the owner's allowance; the aim, and the meter's base, stays US$100.

## Overflow counts against the meter

Overflow (`shipping.md`, "Runners": pool heartbeat stale, or the oldest queued job over 15 minutes) sends priority 1 to 5 work to a hosted runner. A hosted runner bills the same minutes whatever sent the job there, so overflow is inside the meter's minutes and dollars from the moment the billing report shows them. There is no separate overflow counter.

What this means in practice:

- A pool outage shows as a higher projection on the next 2-hourly run, and as a 70% or 90% line if it is large enough. That is the signal to put a repository back on the pool or hold BinderCurve, not a bill to read afterwards.
- The meter is month to date, so the pool setting coming back after the queue clears is visible as the projection flattening.
- The billing report lags by hours, so the first minutes of an overflow show on a later run.
- To see how much of a month was overflow, compare the month's minutes with the steady-state estimate in the CI resourcing plan (private ops). A per-repository split stays out of the public file by design; read it from the billing page.

Changing the overflow switch itself (`HEAVY_RUNS_ON` and the heartbeat threshold) is a separate pull request.
