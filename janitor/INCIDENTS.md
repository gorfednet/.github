# Fleet janitor incidents

One dated line per cause that is a pattern: what happened, what changed, a link.

- 13 November 2026: in 5 daily runs (9 to 13 November) the janitor never swept a session or pruned a worktree. 9, 10 and 11 November: the first Bash call waited on a permission prompt in an unattended run and was interrupted 49 minutes later. 12 November: one repository answered HTTP 500 and the prompt said to stop on any unreadable repository. 13 November: the run printed 80 lines of `fleet-status` (4 of 21 repositories), and version 3's propose-only mode ran steps 1 to 3 only, so step 4 was never reached. Changed in version 4 (plan row 1.5): retry then carry on past an unreadable repository, `fleet-status --save` and a whole-file read, every step runs in a dry run, mode set by a file Desk writes, and the git work done by `scripts/janitor-prune.mjs` with its guards under test.
