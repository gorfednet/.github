# Fixed eval set (plan row 1.27)

56 real cases from this fleet, scored on every new model and every served local model.

**Scoring version 3 (plan row 1.27b, 14 November 2026).** A PASS recorded before this version doesn't count for routing, tier moves or adoption. The scorer used to accept copy that check-voice never read, count a cause hit for naming 10 lines to catch 1, and run triage against a floor with no line list. Rerun every arm on this version first (the builder task is the one unaffected). The next section lists what changed. The manifest lists only `{id, task, label, sha256}`. Case bodies are private and live in the ops repository.

| Task | Cases | Label | Scored by |
|------|-------|-------|-----------|
| reviewer | 28 (14 pairs) | `valid` or `invalid` | verdict equals label |
| builder | 10 | `files:<salted sha256 of the sorted file list>` | the files the arm picks hash to the label; not graded until an arm produces a diff |
| triage | 10 | `real`, `flake` or `infra` | verdict equals label; cause lines near the truth |
| copy | 8 | `voice:<check-voice findings before the rewrite>` | findings left after the rewrite; a fact-kept grade |

Labels:

- Reviewer pairs come from git, not from reply wording. One finding is shown twice: with the code at the commit it was made on (`valid`) and with the code at the commit that fixed it (`invalid`). The input is the region the fix touched plus any `path:line` the finding cites. One pair per dispute, one per pull request. A pair is kept only when the fix changes text the model sees (lines are cut at 220 characters) within 10 lines of the finding or a cited line, the bot did not raise the same finding again at or after the fix, and the fixed code does not cite its own review.
- Triage follows the design's rule: `flake` = a later attempt on the same commit passed, `real` = the next code commit went green, `infra` = the job never started or the runner was lost. One case per failure signature.
- Builder labels are salted per case (`--salt-file`, kept in the private repository), so a file list guessed from a repository can't be checked against the public label.

Scripts, all in `scripts/local-llm/`:

- `evalset.mjs`: manifest schema, scorer and judge. Exit 0 only when every arm passes.
- `evalset-run.mjs`: runs one served model (`--model`), writes the no-model arm (`--nomodel`, majority label computed from the cases), writes the rule arm (`--nomodel-rule`: reviewer, invalid when the region holds code from the finding's own Fix sentence; and triage, the log's own `##[error]` lines), writes input-only prompts for Claude-tier arms, triage included (`--emit-inputs`) and turns their replies into an arm file (`--ingest`). It checks every body against its sha256 first and stops on a missing or changed one.
- `evalset-baseline.mjs`: freezes the scores of the committed arm files into `baseline.json`. The arm files themselves are private (ops, `docs/evals/evalset/arms/`).

Rules the scorer enforces, per task:

- Rejected: every answer the same (builder compares the file lists, not the salted keys), or every answer equal to a no-model arm. A task the arm did not run counts as constant.
- No reference: the Haiku arm must be a real answer on the task: schema-valid on every case, not rejected, and at least the better no-model arm plus 2. For copy it must also be graded on every case with mean 4 and no grade under 3. Otherwise that task reports `no reference` and the arm is not compared on it. The status is `NO-REFERENCE`, never `PASS`.
- Two no-model arms: the majority label, and the rule arm for reviewer pairs and triage. Every "no-model plus 2" bar uses the better of the two on that task. A pair needs the second arm because a majority label scores 50% by construction and a rule on the fix's own code does not.
- Frozen references: `--baseline` is required. The Haiku and no-model arm files must match the sha256 values in `baseline.json`, and the baseline must name this manifest, or the run stops.
- Pass: correct at least Haiku minus 1, at least the better no-model arm plus 2, no more dangerous misses than Haiku (a `valid` finding called invalid, a `real` failure called something else), every answer schema-valid. There is no absolute floor: the bars come from the reference arms, since a 70% floor failed Haiku and Sonnet on builder.
- Latency (60 s median) applies only to an arm that was timed. An ingested Claude arm has no timings and skips it. An arm timed on only some answers fails.
- Triage: cause lines at least Haiku's and no-model plus 2. The runner sets `cause` on each answer from the private truth; an arm file with none fails.
- Copy: findings dropped from the starting count at least Haiku's minus 1, plus the grade below.
- Grades (copy only): `{armName: {sha256 of "<case id>\n<answer text>": integer 0..5}}` (`gradeKey` in `evalset.mjs`). A grade that isn't an integer 0 to 5 fails the arm. The mean must be at least 4 and no case below 3. Missing grades leave the arm `PENDING-GRADE`.

`baseline.json` pins the manifest by sha256, and a test fails when the manifest changes without a refreeze.

Version 3 changes:

- Copy: an answer is invalid when it carries anything check-voice doesn't read: a code fence, an HTML comment, an inline code span, a link target, a reference line, an HTML tag, a bare URL or front matter. A check-voice run that read 0 strings never counts as clean.
- Claude-tier arm inputs (`--emit-inputs dir --id-map map.json`) carry opaque names, no case id and no task, and are written in a random order. The inputs directory must be empty. The map is private (mode 0600), outside the inputs directory and outside any repository working tree. `--ingest raw.json --id-map map.json` is the only ingest: it translates the replies back and marks the arm file `blind: true`. Reviewer pairs share their finding text, so a Claude-tier arm answers one case per context: a context that sees both halves of a pair can match them.
- Every arm file carries `scoringVersion: 3`. The scorer refuses a triage arm, Haiku file or no-model file without it, because `cause` is set by the runner from private truth.
- Triage: a cause hit needs at least half of the named lines within 3 of a cause line. `--nomodel-rule` also writes a triage rule arm (the log's own `##[error]` lines, tagged `rule: "error-line"`). Triage reports `NO-REFERENCE` until a frozen no-model arm with that tag covers it, and its cause floor is the best any no-model arm reaches.
- The CLI prints `NO-REFERENCE` for a task with no no-model floor instead of crashing.
- `--model` runs stop on Ctrl-C (SIGINT) or SIGTERM: no further request is sent, the request in flight is aborted, the model unloads, the lock is freed and the run exits 130 with no arm written. A second signal during the unload frees the lock and exits at once. The arm file carries `_model: {id, sha}` (the served model id and its snapshot sha, with a `warning` when the sha is missing).

Local output is a lead until a model is adopted in `docs/models.json`. Model free text never reaches a Claude session from the router. The copy grade is the one eval-only exception, and it needs a tool-less grader (deferred, see the pull request's `## Next`).
