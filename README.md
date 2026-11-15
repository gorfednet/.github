# gorfednet/.github

Shared CI and tooling for the gorfednet sites.

## What's here

- **Pull request checks**: reusable `pr-check-*` workflows in `.github/workflows/` for static sites, Vite apps, Flask apps and full-stack projects
- **Claude review**: `claude-review.yml` reviews a pull request when it opens or leaves draft. A `claude review` comment runs it again. `scripts/review-status.mjs` reads its verdict for a merge gate.
- **Verification kit and rules**: `templates/verification-kit/` holds the checks. `docs/verification-rules.md` holds the rules they enforce.
- **ship-bot**: `ship-bot/` merges pull requests that carry `ready-to-merge` once their checks pass
- **Janitor**: `janitor/` closes out merged work each day
- **fleet-status**: `fleet-status.yml` rebuilds `STATUS.md` on the `status` branch. It lists open pull requests and red `main` branches across the sites.
- **Site deploy**: `scripts/site-deploy.sh` publishes a static site as a release and rolls it back. See [`docs/site-deploy.md`](docs/site-deploy.md).
- **Privacy guard**: this repository is public, so `privacy-guard.yml` fails a pull request that adds private detail

## Use it

Call a workflow from a site's own pull request workflow:

```yaml
jobs:
  check:
    uses: gorfednet/.github/.github/workflows/pr-check-vite-spa.yml@main
    with:
      test-report: test-results/results.json
      min-tests: "24"
```

- The `pr-check-*` workflows need no secrets
- The review job needs `CLAUDE_CODE_OAUTH_TOKEN`. Copy [`templates/claude-review.yml`](templates/claude-review.yml) and add a `REVIEW.md` with the site's house rules.
- `fleet-status.yml` needs `FLEET_READ_TOKEN` and `NTFY_TOKEN`

Runbooks and plans are in the private ops repository.
