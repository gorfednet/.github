# Public repositories

Applies in every repository. Added 15 November 2026 (owner decision). Three repositories are public: `gorfednet/.github`, `ACID2REAPER` and `ai-use-levels`. Everything else is private.

A push to a public repository can't be taken back. Every branch is world-readable at once. Force push and branch delete are denied there, and git history counts as disclosed. The pull request check runs after the push, so it only stops a merge. Prevention happens before the push.

## Rules

- **Know the visibility before writing to a repository.** `gh repo view <owner/name> --json visibility`. If you can't tell, treat it as public.
- **A public repository never gets**: host names, IP addresses, session ids, private repository names, owner quotes, personal email addresses or home-network detail. It never gets logs, plans, handoffs, briefs or assessments either. Those go in the private ops repository.
- **Describe, don't name.** Write "the pool" or "the private ops repository". Never write the host name or the private repository's name.
- **Never widen visibility.** No repository goes from private to public, and no private data goes into a public repository, on any move or migration. Baseline and diff the visibility of every repository before and after.
- **The hook runs before the push.** `public-push-guard.sh` is a `PreToolUse` hook on Bash. It reads every ref a `git push` would send, minus what the remote already holds, and scans each outgoing commit. It scans the text of `gh pr create`, `gh pr edit`, `gh pr comment`, `gh issue create`, `gh release create` and `gh api` writes. A private repository passes. A public one runs `scripts/privacy-guard.mjs` and refuses on a finding. It refuses a command it can't read, or can't check, rather than skip it. It also refuses to make a repository public. Don't work round it. Fix the finding. **Commit in one call and push in the next**: the hook reads the repository before a command runs, so it refuses a push to a public repository that follows a commit, merge or checkout in the same command.
- **What the hook doesn't cover:** a push from a script file or a shell function it can't see, `git subtree push`, submodules, git aliases, extra push URLs on a remote, text posted through a variable it has no value for, and any push made outside Claude Code. The pull request check still runs on those.
- **The pull request check is the second line.** `privacy-guard` in `gorfednet/.github` fails a pull request that adds private detail. A new public repository gets the same workflow before its first push.
- **A slip is disclosed.** Don't try to hide it. Tell Desk, record it in the private ops repository's `INCIDENTS.md` (what happened, what changed, never the value itself), and carry on. The value stays in history.

## Why

Two incidents on 14 and 15 November 2026: a plan and a baseline file listing private repository names reached a public branch, and an audit then found host names, an address, session ids, private repository names and owner quotes in public files. The detail is in the private ops repository's incident log, not here.
