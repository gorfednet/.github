#!/usr/bin/env bash
# Post the fleet janitor's digest to ntfy ops-report (janitor/PROMPT.md, step 8).
#   bash scripts/janitor-notify.sh <digest-file>
# The token is read here, from ~/.fleet-janitor/ntfy.token or ~/.ship-bot/ntfy.token, so it never
# appears in the janitor's transcript. With no token file the digest stays where it is and this
# says so; a failed post exits 1.
set -euo pipefail
digest="${1:?usage: janitor-notify.sh <digest-file>}"
test -s "$digest" || { echo "janitor-notify: $digest is empty" >&2; exit 2; }
lines=$(wc -l < "$digest" | tr -d ' ')
[ "$lines" -le 10 ] || { echo "janitor-notify: digest has $lines lines, at most 10" >&2; exit 2; }
token_file=""
for f in "$HOME/.fleet-janitor/ntfy.token" "$HOME/.ship-bot/ntfy.token"; do
  if [ -s "$f" ]; then token_file="$f"; break; fi
done
if [ -z "$token_file" ]; then
  echo "janitor-notify: no ntfy token file; digest kept at $digest"
  exit 0
fi
curl -sS --fail --max-time 15 -o /dev/null \
  -H "User-Agent: gorfednet-fleet-janitor" \
  -H "Title: Fleet janitor" -H "Tags: broom" \
  -H "Authorization: Bearer $(tr -d '\n' < "$token_file")" \
  --data-binary @"$digest" "https://ntfy.gorfed.net/ops-report"
echo "janitor-notify: posted $lines lines to ops-report"
