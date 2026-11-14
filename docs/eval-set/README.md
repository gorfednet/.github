# Fixed eval set (plan row 1.27)

62 real cases from this fleet, scored on every new model and every served local model. The manifest lists only `{id, task, label, sha256}`. Case bodies are private and live in the ops repository.

| Task | Cases | Label | Scored by |
|------|-------|-------|-----------|
| reviewer | 30 (15 pairs) | `valid` or `invalid` | verdict equals label |
| builder | 10 | `files:<salted sha256 of the sorted file list>` | the files the arm picks hash to the label; not graded until an arm produces a diff |
| triage | 12 | `real`, `flake` or `infra` | verdict equals label; cause lines near the truth |
| copy | 10 | `voice:<check-voice findings before the rewrite>` | findings left after the rewrite; a fact-kept grade |

Labels:

- Reviewer pairs come from git, not from reply wording. One finding is shown twice: with the code at the commit it was made on (`valid`) and with the code at the commit that fixed it (`invalid`). The input is the region the fix touched plus any `path:line` the finding cites. One pair per dispute, one per pull request.
- Triage follows the design's rule: `flake` = a later attempt on the same commit passed, `real` = the next code commit went green, `infra` = the job never started or the runner was lost. One case per failure signature.
- Builder labels are salted per case (`--salt-file`, kept in the private repository), so a file list guessed from a repository can't be checked against the public label.

Scripts, all in `scripts/local-llm/`:

- `evalset.mjs`: manifest schema, scorer and judge. Exit 0 only when every arm passes.
- `evalset-run.mjs`: runs one served model (`--model`), writes the no-model arm (`--nomodel`, majority label computed from the cases), writes input-only prompts for Claude-tier arms (`--emit-inputs`) and turns their replies into an arm file (`--ingest`). It checks every body against its sha256 first and stops on a missing or changed one.
- `evalset-baseline.mjs`: freezes the scores of the committed arm files into `baseline.json`. The arm files themselves are private (ops, `docs/evals/evalset/arms/`).

Rules the scorer enforces, per task:

- Rejected: every answer the same (builder compares the file lists, not the salted keys), or every answer equal to the no-model arm. A task the arm did not run counts as constant.
- No reference: if the Haiku arm is itself rejected on a task, that task reports `no reference` and the arm is not compared on it. The status is `NO-REFERENCE`, never `PASS`.
- Pass: correct at least Haiku minus 1, at least no-model plus 2, no more dangerous misses than Haiku (a `valid` finding called invalid, a `real` failure called something else), every answer schema-valid. There is no absolute floor: the bars come from the reference arms, since a 70% floor failed Haiku and Sonnet on builder.
- Latency (60 s median) applies only to an arm that was timed. An ingested Claude arm has no timings and skips it. An arm timed on only some answers fails.
- Triage: cause lines at least Haiku's and no-model plus 2. The runner sets `cause` on each answer from the private truth; an arm file with none fails.
- Copy: findings dropped from the starting count at least Haiku's minus 1, plus the grade below.
- Grades (copy only): `{armName: {sha256 of the answer text: integer 0..5}}`. A grade that isn't an integer 0 to 5 fails the arm. The mean must be at least 4 and no case below 3. Missing grades leave the arm `PENDING-GRADE`.

`baseline.json` pins the manifest by sha256, and a test fails when the manifest changes without a refreeze.

Local output is a lead until a model is adopted in `docs/models.json`. Model free text never reaches a Claude session from the router. The copy grade is the one eval-only exception, and it needs a tool-less grader (deferred, see the pull request's `## Next`).
