# Local models (plan 1.19): routing and eval design, 14 Nov 2026

Fable reviewer, read-only. Desk accepted it at 02:00 ET and started PR 1.

## Findings that change the row
- Llama.app lists only the models already on the drive; during the redownload `/v1/models` showed 1. PR 1 proves itself on a stub; no eval table in its done-when.
- The generated preset runs `ctx-size 4096` and `sleep-idle-seconds 300`. A failed-step log won't fit. The harness reads ctx from the server and refuses over-length input. Raising ctx is a Llama.app preset change (`~/.config/llama/models.user.ini`).
- No ready ground truth: INCIDENTS files carry almost no run links. Labels come from GitHub itself (below).
- `.github` is public: private repos' logs and PR bodies can't be fixtures there. Fixtures go on the USB, the manifest in ops (private).
- 1.17's orphan finding is already deterministic (`scripts/lib/inventory.mjs`). Embeddings add only "nearest row for an orphan" and duplicate pairs.
- No measured split of what sessions read, so no "tokens saved" number yet. Step 0 measures it.
- 20 of 20 right still allows a true error near 14%: the bar licenses lead use only, never skipping a Claude read.
- MoE cuts compute, not RAM (26B about 28 GB resident, 35B about 37 GB): the fit rule is measured, file size plus 4 GB against free memory.

## Order
- Step 0: one `session-report` pass over 7 days, bytes read from `gh run view --log*`, images and inventories. If logs are a few percent, (a) drops too.
- (a) CI-log triage first, with a no-model arm. If the no-model arm is within 1 of Haiku, ship it and load no model.
- (b) embeddings, suggestions only, next PR on the same harness.
- Wait: (c) screenshot screening (needs about 60 known-bad images), (e) local runner tier (4096 ctx, tools behind an unevaluated model).
- Drop: (d) summary drafts (saves output only; PR bodies are editor work).

## Eval for (a)
- 20 failed runs from the last 90 days across BinderCurve, MoonMan, .github, heuristics: 10 real, 6 flake, 4 infra.
- Labels: flake = attempt 1 failed and a later attempt on the same sha passed; real = the next code commit went green (cause line labelled once by Sonnet from the fixing diff); infra = never started or runner lost.
- Collection: about 60 `gh` calls after `gh api rate_limit`. Bodies to `/Volumes/gorfkcits/evals/ci-triage/`, manifest to ops `docs/evals/ci-triage.json`.
- Same deterministic prefilter for every arm (each `##[error]` line with 5 either side, last 200 lines per failed step, 24,000 characters, line-numbered). Output JSON only: `{verdict, lines[≤10]}`.
- Arms: local model by id and sha, Haiku (a Haiku session spawning `scout`, frozen `baseline.json`, on the Max plan, never the API), no-model.
- Pass: verdict ≥ Haiku − 1 and ≥ 16; cause the same; dangerous misses (real called flake or infra) ≤ Haiku's; 20/20 schema-valid; median warm latency ≤ 60 s; cause ≥ no-model + 2.

## Routing and safety
- `local-llm pick <task>`: adopted (id, sha) from `docs/models.json`; server answers in 2 s; id present; sha matches; file exists; fits free memory; input fits ctx − 1,024; no other model loaded; lock taken (`mkdir` lock, exit 75 when held). Any failure exits 69 naming the link and "use the Claude tier".
- Unload on release; 180 s cold-load timeout off the USB.
- `local-llm queue` lists live models with no row; a changed sha counts as new. Evals only for named pairs.
- Model free text never reaches a Claude session: enum plus line numbers only. Fixed system message, delimited log, no tools, temperature 0, `max_tokens` 200. A `flake` verdict never authorises a rerun or label. Nothing in ship-bot, janitor or gates imports it.

## Build (PR 1)
- gorfednet/.github, about 380 lines: `scripts/local-llm/{client,route,eval}.mjs`, `tasks/ci-triage.mjs`, `test/localLlm.test.mjs` (node:http stub), `docs/models.json`, generated `docs/models.md`.
- Not in the verification kit (vendored into about 15 repos). Projects call it from PATH with `--tasks <dir>`; this is also the reusable pick step for future projects.
- Done when: stub tests cover every fail-closed link and the 75; the scorer rejects a constant arm and a no-model-equal arm; one guard watched failing; real `local-llm queue` output on the PR.
- Waits: fixtures, labels, baseline, the ctx preset, the session rule line, the weekly Hugging Face sha job, (b), (c), (e).

## Step 0 result and decision (14 Nov 2026, 08:17 ET)
- Measured by a Sonnet builder from 684 session transcripts modified in the 7 days to 14 Nov (tool-result characters, not tokens): `gh run view --log*` is 0.37% of all tool-result characters, about 1.2% without images. Images (base64) are 70.4%.
- Decision (Desk): task (a) CI-log triage is dropped, by this design's own rule ("if logs are a few percent, (a) drops too"). The 20-item manifest in ops `docs/evals/ci-triage.json` stays for a later eval if the share changes.
- Caution: base64 characters overstate images against tokens (an image costs a fixed token budget, not its byte size). Before (c) screenshot screening is chosen, step 0 is redone in tokens. Until then (c) and (b) stay waiting; no local model is adopted.
- Blocker found: this process gets "Operation not permitted" reading `/Volumes/gorfkcits/evals` (macOS removable-volume permission for the Claude helper). Any eval needing the USB bodies runs from a session the owner opens, or after he grants the permission.
