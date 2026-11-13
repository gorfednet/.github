# Pull request review ({{name}})

Read by the Claude reviewer (`.github/workflows/claude-review.yml`, which calls the shared workflow in `gorfednet/.github`) on every non-draft pull request and on a `claude review` comment. The shared workflow says what to report in general. This file holds what is particular to this repository.

## What this repository is

{{summary}}

## House rules to hold the change to

- A change that fixes a bug comes with a test that fails without it.
- A check is never made green by weakening it: no lowered floor, widened tolerance or deleted assertion.
- `verification-kit/` is vendored from `gorfednet/.github`. Edits there go upstream, never here.
- Open work lives in `docs/backlog.json` as typed entries, with `created` and `updated` dates.
- No secrets in the repository: `.deploy-env`, keys and tokens stay out.

## Where the rules live

- `CLAUDE.md`, `docs/backlog.json`, `docs/verification-rules.md`
