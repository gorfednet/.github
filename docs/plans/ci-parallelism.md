# CI parallelism sized from the container's cpus: fleet fix

Written 15 November 2026 by the session that fixed papers.4thcltr.com's red `main` (papers PR 43). Approved by the owner the same evening. One brief per item is in `briefs/ci-par-*.md`. Each session reads this file and its own brief, nothing else.

## Context

On 15 November 2026 papers.4thcltr.com's `main` and its release PR 42 went red on the wordmark's cut-pace specs with no code change. CI had moved onto the self-hosted pool, whose runner containers have 2 cpus, and Playwright started 6 workers because it counts the host's 12 processors. 4thcltr.com hit the same thing on 4 October and fixed it locally. The fix was then copied by hand into papers (PR 43, green and reviewed, waiting for its label).

The owner asked for the root causes fixed for every current and future repository, and for related issues found and fixed too.

## What was verified (15 November 2026)

- **The technical cause.** Inside a pool container (probed on dapyllil on 15 November 2026, Node 26, libuv 1.52): `os.cpus().length` is 12, `nproc` is 8 (the cpuset), `os.availableParallelism()` is 2, `cpu.max` is `200000 100000`. Playwright sizes from `os.cpus()`, so it is the exposed tool. Vitest and `node --test` size from `availableParallelism()`, which honours the quota on a recent Node.
- **No shared fix.** The helper exists only in 4thcltr.com (`scripts/playwright-workers.mjs`) and now papers' PR 43. MoonMan has a third copy for Vitest (`scripts/lib/cpu-budget.mjs`). Nothing checks a config.
- **The template is unsafe.** `templates/playwright.config.ts` in `gorfednet/.github` leaves workers to Playwright's default, and the bootstrap skill and `register-repo.mjs` say nothing about it. New repositories inherit the problem.
- **No test before a move to the pool.** A session set `HEAVY_RUNS_ON` on 11 repositories on 15 November by hand. `docs/plans/ci-resourcing.md` records "Pool job seen running", not passing. Papers went red 20 seconds later.
- **A workaround is already in place.** heuristics.4thcltr.com has the same unprotected config and the same wordmark spec. Its variable was set back to `"ubuntu-latest"` at 18:16 ET. It's green on hosted minutes and still unfixed.
- **Unprotected on 15 November** (from `origin/main` of each): heuristics, papers (until PR 43), gorfmusic's `canaries` job, wychwood (inactive, hosted). Oversubscribed by a fixed number: BinderCurve (`resolveWorkers()` default 2 for axe, Vitest `Math.min(4, os.cpus().length)`), assess (3 browser files at once).
- **Protected on 15 November:** 4thcltr (cgroup helper), MoonMan (`CI ? 1`), and denseware, ssatcy, promptboi, gorfed.net and gorfmusic's browser-compat job (the shared workflow sets `PLAYWRIGHT_WORKERS: 1`, which only their configs read).
- **One worker isn't the whole answer.** 4thcltr.com's `docs/incidents.md` line for 15 November says specs whose bound "is a sum of the runner's speed" still went red on the pool with the helper in place. That is a spec-design problem, handled in wave 3.
- **The fixes so far were all local.** The research found the helper copied 3 times, and 17 dated ledger lines since 2 October about pool or Mac load. The only shared fixes were the pool's capacity and ship-bot's launchd class (already `Interactive`, installed).
- **papers and heuristics run an older wordmark spec.** 4thcltr.com's `e2e/wordmark-fours.spec.ts` moved to a frame clock and cut counts on 14 and 15 November. The copies in papers and heuristics still time with the observer clock.
- **Other specs that measure the runner** (research, not yet re-read by me): 4thcltr.com `e2e/arrivals.spec.ts:137` and `e2e/scroll-choreography.spec.ts:415` (frame floors that fail at 20Hz), BinderCurve `e2e/spend-planner-main-thread.spec.ts:110` (a 500ms budget inside the merge gate) and `spendPlanOptimizer.test.ts:694`. gorfed.net's `e2e/motion.spec.ts:719` counts frames and is the model.
- **The local rule is prose.** "`--workers=2` while the Mac is loaded" is written in 4 places and enforced in none. `gate-run` only warns.
- **Not verified:** which Node each repository's job uses. My probe read the image's Node 26. An older Node may report 8 from `availableParallelism()`, which would leave Vitest oversubscribed. Item 1.2's log line settles it per repository.

## Design decisions

