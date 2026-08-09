# gorfednet.github

Shared GitHub Actions workflows and NAS deploy helpers for portfolio sites.

## NAS SSH deploy (replaces SMB mounts)

1. Run Phase 0 setup once (installs your Mac SSH key on `dev@gorfednas`):

   ```bash
   NAS_DEV_PASSWORD='your-dev-password' ./scripts/setup-nas-ssh.sh
   ```

2. Each site uses a gitignored `.deploy-env` (see `.deploy-env.example`).

3. Deploy from any site repo:

   ```bash
   make deploy          # static sites
   make deploy-nas-dev  # bindercurve.com dev SPA
   ```

Shared shell helpers live in [`scripts/nas-ssh-deploy.sh`](scripts/nas-ssh-deploy.sh).
