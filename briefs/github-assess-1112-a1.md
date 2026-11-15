# Brief: Bring every active repo's pinned gate ref to the current kit.

Model: Sonnet. One session, one pull request, ends when it merges. At most 2 builders live; run builder-ok before each. Return a PR with `## Next`.

Read docs/assessment-2026-11-12-output-quality.md lane A1, backlog entry assess-1112-a1-*, and the "Kit is current and unmodified (drift)" row in docs/verification-rules.md.

## Why this is about the pin, not a copy
The gate runs this repository's kit, resolved from its own checkout at the ref each caller pins. A consumer's vendored copy is running its own scripts, not the gate's. So moving vendored copies changes nothing the gate runs. The drift check was removed for that reason, and "two kit releases each needed thirteen mechanical pull requests" was the cost. Do not bring that cost back.

## Steps
- Read the pinned gate ref in each active repo's CI caller workflow, and the kit version on `.github` main (`templates/verification-kit/MANIFEST.json`, 0.62.0 on 14 November 2026).
- List every repo whose pin is behind. Check what `fleet-audit.yml` already reports for the pin, and what scripts/fleet-status.mjs reads (it reads each repo's vendored `verification-kit/MANIFEST.json`, which is not what runs).
- Move each stale pin forward in one small PR per repo, batched where the repo's CI is short. A repo with a vendored copy that it chooses to keep may use `refresh-kit.mjs`; never require it.
- Do not make kit drift fail a pull request: another repository can't fail a PR (verification-floor rule 5). Drift stays in the scheduled reports (`fleet-audit.yml`, STATUS.md).
- If STATUS.md should show the pin instead of the vendored copy, change fleet-status to read the pin. Watch that row fail once on a stale pin.

## Done
`fleet-audit.yml` or STATUS.md shows every active repo's pinned gate ref on the current kit, and no vendored copy is the measure.
