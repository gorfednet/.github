# Brief: CI pool bottleneck, then hosted drift (plan rows 3.1 and 3.2)

Model: Opus 5.5. Why: infrastructure judgement on a shared host, with no reviewer behind the diagnosis. `reviewer` (Fable) reads the diff before labelling.
Folder: `~/Developer/gorfednet/bindercurve.com`, own worktree. The pool config lives in `infra/ci-runner/` (`pools.conf`, `supervisor.sh`, `install.sh`, `Dockerfile`, `DESIGN.md`). Note the older `bindercurve.com-sharedpool` clone; work from the main clone's `origin/main`.
Owner priority (13 Nov, 08:35 ET): bottlenecks first, so everything else ships faster before the Fri 20 Nov usage reset.

## Objective
The 4-slot shared pool on dapyllil (12 threads, 61 GiB, load about 1.1) serves 17 repos. MoonMan's median queue wait is 46 min (max 182), and 4thcltr e2e shards take up to 103 min. Hypothesis: the slot count is the limit, not CPU or memory. MoonMan walks and 4thcltr shards block each other, and the per-repo caps aren't real because every repo shares one slot set.

1. Measure first. Write `scripts/pool-wait-report.mjs` (queued to started per job, last 48 h, per repo, median and p90) and commit it. Record the before figures.
2. Confirm or reject the hypothesis from the host: `hc exec --on dapyllil` or `ssh dapyllil` for load, memory and per-container CPU while jobs run.
3. Change: either 6 slots on CPUs 2 to 11 at about 1.5 CPUs and 6 GB each, or keep 4 and add dedicated second pools for MoonMan and 4thcltr. Pick from the measurement and say why in `DESIGN.md`.
4. 3.2 in the same PR, or a second one if separate rollback matters: add `rsync` to the pool image so gorfed.net can leave `ubuntu-latest`. List which repos lack pool tokens (ssatcy, denseware, gorfmusic) as owner lines.

## Done when
- A PR with the report script, the before numbers and the pool change, `## Next` naming the one `sudo install.sh` command the owner runs on dapyllil (exact, with its `ssh -t dapyllil "…"` hop).
- After he runs it: 48 h of the same report showing a median under 10 min and p90 under 30 min. Until then, `## Next` says the measurement is pending.
- A dated incident line in the repo's ledger for the bottleneck.

## Boundaries
- Never run `sudo` on dapyllil yourself, and never restart the running runners mid-job. The owner runs install.
- Never `gh pr merge`. Don't touch other repos' workflows except to list what 3.2 needs.
- Load guard on the Mac: hold builds while the 1-minute load is over 10. Your work is mostly remote, so keep local runs small.
Return the PR link with `## Next`.
