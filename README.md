# gorfednet/.github

Central GitHub Actions workflows, composite actions, and CI templates for [gorfednet](https://github.com/gorfednet) portfolio sites.

## Consumer setup

Each site repo adds thin caller workflows:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    uses: gorfednet/.github/.github/workflows/pr-check-vite-spa.yml@main
```

See [templates/](templates/) for Playwright smoke tests and Dependabot config.

## Reusable workflows

| Workflow | Purpose |
|----------|---------|
| `pr-check-vite-spa.yml` | React/Vite SPAs — build, lint, audit gate |
| `pr-check-static.yml` | Static HTML sites |
| `pr-check-static-verify.yml` | Static + Python/Node verify (anal0g, gorfed) |
| `pr-check-python-flask.yml` | Flask + Mongo + Redis (towit.io) |
| `pr-check-fullstack.yml` | Frontend + server (promptboi.com) |
| `browser-compat.yml` | Playwright Chromium/Firefox/WebKit matrix |
| `production-healthcheck.yml` | Weekly live URL HTTP + Playwright smoke |

## Branch protection

See [.github/BRANCH_PROTECTION.md](.github/BRANCH_PROTECTION.md).
