---
name: verification-bootstrap
description: Install the shared verification kit into a project at the right adoption tier, or create a new project with it already wired. Use when a repo has no verification-kit/ directory, when asked to add verification, gates, a backlog, or CI checks to a project, or when starting a project from scratch.
---

# Verification bootstrap

Install the fleet's verification baseline into a project. The kit runs on plain
node with no dependencies and no `package.json`, because most of this fleet is
static sites and a kit that needs a toolchain is a kit those projects never get.

Canonical source: `gorfednet/.github` → `templates/verification-kit/`.
Rules: `docs/verification-rules.md` (`V1`…`V38`).

## 1. Pick the tier honestly

The tier is what the project can actually run **today**, not what it should run.
A project claiming a tier it does not meet is the fiction the registry exists to
prevent, and the registry check will fail it.

| Tier | The project has | It gets |
|---|---|---|
| 1 | No `package.json`, no tests | Drift check, tracked-artifacts check, backlog, rules |
| 2 | A build or a test runner that is not npm | Tier 1, plus the executed-count assertion wired to whatever produces a report |
| 3 | A real test suite, ideally sharded | Tier 2, plus mutation canaries against its own gates, plus the Claude reviewer (`claude-review.yml`, `REVIEW.md`) |

Tier 2 means the floor **executes**, not that a floor is configured. Passing
`min-tests` to a shared workflow whose step runs `if: inputs.test-report != ''`
configures a step that never runs, and reads in the diff exactly like one that
does. Five projects claimed tier 2 in that state. Measure the floor from a real
green run and confirm the assertion appears in the job log before claiming it.

Do not skip Tier 1 on a small project on the grounds that there is nothing to
check. The `.gitignore` truth check found 548 committed cache blobs in a repo
whose reviewers had scrolled past them twice.

## 2. Install

```bash
git clone --depth 1 https://github.com/gorfednet/.github /tmp/org-github
cp -R /tmp/org-github/templates/verification-kit ./verification-kit
cp /tmp/org-github/docs/verification-rules.md docs/verification-rules.md
cp verification-kit/templates/backlog.json docs/backlog.json
printf '\n.mutation-canary-dirty.json\n' >> .gitignore
```

Then confirm it runs before wiring anything:

```bash
node verification-kit/bin/check-kit-drift.mjs
node verification-kit/bin/check-tracked-artifacts.mjs
node verification-kit/bin/check-backlog.mjs
node verification-kit/bin/check-rule-citations.mjs
```

Expect `check-backlog` and `check-tracked-artifacts` to fail on first run in a
real project. That is the point — triage what they found before silencing them.

Run all four **before** wiring them, and again after, because a check that is
vendored and never invoked is not a check. bindercurve.com — the repository the
kit was written in — vendored `check-rule-citations` and `check-kit-drift` and ran
neither, which is how its copy went from v0.12.0 to v0.25.0 with nothing saying
so, and how a latent false positive sat waiting for whoever wired it first. When
one of these fails on first run in a repository that has never run it, suspect the
check before the code: that is where two matcher bugs were found.

## 3. Wire CI

If the project already uses a shared workflow, the gate comes with it. Upgrade
the `uses:` line and pass the inputs:

```yaml
uses: gorfednet/.github/.github/workflows/pr-check-static.yml@main
with:
  test-report: ""        # Tier 1: no report to assert against
  min-tests: "1"
```

Tier 2 and 3 point `test-report` at the JSON their runner emits and set
`min-tests` to what the job runs **today**, minus nothing. A floor set below the
real count tolerates exactly the silent decay it is meant to catch.

If the project has its own bespoke workflow, add the composite action directly:

```yaml
- name: Verification gate
  if: ${{ !cancelled() }}
  uses: gorfednet/.github/.github/actions/verification-gate@main
```

The `if:` is not optional. GitHub defaults a step to `success()`, so an
unrelated earlier failure switches the gate off at the moment it matters.

A project that publishes a website also runs the two halves of V77 (added
12 November 2026, after Search Console flagged soft 404s on gorfmusic.com and a
fleet probe found the same class on six more sites):

- Per PR, against the build: `node verification-kit/bin/check-sitemap-pages.mjs
  --root dist --origin https://<site>`. Every sitemap URL must be a
  self-canonical, indexable, substantive page in the slash form nginx serves.
- On a schedule: the shared `production-healthcheck.yml` caller with
  `error-page-marker`, `expect-sitemap: true`, `expect-www-redirect: true` (if
  the site has www) and `expect-error-pages-hidden: true`. The vhost needs a
  redirect-only www block and `location = /404.html { internal; }`.

## 4. Tier 3 only: canaries

Two or three, against the project's **real** gates, not against toy code. Each
names the guard it proves and the edit that should break it:

```json
{
  "id": "auth-expiry-check-can-fail",
  "guards": "The session test notices when the expiry check is removed.",
  "command": "npm run test:auth",
  "file": "src/auth.ts",
  "find": "if (session.expiresAt < now)",
  "replace": "if (false)"
}
```

Run `node verification-kit/bin/mutation-canary.mjs --file canaries.json`. A
`NOT CAUGHT` is a finding — record it in the backlog rather than deleting the
canary.

## 5. Seed the backlog, and register the project

Delete the example entry. Add whatever the checks above surfaced, each with a
symptom in the user's words and evidence that is a citation rather than a hunch.

Then add the project to `fleet.json` in `gorfednet/.github` with its archetype,
tier, owner and today's date, and run `node scripts/write-fleet-md.mjs`. Never
hand-edit `FLEET.md`: it is generated. A registry nothing updates becomes fiction, so its
own check fails a project claiming a tier it does not meet.

## For a project that does not exist yet

Same order, earlier: `git init`, the install step above, then the first real
commit. Starting with the kit means the first CI run is already honest, and
avoids the much harder job of retrofitting gates onto code that has learned to
pass without them.

## What not to do

- Do not write a one-off version of a check the kit already has. That is a
  fourteenth copy nothing checks, and the drift gate cannot see it.
- Do not edit files inside `verification-kit/`. The drift check will fail, and
  it is right to: a local fix is a fix fourteen other projects will not get.
  Upstream it, or put the change in a project-local script outside the kit.
- Do not set `min-tests` to 1 on a project that runs 200. The floor is a
  ratchet, and a floor of 1 is the same as no floor.
- Do not claim a tier to make the registry look better.
