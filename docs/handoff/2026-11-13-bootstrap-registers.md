# Handoff: bootstrap registers (plan row 5.6), 13 November 2026

- `scripts/register-repo.mjs` shipped in .github 162. `gorfednet/scratch-bootstrap-5-6` is the end-to-end proof.
- Left: the skill text. `docs/claude-home/` arrives with .github 153, which waits on 2 review findings. Once 153 merges, copy the text below to `docs/claude-home/skills/verification-bootstrap/SKILL.md` in a new pull request, and to the live `~/.claude/skills/verification-bootstrap/SKILL.md` once that merges. It also fixes a real gap: the old install step never copied `docs/content-guidelines.md`, so `check-kit-drift` failed on a fresh install.
- Left: STATUS.md should list the scratch repo after the next fleet-status run (14 November 01:30 ET). Deleting the scratch repo, and dropping its rows, is the owner's call.

## The skill text

````markdown
---
name: verification-bootstrap
description: Install the shared verification kit into a project at the right adoption tier and register it with the fleet in one run, or create a new project with both done. Use when a repo has no verification-kit/ directory, when asked to add verification, gates, a backlog, or CI checks to a project, or when starting a project from scratch.
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
| 3 | A real test suite, ideally sharded | Tier 2, plus mutation canaries against its own gates |

Every tier gets the Claude reviewer (`claude-review.yml`, `REVIEW.md`) from step 5.

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
cp /tmp/org-github/docs/content-guidelines.md docs/content-guidelines.md
printf '\n.mutation-canary-dirty.json\n' >> .gitignore
```

Then confirm it runs before wiring anything:

```bash
node verification-kit/bin/check-kit-drift.mjs
node verification-kit/bin/check-tracked-artifacts.mjs
node verification-kit/bin/check-backlog.mjs
node verification-kit/bin/check-rule-citations.mjs
```

Run them again after step 5, which writes `docs/backlog.json`. Expect
`check-backlog` and `check-tracked-artifacts` to fail on first run in a
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

## 5. Register the project everywhere, in one run

From a `gorfednet/.github` clone on a fresh branch (plan row 5.6):

```bash
node scripts/register-repo.mjs --slug gorfednet/<name> --repo-dir <clone> \
  --ops-dir <ops clone on a fresh branch> --archetype <a> --tier <n> \
  --monitor-class <c> --summary "<one line>" --priority <1-6> \
  --expected-checks "check / check"
```

Add `--dry-run` first to see the list. It never overwrites a file the project
already has, and it refuses a slug either register already holds. It writes:

- In the project: `.github/workflows/claude-review.yml`, `REVIEW.md`,
  `CLAUDE.md` with the plan-of-record pointer and the handoff rules, and an
  empty `docs/backlog.json`. Fill in `REVIEW.md`'s house rules by hand.
- In `gorfednet/.github`: the `fleet.json` entry (which is also what puts the
  project in fleet-status and STATUS.md), the ship-bot row in
  `config.example.json`, a patch under `ship-bot/patches/` that adds the same
  row to the live config, and a regenerated `FLEET.md`.
- In ops: a queued Herdr job for the first triage pass, and the project's tab
  in `herdr-spaces`.

The ship-bot row starts merge-only and not live. Deploy steps come in a later
patch. Being in ship-bot's list is what makes the project eligible for the
headless starter, so the patch is the step that joins it to the loop.
Ship-bot's own tests pin the repository list on purpose: add the new row to
the modes in `ship-bot/test/config.test.mjs` and raise the count in
`ship-bot/test/support.test.mjs` in the same pull request.

Open one pull request in `gorfednet/.github` and one in ops, each with a
`## Next`. The script prints the lines the owner needs: a pool token, the
`CLAUDE_CODE_OAUTH_TOKEN` secret, the patch to apply with `patch-config.mjs`
once the pull request merges, the `FLEET_READ_TOKEN` scope, and opening the
folder once in Claude Code so the Herdr job can start. Give each one to him in
the chat when it is his next step, never before.

Then triage what the checks in step 2 found into the backlog, each entry with
a symptom in the user's words and evidence that is a citation, not a hunch.
Never hand-edit `FLEET.md`: it is generated. A registry nothing updates
becomes fiction, so its own check fails a project claiming a tier it does not
meet.

## For a project that does not exist yet

Same order, earlier: `gh repo create gorfednet/<name> --private`, `git init`,
the install step above, CI from step 3, the registration in step 5, then the
first real commit. Starting with the kit means the first CI run is already honest, and
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
````
