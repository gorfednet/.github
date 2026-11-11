# CI resourcing plan: dapyllil pool and hosted runners

Written 11 November 2026 from 14 days of measured data (28 October to 11 November). Owner rules: `~/.claude/rules/shipping.md` "Runners". Priority: infra, 4thcltr and subdomains, gorfed, resumes, MoonMan, BinderCurve.

## What the data says

- **The pool does most of the work.** 3,558 pool jobs in 14 days: BinderCurve 2,759 (78%), 4thcltr 336, MoonMan 311, assess 131, career-portfolio 21. Real work was about 553 slot-hours. On hosted 2-core runners that is about 71,000 minutes a month, roughly US$425 at US$0.006 a minute. dapyllil is worth keeping.
- **Capacity is not the problem.** 4 slots of 2 CPUs and 6 GB, pinned to the 8 efficiency cores (12 threads, 62 GB). 553 of 1,344 slot-hours is 41% use. GitHub reports 1,347 slot-hours, but 794 of those are 57 orphaned jobs that hung until GitHub cancelled them, some at 24 hours.
- **Reliability is the problem.** Two outages in 14 days:
  - 3 to 5 November, about 2 days. The firewall isolation rules disappeared, so the supervisor refused to start runners (it fails closed, as designed). Its heartbeats kept saying healthy, so every preflight sent work to a pool that would not run it. Why the rules vanished is not established.
  - 6 November, about 12:00 to 23:00 ET. The supervisor's GitHub API calls returned 403. Jobs were orphaned for up to 11 hours.
- **Queue waits on the pool** (job created to started): 4thcltr p50 16 min, p90 112. BinderCurve deploy-check p50 28, p90 153. BinderCurve nightly p50 56. On the quiet days, 9 to 11 November: p50 3 to 18, p90 36 to 92. The model service cut CI to 1 slot 22 times.
- **The 7 November fallback is still on.** assess, MoonMan and gorfed.net set `HEAVY_RUNS_ON` to `"ubuntu-latest"` on 7 November and nobody switched them back. Since then MoonMan used 4,410 hosted minutes and assess 763. That is 51% of November's hosted use.
- **Hosted spend.** About 10,200 billed minutes from 1 to 11 November across the private repositories (job-level, rounded up per job), counting about 1,075 for the reviewer. Allowing 2,000 to 3,000 included minutes, that is about US$43 to 49 so far, on course for about US$150 for November. The ceiling is US$50. The exact bill needs the `user` scope on the `gh` token, which no session has.
- **Failures, by cause** (job-level failing step, 14 days):
  - Infra, hosted: `Install ripgrep` (apt, `security.ubuntu.com`) failed 20 times in `verification-kit` and blocked heuristics PR 85. PR 121 removes the apt install.
  - Infra, pool: 57 orphaned jobs. Playwright install or decision steps failed 17 times on 4thcltr and BinderCurve.
  - Roll-up echoes, not causes: BinderCurve's "Confirm all E2E matrix jobs passed" (35) and "canary shard" (19), 4thcltr's sweep (12).
  - Code: MoonMan formatting (13) and coverage floors (9). BinderCurve vendored kit drift (11). heuristics `Verify` (7) and share-mount guard (5).
  - Flaky, as far as reruns show: 28 runs went green on a rerun (BinderCurve 15, 4thcltr 4, MoonMan 4).
  - No hosted outage, other than the apt mirror.
- **Red every time:** BinderCurve `nightly-main` had 0 green runs out of 8. `.github` `fleet-status` failed 9 times out of 13 (repository reads and backlog checks), so STATUS.md is not reliable.

## Where each class of job runs

