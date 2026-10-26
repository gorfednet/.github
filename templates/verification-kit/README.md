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
| `bin/check-ci-headroom.mjs` | A job quietly growing into its `timeout-minutes`. Green until it is not, and then it lands on an unrelated PR. |
| `bin/assert-checks-started.mjs` | A pull request whose CI failed to *start*. That produces no check runs, so `gh pr checks` shows nothing at all and it reads as a repo with no CI. Also a run whose jobs failed without running a step (GitHub refusing jobs while an account's payment fails), which reads as a broken branch nobody tested. |
| `bin/check-backlog.mjs` | The plan of record decaying into prose nobody validates. |
| `bin/check-rule-citations.mjs` | A code comment citing a rule number that has moved, or no longer exists. |
| `bin/check-tracked-artifacts.mjs` | Generated files reaching `main` under an ignore rule that does not cover them. |
| `bin/check-kit-drift.mjs` | This copy of the kit silently falling behind the canonical one, or being edited in place. |
| `bin/mutation-canary.mjs` | A guard nobody has ever seen fail being counted as coverage. |
| `bin/check-voice.mjs` | Copy drifting back to praise-then-pivot summaries, software metaphors, "delivers value" and "Learn more" links. Enforces the checkable half of [`docs/content-guidelines.md`](../../docs/content-guidelines.md). |

The checks that ask GitHub about a repository (`assert-checks-started`,
`check-ci-headroom`, `check-backlog --verify-prs`) take it from `--repo owner/name`, then `GITHUB_REPOSITORY`, then the origin of the
clone they run in, and print which one they used as their first line on stderr.
An argument they do not recognise is an error rather than ignored: a dropped
`--repo=…` used to fall back to the clone's origin and report another
repository's pull request under the number asked about.

## Install

Copy `verification-kit/` into the project, commit it, and wire the checks into
whatever the project already runs. There is no installer, because half the
fleet has nothing to install with.

```sh
cp -R templates/verification-kit ./verification-kit
cp verification-kit/templates/backlog.json docs/backlog.json
cp verification-kit/templates/canaries.json ./canaries.json   # tier 3 only
cp docs/verification-rules.md docs/verification-rules.md      # from gorfednet/.github
cp docs/content-guidelines.md docs/content-guidelines.md      # from gorfednet/.github
```

## Adoption tiers

- **Tier 1**: the vendored kit, `docs/backlog.json`, the drift check, and
  `check-voice` in every repository with user-facing copy (a site, an app, a
  published report). A tool with no visitor-facing text skips `check-voice`.
- **Tier 2**: tier 1 plus `assert-tests-executed` on every test job.
- **Tier 3**: tier 2 plus `canaries.json` run by `mutation-canary`.

`scripts/check-fleet.mjs` asks for the files each tier requires; it does not
yet ask whether `check-voice` is wired, because that is a line in a workflow or
a test script rather than a file, and the fleet adopts it repository by
repository first.

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
resolvable. A citation is a number on the same line as the word "rule", so
prose that ends a sentence in "rules" above a line beginning with a digit is not
one.

## Voice

`check-voice.mjs` reads what a visitor reads and fails on the phrase lists in
rules 4, 6, 8, 9 and 10 of [`docs/content-guidelines.md`](../../docs/content-guidelines.md),
on "Learn more", "Click here", "Get started" and "Read more" as link or button
text, on a summary over four sentences, and on the praise-then-pivot summary
(a first sentence of eight words or fewer with no digit, then one beginning
The, Its, Where or What). Rule 10's tics are allowed once per file and never
in a summary or heading.

```sh
npm run build && node verification-kit/bin/check-voice.mjs          # dist/ or build/ HTML
node verification-kit/bin/check-voice.mjs 'src/content/locales/*.ts' 'content/*.json' \
  --allow voice-allow.json --allow-shrinks verification-kit/state/voice-allow.json
node verification-kit/bin/check-voice.mjs README.md 'docs/**/*.md' --term Door   # a spec repository
```

Markdown is read as a document: each paragraph, heading, list item, table cell
and blockquote line is one string, located as `L<line>`. Fenced code blocks and
inline code are skipped, link text is read and its URL is not, and front matter
is read as key/value pairs. A paragraph under a heading that says Summary or
Abstract is held to the summary rules.

`--term <word>` (repeatable) exempts a word a specification uses as a defined
term, such as a field called "Door". It is case-sensitive and word-bounded:
`--term Door` exempts "the Door field" and still fails "every door" and
"Doors". The phrase lists themselves do not change, so a repository that
names its fields after a metaphor says so on its command line.

The phrase lists match a hyphenated "let-down" (the noun) never and an
unhyphenated "a let down" always: the lint cannot tell that noun from the verb,
and the plain rewrite is better either way. "stray" matches the bare word only,
not "astray" or "strayed".

A glob that matches nothing fails (V2). `--exclude <glob>` (repeatable) drops
files from every glob's matches before that check, so a glob whose every match
is excluded still fails, and so does an exclude that removed nothing:

```sh
node verification-kit/bin/check-voice.mjs 'dist/**/*.html' --exclude 'dist/admin/**'
```

**Language.** The phrase lists are English, and "door" is Dutch for "through".
A file's language is, first match wins: a `--lang-map '<glob>=<lang>'` entry
(repeatable), the `lang` on an HTML file's `<html>`, a locale code in its path
(`dist/nl/…`, `locales/nl.ts`, `index.nl.html`, `locales/pt-BR/…`), else
English. Only ISO 639-1 codes count, with a script or region in its registered
case (`zh-Hant`, `pt-BR`), so `dist/js/` and `no-js.html` stay English. A
non-English file skips rules 4, 6, 8, 9 and 10 and is still held to the summary
length, the pivot shape and link labels read by key. Every run prints how many
files it read as not English and why, so a path that reads as a locale by
accident is visible.

```sh
node verification-kit/bin/check-voice.mjs 'content/**/*.md' --lang-map 'content/handbuch/**=de'
```

**Quotation.** Text inside double quotes, straight or curly, or curly single
quotes is exempt: it is the site's own label being quoted. Straight single
quotes are not, because they are also apostrophes. Quoted blocks are exempt
the same way, because a client's recommendation is the client's words: in HTML
the text inside `<blockquote>`, `<q>` and any element whose class or role
contains "quote" or "testimonial" is not read; in JSON, TS/JS and front matter
a string whose own key matches /quote|passage|pull|testimonial|recommendation/i
skips the phrase lists (`recommendations[0].passage` does,
`recommendations[0].note` does not). A Markdown `>` line is still read: in a
README it is usually the author's own note.

**Allowlist.** A JSON array of `{match, where, reason, reviewBy}`; a lapsed
`reviewBy` warns and never fails (V5), and an entry that allowed nothing warns.
`--allow-shrinks <previous>` fails on any entry the previous list did not have,
so the list only shrinks. `--shrinks-only` runs that comparison alone, reading
no content. A repository wires the previous list one of two ways:

- From main, in CI. A caller of `pr-check-static` sets `voice-allow-shrinks: true`
  (and `voice-allowlist:` when the list is not `voice-allow.json` at the root).
  The workflow fetches `origin/main`, compares `git show origin/main:<list>` with
  the pull request's list, and passes with a note when main has no list yet or
  the branch removed it; it fails when neither side has the file. A pull request
  is checked out merged with main, so an entry main has since removed does not
  read as growth. Another workflow does the same by hand:

  ```sh
  git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main
  git show origin/main:voice-allow.json > "$RUNNER_TEMP/voice-allow.main.json"
  node verification-kit/bin/check-voice.mjs --allow voice-allow.json \
    --allow-shrinks "$RUNNER_TEMP/voice-allow.main.json" --shrinks-only
  ```

- From a committed copy, offline. Keep the list as of the last release in
  `verification-kit/state/voice-allow.json` (the kit's drift check, manifest and
  refresh leave `state/` alone; it is the project's) and copy the list over it
  as a release step. The test suite then runs
  `--allow voice-allow.json --allow-shrinks verification-kit/state/voice-allow.json`,
  which needs no network and no git history.

## Backlog

`check-backlog.mjs` validates the schema, including that each `reviewBy` is a
`YYYY-MM-DD` date, and fails on any problem with it. A `reviewBy` that has
passed is printed as a warning and never fails the run, because a pull request
cannot change the date; the scheduled fleet audit lists lapsed dates per
repository until someone renews or closes each one. Pass `--verify-prs`
where a token is available and it also asks GitHub whether each entry is true:
an entry saying `in-review` against a merged pull request, `landed` against an
open one, or either against a number that does not exist. It needs `--repo
owner/name`, distinguishes a missing pull request from a repository the token
cannot see, and when GitHub is unreachable it says how many entries it skipped
rather than passing quietly.

Then, in CI, after whatever step produces a test report:

```yaml
- name: Assert this job actually ran its tests
  # Rule 36: without this the assertion is skipped by an unrelated earlier
  # failure, which is precisely when you most need it to speak up.
  if: ${{ !cancelled() }}
  run: node verification-kit/bin/assert-tests-executed.mjs --report results.json --min 12
```

Pick `--min` from what the job runs today, minus nothing. A floor set below the
real count tolerates exactly the silent decay it is meant to catch. A floor of
`1` is not a floor: it is satisfied by the one test that still runs.

If the report is Playwright's, this also names any test that failed and passed
on a retry, which the exit code hides and the summary reduces to a count
(rule 58). Add `--max-flaky <n>` to make that a budget the job enforces rather
than a line somebody has to read.

## Staying current

The kit is distributed by copying, because a project with no package manager
has no other mechanism. Copying has exactly one failure mode, and it is this
repository's own thesis turned inward: fifteen copies drift apart one fix at a
time, every one of them still printing ticks.

```sh
node verification-kit/bin/check-kit-drift.mjs   # in CI, on every run
node verification-kit/bin/refresh-kit.mjs       # what a drift failure tells you to run
```

It reports three different situations, because the responses differ
(rule 56). **Edited here** means someone changed a copied file, and **fails**:
upstream it, or move the change into a project-local script outside
`verification-kit/`. **One release behind** **warns and exits 0** — every named
file is a fix or a rule this project is not getting, so read the upstream commit,
but a routine refresh should not stop unrelated work. **More than one minor
release behind** fails again, and so does being behind at all once the tolerance
expires on 2026-12-15, because an undated leniency becomes permanent by accident.
Being *ahead* of canonical fails too: it means the kit was edited here and
version-bumped, which the hash comparison alone would read as staleness.

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
