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
  - Infra, hosted: `Install ripgrep` (apt, `security.ubuntu.com`) failed 20 times in `verification-kit`, fixed by #123 (pinned tarball). The same apt install in `no-smb-guard` blocked heuristics PR 85; PR 121 removes it.
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
4. **Land PR 121's `no-smb-guard` change** (runner): rebase it on main and drop its `verification-kit.yml` edit, which #123 superseded. This ends the apt dependency behind heuristics' block.
5. **heuristics and papers onto the pool** (backlog `ci-on-the-pool`; after step 2). Their rows and labels (`hx-heavy`, `pp-heavy`) are in `pools.conf` and their CI has the preflight. Missing: a token each (the owner) and `HEAVY_RUNS_ON` (runner).
6. **gorfed.net onto the pool** (runner). Its token is live. Set `["self-hosted","linux","gn-heavy"]` and add the hosted preflight its `ci.yml` lacks.
7. **Stop or cut** (Sonnet, BinderCurve): pause `nightly-main` until it can go green. Move `production-monitor` (722 runs in 7 days, 321 cancelled by its own concurrency) to a dapyllil systemd timer, like `cta-watch`.
8. **Fix fleet-status** (Sonnet, `.github`; infra priority 1): 9 failures in 13 runs.
9. **Report hosted minutes** (runner, after the owner grants the `user` scope): `fleet-status` reads the billing API and puts hosted minutes against US$50 in the daily digest. Built as replan row N6: see `docs/actions-spend-meter.md` (the read needs the Plan permission, read, on the fleet token, not the `gh` `user` scope).

Not recommended: more slots or new hardware. Use is 41%. Waits come from the outages, orphaned jobs, the model service's 1-slot mode and per-repository caps. Revisit slots only if p90 stays over 60 minutes for a week after steps 2 and 3.

## Owner steps (only what a session cannot do)

- Two fine-grained tokens for step 5, one each for `gorfednet/heuristics.4thcltr.com` and `gorfednet/papers.4thcltr.com`: Administration read and write, Actions read-only, with an expiry. Then on dapyllil `sudo infra/ci-runner/install.sh --set-token heuristics`, the same for `papers`, then `sudo systemctl restart bc-ci-runner`.
- `gh auth refresh -h github.com -s user` on the Mac, for step 9.

## Update 15 November 2026 (plan row 3.2): the pool takes the rest

The pool supervisor mints runner tokens through its own GitHub App since 16:57 ET on 15 November, so the 11 repositories it skipped for "no token" now get runners. Nothing in their workflows had to change: every heavy job already reads `HEAVY_RUNS_ON`. The missing piece was the repository variable. A repository without it ran everything hosted.

Set on 15 November 2026 (values are `["self-hosted","linux","<label>"]`):

| Repository | Label | Pool job seen running |
|---|---|---|
| ssatcy.com | `ss-heavy` | `bc-ssatcy-dapyllil-*` (check, deploy-safety, 3 browser-compat) |
| denseware.com | `dw-heavy` | `bc-denseware-dapyllil-*` |
| gorfmusic.com | `gm-heavy` | `bc-gorfmusic-dapyllil-*` |
| promptboi.com | `pb-heavy` | `bc-promptboi-dapyllil-*` |
| anal0g.org | `an-heavy` | `bc-anal0g-dapyllil-gowyllop-ci-*` (remote slot) |
| blackpixelrecords.com | `bp-heavy` | `bc-blackpixel-dapyllil-gowyllop-ci-*` |
| rowanmcarthur.com | `rm-heavy` | `bc-rowan-dapyllil-gowyllop-ci-*` |
| subrythm.com | `sr-heavy` | `bc-subrythm-dapyllil-gowyllop-ci-*` |
| heuristics.4thcltr.com | `hx-heavy` | `bc-heuristics-dapyllil-gowyllop-ci-*` |
| papers.4thcltr.com | `pp-heavy` | `bc-papers-dapyllil-*` (derive, check) |
| gorfed.net | `gn-heavy` (was `ubuntu-latest`) | `bc-gorfed-dapyllil-*` |

gorfed.net needed no image change: `bc-ci-runner:current` on dapyllil already carries rsync 3.2.7 (checked 15 November). gorfed.net's `ci.yml` has had the hosted `heavy-runner-preflight` since commit 3076b93 (every pool job `needs` it), so step 6's "add the hosted preflight" is already done and a dead pool fails its runs in seconds. Rolling back a repository is `gh variable set HEAVY_RUNS_ON --body '"ubuntu-latest"'` or deleting the variable; the hosted preflight fails a run in seconds if the pool stops reporting.

### Jobs that stay hosted, and why

