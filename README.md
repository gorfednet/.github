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
