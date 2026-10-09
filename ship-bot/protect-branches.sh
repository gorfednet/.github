#!/usr/bin/env bash
# Protect each configured repository's default branch, with the ship bot's
# expectedChecks as the required checks, and turn on delete-branch-on-merge.
#
#   ship-bot/protect-branches.sh --dry-run                print every gh api call; change nothing
#   ship-bot/protect-branches.sh                          apply to every repo whose mode is not "off"
#   ship-bot/protect-branches.sh --repo MoonMan           only that repo (repeatable)
#   ship-bot/protect-branches.sh --config <path>          default ~/.ship-bot/config.json
#
# Supersedes scripts/apply-all-branch-protection.sh, whose hand-kept list had
# drifted from the workflows. The list now comes from the same config the bot
# merges by, so "required to merge" and "checked before merging" cannot differ.
#
# The protection: required checks = that repo's expectedChecks, not strict (a
# branch need not be up to date with its base), no required reviews and no
# required pull request (the owner does not review, and release steps such as
# BinderCurve's /ship commit to main), admins not bound (the owner can still
# fix things by hand), force pushes and branch deletion refused.
#
# Needs gh, authenticated as an admin of the repositories.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HOME}/.ship-bot/config.json"
DRY_RUN=0
REPOS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --config) CONFIG="${2:?--config needs a path}"; shift ;;
    --repo) REPOS+=("${2:?--repo needs a name}"); shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "protect-branches.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# One line per repository: slug, then the JSON body for the protection call.
# Built by the bot's own config loader, so a config the bot would refuse is
# refused here too. An unmatched --repo is an error, not an empty run.
plan="$(node "${HERE}/lib/protection.mjs" "${CONFIG}" "${REPOS[@]+"${REPOS[@]}"}")" || exit $?

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] gh'
    printf ' %q' "$@"
    printf '\n'
  else
    gh "$@" </dev/null
  fi
}

while IFS=$'\t' read -r slug body; do
  [[ -n "${slug}" ]] || continue
  if [[ "${DRY_RUN}" == "1" ]]; then
    branch="<default branch of ${slug}>"
    printf '[dry-run] gh api repos/%s --jq .default_branch\n' "${slug}"
  else
    branch="$(gh api "repos/${slug}" --jq .default_branch </dev/null)"
    if [[ -z "${branch}" ]]; then
      echo "protect-branches.sh: could not read the default branch of ${slug}" >&2
      exit 1
    fi
  fi
  echo "== ${slug} (${branch})"
  if [[ "${DRY_RUN}" == "1" ]]; then
    run api --method PUT -H "Accept: application/vnd.github+json" "repos/${slug}/branches/${branch}/protection" --input -
    echo "    with body: ${body}"
  else
    printf '%s' "${body}" | gh api --method PUT -H "Accept: application/vnd.github+json" \
      "repos/${slug}/branches/${branch}/protection" --input - >/dev/null
  fi
  run api --method PATCH "repos/${slug}" -F delete_branch_on_merge=true --silent
done <<<"${plan}"

if [[ "${DRY_RUN}" == "1" ]]; then echo "Dry run: nothing was changed."; else echo "Done."; fi
