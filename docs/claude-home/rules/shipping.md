# How changes ship

Applies in every repository. Rewritten 2026-10-03 from always-pr, durable-plan-and-self-healing and verification-baseline (originals in `~/.claude/rules-archive-2026-10-03/`).

## Pull requests

- Every change is a branch and a GitHub pull request; draft is fine. Never commit feature work on `main`, never leave commits only on this machine. Exceptions: a repository's release steps on `main` after the feature PR merged (for example BinderCurve `/ship`), or the owner says otherwise.
- The Claude reviewer reviews pull requests (owner: Cursor and Bugbot were retired on 2026-10-16, with no further spend). In a repository with `.github/workflows/claude-review.yml` it reviews a pull request when it opens or leaves draft; for a draft, or for the final head after a later push that changes code someone wrote, comment `claude review` once, on a line by itself (the trigger matches whole lines, so a sentence ending in it runs nothing: ops PR 44, 7 November 2026). Do not ask after a push that only merges main cleanly (main's code was reviewed on its own pull requests), regenerates derived files, moves a pin or a budget number, or fixes lint or formatting; say on the pull request which kind it was. `review-status.mjs` reads only the current head, so it then says `not-run`: check by hand that every commit after the reviewed head is one of those kinds (`git show --cc <merge>` prints no conflict edits for a clean merge of main), and say so on the pull request before merging. Never merge until `review-status.mjs --pr <n>` says `clean` for the head being merged, or its findings are triaged on the PR. A repository without the reviewer yet (until BinderCurve's plan item P1.4 rolls it out) merges on green CI plus the main session's own read of the diff, said on the PR. TowIt, wychwood and whywa.it are inactive. No second review automation.
- Push, tag and deploy happen in the main session where they can be watched. Ship-bot is the only merger. Never auto-merge. Merge commits only.
- Sessions label, ship-bot merges (owner, 2026-10-19: "can't you handle all of it… for all work, all repos, all projects"; 11 November 2026: `gh pr merge` is denied in settings). When a pull request's gates pass (green CI read through `assert-checks-started`, `review-status.mjs` clean or triaged, `check-closing-keywords`, the diff read), mark it ready and add `ready-to-merge` yourself, and say so. Never hand that to the owner. Never label over red, never label a release-sensitive change at the wrong moment (for example into a store build it should stay out of), and never turn on GitHub auto-merge.
- Never ask the owner to check or approve before a merge, in any repository or session (owner, 2026-10-31: "stop asking me in all sessions I dont want to check before merge rule for all repos"). No "check and merge" button, no question, no "come back at 10:07". After marking a pull request ready or pushing a new head, start one background wait in the same turn (`gh run watch <id> --exit-status --interval 60` with `run_in_background`; never the default 3-second interval or `gh pr checks --watch` without `--interval 60`, because on 13 November 2026 a handful of default-interval watchers emptied the owner's 5,000-an-hour GitHub quota twice in one morning, which wakes the session without polling from a turn). On the wake, run the gates above, triage and fix findings, and label. This is the one wake `agents-and-cost.md`'s "Never wake a chat to check CI" allows: it ends in the label, and it replaces asking the owner. Stop and tell the owner only for red with no established cause or a release-sensitive merge.
- Ship-bot merges labelled pull requests (owner, 7 November 2026, "automate as much as possible to manage without me"): the bot in `gorfednet.github/ship-bot/` merges a pull request that carries `ready-to-merge`, has no `hold`, is green on every expected check and clean in `review-status.mjs`. The label is the decision, taken after the session reads the gates itself. Every open pull request carries a `## Next` section with `- [ ]` lines, rewritten by any turn that leaves it open. Status reports come from `fleet-status` (`STATUS.md` on the `status` branch of `gorfednet/.github`), never from hand counts. A draft whose `## Next` first unchecked line says merge, with no line handing the decision to a person, is ship-bot's: it marks it ready and labels it once the gates are clean. Desk does the same on each pass. A draft that must stay draft carries `hold` or says so under `## Next`.
- Batch small, related changes into one pull request; do not open one per fix (owner decision 2026-10-04). Every PR runs CI on the shared self-hosted pool, and in BinderCurve every PR labelled ready-to-merge runs the full three-browser gate. 75 BinderCurve PRs in the week to 2026-10-04 saturated the pool on dapyllil, with queue waits up to 8 hours. Split only when the changes need separate review, separate rollback, or would block each other.

- Merged work closes itself (owner, 13 November 2026: "auto-close after merge"). Once a pull request merges, its session is done. The janitor archives the session, deletes the merged branch and prunes its clean worktree. A worktree with uncommitted work is never pruned. It gets a handoff file and a draft PR first (`/fleet-drain`). A session stays open after a merge only to run its repository's release steps.

## Release trains (owner decision 2026-10-11, all repositories)

When several pull requests are waiting for CI, carry them in one train instead of running the full gate on each. It saves runner time and hosted minutes; review cost stays about the same.

- Review first, in parallel: each change is its own pull request, opened as a draft so heavy CI does not run (check the repository's workflows skip drafts), with `claude review` commented on its head. A train only carries heads that are `clean` or triaged.
- Build the train from `origin/main`: merge each carried head with a merge commit, resolve conflicts once, regenerate derived files, push it as one pull request, label it for the full gate, and `claude review` on its head only when a conflict resolution changed code (a union merge of translation catalogs, lists or registries, a regenerated file or a budget number is not a code change).
- One full CI run on the train. Merging it marks every carried pull request merged, so `check-closing-keywords` must scan the carried ones too. The train's body lists what it carries; comment on each carried pull request that it rides the train.
- A red train: find the piece that broke it, fix it on that piece's branch or drop the piece and rebuild. Never merge a train over red.
- Keep a change out of a train when it needs separate rollback, a separate release, or the owner's review on its own. Small repositories with short CI need no train; one pull request is fine.

## Runners (owner, 2026-10-19; cap changed 13 November 2026)

Every CI job in every repository runs on our self-hosted runners on dapyllil by default: tests, builds, e2e, smoke, canaries, deploys, alerts.

- Hosted minutes have a hard cap of US$100 a month across all repositories (owner, 13 November 2026: "Yes, US$100 hard cap"). November 2026 may reach US$150 (owner: "if this month goes to 150 cause of the mistakes and transitions its ok but let's aim for 100 tops"). A GitHub billing budget on Actions stops usage at the cap.
- Hosted is allowed for the reviewer, roll-ups, the pool-liveness preflight (it must run off the pool to notice the pool is down) and light gates on heuristics, papers and gorfed.net.
- Overflow is automatic (owner, 2026-10-30: "hosted runners when backed up yes"). When the pool heartbeat is stale or the oldest queued job has waited over 15 minutes, priority 1 to 5 work goes hosted. BinderCurve waits. The pool setting comes back once the queue clears.
- Overflow minutes are reported in the daily digest, not to the owner each time.
- A repository that runs heavy jobs hosted outside these cases is a bug to fix.

## Before merging, ask the scripts, not the checks panel

- `assert-checks-started --pr <n>` first: a workflow that fails to start produces no check runs at all, so the panel shows nothing rather than red.
- `review-status.mjs --pr <n>`: the review verdict on the current head (clean, findings or not-run); the checks panel cannot tell a review that found something from one that never ran.
- `check-closing-keywords`: GitHub closes any issue a closing phrase names, in a PR body or commit message, on merge.

Run them from the target repository's clone, or pass `--repo owner/name`.

## When CI is red

- Establish why before making it green: logs, artifacts, a bisect, a probe in the running app.
- Never go green by weakening: no raised ratchet, widened tolerance, deleted assertion or refreshed snapshot you have not read. When a baseline honestly must move, the commit that moves it says why.
- Retiring a check is not weakening. It is a recorded decision: the PR says what the check had caught and what still catches that class, and the repository's ledger lists it.
- Inherited red: if the base branch is already red, fix the base, not each PR. Claim a failure before investigating it so parallel agents do not race it. When the cause is not established, report what you found and stop.
- Read the gate's exit code, not the last command in a pipe: run gates unpiped or with `set -o pipefail`.
- Reproduce a gate the way CI invokes it (its environment variables, flags and event), or it is a different test.

## Learning from an incident

When a cause is a pattern rather than a typo, write one dated line in the repository's incident or ledger file: what happened, what changed, a link. Add an enforced check only when the PR can name a defect that reached `main` or users which the check would have caught, and shows the check's output from one deliberate break. One incident is a note; a check is a standing cost every change pays.
