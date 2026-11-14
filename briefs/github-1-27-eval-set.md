# Brief: 1.27 fixed eval set, rerun on every new model

Model: Sonnet 5.5 `builder` curates and wires. A Fable `reviewer` checks every label and the pass bar (a design decision). Repos: `gorfednet/.github` (scorer, manifest schema, `docs/models.json`), `gorfednet/ops` (private case bodies), USB m.2 `/Volumes/gorfkcits/evals/`.

Read first: `git show origin/desk-log:docs/assessments/2026-11-14-local-models-design.md` ("Eval for (a)", "Routing and safety"), `scripts/local-llm/eval.mjs`, ops `docs/evals/README.md`.

## Objective
About 50 graded real cases from this fleet, rerun whenever a model ships or a local model is added, so `docs/models.json` and the tier table move on scores, not guesses. Replaces 1.19's CI-triage-only eval, which was dropped because logs are about 1% of reads.

## Done when
- Cases cover 4 tasks in proportion to what sessions spend on them: reviewer findings (true and false positives from merged PRs), builder tasks with a known-good diff, triage calls, copy edits scored by `check-voice` plus a Fable grade. Each has a sha256 in the manifest.
- The scorer rejects a constant-answer arm and the no-model arm, as `eval.mjs` does for triage, and each rejection is watched once.
- Haiku, Sonnet and every served local model scored on the same set. Write-up in `docs/evals/`. Any tier change cites a score.

## Boundaries
Case bodies stay private: only ids, labels and hashes in `.github`. No API spend beyond the Max plan without asking. Local output is a lead until adopted. `## Next`, `claude review`, label when clean.
