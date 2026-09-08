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
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = join(KIT_ROOT, 'MANIFEST.json')

/**
 * The manifest describes itself out, and describes out the files a consuming
 * project is expected to edit. `canaries.json` is the obvious one: a project's
 * canaries are its own, and holding them to a canonical hash would mean either
 * every project ships the fleet's canaries or every project is permanently in
 * drift. Neither is a check.
 */
const NOT_TRACKED = new Set(['MANIFEST.json', 'canaries.json'])
const NOT_TRACKED_DIRS = new Set(['templates'])

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

export function buildManifest(root = KIT_ROOT, version) {
  const files = {}
  for (const rel of kitFiles(root)) files[rel] = hashFile(join(root, rel))
  return { version, files }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
  const changed =
    JSON.stringify(built.files) !== JSON.stringify(previous.files ?? {})

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

  // A content change consumers have to notice is a version bump, so the drift
  // check can say "you are two versions behind" rather than only "different".
  if (changed) {
    const [major, minor, patch] = String(previous.version ?? '0.0.0').split('.').map(Number)
    built.version = `${major || 0}.${(minor || 0) + 1}.${patch || 0}`
  }

  writeFileSync(MANIFEST, `${JSON.stringify(built, null, 2)}\n`, 'utf8')
  console.log(
    `✓ MANIFEST.json: ${Object.keys(built.files).length} file(s) at v${built.version}` +
      (changed ? ` (was v${previous.version})` : ' (unchanged)'),
  )
}