| Repository | Hard-coded `ubuntu-latest` | Decision |
|---|---|---|
| ask-collector | `check` (compose config, `docker build`) | Stays hosted. Pool job containers have no Docker socket. Move it when the image build is split from the unit tests. |
| bindercurve.com (26) | 4 preflights (`deploy-check`, `milestone-release`, `nightly-main`, `pr-fast-check`) and `pool-heartbeat` | Hosted by design: they must answer when the pool is dead. |
| | roll-ups and alerts: `e2e-success`, `mutation-canary-success`, `deploy-check-alert`, `nightly-main-alert`, `security-nightly-alert`, `seed-freshness-alert` | Hosted: seconds of work that must run when the pool does not. |
| | `e2e-visual`, `staging-e2e-visual` | Hosted: pool font rendering is not proven identical to `ubuntu-latest`, so pixel diffs would be noise. Revisit with a measured baseline compare. |
| | `build-spa`, `deploy-canary`, `post-deploy-smoke`, `rollback`, `provider-pings`, the 4 `worker-release` jobs, the 3 `ops-*-prod` workflows | Hosted: they hold deploy, affiliate or provider secrets, and secret-holding jobs stay off the pool (2026-10-10 security review, M7; owner decision 2026-10-19). |
| | `production-smoke` | Hosted: it probes production, so it must not depend on the host it watches. |
| 4thcltr.com (3 plain, 1 fallback) | `heavy-runner-preflight`, `security-headers` (scheduled live check), `wcag-watch` (weekly, about a minute) | Stay hosted: preflight, live-state report, and a job too small to be worth a pool slot. The `ci.yml:326` fallback is intentional (a dead pool must not queue the sweep). |
| MoonMan (3) | the `heavy-runner-preflight` in `ci.yml`, `full-walks.yml`, `visual-baselines.yml` | Stay hosted: they are the liveness preflights. |

No workflow in these four repositories needed a change, so no pull request was opened for them. Plan row 3.2's counts (25 bindercurve, 6 4thcltr, 3 MoonMan) included `ubuntu-latest` fallbacks inside `fromJSON(vars.HEAVY_RUNS_ON || ...)` expressions, which follow the variable; the lists above are the plain hard-coded ones (26, 3 plus the one conditional fallback, 3). A guard that fails a new hard-coded `ubuntu-latest` outside this list belongs in fleet-status ("hosted jobs last 7 days"), plan row 3.2's own done-when.

### If CI gets cut off: recovery

Owner ask, 15 November 2026: "if CI gets cut off we need recovery plans". What exists today, what fails, and the manual way out. Hosted overflow is not built yet (session `pool-order-hosted-last` proposes it), so every row's "automatic" column is what happens now, not what is wanted.

| Cut-off | What happens now | Recovery |
|---|---|---|
| dapyllil down or rebooting | Heartbeat goes stale. Each repo's hosted `heavy-runner-preflight` fails in seconds with the fix in its message. Pool jobs already queued wait, up to 24 hours before GitHub cancels them. The remote slots (gowyllop-ci, gamingpc-ci) are started by dapyllil's supervisor, so they stop too. | Bring dapyllil back (`ssh dapyllil`, `systemctl status bc-ci-runner`). If it stays down past an hour, flip the priority repos to hosted (below) and flip them back when the heartbeat is fresh. Boot hang: plan row 3.7. |
| Supervisor cannot mint tokens (App or owner token at 0 of 5,000 an hour, or 403) | The journal says "GITHUB API FAILING" or "no token"; no runners start; heartbeats stop being written. 3 outages so far (3 to 5 and 6 November, 13 November). | `gh api rate_limit` for the owner token, then wait for the reset or flip to hosted. Journal: `journalctl -u bc-ci-runner`. The App's budget is separate from the owner's. |
| One remote host down (gowyllop-ci or gamingpc-ci) | The supervisor gives that host 0 slots, logged ("engine did not answer over ssh"), and places work on the other hosts. Nothing fails. | None needed for correctness; capacity drops. gamingpc-ci has been at 0 slots since at least 15 November 16:51 ET: check the PC is on and Docker is up. |
| Firewall rules missing on the pool | The supervisor refuses to start runners (fails closed) and now stops writing heartbeats, so the preflight goes red. | `infra/ci-runner/firewall.sh --check` on dapyllil, then rerun `install.sh`. |
| GitHub Actions down | Nothing runs, hosted or pool. | Wait. No merges happen (ship-bot reads green checks). |
| Hosted minutes cap (US$100 a month) reached | GitHub stops hosted jobs: the preflights, reviewer and scheduled reports fail to start. Pool jobs still run if their preflight ran earlier in the run; new runs cannot pass the preflight. | Raise the budget one step (owner), or wait for 1 December. Do not move reviewer or preflights to the pool to dodge it. |

Flip every moved repository to hosted (cost: hosted minutes, so only for the repositories the outage blocks, priority 1 to 5 first):

```sh
for r in ssatcy.com denseware.com gorfmusic.com promptboi.com anal0g.org blackpixelrecords.com \
         rowanmcarthur.com subrythm.com heuristics.4thcltr.com papers.4thcltr.com gorfed.net; do
  gh variable set HEAVY_RUNS_ON -R gorfednet/$r --body '"ubuntu-latest"'
done
```

Flip back by setting each to `["self-hosted","linux","<label>"]` (labels in the table above). bindercurve.com, 4thcltr.com, MoonMan, assess and career-portfolio use the same variable; do those only when the owner says, because their heavy runs are the ones that would burn the cap. The monthly failure drill in plan-of-record (quota at 0, ship-bot down, pool down) should run this table once and date the result here.

## Method

Runs: `gh api repos/gorfednet/<repo>/actions/runs?created=>=2026-10-28` for 10 repositories, 4,000 runs (BinderCurve per workflow, past the 1,000-result cap). Jobs: `…/runs/<id>/jobs` for every heavy-workflow run and 25 sampled runs of the others, 1,249 runs. Pool: the supervisor journal on dapyllil (`journalctl -u bc-ci-runner`), `pools.conf` on BinderCurve main. Price: GitHub's 2026 Linux 2-core rate, US$0.006 a minute.
