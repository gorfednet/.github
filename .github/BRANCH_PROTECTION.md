# Branch protection for gorfednet portfolio repos

One-time setup after the first successful CI run on `main` (GitHub must see check names once).

## Automated

From a clone of `gorfednet/.github`:

```bash
chmod +x scripts/setup-branch-protection.sh

# Vite SPA (CI + browser compat)
./scripts/setup-branch-protection.sh gorfednet/denseware.com \
  "CI / check" "browser-compat / compat-success"

# Static verify (gorfed.net)
./scripts/setup-branch-protection.sh gorfednet/gorfed.net \
  "CI / check" "browser-compat / compat-success"

# Python Flask (towit.io)
./scripts/setup-branch-protection.sh gorfednet/TowIt "CI / test"

# Static only
./scripts/setup-branch-protection.sh gorfednet/blackpixelrecords.com \
  "CI / check"
```

Requires [GitHub CLI](https://cli.github.com/) with **admin** on the target repo.

## Required checks by tier

| Tier | Required checks |
|------|-----------------|
| Vite SPA | `CI / check`, `browser-compat / compat-success` |
| Static + build | `CI / check`, `browser-compat / compat-success` |
| Fullstack | `CI / check`, `browser-compat / compat-success` |
| Python Flask | `CI / test` |
| Static HTML | `CI / check` |

`browser-compat / compat-success` is the aggregator job — do not require individual matrix cells.

## Manual (GitHub UI)

1. **Settings** → **Branches** → **Add branch protection rule**
2. Branch name pattern: `main`
3. **Require status checks to pass before merging**
4. **Require branches to be up to date before merging**
5. Select checks from the table above
6. Disable force pushes and deletions

Private repos need **GitHub Pro** (or public visibility) for the Branch protection API.
