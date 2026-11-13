# Fable review of the whole automation design, 13 Nov 2026 (about 12:00 ET)

Read-only `reviewer` (Fable). It read the plan, Desk brief, 1.9 and 1.10 briefs, PR 148, 152 and 155 (head 76f189c), ship-bot README, INCIDENTS, `drafts.mjs`, `gates.mjs`, `fleet-status.yml`, STATUS.md, today's Desk log, and Herdr README and `lib/`. It did not check the live ship-bot config or state, live Herdr state, real `hc` behaviour, `janitor-prune.mjs` internals or the healthcheck alert path.

## Findings (ranked)
1. Defect, runaway. Three starters, each with its own cap and no shared backpressure: Herdr reconciler `maxClaude` 2 to 3 (`ops/hosts/gorfpael/herdr/lib/claude-job.mjs`), the 1.10 starter 3, the app 5. `lib/refill.mjs` re-imports every open backlog entry when the queue empties. `lib/budget.mjs` `ceilings()` lets the hold reach 99.5% before Friday. Nothing gates on open PRs or the pool queue (63 open PRs).
2. Defect, duplicates. `claude-job.mjs` `finish()` always runs `gh pr create --draft` from a fresh worktree, so a job can't continue an existing PR. `herdr-import-open` makes 1 job, so 1 PR, per backlog entry, and nothing claims an entry before work starts.
3. Risk, unattended merge. A builder's own `## Next` merge line makes ship-bot ready, merge and deploy the PR (`drafts.mjs` `draftClaim`). A finding counts as triaged on any reply from an allowlisted login (`gates.mjs:246-260`), and every session posts as the owner. The draft path has no control-plane path guard, while the janitor's label rule does.
4. Risk, silent failure. Every push goes to ntfy on dapyllil, the same host as CI and production. ship-bot, herdr-reconcile, capacity and the janitor have no heartbeat. No token-free push at 90% weekly usage, although `budget.mjs` has the figure.
5. Risk, mutable gates. Ship-bot's gate scripts run from the main clone, which another session can switch branches in.
6. Defect, records. Plan lines 54 and 171 still say hold at 70%. The janitor doesn't start a Desk successor (PR 148 only writes a `Needs:` line). The Desk cost line is far below today's real use.

Gaps for a loop with no owner turn: start (the app needs him), a single queue (4 lists today), review findings back to a fix job, detection (fleet-status runs once a day), block to diagnosis, close (janitor dry until 16 Nov, and its Herdr time is 06:00 where the prompt says 07:00).

Cut or merge: drop the 1.10 starter, so the Herdr reconciler is the one starter and queue. Fold the free-memory check into `builder-ok`. Janitor's LLM run handles only archive and rescue, and the docs-only label moves to ship-bot. Defer 4.4 and phase 6.

dapyllil builders: yes for at most 2 Sonnet or Haiku builders, but only after 1, 2 and 3 above. Each needs its own unprivileged user or container (no Docker socket, no sudo, a PAT without workflow scope), a systemd slice with `MemoryMax` and `CPUQuota` (no swap), synced `~/.claude` guards, and the reconciler running locally there.

## Desk decisions (13 Nov)
- Accepted 1 to 6. PR 155 (1.10 starter) closes. The Herdr reconciler becomes the one starter and queue, under new row 1.11.
- New rows: 1.11 one queue with backpressure in Herdr, 1.12 ship-bot unattended-merge guards, 1.13 heartbeats and usage pushes, 1.14 detection and repair loop, 1.15 dapyllil builders (after 1.11 to 1.13).
- 4.4 and phase 6 deferred.
