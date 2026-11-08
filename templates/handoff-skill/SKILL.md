---
name: handoff
description: Write docs/handoff/<today>-<topic>.md for this session, stamp touched backlog entries, rewrite the PR's ## Next section, and commit.
---

# /handoff <topic>

Use when a session ends, runs long, or hands work on. The topic is a short kebab-case slug.

1. Work from the repository root, on the current branch. Stop if it is `main`: say so and ask for a branch.
2. Read the template: `templates/handoff.md` in this repository, else `/Users/gorf/Developer/gorfednet/gorfednet.github/templates/handoff.md`.
3. Write `docs/handoff/<today, YYYY-MM-DD>-<topic>.md` from it. Fill every section from this session, not from guesses:
   - Goal: what was asked.
   - Done: what finished, with PR numbers and commits.
   - Next: ordered `- [ ]` lines a fresh session can start on.
   - Open PRs: `gh pr list --state open --author @me`, with each one's state.
   - Blockers: what stops the work and who clears it, or "None".
   - Decisions: what was chosen and why, with the date.
   Style: short sentences, contractions, no em dashes, digits for numbers, dates as "7 November 2026".
4. If `docs/backlog.json` exists, set `updated` to today on each entry this session touched. Set `created` too when the session added the entry. Dates are `YYYY-MM-DD`. Change nothing else in the file.
5. If the current branch has an open PR (`gh pr view --json number,body`), rewrite only its `## Next` section with the same `- [ ]` lines, keeping the rest of the body, then apply it with `gh pr edit <n> --body-file <file>`. If the PR has no `## Next`, add one at the end, above any `Generated with` line.
6. Commit the handoff and the backlog change on the current branch. Never commit to `main`. Push only when the branch already has a PR.
7. Report the handoff path and the PR number in two lines.

Never write a handoff only into the chat. Never put secrets or tokens in one.
