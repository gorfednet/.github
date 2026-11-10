# Fleet coordination 7 (9 November 2026)

Goal: infra first, then 4thcltr, gorfed.net, resumes (paused), MoonMan, BinderCurve (lowest, continues under load). Status comes from `STATUS.md` on the `status` branch (reads all 21 repos since .github #97).

## Done today
- Herdr: reconciler runs every 5 min (launchd, PATH fixed, ops #54); `herdr-requeue` (ops #56) retried 37 failed once-jobs; worktree-claim race fixed (ops #57); Sonnet/Fable usage hold raised 80 to 90 (ops #58, owner chose 90 on 9 Nov); TowIt and rowanmcarthur.com jobs paused (ops #55). 8 site folders trusted in Claude Code.
- fleet-status: FLEET_READ_TOKEN permissions fixed; CI state now from Actions runs (.github #97).
- Job applications: paused by the owner until he says start. 15 `questions` rows stay in `queue.tsv`; resume working copies are gitignored, never commit them.

## Open
- `.github` #104: recovered Herdr job (fail-on-build-edits step, opt-in). In review.
- bindercurve #641 (reviewer skips Dependabot): full CI on a deep pool queue; merge when green (a Herdr terminal `bc641` waits). Then the 4 Dependabot PRs (#620 #621 #622 #639) go through review.
- ops #57 follow-up (Low): claiming gate should exclude only `done`, not paused (`o.status !== 'done'`) plus a test.
- 21 Herdr jobs are owned by fleet-coordinator-5 (heuristics deep-3, PR jobs): fleet-coordinator-6 (`local_c28083bf-5ef3-4746-adda-38290c7114f8`) decides release or close.
- 3 red mains on the board, causes not traced (coordinator 6 asked).
- deep-3 train: push Wed 11 Nov, merge Thu 12 Nov 9 AM ET, deploy 10 AM ET. Risk: usage above 85% before then.
- Ship-bot stages 2 and 3 Thu 12 Nov; MoonMan deploy Sun 15 Nov.
- Assess parity plan: Sonnet drafts after the Friday 5 AM ET reset; one Fable review at the end.

## Rules learned
- Rerunning only failed jobs fails when the build artifact has expired: update the branch or push a fresh run.
- Fine-grained tokens cannot read `statusCheckRollup`; use Actions runs and commit statuses.
- Gate pushes on the test exit code (`cmd && git push`), not a chain that continues on failure.
