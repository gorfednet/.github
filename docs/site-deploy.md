# Site deploy

`scripts/site-deploy.sh` publishes a static site as an immutable release and can roll it back. Run it from a site repository that has a `.deploy-env` (see `.deploy-env.example`). The keys are `SITE`, `SITE_HOST`, `SITE_ROOT`, `SITE_KEEP`, `SITE_LIVE_URL` and `SITE_EXCLUDES`.

```bash
scripts/site-deploy.sh deploy dist      # --dry-run to preview
scripts/site-deploy.sh list             # releases, newest first, current marked
scripts/site-deploy.sh rollback         # to the newest release older than current
scripts/site-deploy.sh rollback <id>    # to a named release
```

## Layout on the host

```
<SITE_ROOT>/<site>/releases/<UTC-stamp>-<gitsha>/   immutable, one per deploy
<SITE_ROOT>/<site>/current -> releases/<id>          relative symlink
```

The web server serves `current` read-only.

## What a deploy does

1. Uploads to `releases/<id>.partial`. Unchanged files are hard-linked from the current release.
2. Refuses an empty release, or one without `index.html`. `SITE_NO_INDEX=1` overrides the second.
3. Renames the upload into place and switches `current` with a rename. The web server isn't restarted.
4. Keeps the newest `SITE_KEEP` releases
5. Compares the live site's `index.html` with the uploaded one byte for byte. If they differ, it switches `current` back and exits non-zero.

`scripts/test-site-deploy.sh` runs all of this against a temporary directory.

## The merged-tip guard

Before it reads `.deploy-env` or uploads anything, `deploy` checks the site repository it runs in. It refuses when:

- `HEAD` isn't exactly the default branch of `origin` after a quiet fetch. The message gives both short SHAs and the fix: `git pull --ff-only`, or merge the pull request first. A failed fetch refuses too.
- A tracked file has uncommitted changes. Untracked files are left to the publish-set checks.
- The helper's own clone isn't the merged tip of its repository. The message gives the `git pull --ff-only` fix.
- The directory being uploaded holds a `.claude` path or a `.git` file or directory at any depth. The paths are named. This refusal has no override.

Then it checks the build. The upload's `.build-sha` must match `HEAD` and must not end in `-dirty`. A site marked `"buildStamp": true` in `fleet.json` must also have one. A stale `dist/` is refused with the SHA it was built from. Rebuild and deploy again. No override reaches this check.

Emergency override of the tip, uncommitted-change and helper-clone refusals: `DEPLOY_ALLOW_UNMERGED=1 DEPLOY_REASON="why"`. The reason is required. The deploy prints a warning with the commit SHA and the reason, then goes on.

The live check compares the live site with the local build. It doesn't read `origin`, so a stale clone would pass it without this guard. Test it with `scripts/test-site-deploy-guard.sh`, which runs the guard against real temporary git repositories with a bare origin.
