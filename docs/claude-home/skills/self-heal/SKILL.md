---
name: self-heal
description: Diagnose red CI and fix the cause, or bootstrap a repo's durable plan of record. Use when CI is failing, when a bug keeps coming back, or when a project has no committed backlog and open work only exists in chat sessions.
---

# Self-heal

Two jobs, one discipline: **find the cause, then leave behind the thing that stops it recurring.**

Ask which is wanted if it is not obvious from the request:

- **Triage** — CI is red, or a bug returned. Start at *Triage loop*.
- **Bootstrap** — the repo has no committed backlog. Start at *Bootstrap a plan of record*.

**First, check whether the repo has the shared kit.** If `verification-kit/`
exists, most of what follows is already a script — use it rather than
reimplementing it, and read `docs/verification-rules.md` (every `V` rule) before
writing a new guard, because the class has usually been named already. If the
kit is absent, the `verification-bootstrap` skill installs it; that is often the
right response to "this bug keeps coming back", since the answer is usually a
gate the project never had.

---

## Triage loop

### 0. Is the CI missing rather than failing?

Before triaging red, check that anything ran. A workflow that fails to *start*
produces no check runs, and `gh pr checks` lists check runs — so it prints
nothing, and the pull request reads as one with no CI configured rather than
one that is broken.

```bash
node verification-kit/bin/assert-checks-started.mjs --pr <number>
# no kit yet:
gh run list --branch <branch> --limit 5 --json conclusion,name  # look for startup_failure
```

Usual causes: an input the reusable workflow does not accept yet (common when a
shared-workflow change has not merged), invalid YAML, a missing secret named in
`uses:`. Shared rule V45.

### 1. Is this failure inherited?

Check the base branch before anything else.

```bash
gh run list --branch main --limit 5 --json conclusion,name,createdAt
```

If `main` is already failing the same job, **stop**. Every open PR is red for one reason. Fix the base; do not open one investigation per affected PR. Say so plainly and move to the base branch.

Check the timestamp against your own last merge. A base that went red *at* a merge you made is the strongest available clue about the cause, and it points at the change rather than at the branch you happen to be looking at. `gorfednet/.github`'s `main` went red at 03:49:39Z, the second the release adding a new gate merged, and the gate was failing on the entries that release had written.

### 1b. Did the failing step get its output from the step you think it did?

`gh run view <id> --log-failed` can return post-job cleanup noise rather than the failure. Get the step name from the API before reading any log, or you will diagnose the wrong step — twice in one session, a step whose script exits 0 when run verbatim was blamed for a job that failed three steps later.

```bash
gh api repos/<owner>/<repo>/actions/jobs/<job-id> --jq '.steps[]|select(.conclusion!="success")|.name'
```

### 2. Is it one cause or many?

```bash
gh run list --limit 100 --json conclusion,name,createdAt,headBranch \
  --jq '[.[] | select(.conclusion=="failure")] | group_by(.name) | map({name: .[0].name, count: length})'
```

Failure count is not problem count. Group by cause before estimating effort.

### 3. Reproduce before theorising

Get the failing step's actual output — `gh run view <id> --log-failed` — and reproduce locally. A theory that was never reproduced is a guess, and guesses here are expensive because the fix ships.

**Reproduce the invocation, not the command.** A gate whose behaviour depends on the environment takes a different code path in your shell than in CI, so running it by hand and seeing green is a different test, not a reproduction. Read the workflow and match it: `GITHUB_REF=refs/pull/<n>/merge` for anything that knows which pull request it is on, the same token scope, the same flags. A reconciler passed locally and failed in CI for exactly this reason, and the local pass was reported as verification before the mistake surfaced.

### 4. Fix the cause, not the red

This is the step that goes wrong. **Never** make a failing check pass by weakening it:

- raising a ratchet or budget
- widening a tolerance or timeout
- deleting or loosening an assertion
- refreshing a snapshot you have not looked at
- adding a skip without an expiry date

Each of these converts a signal into silence and reads as a fix in the log.

When a baseline genuinely must move, the commit that moves it explains why, in its message. When a check flags something that is legitimately out of its scope — a registry that names things it does not render, a fixture that must stay in English — **exempt the path with a comment stating the mechanism**, rather than absorbing it into the budget the project is trying to burn down.

Signals that the check is right and you are wrong:

- it passes on one branch and fails on five → not stale, nondeterministic; find the difference
- it started failing the moment you touched an unrelated file → you touched something load-bearing
- "just update the baseline" is the whole plan → you have not established a cause

Signals that the check is genuinely wrong — rarer, and worth separating from the above because the fix is different:

- it reports something that cannot be true (a consumer *ahead* of the source it vendors) → suspect the input, not the logic. A read through a CDN or any cache reports the cache; get an uncached second opinion before acting, and fail if you cannot get one.
- it fires on the legitimate neighbour of what it detects (`test.fail()` read as a flake, a rulebook section read as a rule number) → the matcher never had its negative case written down.
- it fails for a reason unrelated to what it guards (a hard-coded version in an assertion) → fix it anyway, and quickly. Every red build teaches somebody, and this one teaches that the check is noise.

