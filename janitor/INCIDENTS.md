# Fleet janitor incidents

One dated line per cause that is a pattern: what happened, what changed, a link.

- 13 November 2026: in 5 daily runs (9 to 13 November) the janitor never swept a session or pruned a worktree. On 9, 10 and 11 November the first Bash call waited on a permission prompt in an unattended run. It was interrupted 49 minutes later. On 12 November one repository answered HTTP 500, and the prompt said to stop on any unreadable repository. On 13 November the run printed 80 lines of `fleet-status` (4 of 21 repositories). Version 3's propose-only mode ran steps 1 to 3 only, so step 4 was never reached. Version 4 (plan row 1.5) changed 5 things. It retries, then goes on past an unreadable repository. It runs `fleet-status-local.sh --save` and reads the whole file. Every step runs in a dry run. A file that Desk writes sets the mode. `scripts/janitor-prune.mjs` does the git work, with its guards under test.
