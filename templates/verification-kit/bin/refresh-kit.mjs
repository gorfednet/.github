#!/usr/bin/env node
/**
 * Pull the canonical kit down over this project's copy.
 *
 * A drift check that names no remedy is a check people learn to ignore, so
 * this is the command every drift failure prints. It overwrites; that is the
 * point. Local edits to kit files are the thing being prevented, and anything
 * worth keeping belongs upstream or in a project-local script.
 *
 * Usage:
 *   node verification-kit/bin/refresh-kit.mjs [--kit verification-kit] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const RAW = 'https://raw.githubusercontent.com/gorfednet/.github/main/templates/verification-kit'

/** Every file in the vendored kit except the manifest and the starters. */
function kitFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      const rel = relative(root, path).split(sep).join('/')
      if (rel === 'MANIFEST.json' || rel === 'templates') continue
      if (statSync(path).isDirectory()) walk(path)
      else found.push(rel)
    }
  }
  walk(root)
  return found
}

function parseArgs(argv) {
  const args = { kit: 'verification-kit', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kit') { args.kit = argv[i + 1]; i += 1 }
    else if (argv[i] === '--dry-run') args.dryRun = true
  }
  return args
}

function fetchText(url) {
  return execFileSync('curl', ['-fsSL', '--max-time', '30', url], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const { kit, dryRun } = parseArgs(process.argv.slice(2))

let manifest
try {
  manifest = JSON.parse(fetchText(`${RAW}/MANIFEST.json`))
} catch (cause) {
  console.error(
    `\n✗ refresh-kit: cannot read the canonical manifest (${cause.message}).\n` +
      `  ${RAW}/MANIFEST.json\n`,
  )
  process.exit(1)
}

const files = Object.keys(manifest.files ?? {})
if (files.length === 0) {
  console.error('\n✗ refresh-kit: the canonical manifest lists no files. Refusing to wipe the kit.\n')
  process.exit(1)
}

/**
 * The local manifest is read for one thing: printing which version is being
 * replaced. An unreadable one is precisely the case `check-kit-drift` prints
 * this command for, so letting a parse error throw here made the named remedy
 * unable to repair the failure it was named for. Cosmetic input, cosmetic
 * failure.
 */
let before = 'none'
try {
  const local = join(kit, 'MANIFEST.json')
  if (existsSync(local)) before = JSON.parse(readFileSync(local, 'utf8')).version ?? 'unreadable'
} catch {
  before = 'unreadable'
}

if (dryRun) {
  console.log(`refresh-kit --dry-run: would write ${files.length} file(s), v${before} → v${manifest.version}`)
  for (const rel of files) console.log(`  ${kit}/${rel}`)
  process.exit(0)
}

for (const rel of files) {
  const target = join(kit, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, fetchText(`${RAW}/${rel}`), 'utf8')
}
writeFileSync(join(kit, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

/**
 * Writing the new files is only half a refresh. A file upstream has deleted
 * stays on disk, and `check-kit-drift` then reports it as `not upstream` — and
 * prints this command as the fix, which has already run. Following the printed
 * remedy has to be able to reach green, or the remedy is decoration.
 */
const removed = []
for (const rel of kitFiles(kit)) {
  if (rel in (manifest.files ?? {})) continue
  rmSync(join(kit, rel), { force: true })
  removed.push(rel)
}

console.log(
  `✓ refresh-kit: ${files.length} file(s) written to ${kit}/, v${before} → v${manifest.version}` +
    (removed.length > 0 ? `\n  removed ${removed.length} file(s) upstream no longer ships:` : '') +
    removed.map((rel) => `\n    ${kit}/${rel}`).join('') +
    '\n  Read the diff before committing. A kit change usually means a new class of bug\n' +
    '  was found elsewhere in the fleet.',
)
