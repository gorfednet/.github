# Brief: land the Desk brief and briefs dir (plan row 1.1)

Model: Fable (`reviewer` role). Why: these docs set what Desk and ship-bot do unattended.
Folder: `~/Developer/gorfednet/gorfednet.github`, own worktree.

## Objective
Three labelled .github PRs can't merge:
- 118 "Desk standing brief": open reviewer threads (ship-bot comment `review-threads` at 03:12 UTC 13 Nov).
- 133 "Assessment 12 Nov…": open reviewer threads.
- 120 "Desk brief: session-start rule" (draft): fold into 118, then close 120 with a note naming 118.
- 129 is being rebased by its own session (Release loop 4); leave it alone.

For each thread on 118 and 133: decide whether it is a real finding. Fix real ones on the branch, answer and resolve the rest with a one-line reason. 118 must agree with `docs/desk/brief.md` from .github 138 (13 Nov plan of record); where they conflict, 138 wins, and 118 may be closed as superseded with a note if 138 already covers it.

## Done when
- No unresolved threads on 118 and 133; `review-status.mjs --pr <n>` clean or triaged on each head (run with `GITHUB_REPOSITORY=gorfednet/.github`; scripts in `scripts/` and `scripts/gates/`).
- `assert-checks-started` and `check-closing-keywords` pass.
- `## Next` on each says merge. They keep `ready-to-merge`; ship-bot merges.

## Boundaries
Never `gh pr merge`. Docs only. A push that changes text a person wrote gets one `claude review` comment. Return PR links with `## Next`.
