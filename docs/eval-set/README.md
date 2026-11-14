# Fixed eval set (plan row 1.27)

50 real cases from this fleet, scored on every new model and every served local model. The manifest lists only `{id, task, label, sha256}`. Case bodies are private and live in the ops repository.

| Task | Cases | Label | Scored by |
|------|-------|-------|-----------|
| reviewer | 20 | `valid` or `invalid` finding | verdict equals label |
| builder | 10 | `files:<sha256 of the sorted file list>` | the files the arm picks hash to the label; a Fable grade slot |
| triage | 10 | `real`, `flake` or `infra` | verdict equals label |
| copy | 10 | `voice-clean` | `check-voice` finds nothing in the rewrite; a Fable grade slot |

Scripts, all in `scripts/local-llm/`:

- `evalset.mjs`: manifest schema, scorer and judge. Exit 0 only when every arm passes.
- `evalset-run.mjs`: runs one served model (`--model`), writes the no-model arm (`--nomodel`), writes input-only prompts for Claude-tier arms (`--emit-inputs`) and turns their replies into an arm file (`--ingest`). It checks every body against its sha256 first and stops on a missing or changed one.

Rules the scorer enforces, per task:

- Rejected: every answer the same, or every answer equal to the no-model arm. A task the arm did not run counts as constant.
- Pass: correct at least Haiku minus 1, at least 70% of cases, at least no-model plus 2, no more dangerous misses than Haiku (a `valid` finding called invalid, a `real` failure called something else), every answer schema-valid, median latency 60 s or less.
- Builder and copy stay `PENDING-GRADE` until a Fable editor grade exists for every case.

Local output is a lead until a model is adopted in `docs/models.json`. Model free text never reaches a Claude session from the router. The copy grade is the one eval-only exception: a Fable editor reads the rewrite as delimited data.