1. **One implementation, in the kit.** `templates/verification-kit/lib/cpuBudget.mjs` exports `usableCpus()` (the smallest of `os.cpus().length`, `os.availableParallelism()` and the cgroup v2/v1 quota) and `playwrightWorkers()` (half of that, at least 1). `lib/` is already manifest-hashed, drift-checked and imported by repositories. It replaces the three hand copies.
2. **One check, in the gate.** `bin/check-parallelism.mjs` fails a Playwright config whose `workers` is neither the kit's `playwrightWorkers()` nor a literal `1`, unless the line has a written waiver. The gate runs the canonical kit at `@main`, so every `pr-check-*` caller gets it with no refresh. It ships as a warning, and becomes a failure once every pool repository is converted (item 2.6). The named defects it would have caught: 4thcltr.com on 4 October and papers on 15 November.
3. **Evidence in every log.** `assert-tests-executed` already reads the Playwright JSON report, which records `config.workers`. It prints "N workers on M usable cpus" with what `os.cpus()` and `availableParallelism()` said, and fails when N is greater than M. Today's diagnosis would have taken one line. `playwrightWorkers()` honours a `PLAYWRIGHT_WORKERS` override, so the shared browser-compat workflow and the local gate keep working.
4. **No change to the pool.** `--cpus 2` is right. Making `os.cpus()` honest needs lxcfs, whose daemon failing would break every job. A pool-set environment variable only helps configs that read it. The check covers this better.
5. **A move to the pool runs its own test first.** `scripts/pool-flip.mjs` in `gorfednet/.github` refuses a repository that fails `check-parallelism`, sets the variable, reruns `main`'s CI on the pool, and sets it back to hosted if that run is red. The plan table records "passing", not "running".
6. **Timing specs stop measuring the runner.** Wave 3, designed after the reset, with no bound loosened.

## Plan

Every pull request gets the Claude reviewer (Fable). Desk labels. Builders run at most 3 at once, after `builder-ok`.

**Which model runs what.** Every item is its own session, started from its brief on the model its row names: Fable for 1.2, 2.5, 2.6 and 3.1, Haiku for 2.7, Sonnet for the rest. Each brief states its model, so Desk passes it when it starts the session.

### Wave 0: tonight, already in flight

| # | Item | Who |
|---|------|-----|
| 0.1 | Papers PR 43 gets its label and merges. The release-wk46 session then merges `main` into PR 42 and regates. | Desk labels. No new agent |

### Wave 1: the shared fix, starts on approval

| # | Item | Who and why |
|---|------|-------------|
| 1.1 | This file, the briefs and the backlog entry, in one PR to `gorfednet/.github`. | The papers fix session (Opus). Done when it merges |
| 1.2 | Kit PR in `gorfednet/.github`: `lib/cpuBudget.mjs` with its `.d.mts`, `test/cpuBudget.test.mjs` (fixtures from the 15 November probe: 12, 8, 2, `200000 100000`), `bin/check-parallelism.mjs` with a canary and the near-miss cases, the `assert-tests-executed` line, the gate step as a warning, rule V78, `write-manifest`, the kit's test floor. Reuses 4thcltr's `scripts/playwright-workers.mjs` and its 7 tests. Also fixes `templates/playwright.config.ts`, the bootstrap skill and `register-repo.mjs`, so new repositories start protected. | **New Fable session.** It changes what CI enforces for every repository, and writes skill text every session reads |
| 1.3 | heuristics.4thcltr.com: kit refresh, config uses the kit helper, ledger line. Depends on 1.2. | **Sonnet builder session.** Mechanical once the kit exists. The check and the reviewer catch a slip |

### Wave 2: fleet rollout, Desk starts one session per brief

| # | Item | Who and why |
|---|------|-------------|
| 2.1 | papers and 4thcltr.com: kit refresh, delete the local helper and its test, import the kit's. 4thcltr.com also gets the missing 4 October ledger line. | **Sonnet builder**, one session per repository |
| 2.2 | gorfmusic (fixes the `canaries` job), denseware, ssatcy, promptboi, gorfed.net: kit refresh, config uses the kit helper. | **Sonnet builder**, one session per repository. A Haiku runner is wrong here: a kit refresh can show drift that needs diagnosis |
| 2.3 | assess: `Math.min(3, usableCpus())` for its browser file concurrency. | **Sonnet builder** |
| 2.4 | `scripts/pool-flip.mjs` with tests, the pool README's "Add a repository" step, and `ci-resourcing.md`'s column renamed to "passing". | **Sonnet builder**, reviewed by Fable. It's run by a session, never unattended |
| 2.5 | `shipping.md` Runners gets 2 lines (workers come from the kit; a move to the pool goes through `pool-flip`). Mirrored in `docs/claude-home/`, then copied to `~/.claude/rules/`. | **Fable editor.** Every session reads this file |
| 2.6 | Turn the gate's check from a warning into a failure. `fleet-audit` (scheduled) lists any repository not converted, and any whose `HEAVY_RUNS_ON` is hosted while it has a pool row. | **Fable**, small PR. It changes what CI enforces |
| 2.7 | Move heuristics back to the pool with `pool-flip`. Re-run it for the other 10 repositories moved on 15 November, so each has a passing pool run on record. | **Haiku runner.** It runs one script per repository and reports the output |
| 2.8 | BinderCurve: axe jobs and Vitest take their count from the kit, and `pools.conf`'s comment is corrected. | **Sonnet builder.** Priority 6, so it goes last and waits when the pool is busy |
| 2.9 | `gate-run` (in `ops`, `hosts/gorfpael/herdr/bin/`) exports `PLAYWRIGHT_WORKERS=2` when `builder-ok` says the Mac is loaded, so the written rule is enforced. | **Sonnet builder**, small PR |
| 2.10 | Any repository whose log line from 1.2 shows `availableParallelism()` above its usable cpus gets `maxWorkers` from the kit in its Vitest config. | **Sonnet builder**, only if the logs show it |

