# Cloud session start failure, 13 November 2026

## Cause (established)
Anthropic's cloud session API answered `503 overloaded_error` to `POST /v1/code/sessions`. Not a GitHub App, environment or repo-access fault.

Evidence, `~/Library/Logs/Claude/`:
- `main.log` 09:04:12 ET: four `side session (cloud request)` tasks created (task_ed8ddc62, 568814fc, beed8333, c2905a46). 09:04:21-22 each was launched. 09:04:26-32 each logged `cloud session not created`.
- `claude.ai-web.log` lines 848-851, 09:04:26, :27, :31, :32 ET: `QueryClient error: 503 POST /v1/code/sessions overloaded_error`. Four requests, four 503s, same seconds. No other error in the window.
- Only these four 503s appear in the log, so it was a capacity blip at that moment, not a standing fault.

## Ruled out or not reachable
- Environment "Default": `list_start_targets` reported it hosted, default, available at request time. The request reached the API, so the environment resolved.
- Conversation not in front: from a side session, `list_start_targets` now reports `cloud: {available:false, reason:"not_on_screen"}`. That blocks cloud starts from a session that is not on screen. It is a second, separate trap. Desk's 09:04 requests did reach the API, so it was not the cause that time, but it will be next time Desk is in the background.
- GitHub App install: not verified. The `gh` token cannot call `/user/installations` (403, needs an app-authorized token) or `orgs/gorfednet/installations` (needs `admin:org`). Repos exist: 4thcltr.com and gorfed.net are private, `.github` is public, default branch `main` on all. The 503 came before any repo access check, so the App install is unproven either way.
- Probe session on `gorfednet/.github`: not run. The auto-mode classifier denied the `start_session` call, so the fault was not reproduced.

## Fix
1. Retry. A 503 `overloaded_error` is transient. Retry the cloud request, spaced out (one at a time, not four at once), from a session that is in front in the app.
2. Request cloud sessions only while the requesting conversation is the one on screen.
3. Owner step, only if a retry fails with a different error naming GitHub access: check the Claude GitHub App covers the repos. Steps, for someone who does not code:
   - `gorfednet` is a personal account (not an organization), so the setting lives under his own settings. Open github.com/settings/installations, or: profile picture, Settings, left sidebar "Applications", tab "Installed GitHub Apps".
   - Find "Claude" and click Configure.
   - Under "Repository access", choose All repositories (or add 4thcltr.com, gorfed.net and .github to the list). Click Save.
   Nothing for him until a retry shows a GitHub-access error.

## Next
- [ ] Merge (docs only).
- [ ] Desk: retry one cloud request from the foreground, one at a time.