| Job class | Runs on | Why | Expected wait | Cost a month |
|---|---|---|---|---|
| Browser matrices, e2e shards, unit and lint gates with Playwright, PDF and site builds | pool | 80%+ of minutes; hosted would cost about US$425 | p50 under 15 min, p90 under 60, once fixes 1 to 3 land | 0 |
| Light PR gates for heuristics, papers, gorfed.net, career-portfolio | pool, with the hosted preflight fallback | the rule says pool by default; about 5,500 hosted minutes a month today | the same | about US$33 saved |
| Preflights and heartbeats, roll-up "all passed" jobs | hosted | they must run when the pool is dead, and they take seconds | 0 | about US$15 |
| Claude reviewer (`claude-review.yml`) | hosted | bound by API calls, 1 to 3 min; a pool slot would add 16 to 150 min before every review | 0 | about US$17 |
| Production healthchecks, scheduled reports, fleet-status, Dependabot | hosted (fleet-status is public, so free) | must not depend on the host they watch | 0 | under US$3 |
| Deploys to dapyllil | pool | they deploy to the same host | as above | 0 |

Steady state: about 6,800 hosted minutes a month, about US$23 to 29 after the included minutes. That is under the ceiling with room for one pool-down day.

## Plan, in order

1. **Restore the pool on assess and MoonMan** (runner, done 11 November with this plan): `HEAVY_RUNS_ON` back to `as-heavy` and `mm-heavy`. Both ran on the pool until 6 November, and the pool is up (rebooted 11 November, 9:54 ET).
2. **Honest heartbeat** (Sonnet builder, BinderCurve `infra/ci-runner/supervisor.sh`). Write a heartbeat only when `firewall.sh --check` passes and a runner could start. Post to ntfy `ops-report` when the rules are missing or a queue has had no start for 30 minutes. On 3 to 5 November this alone would have sent the work to hosted after 30 minutes, not after 2 days.
3. **Reap orphaned jobs** (Sonnet builder, same script). Set `timeout-minutes` on every pool job (60 for a shard). The supervisor cancels a run whose container is gone or past that limit. That frees the 794 lost slot-hours and stops 24-hour hangs.
4. **Merge PR 121** (no apt in `no-smb-guard`). This fixes the 20 ripgrep failures and heuristics' block.
5. **heuristics and papers onto the pool** (backlog `ci-on-the-pool`; after step 2). Their rows and labels (`hx-heavy`, `pp-heavy`) are in `pools.conf` and their CI has the preflight. Missing: a token each (the owner) and `HEAVY_RUNS_ON` (runner).
6. **gorfed.net onto the pool** (runner). Its token is live. Set `["self-hosted","linux","gn-heavy"]` and add the hosted preflight its `ci.yml` lacks.
7. **Stop or cut** (Sonnet, BinderCurve): pause `nightly-main` until it can go green. Move `production-monitor` (722 runs in 7 days, 321 cancelled by its own concurrency) to a dapyllil systemd timer, like `cta-watch`.
8. **Fix fleet-status** (Sonnet, `.github`; infra priority 1): 9 failures in 13 runs.
9. **Report hosted minutes** (runner, after the owner grants the `user` scope): `fleet-status` reads the billing API and puts hosted minutes against US$50 in the daily digest.

Not recommended: more slots or new hardware. Use is 41%. Waits come from the outages, orphaned jobs, the model service's 1-slot mode and per-repository caps. Revisit slots only if p90 stays over 60 minutes for a week after steps 2 and 3.

## Owner steps (only what a session cannot do)

- Two fine-grained tokens for step 5, one each for `gorfednet/heuristics.4thcltr.com` and `gorfednet/papers.4thcltr.com`: Administration read and write, Actions read-only, with an expiry. Then on dapyllil `sudo infra/ci-runner/install.sh --set-token heuristics`, the same for `papers`, then `sudo systemctl restart bc-ci-runner`.
- `gh auth refresh -h github.com -s user` on the Mac, for step 9.

## Method

Runs: `gh api repos/gorfednet/<repo>/actions/runs?created=>=2026-10-28` for 10 repositories, 4,000 runs (BinderCurve per workflow, past the 1,000-result cap). Jobs: `…/runs/<id>/jobs` for every heavy-workflow run and 25 sampled runs of the others, 1,249 runs. Pool: the supervisor journal on dapyllil (`journalctl -u bc-ci-runner`), `pools.conf` on BinderCurve main. Price: GitHub's 2026 Linux 2-core rate, US$0.006 a minute.
