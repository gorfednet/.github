# Brief: land the briefs dir (plan row 1.1)

Model: Fable (`reviewer` role). Why: these docs set what Desk and sessions do unattended.
Folder: `~/Developer/gorfednet/gorfednet.github`, own worktree.

## Objective
.github 133 ("Assessment 12 Nov…", adds `briefs/`) carries `ready-to-merge` but has open reviewer threads, so ship-bot won't merge it. For each thread: decide whether it's a real finding. Fix real ones on the branch, and answer and resolve the rest with a one-line reason. Where 133 contradicts `docs/desk/brief.md` or `docs/plan-of-record.md` (from .github 138), those win.

Not yours: 118 and 120 close as superseded (Desk does that once 138 merges). 129 is being rebased by its own session.

## Done when
- No unresolved threads on 133. `review-status.mjs --pr 133` is clean or triaged on its head (run it with `GITHUB_REPOSITORY=gorfednet/.github`; the scripts are in `scripts/` and `scripts/gates/`).
- `assert-checks-started` and `check-closing-keywords` pass.
- `## Next` says merge, and the PR keeps `ready-to-merge`. Ship-bot merges.

## Boundaries
Never `gh pr merge`. Docs only. A push that changes text a person wrote gets one `claude review` comment. Return the PR link with `## Next`.
