# Bugbot review notes

Keep PRs small and focused.

- Do not commit secrets (`.env`, API keys, credentials, `.deploy-env`).
- Do not weaken or skip GitHub Actions checks to go green.
- Prefer existing deploy scripts (`make deploy` / NAS SSH helpers) over new one-off paths.
- Feature work belongs on a branch with a GitHub PR so Cursor Bugbot can run — do not push feature commits straight to `main`.
- Do not enable Bugbot Autofix or add a Cloud Agent automation that re-reviews PRs.

Dashboard: incremental reviews on, Autofix off, effort **Low**. See BinderCurve `docs/CURSOR_BUGBOT.md` for the operator checklist.
