# Brief: 1.19 local models, baseline and first eval (CI-log triage)

Model: Sonnet 5.5 (builder-level work; a Fable `reviewer` reads the result before anything is adopted). Repo: `gorfednet/.github`, harness in `scripts/local-llm/`. Private data lives in `gorfednet/ops` and on `/Volumes/gorfkcits/evals/ci-triage/`.

Read first, nothing else: `git show origin/desk-log:docs/assessments/2026-11-14-local-models-design.md` (sections "Eval for (a)" and "Routing and safety"), then `scripts/local-llm/eval.mjs --help` and ops `docs/evals/ci-triage.json` (fixtures, ops 85 merged).

## Objective
Run the first eval of task (a), CI-log triage: Haiku baseline, no-model arm, and each local model already served by Llama.app (127.0.0.1:9931), scored by `eval.mjs`. Adopt a model in `docs/models.json` only if it passes every bar in the design.

## Steps
1. Step 0 from the design: one 7-day pass over what sessions read (`gh run view --log*`, images, inventories). Record the share. If logs are a few percent, say so and stop after the baseline.
2. Check the manifest has 20 labelled items (10 real, 6 flake, 4 infra) with cause lines. Fill any gaps as the design says (Sonnet labels the cause from the fixing diff). `gh api rate_limit` before any bulk read.
3. Haiku baseline: a Haiku session spawns `scout` over the same prefiltered inputs. Freeze `baseline.json` in ops. Max plan only, never the API.
4. No-model arm and local arms: only models `/v1/models` lists now (the redownload finishes about 13:00 ET; park later models under `## Next` with that time). If a log won't fit the preset's ctx, record it. Don't edit the Llama.app preset without saying so in the PR.
5. Score with `eval.mjs`. Put the table in the PR. Adopt only on a pass, with evidence.

## Done when
A PR in `gorfednet/.github` (results and any `docs/models.json` row) plus one in ops (baseline, manifest fixes), each with `## Next`. Fable `reviewer` read the results. No private logs or PR bodies in `.github` (it's public).

## Boundaries
`builder-ok` before each builder. One local model loaded at a time (the harness lock). No change to ship-bot, janitor or gates. Model text never reaches a Claude session (enum plus line numbers). A wait (downloads, CI) is parked under `## Next` with its ET time while you take the next step. Return a PR with `## Next`.
