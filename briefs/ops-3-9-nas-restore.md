# Brief: 3.9 NAS at 90%, music off-site, B2 test-restore

Objective: the NAS is at 90% (63 of 70 TB). Report the largest trees, get music into the off-site copy, and prove the B2 copy restores.
Model: Opus (infra on dapyllil, no reviewer behind the restore drill). Run the size report as a `runner` subagent.
Repo: `gorfednet/ops`, own worktree. Backlog entries exist; attach them.
Steps:
1. Top-10 largest trees on the NAS, as a table in the PR body. The owner decides what to delete. Delete nothing.
2. Music off-site: add it to the B2 job config. Any step that needs sudo or a new key goes under `## Next` as one owner command, in full.
3. Restore drill: restore a sample (a few GB across 3 trees) from B2 to a scratch path, checksum it against the source, record it in `hosts/dapyllil/backup/RESTORE.md`, delete the scratch copy.
Boundaries: never read `*.env*` or `ops/credentials.json` (use the tools that already hold keys). Use `hc exec --on dapyllil` for long runs. CI waits with `gh run watch <id> --interval 60 --exit-status` in the background, no `gh` loops. A blocked step never stalls you: park it under `## Next` with its resume time in ET and carry on.
Done when: the PR has the top-10 table, the music job, and a restore log with matching checksums. Return a draft PR with `## Next`, first line says merge when gates pass.
