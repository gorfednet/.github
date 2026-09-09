# gorfednet.github

Shared GitHub Actions workflows and NAS deploy helpers for portfolio sites.

## NAS SSH deploy (replaces SMB mounts)

1. Run Phase 0 setup once (installs your Mac SSH key on `dev@gorfednas`):

   ```bash
   NAS_DEV_PASSWORD='your-dev-password' ./scripts/setup-nas-ssh.sh
   ```

2. Each site uses a gitignored `.deploy-env` (see `.deploy-env.example`).

3. Deploy a static site from a site repo that provides the shared Make target:

   ```bash
   make deploy
   ```

   `make deploy-nas-dev` is specific to `bindercurve.com`; it is not a
   fleet-wide target.

Shared shell helpers live in [`scripts/nas-ssh-deploy.sh`](scripts/nas-ssh-deploy.sh).

`scripts/test-nas-ssh-deploy.sh` exercises the helper's rsync options and
permission contract without contacting the NAS. After initial SSH setup,
`scripts/phase0-verify.sh` checks connectivity, key authentication, remote
write access, and an rsync dry run.

## Shared CI tooling

The reusable pull-request workflows under `.github/workflows/` provide common
checks for static sites, Vite SPAs, and full-stack projects. Both
`pr-check-vite-spa.yml` and `pr-check-fullstack.yml` accept an optional
`lint-command` input; the step is skipped when the input is empty. Callers can
use it for linting, type checking, or a combined command.

The no-SMB guard rejects legacy network-share deployment references in the
source tree it scans. The `pr-check-static.yml`,
`pr-check-static-verify.yml`, and
`pr-check-vite-spa.yml` workflows all call the shared
`.github/actions/no-smb-guard` composite action. That action sparse-checks out
this repository's `scripts/` directory and runs the single implementation in
`scripts/no-smb-guard.sh`.

Run the same guard locally (requires `rg`):

```bash
bash scripts/no-smb-guard.sh <path>
```

## Verification baseline

Every project in the fleet runs the same checks against a green build, because
a green build is the thing most likely to be lying. The rules are in
[`docs/verification-rules.md`](docs/verification-rules.md) as `V1`…`V38`; the
checks that enforce them are in
[`templates/verification-kit/`](templates/verification-kit/), and the case file
behind every rule is bindercurve.com's `docs/audit/verification-teardown.md`.

Three layers:

1. **Machine-wide** Cursor rules and skills, so an agent applies the standing
   loop in a repository that has adopted nothing yet.
2. **This repository.** The canonical kit, the shared rules, the
   `verification-gate` composite action, and `bugbot-verdict.yml`.
3. **Each project**, which copies the kit and runs `check-kit-drift.mjs` so its
   copy cannot quietly fall behind.

A project adopts the whole thing by upgrading the `uses:` line on its existing
`pr-check-*` workflow. The gate is inherited; nothing is added to the project's
own workflow file. Point it at a test report to get the executed-count
assertion:

```yaml
uses: gorfednet/.github/.github/workflows/pr-check-vite-spa.yml@main
with:
  test-report: test-results/results.json
  min-tests: "24"
```

Set `verification-kit: ""` to disable the gate. That should only ever be a
temporary state during adoption, and the fleet registry records which projects
are in it.

Adoption is tiered, because a static site with no `package.json` cannot run
what BinderCurve runs. The kit is plain node with no dependencies for exactly
that reason.

## Pull requests and Cursor Bugbot

Feature work on portfolio sites is a **branch + GitHub PR** so Cursor Bugbot and the reusable `pr-check-*` workflows run. Do not push feature commits straight to `main`.

Repo review notes: [`.cursor/BUGBOT.md`](.cursor/BUGBOT.md). Operator checklist (effort Low, Autofix off, incremental on): BinderCurve [`docs/CURSOR_BUGBOT.md`](https://github.com/gorfednet/bindercurve.com/blob/main/docs/CURSOR_BUGBOT.md). Do not add a Cloud Agent automation that comments on every PR.

