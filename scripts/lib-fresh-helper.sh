#!/bin/bash
# Sourced by the site-deploy tests. site-deploy.sh refuses to run from a clone that is not the
# merged tip of its own repository, so the tests run a copy that is: a temp git repo holding the
# helper's files, in sync with a bare origin. Sets FRESH_HELPER_DIR (its scripts/ directory).
make_fresh_helper() {
  local base="$1" src_root="$2"
  local origin="${base}/helper-origin.git" repo="${base}/helper"
  git init -q --bare -b main "${origin}"
  git init -q -b main "${repo}"
  mkdir -p "${repo}/scripts"
  cp "${src_root}/scripts/site-deploy.sh" "${src_root}/scripts/nas-ssh-deploy.sh" "${repo}/scripts/"
  [[ -f "${src_root}/fleet.json" ]] && cp "${src_root}/fleet.json" "${repo}/"
  git -C "${repo}" add -A
  git -C "${repo}" -c user.email=t@t -c user.name=t commit -q -m helper
  git -C "${repo}" remote add origin "${origin}"
  git -C "${repo}" push -q origin main
  git -C "${repo}" fetch -q origin
  git -C "${repo}" branch -q --set-upstream-to=origin/main main
  FRESH_HELPER_DIR="${repo}/scripts"
}
