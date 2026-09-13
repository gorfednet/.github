#!/usr/bin/env node
/**
 * Write the canonical manifest for the kit. Run in gorfednet/.github only.
 *
 * The manifest is what makes a copied file checkable. Without it, fifteen
 * copies of the same script drift apart one bug fix at a time and nothing
 * anywhere notices — which is the failure the kit was built to stop,
 * reproduced by the kit's own distribution model.
 *
 * Usage:
 *   node templates/verification-kit/bin/write-manifest.mjs [--check]
 *
 * `--check` writes nothing and exits non-zero if the manifest on disk is out
 * of date, which is how CI stops a kit change from merging without one.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from '../lib/isMain.mjs'

const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = join(KIT_ROOT, 'MANIFEST.json')

/**
 * The manifest describes out itself, and the `templates/` starters a project
 * copies and then edits.
 *
 * Nothing else. A project's own canaries live at the repository root, outside
 * this directory, because the kit directory having one writable slot is what
 * let this repository's canary manifest ride along inside the copied tree — a
 * consuming project vendored nineteen canaries against files it did not have,
 * and the drift check waved it through as expected-to-differ. Anything found
 * in here that the manifest does not name is now drift.
 */
const NOT_TRACKED = new Set(['MANIFEST.json'])
const NOT_TRACKED_DIRS = new Set(['templates'])

/*
 * Files the kit distributes that do not live inside the kit directory, relative
 * to the repository root.
 *
 * `docs/verification-rules.md` is the shared rules document, cited from code in
 * every project, and the manifest never named it because it is not a kit file.
 * So nothing compared it, and one project's copy carried two rules canonical did
 * not have — numbered in the shared sequence, which the next fleet rule then
 * collided with — while its drift check printed a tick.
 */
const COMPANIONS = ['docs/verification-rules.md']

/**
 * The repository root, for the two layouts this file ever runs in.
 *
 * Canonically the kit sits at `templates/verification-kit/`, so the root is two
 * levels up. In a consuming project it sits at `verification-kit/`, so it is one.
 * A single `../..` fits only the first, and the v0.31.0 companion work shipped
 * with it — so `write-manifest --check`, which the kit's own test suite runs,
 * threw in every consuming project, looking for `docs/verification-rules.md` in
 * the directory *above* the project. Upstream CI could not see it: there, the
 * formula is correct.
 *
 * Decided by layout rather than by a flag, because a flag is a thing fifteen
 * projects have to pass correctly and this is knowable from the path.
 */
export function resolveRepoRoot(kitRoot = KIT_ROOT) {
  const parent = join(kitRoot, '..')
  return basename(parent) === 'templates' ? join(parent, '..') : parent
}

const REPO_ROOT = resolveRepoRoot()

export function kitFiles(root = KIT_ROOT) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      const rel = relative(root, path).split(sep).join('/')
      if (NOT_TRACKED.has(rel) || NOT_TRACKED_DIRS.has(rel)) continue
      if (statSync(path).isDirectory()) walk(path)
      else found.push(rel)
    }
  }
  walk(root)
  return found
}

export function hashFile(path) {
  // Hash the bytes, not a normalized form. A CRLF checkout is a real
  // difference: it is what the consuming project will actually execute.
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function buildManifest(root = KIT_ROOT, version, repoRoot = resolveRepoRoot(root)) {
  const files = {}
  for (const rel of kitFiles(root)) files[rel] = hashFile(join(root, rel))
  const companions = {}
  for (const rel of COMPANIONS) {
    const path = join(repoRoot, rel)
    if (!existsSync(path)) {
      // Fail rather than omit. A companion silently dropped from the manifest is
      // a document the whole fleet stops comparing, and the omission looks
      // exactly like a fleet that has nothing to compare.
      throw new Error(
        `write-manifest: ${rel} is named as a shared document but is not at ${path}. ` +
          'Either it moved, in which case update COMPANIONS, or this is not being run ' +
          'from gorfednet/.github.',
      )
    }
    companions[rel] = hashFile(path)
  }
  return { version, files, companions }
}

if (isMain(import.meta.url)) {
  const checkOnly = process.argv.includes('--check')

  let previous = { version: '0.0.0', files: {} }
  try {
    previous = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  } catch {
    if (checkOnly) {
      console.error('\n✗ MANIFEST.json is missing or unreadable. Run write-manifest.mjs.\n')
      process.exit(1)
    }
  }

  const built = buildManifest(KIT_ROOT, previous.version)
  // A companion's content changing is a change consumers must act on, exactly
  // like a kit file's: the shared rules document is the thing they cite from
  // code. Leaving it out of this comparison would have let a rule be added
  // upstream with no version bump, which the drift check reads as two copies
  // claiming one version — a failure in every consumer, for a reason none of
  // them caused.
  const changed =
    JSON.stringify(built.files) !== JSON.stringify(previous.files ?? {}) ||
    JSON.stringify(built.companions) !== JSON.stringify(previous.companions ?? {})

  if (checkOnly) {
    if (!changed) {
      console.log(`✓ MANIFEST.json matches ${Object.keys(built.files).length} kit file(s)`)
      process.exit(0)
    }
    const added = Object.keys(built.files).filter((f) => !(f in (previous.files ?? {})))
    const removed = Object.keys(previous.files ?? {}).filter((f) => !(f in built.files))
    const edited = Object.keys(built.files).filter(
      (f) => f in (previous.files ?? {}) && built.files[f] !== previous.files[f],
    )
    console.error(
      '\n✗ MANIFEST.json is out of date.\n\n' +
        [...added.map((f) => `  + ${f}`), ...removed.map((f) => `  - ${f}`), ...edited.map((f) => `  ~ ${f}`)].join('\n') +
        '\n\n  A kit change that ships without a manifest update leaves every consuming\n' +
        '  project unable to tell a stale copy from a current one.\n\n' +
        '  Refresh it, and bump the version if consumers must act:\n' +
        '    node templates/verification-kit/bin/write-manifest.mjs\n',
    )
    process.exit(1)
  }

  /*
   * A content change consumers have to notice is a version bump, so the drift
   * check can say "you are two versions behind" rather than only "different".
   *
   * `--version` exists because the automatic bump is per *run*, not per release,
   * and one change is often written over several runs. Three runs while
   * finishing v0.27.0 published v0.29.0, and that is not cosmetic: the drift
   * checker fails rather than warns once a consumer is more than one minor
   * behind, so an accidental double bump turns every project's routine refresh
   * into a red build.
   */
  const explicit = process.argv[process.argv.indexOf('--version') + 1]
  if (process.argv.includes('--version')) {
    if (!/^\d+\.\d+\.\d+$/.test(explicit ?? '')) {
      console.error('\n✗ --version needs a MAJOR.MINOR.PATCH value.\n')
      process.exit(1)
    }
    built.version = explicit
  } else if (changed) {
    // Patch resets. Carrying it forward meant one hand-set patch release poisoned
    // every later automatic bump — v0.32.1 became v0.33.1 — and the suite's own
    // "one bump per run" test expects the `.0` the rest of the fleet reads in
    // every version string it has ever seen.
    const [major, minor] = String(previous.version ?? '0.0.0').split('.').map(Number)
    built.version = `${major || 0}.${(minor || 0) + 1}.0`
  }

  writeFileSync(MANIFEST, `${JSON.stringify(built, null, 2)}\n`, 'utf8')
  console.log(
    `✓ MANIFEST.json: ${Object.keys(built.files).length} file(s) at v${built.version}` +
      (changed ? ` (was v${previous.version})` : ' (unchanged)'),
  )
}
