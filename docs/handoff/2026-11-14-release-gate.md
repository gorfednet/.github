# Handoff: ship-bot release gate (plan row 1.25), 14 November 2026

PR: gorfednet/.github 187, branch `ship-bot/release-gate-1-25`.

- Ship-bot merges every ready pull request but deploys a `deploy` row only for a `release` or `hotfix` pull request (`ship-bot/lib/deploy-plan.mjs`). Mechanics: `ship-bot/README.md`, "Releases, not every merge". Rule: `docs/claude-home/rules/shipping.md`, "Releases".
- Fable reviewer: round 1 had 9 findings, all fixed (2a669d2). Round 2 found nothing serious. Its two medium items (a plain merge landing ahead of the release, and an unblock that records a deploy) and three of its low items are fixed in the third commit. The low items left: no post-merge parent check for a release (the window is narrow and the bot holds the run lock), and a `## Release notes` heading in a repository's PR template would stop plain PRs there (no template checked).
- 388 tests. 28 deliberate breaks across three rounds, each seen red.

## Next

- [ ] Claude review clean, CI green, then label `ready-to-merge`
- [ ] After the merge: `ship-bot/install.sh` rerun from an `origin/main` checkout (Desk gives the owner the command). Until then the installed bot still deploys on every merge.
- [ ] After the install: create the `release` and `hotfix` labels in the 13 deploy repositories
- [ ] Copy `docs/claude-home/rules/shipping.md` to `~/.claude/rules/shipping.md`
- [ ] Desk: brief paragraph and plan row 1.25 on `desk-log` (the text is on the PR under `## Next`)
- [ ] Follow-ups: a "merged, not live" row in fleet-status, gate-run receipts, a hotfix cap
