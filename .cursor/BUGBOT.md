# Bugbot review notes

Keep PRs small and focused.

- Do not commit secrets (`.env`, API keys, credentials, `.deploy-env`).
- Do not weaken or skip GitHub Actions checks to go green.
- Prefer existing deploy scripts (`make deploy` / NAS SSH helpers) over new one-off paths.
- Feature work belongs on a branch with a GitHub PR so Cursor Bugbot can run — do not push feature commits straight to `main`.
- Do not enable Bugbot Autofix or add a Cloud Agent automation that re-reviews PRs.

Dashboard: [cursor.com/dashboard?tab=bugbot](https://cursor.com/dashboard?tab=bugbot). Autofix **off**. Effort and incremental reviews follow `monitorClass` in `fleet.json`, not a single org-wide default.

| monitorClass | Repos | Bugbot | Effort | Incremental |
|---|---|---|---|---|
| active-product | bindercurve.com | on | Smart (High only for `packages/api/**`, `packages/worker/**`, auth, billing, deploy) | on |
| active-site | 4thcltr.com, promptboi.com, gorfed.net, MoonMan | on | Low | on |
| static-marketing | anal0g.org, blackpixelrecords.com, denseware.com, gorfmusic.com, rowanmcarthur.com, ssatcy.com, subrythm.com | on | Low | **run-once** |
| dormant | TowIt, wychwood | **off** | — | — |
| tool | ACID2REAPER | **off** unless it starts shipping weekly | — | — |
| org-shared | gorfednet/.github | on | Low | on |

A credit outage looks like **no Bugbot check at all** (MoonMan #150–#153, 2026-09-21), not a red Actions job. Restore usage first, then comment `bugbot run` on any open PR that sat unreviewed.

`bugbot-verdict.yml` is not a required check. Wiring it fleet-wide turns a billing outage into a twelve-minute red on every pull request.

## Operator gates this registry cannot click

1. Restore Cursor credits when the dashboard says usage is exhausted.
2. Apply the table above on the Bugbot dashboard after a credit restore or a new repo.
3. Add `FLEET_READ_TOKEN` on `gorfednet/.github`: fine-grained PAT, Contents + Metadata read across `gorfednet`. The Monday `fleet-audit` job fails closed without it on purpose.

See BinderCurve `docs/CURSOR_BUGBOT.md` for the NEUTRAL-vs-unreviewed checklist.
