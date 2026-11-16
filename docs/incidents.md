# Incidents

One dated line each: what happened, what changed, a link.

- 2026-11-16: a full local gate of this repository ran for about 40 minutes and held the Mac's one-gate lock until it was ended by hand. Its log stopped after the `fleet-status-local.sh` tests. The cause is not established: the next run on the same tree passed in 36 seconds, and `test/ghPollGuard.test.mjs` (its hook spawns had no ceiling) passes three times in a row alone. Changed: every hook spawn in that test now has a 20 second ceiling and a kill fails the test, so a hang cannot hold the lock. Not fixed: the cause. The gate's own log stops at the last finished suite, so the next hang should name its test. PR 221.