### 5. Prove the fix can fail

Break the thing the guard protects. Watch it go red. Restore. Watch it go green. State that you did this and what you saw. An untested guard is decoration.

### 6. Record it

Every shipped bug is also a verification failure. Name the specific miss before
you close the item, then put the answer where it will be read again:

| The miss | Where it goes |
|---|---|
| No test covered the path | A test, in the same change as the fix |
| A test covered it and passed anyway | Fix the assertion, then prove it can fail |
| A check could not fail (soft-fail, report mode, empty selection) | A lint rule, plus something that proves the rule works |
| A check failed unreadably or silently | A standing rule wherever the project keeps them |
| A hand-maintained list drifted | Derive it, or add a sync check against its source |
| An agent clobbered work or skipped a gate | A rule in `~/.claude/rules/` or the repository's `.claude/rules/`: behaviour that must be remembered will not be |

Then ask whether the defect is a **shape** rather than an instance. Grep for it.
If the count is small, fix them all; if it is large, add a shrink-only baseline
so it cannot grow while you burn it down. A fix that only repairs today's
instance guarantees tomorrow's.

If a premise turned out wrong, correct the record rather than closing it
quietly. A backlog holding only confirmed findings teaches nothing about how
findings get misread, and misreadings are most of what a triage loop produces.

Then update the plan of record (below) so the next session starts from what you learned.

---

## Bootstrap a plan of record

Symptom: open work exists only in chat sessions, or in a doc that nobody updates. Both rot silently — a stale doc still reads as authoritative, which is worse than no doc.

### The shape

A committed, typed registry plus a test that fails when it drifts. Adapt naming to the repo's conventions; the properties matter, not the syntax.

```ts
export type BacklogEntry = {
  readonly id: string
  readonly title: string
  readonly status: 'confirmed-bug' | 'suspected' | 'in-review' | 'landed' | 'declined'
  readonly assignee: string      // which model or agent does this
  readonly userSymptom: string   // what a user notices, in their words
  readonly evidence: string      // file:line, run URL, or a measurement
  readonly pr?: number
  readonly reviewBy?: string     // YYYY-MM-DD, for anything deferred
}
```

`userSymptom` is the load-bearing field. An item nobody can describe a symptom for is a preference, not a bug, and should compete on those terms.

### The gate

Without this it is just a doc. The test must fail when:

- an entry has no real symptom or evidence
- an item claims `in-review` or `landed` with no PR
- a `reviewBy` date has passed — the same expiry discipline a good test-quarantine uses, so deferral stays a decision rather than a drift

### The status renderer

A script that imports the registry **directly** (not a generated copy, which can describe a backlog that no longer exists), renders it against live `gh` state, and exits non-zero on contradiction: an entry claiming landed whose PR never merged, or claiming review on one that closed.

Make network failure return "unknown", never "contradiction" — otherwise a blip marks healthy entries broken.

Reference implementation: `bindercurve.com` → `src/lib/planning/backlogRegistry.ts`, its test, and `scripts/plan-status.ts`.

For a project with no TypeScript to compile it with — which is most of the
fleet — the same rules ship as JSON plus a plain-node validator:
`verification-kit/bin/check-backlog.mjs`. Copy
`verification-kit/templates/backlog.json` and delete the example entry. Do not
hand-roll a third shape.

---

## The fleet

Fifteen projects share this discipline. `gorfednet/.github` holds the canonical
kit, the shared rules, the reusable workflows, and `FLEET.md` — every project
with its archetype, adoption tier, owner and last-verified date. Its own check
fails a project claiming a tier it does not meet, because the registry is a
list, and every list gets a gate.

Three things follow from that when triaging:

- **A cause that is not specific to this repo belongs upstream.** Fix it in
  `gorfednet/.github`, let the drift check pull it into the others, and record
  it as a `V` rule. A fix that lands in one of fifteen copies is a fix the other
  fourteen will rediscover.
- **A copied kit file edited locally is a finding, not a fix.** `check-kit-drift`
  will say so. Upstream it, or move the change outside `verification-kit/`.
- **When the same red appears across several projects at once**, suspect the
  shared layer — a reusable workflow, an action pinned to `@main`, or a runner
  image — before opening one investigation per repo. Do not fire on inherited
  failures, at fleet scale as much as at branch scale.

---

## The recurring defect, stated once

Almost every incident this skill exists for is **a hand-maintained list that nothing verifies**. It keeps reading as authoritative long after it stopped being true.

Real examples: a grep-selected CI gate that silently ran zero tests; a monitor that restored a probe script without its newly-added helper and killed production monitoring for weeks; a spec registry whose header said 18 while its list held 17.

So: **whenever you add a list — specs, routes, restored files, allowed paths, backlog items — add the check that fails when it drifts, in the same change.** Not as follow-up work.