In 2.1, papers' `check` job is also read against its 10-minute limit now that it runs 1 worker. PR 43's pool run took about 6 minutes.

Not converted, on purpose: MoonMan (already `CI ? 1`, passes the check as written), wychwood, TowIt and whywa.it (inactive, listed by `fleet-audit` only).

### Wave 3: timing specs that measure the runner, after the weekly reset on Friday 20 November 2026 at 05:00 ET

| # | Item | Who and why |
|---|------|-------------|
| 3.1 | Design, starting from 4thcltr.com's 14 and 15 November frame-clock spec: the wordmark's pace is asserted against the page's own frames. A cut lands on the first frame at or after the cut time, at any frame rate. The 90ms bound stays and applies whenever the frames were on time. Chromium's CPU throttle reproduces a starved runner locally, which the papers fix session could not do. Two deliberate breaks shown: a 100ms pace fails throttled and unthrottled. Coordinate with the session already on 4thcltr.com's red `main`. | **Fable.** A design decision about what a test may fail on, with no reviewer behind it |
| 3.2 | Apply it in 4thcltr.com (the wordmark's source), then bring papers' and heuristics' older copies up to it. | **Sonnet builder** per repository, Fable review |
| 3.3 | 4thcltr.com's 2 frame-floor specs: count frames the way gorfed.net's `motion.spec.ts` does. | **Sonnet builder**, Fable review, after its session re-reads both specs |
| 3.4 | BinderCurve: move the 500ms spend-planner budget out of the merge gate into its uncontended perf slice, as its own registry rule says. This retires nothing: the PR names what still catches it. | **Sonnet builder**, Fable review. Priority 6, last |
| 3.5 | Check whether jobs started through Herdr inherit the `Background` class of `net.gorfed.herdr-reconcile.plist`. Measure a timer under `hc run`; fix the plist only if it's throttled. | **Sonnet builder.** A measurement with a clear pass or fail |

Left alone: `retries` settings, and unit "hang" bounds with wide margins. Neither has failed.

## Verification

- **Kit (1.2):** `node --test templates/verification-kit/test/`. The check's canary shows it failing on a config with no `workers` line, and on the near miss (an imported helper that isn't used). The PR says so.
- **Each repository:** typecheck, lint, the unit suite, and the changed e2e specs on their own project. The pool run's log must print the worker count from `assert-tests-executed`, and it must equal the kit's answer for a 2-cpu slot: 1.
- **heuristics (2.7):** `pool-flip` leaves it on the pool only after a green pool run on `main`.
- **Fleet:** `fleet-audit` lists 0 unconverted pool repositories before 2.6 merges.
- **Wave 3:** the spec passes under CPU throttle with the product unchanged, and fails under both conditions with the pace broken.

## Cost

- The week is at 80% of all models and 66% of Fable. It resets Friday 20 November 2026 at 05:00 ET.
- Fable work before the reset: 1.1 (small, here), 1.2 (one session), 2.5 and 2.6 (small). Everything else before the reset is Sonnet or Haiku.
- Wave 3's design waits for the reset. Nothing in waves 1 and 2 depends on it.
- About 24 small sessions in all, each ending when its pull request merges: 4 Fable, 1 Haiku, 1 Opus (item 1.1) and 18 Sonnet. 2.10 rides inside the 2.2 sessions. Before the reset: 2 Fable (1.2, then 2.5), 12 Sonnet (1.3, 2.1, 2.2, 2.3, 2.4, 2.8, 2.9) and 1 Haiku. 2.6 runs only once those land.
