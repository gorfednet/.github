#!/usr/bin/env bash
# Read-only check for the GitHub org migration (docs/plans/github-org-migration.md).
# Lists every repository owned by each OWNER given (a user or an org), takes the
# union by name, and diffs name, visibility, fork flag and Pages against the
# baseline. Any difference, a repository missing or extra, an empty listing or an
# API error exits non-zero. It only makes GET calls.
#
#   scripts/visibility-baseline.sh                       # owner gorfednet
#   scripts/visibility-baseline.sh gorfednet NEW-ORG     # during and after the moves
#
# The baseline names private repositories, so it lives in the private ops repo,
# never here (this repository is public). BASELINE=path overrides it.
set -euo pipefail

baseline=${BASELINE:-$HOME/Developer/gorfednet/ops/docs/github-org/visibility-baseline.tsv}
[ -s "$baseline" ] || { echo "visibility-baseline: no baseline at $baseline" >&2; exit 2; }
[ $# -gt 0 ] || set -- gorfednet

me=$(gh api user --jq .login)
live=$(mktemp); want=$(mktemp); trap 'rm -f "$live" "$want"' EXIT

for owner in "$@"; do
  type=$(gh api "users/$owner" --jq .type)
  if [ "$type" = Organization ]; then
    path="orgs/$owner/repos?type=all&per_page=100"
  elif [ "$owner" = "$me" ]; then
    path="user/repos?affiliation=owner&per_page=100"
  else
    echo "visibility-baseline: $owner is a user other than the signed-in $me; its private repositories can't be listed" >&2
    exit 2
  fi
  gh api --paginate "$path" --jq '.[] | [.name, .visibility, .fork, .has_pages, .owner.login] | @tsv' >> "$live"
done

[ -s "$live" ] || { echo "visibility-baseline: GitHub listed no repositories for $*" >&2; exit 2; }

dupes=$(cut -f1 "$live" | sort | uniq -d)
[ -z "$dupes" ] || { echo "visibility-baseline: the same name under two owners: $dupes" >&2; exit 1; }

grep -v '^#' "$baseline" | LC_ALL=C sort > "$want"
if diff <(cut -f1-4 "$live" | LC_ALL=C sort) "$want" > /dev/null; then
  n=$(wc -l < "$want" | tr -d ' ')
  echo "visibility-baseline: OK, $n repositories match the baseline ($(cut -f2 "$want" | sort | uniq -c | tr -s ' ' | paste -sd, -))."
  cut -f5 "$live" | sort | uniq -c | sed 's/^ */  owner count: /'
  exit 0
fi
echo "visibility-baseline: MISMATCH (< live, > baseline):" >&2
diff <(cut -f1-4 "$live" | LC_ALL=C sort) "$want" >&2 || true
exit 1
