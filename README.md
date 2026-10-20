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

## Site deploy to dapyllil (releases)

Static sites are moving from the NAS to dapyllil's local disk.
[`scripts/site-deploy.sh`](scripts/site-deploy.sh) is the new deploy path; run it
from a site repo with a `.deploy-env` (see `.deploy-env.example`, keys `SITE`,
`SITE_HOST`, `SITE_ROOT`, `SITE_KEEP`, `SITE_LIVE_URL`, `SITE_EXCLUDES`):

```bash
scripts/site-deploy.sh deploy dist      # --dry-run to preview
scripts/site-deploy.sh list             # releases, newest first, current marked
scripts/site-deploy.sh rollback         # to the newest release older than current
scripts/site-deploy.sh rollback <id>    # to a named release
```

Layout on dapyllil, owned by the local user `sitedeploy` (SSH as
`sitedeploy@dapyllil`):

```
/srv/sites/<site>/releases/<UTC-stamp>-<gitsha>/   immutable, one per deploy
/srv/sites/<site>/current -> releases/<id>          relative symlink
```

nginx serves `/srv/sites/<site>/current` read-only. A deploy uploads to
`releases/<id>.partial` (unchanged files are hard-linked from the current
release), refuses an empty release or one without `index.html` (override with
`SITE_NO_INDEX=1`), renames it into place, switches `current` with a rename (no
nginx restart), keeps the newest `SITE_KEEP` releases, and then compares the
live site's `index.html` with the uploaded one byte for byte. If the live site
serves something else, `current` is switched back to the previous release and
the script exits non-zero. `scripts/test-site-deploy.sh` runs all of this against
a temp directory.

**A deploy publishes the merged tip or nothing.** Before it reads `.deploy-env`,
stages or uploads anything, `deploy` judges the repository it runs in (the site
repo, the current directory) and refuses when:

- `HEAD` is not exactly `origin`'s default branch after a quiet fetch: behind,
  ahead or diverged (the message gives both short SHAs and the fix, `git pull
  --ff-only` or merge your PR first), or the fetch fails;
- a tracked file has uncommitted changes (untracked files are the publish-set
  checks' job);
- the directory being uploaded holds a `.claude` path or a `.git` file or
  directory at any depth (agent worktrees live under `<repo>/.claude/worktrees`,
  and a build or stage that copies the repo root carries them). The paths are
  named. This one has no override.

Emergency override of the first two: `DEPLOY_ALLOW_UNMERGED=1
DEPLOY_REASON="why"`. The reason is required; the deploy prints a loud warning
with the commit SHA and the reason, then goes on. Why: the live check compares
the live site with the local build, never with `origin`, so on 2026-10-20 a stale
clone would have passed it. `scripts/test-site-deploy-guard.sh` runs the guard
against real temporary git repos with a bare origin.

`scripts/nas-ssh-deploy.sh` stays only until every site has moved (phase 3) and
is removed in phase 5.

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

1. **Machine-wide** Claude Code rules and skills (`~/.claude`), so an agent applies the standing
   loop in a repository that has adopted nothing yet.
2. **This repository.** The canonical kit, the shared rules, the
   and the `verification-gate` composite action.
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

## Pull requests and review

Feature work on portfolio sites is a **branch + GitHub PR** so the Claude reviewer and the reusable `pr-check-*` workflows run. Do not push feature commits straight to `main`.

Cursor and Bugbot were retired on 2026-10-16. The Claude reviewer reviews pull requests. Its shared parts live here:

- [`.github/workflows/claude-review.yml`](.github/workflows/claude-review.yml): the reusable review job. It reviews when a pull request opens or leaves draft, and again on a `claude review` comment from an owner, member or collaborator, and ends with a `<!-- claude-review head=<sha> findings=<n> -->` verdict comment.
- [`.github/actions/review-input/`](.github/actions/review-input/): builds the whole diff with git (GitHub's diff API stops at 300 files). It runs from this repository, never from the checkout under review, because the review job holds the owner's Claude token.
- [`scripts/review-status.mjs`](scripts/review-status.mjs): the merge gate's review check, `clean`, `findings` or `not-run` for the current head: `node scripts/review-status.mjs --pr <n> --repo gorfednet/<repository>`.

A repository adopts it with a copy of [`templates/claude-review.yml`](templates/claude-review.yml), a `REVIEW.md` holding its house rules, and a `CLAUDE_CODE_OAUTH_TOKEN` secret (from `claude setup-token`). bindercurve.com keeps its own copy of the workflow, where this one was ported from. Retired checks are listed in [`docs/retired-checks.md`](docs/retired-checks.md).

