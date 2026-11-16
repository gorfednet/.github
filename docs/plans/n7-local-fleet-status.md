# N7: the local half of fleet-status (design, revised after the Fable read)

Replan row N7 (merges 1.6, 1.17, 2.3, 2.4). Control-plane paths: `janitor/`, `scripts/janitor-prune.mjs` (the sweep adds a read-only `--propose` mode; delete rules are unchanged). Fable reads the final head too.

## What reads "not measured", and why

Hosted has a token and no Mac. The collectors exist (`collectLocal`, `collectSessions`, `collectWorktrees`, `collectHerdrJobs`, run by `fleet-status.mjs --local --inventory`) but only feed the janitor's private view. Unmeasured: 5 of 9 hygiene rows (dirty clones, clones behind, installed tools, worktrees over 7 days, idle sessions) and 3 of 5 inventory kinds (sessions, worktrees, Herdr jobs).

## Design

1. **Collector.** Daily, in the janitor's existing step 1 output (`status.json` built with `--local --include-private --inventory`). New `scripts/local-status-publish.mjs` reduces it to two files. No new LaunchAgent. Cadence is daily; every row prints its measured date; a row is stale at about 30 h.
2. **Publish right (finding 1).** The janitor has no ops write route today and an LLM-run task must not gain a general one. The script alone pushes, to a dedicated ops data branch (`fleet-local`), never `desk-log` (it would race Desk). It writes `local-counts.json` and `local-detail.json` with `--force-with-lease`. The prompt gains one line: run the script; it is the only new write. The prompt's write exceptions are not widened.
   - **Dry mode** (the janitor's no-commit-no-push mode): the script writes both files under `$R` and prints what it would push. It makes no commit and no push. A prompt test asserts the dry command line carries the dry flag.
3. **Hosted read.** `fleet-status.mjs` fetches `local-counts.json` from ops with `?ref=fleet-local` and FLEET_READ_TOKEN (the published `status.json` shows `inventory.planRead` true, so the token reads ops Contents). No `desk-log`-then-`main` fallback. A hosted test covers it.
4. **One shape (finding 4).** The published file has its own key, `status.localCounts`, so `status.local` keeps its list form for the Mac view. `hygiene()`, `render()` and `digest()` read a counts-or-list helper. Each inventory kind carries its own `measuredAt`. `renderInventory` never prints "No orphans." when any local count is above 0 or null.
5. **Reader is the privacy gate (finding 3).** The hosted reader validates strictly before anything is public: integers only (no negatives or fractions), fixed keys only (a key shaped like a slug or path is rejected), no strings except `measuredAt`, `measuredAt` not in the future. Any failure gives null rows and logs only the rule id, never a key or value. The slug list comes from the fleet's repo registry in `status.json`, not from `privacy-guard-allow.txt` (no merge base at run time); other repos are counted in `otherRepos`. Session, worktree and job items are private by nature: only totals are published, never refs.
6. **Orphans (finding 5).** `orphans` is null, keeping `total`, whenever the PR read hit the reserve, the backlog is null or the plan is unread. A high count from a missing source is never published.
7. **Partial read (finding 6).** One unreadable source: write the file with that row null and the others filled, then exit 1 (as `fleet-status.mjs` does). The janitor prompt says any exit continues to step 2, so the digest names the failed row and the run goes on.

## The 190 no-PR branches and 8 duplicates (finding 2)

`branchesAhead` keeps only branches ahead of main or unrelated to it, so `janitor-prune.mjs` and PR 213's remote sweep, which delete only ancestors of main, delete none of them. Merged branches are already caught; these are not. The real path, with no loosened rule:
- A `runner` runs `janitor-prune.mjs --propose`, which reads `status.json` and writes a private file, one action per branch: **draft PR** (commits worth keeping, via `/fleet-drain`, which rescues to a handoff and a draft PR), **keep** (recorded in a keep list in private ops with a reason and a review date), or **close duplicate** (Desk closes the older PR through the normal path).
- Only a branch that becomes an ancestor of main (its draft PR merges) is deleted, by the existing janitor rules. An unrelated branch and a private-repo branch are never proposed for deletion.
- The count falls as drafts merge or keeps are recorded; a recorded keep leaves the row but stays counted in a "kept" figure.

## Tests

Publisher: full read to counts; each unreadable source to null with others filled and exit 1; non-registry slug to `otherRepos`; orphans null when `planRead` false or PRs null. Hosted reader: rejects an extra key, a string, a negative or fractional count, a slug-shaped key and a future `measuredAt`, giving null and stderr without the planted values; stale file gives null. Published `status.json` is asserted by a positive shape plus planted absolute path, session title, branch name and clone folder, none present. Counts through `hygiene()`, `render()` and `digest()` with one null row. Orphans above 0 never print "No orphans." Sweep fixture with a merged branch, an unmerged one, an unrelated one and a private-repo one. Dry-mode prompt test. Keep the planted-value fixtures outside `test/fixtures/**` (that path is allowlisted, so a break there would pass the guard), and show the guard fail once on a deliberate break. `typecheck:test`, lint, one gate via `gate-run`. The guard does not read the status-branch push, so the reader tests above stand in for it.

## For Fable to check

Null never becomes 0 anywhere. The reader, not the publisher, is what stops private detail. Dry mode pushes nothing. The janitor keeps no wider write right than the one script. Delete rules in `janitor-prune.mjs` are byte-identical outside `--propose`.
