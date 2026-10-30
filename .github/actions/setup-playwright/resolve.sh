#!/usr/bin/env bash
# Decides how setup-playwright gets browsers, and does the pool-side work.
#
# Inputs (env): BROWSERS (space-separated names), SYSTEM_DEPS (always or auto; anything else,
# empty included, is an error on every path), plus the runner's GITHUB_OUTPUT,
# GITHUB_ENV, RUNNER_TEMP. Runs in the directory holding @playwright/test.
#
# Writes to GITHUB_OUTPUT: version, browsers_slug, mode, system_deps.
#   mode=hosted        BC_PREINSTALLED_PLAYWRIGHT_VERSION unset: the caller's cache and
#                      `install --with-deps` steps run, exactly as before.
#   mode=pool-skip     the image already carries the locked version: nothing to install.
#   mode=pool-install  the image carries other versions: browsers (no system deps, which a
#                      pool job cannot install) went to $RUNNER_TEMP/ms-playwright, and
#                      PLAYWRIGHT_BROWSERS_PATH points there for later steps.
set -euo pipefail

browsers="${BROWSERS:-chromium firefox webkit}"

# Fail closed on selection: a typo must not quietly fall back to either behaviour. The action
# declares the default ("always"), so a value that reaches this script empty was passed empty.
system_deps="${SYSTEM_DEPS-}"
case "$system_deps" in
  always | auto) ;;
  *)
    echo "::error::setup-playwright: system-deps must be 'always' or 'auto', got '${system_deps}'."
    exit 1
    ;;
esac

version="$(node -p "require('@playwright/test/package.json').version" 2>/dev/null || true)"
if [ -z "$version" ]; then
  version="$(node -p "require('playwright/package.json').version" 2>/dev/null || true)"
fi
if [ -z "$version" ]; then
  echo "::error::setup-playwright: neither @playwright/test nor playwright resolves from $(pwd). Install dependencies before this step, or set working-directory."
  exit 1
fi

# Word-split on purpose: collapses repeated spaces, then joins with dashes.
# shellcheck disable=SC2086
slug="$(echo $browsers | tr ' ' '-')"
mode=hosted

preinstalled="${BC_PREINSTALLED_PLAYWRIGHT_VERSION:-}"
if [ -n "$preinstalled" ]; then
  mode=pool-install
  for v in $(printf '%s' "$preinstalled" | tr ',' ' '); do
    if [ "$v" = "$version" ]; then mode=pool-skip; fi
  done

  if [ "$mode" = pool-skip ]; then
    echo "Pool image carries Playwright $version (BC_PREINSTALLED_PLAYWRIGHT_VERSION=$preinstalled): skipping browser install."
  else
    target="${RUNNER_TEMP:?RUNNER_TEMP is required on the pool}/ms-playwright"
    echo "::notice::Playwright $version is locked but the pool image carries $preinstalled. Installing $browsers to $target; baking $version into the image would save this download."
    # shellcheck disable=SC2086
    PLAYWRIGHT_BROWSERS_PATH="$target" npx playwright install $browsers
    echo "PLAYWRIGHT_BROWSERS_PATH=$target" >> "${GITHUB_ENV:?}"
  fi
fi

{
  echo "version=$version"
  echo "browsers_slug=$slug"
  echo "mode=$mode"
  echo "system_deps=$system_deps"
} >> "${GITHUB_OUTPUT:?}"
