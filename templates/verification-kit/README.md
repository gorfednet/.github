# Verification kit

Five plain-node checks that stop a green build from lying to you.

Every one of them exists because the corresponding failure actually happened,
and in each case the symptom was silence rather than an error: a CI job that
ran nine specs and executed none of them, a review bot whose findings printed
in the same bucket as a clean pass, 548 cache blobs committed to `main` under
an ignore rule that did not cover them.

## Constraints this kit is built to

- **Plain node, no dependencies, no `package.json` required.** Several projects
  in the fleet are static sites with no npm at all. A kit that needs a
  toolchain is a kit those projects never get.
- **Every check fails closed.** A missing report, an unreadable manifest, an
  API error, an empty file list — each of these is the condition the check
  exists to catch, so none of them may exit 0.
- **Nothing is trusted until it has been watched failing.** `canaries.json`
  holds the proof, and it runs in CI.

## What is in it

| File | What it refuses to let happen |
|---|---|
| `bin/assert-tests-executed.mjs` | A test job reporting success while executing zero tests. Reads Playwright and Vitest JSON. |
| `bin/bugbot-review-status.mjs` | Merging on a Bugbot `NEUTRAL` that actually means *reviewed, and found things*. |
| `bin/check-backlog.mjs` | The plan of record decaying into prose nobody validates. |
| `bin/check-rule-citations.mjs` | A code comment citing a rule number that has moved, or no longer exists. |
| `bin/check-tracked-artifacts.mjs` | Generated files reaching `main` under an ignore rule that does not cover them. |
| `bin/check-kit-drift.mjs` | This copy of the kit silently falling behind the canonical one, or being edited in place. |
| `bin/mutation-canary.mjs` | A guard nobody has ever seen fail being counted as coverage. |

## Install

Copy `verification-kit/` into the project, commit it, and wire the checks into
whatever the project already runs. There is no installer, because half the
fleet has nothing to install with.

```sh
cp -R templates/verification-kit ./verification-kit
cp verification-kit/templates/backlog.json docs/backlog.json
cp verification-kit/templates/canaries.json ./canaries.json   # tier 3 only
cp docs/verification-rules.md docs/verification-rules.md      # from gorfednet/.github
```

The kit directory is **only** canonical files plus `templates/`. Your backlog
and your canaries live outside it, at the paths above. This is not tidiness:
the kit is copied wholesale, so anything you leave inside it travels to the
next project that adopts. It has happened once already, which is why
`check-kit-drift` now reports any unmanifested file in there as drift.

## Rules, and adding your own

[`docs/verification-rules.md`](../../docs/verification-rules.md) holds the
shared rules as `V1`…`Vn`. It is **append-only**: those numbers are cited from
code in other repositories, so renumbering dangles someone else's comment.

A project's own rules go in `docs/verification-rules.local.md` under a prefix
it picks once — `**BC-1. …**`, `**4C-1. …**`. Local numbering can never collide
with the shared sequence, so you never have to negotiate with the fleet to
write down something you learned this morning. When a local rule turns out to
be true of a second project, add a `V` entry that cites it; the local rule
stays where it is so its citations keep resolving.

`check-rule-citations.mjs` holds both sequences gapless and every citation
resolvable.

Then, in CI, after whatever step produces a test report:

```yaml
- name: Assert this job actually ran its tests
  # Rule 36: without this the assertion is skipped by an unrelated earlier
  # failure, which is precisely when you most need it to speak up.
  if: ${{ !cancelled() }}
  run: node verification-kit/bin/assert-tests-executed.mjs --report results.json --min 12
```

Pick `--min` from what the job runs today, minus nothing. A floor set below the
real count tolerates exactly the silent decay it is meant to catch.

## Staying current

The kit is distributed by copying, because a project with no package manager
has no other mechanism. Copying has exactly one failure mode, and it is this
repository's own thesis turned inward: fifteen copies drift apart one fix at a
time, every one of them still printing ticks.

```sh
node verification-kit/bin/check-kit-drift.mjs   # in CI, on every run
node verification-kit/bin/refresh-kit.mjs       # what a drift failure tells you to run
```

It reports two different problems, because the fixes differ. **Edited here**
means someone changed a copied file: upstream it, or move the change into a
project-local script outside `verification-kit/`. **Stale** means upstream
moved, and every named file is a fix or a rule this project is not getting —
read the upstream commit, because a kit change usually means a new class of bug
was found somewhere else in the fleet.

Local integrity is checked without a network. Staleness needs one, and **fails
closed** when it cannot reach the canonical manifest: a check that reports
"current" when it could not look is the failure this kit exists to find. If a
run genuinely has no network, pass `--offline`, which says so in its output
rather than printing the same tick.

`canaries.json` and `templates/` are deliberately outside the manifest. A
project's canaries are its own — holding them to a canonical hash would put
every project in permanent drift.

## Adding a canary

Describe the edit that should break a guard, and what the guard is credited
with:

```json
{
  "id": "auth-check-can-fail",
  "guards": "The session test notices when the expiry check is removed.",
  "command": "npm run test:auth",
  "file": "src/auth.ts",
  "find": "if (session.expiresAt < now)",
  "replace": "if (false)"
}
```

The anchor must appear exactly once. Zero matches mutates nothing and the
canary passes for the wrong reason; the runner treats both as a failure.

The runner writes `.mutation-canary-dirty.json` before mutating and reverts
from it on the next start. It blocks on a synchronous child process, so a
SIGKILL lands with a deliberately broken file on disk and no handler able to
run — the record on disk is the only thing that can undo it. Add that filename
to `.gitignore`.

## Running the kit's own tests

```sh
node --test 'verification-kit/test/*.test.mjs'
node verification-kit/bin/mutation-canary.mjs --file canaries.json
```

A defect in a template replicates into every project that copied it, so this
repository runs both on every pull request.
