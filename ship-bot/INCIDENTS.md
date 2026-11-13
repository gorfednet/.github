# Ship bot incidents

One dated line per incident whose cause was a pattern: what happened, what changed, a link.

- 13 November 2026: the owner's GitHub REST quota (5,000 an hour) ran out at about 09:03 ET and stalled ship-bot and every session until 09:23 ET (it had also run out on 10, 11 and 12 November). Ship-bot shared that quota through `gh auth token` and polled 21 repositories every 2 minutes with uncached REST, re-running the three gate scripts on every waiting pull request each pass. Changed: conditional requests with an ETag cache, gate answers reused while their inputs are unchanged, a stop under 200 remaining with one ntfy alert, and a GitHub App token with its own quota (plan row 1.3, PR on branch `fix/ship-bot-quota`).
