# N7: the local half of fleet-status (design, no code yet)

Replan row N7 (merges 1.6, 1.17, 2.3, 2.4). Control-plane paths touched: `janitor/`, `scripts/janitor-prune.mjs`. Fable reads this design, then the final head.

## What reads "not measured", and why

The hosted run (ubuntu runner, token only) has no `status.local` and no local inventory sources. The code to measure them already exists: `collectLocal` (`scripts/lib/hygiene.mjs`) and `collectSessions`, `collectWorktrees`, `collectHerdrJobs` (`scripts/lib/inventory.mjs`), run by `fleet-status.mjs --local --inventory`. It only runs for the janitor's private view (`fleet-status-local.sh`), and nothing it measures leaves the Mac.

- Hygiene rows: dirty clones, clones behind origin, installed tools behind main, worktrees over 7 days, sessions idle over 24 h (5 of 9).
- Inventory kinds: sessions, worktrees, Herdr jobs (3 of 5).
- Branches with no PR and duplicate PRs are measured hosted. The sweep acts on them.

## Design

1. **Collector.** A new janitor step, run after step 1. It reuses `$R/status.json`, which the janitor already builds with `--local --include-private --inventory`. No new LaunchAgent: the janitor already runs daily on the Mac with the permissions. A 2-hourly light run is a later option, not part of N7. New `scripts/local-status-publish.mjs --in $R/status.json` reduces `status.local` and `status.inventory` to a public-safe file and a private detail file.
2. **Publish.** Two files, written to private ops by the janitor's existing ops-worktree route (`control/fleet-local/`, no push to this public repo):
   - `local-counts.json` (public-safe): `measuredAt`, per-row `{ count | null, unread: <n> }`, per-kind inventory `{ total, orphans } | null`. Slugs only from the allowlist (`.github/privacy-guard-allow.txt` at the merge base). Every other repo is counted in `otherRepos`.
   - `local-detail.json` (private): the full lists (clone dirs, worktree paths, session ids and titles). Hosted never reads it.
3. **Hosted read.** `fleet-status.mjs` reads `local-counts.json` through the same token-and-API route as the plan of record (`PLAN_SOURCE` pattern: ops, `desk-log` then `main`). It fills `status.local` with counts only (the schema gets a counts form: arrays become integers) and the three local inventory kinds. `write-status-md.mjs` renders count plus measured date per row. No local list is rendered on the status branch.
4. **Fail closed.** A row is `null` ("not measured") when the file is missing, unparseable, fails the schema, or is older than 26 h (the row prints "last measured <date>"). It is also `null` when the collector marked the row unread (any clone, session file or tool it could not read; `collectLocal` already does this per row) or a fetch failed (clones behind). A partial read never yields a smaller number. The publisher refuses to write a count it did not fully measure and exits 1, so the janitor names it in its digest.
5. **Privacy.** The publisher whitelists fields by schema (additionalProperties false), not by scrubbing. A test feeds it a status with a private repo name, a `local_<uuid>` id, an RFC1918 address, a tailnet name and a host name, and asserts none appears in the output. `node scripts/privacy-guard.mjs` runs on the diff, plus one deliberate break (a session id in a fixture) to see it fail.

## The sweeps

- **190 no-PR branches, 8 duplicates.** A `runner` lists them from `status.json` (`branchesAhead`, `duplicatePrs`) into a private ops file, one proposed action each: delete (merged), keep, open PR, or close the older duplicate. No deletion by hand.
- Deletion goes through rules the janitor already has. `janitor-prune.mjs` deletes an origin branch only when it is an ancestor of `origin/<default>`. Plan row 1.30 e (PR 213, in flight) sweeps merged origin branches, so N7 waits for it. Unmerged branches with commits ahead (for example `desk-log`, `kit/v0.2x.0`) are kept or get a draft PR via `/fleet-drain`, never deleted. Duplicates: Desk closes the older PR through the normal path.

## Tests

- `local-status-publish`: full read to counts; each unreadable source to `null`; stale file to `null`; non-allowlisted slug to `otherRepos`; the privacy fixture above.
- `write-status-md`: counts form renders count plus date; null renders "not measured"; no list rendered.
- `fleet-status`: a missing, corrupt or stale ops file leaves rows null and the run exits as today; a fresh file fills rows.
- Janitor prune: sweep fixture with a merged branch, an unmerged branch and a protected name; only the merged one is proposed for deletion.
- Schema check on both files; `typecheck:test`, lint, then one gate through `gate-run`.

## For Fable to check

- A null never renders or sums as 0 (publisher, merge into `status.local`, `hygiene()`, digest line).
- Nothing private reaches the status branch or this repo: field whitelist, `otherRepos` counting, and the test fixture is real.
- `measuredAt` is set by the collector at read time, so a fresh stamp cannot sit over old data.
- A publish failure never blocks the janitor's merge or prune steps, and the sweep never runs on a failed publish.
- Janitor deletion rules are unchanged: the sweep proposes, `janitor-prune.mjs` deletes.
- The hosted token can read ops `control/fleet-local/` (Contents read should cover it; confirm).

## Open questions

- Is a daily local publish enough? Rows would be up to 26 h old. "Every row measured, with a date" may need the 2-hourly run.
- Is `control/fleet-local/` on ops `desk-log` the right home, or a path ship-bot already mirrors?
