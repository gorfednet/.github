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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const RAW = 'https://raw.githubusercontent.com/gorfednet/.github/main/templates/verification-kit'

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

const before = existsSync(join(kit, 'MANIFEST.json'))
  ? JSON.parse(readFileSync(join(kit, 'MANIFEST.json'), 'utf8')).version
  : 'none'

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

console.log(
  `✓ refresh-kit: ${files.length} file(s) written to ${kit}/, v${before} → v${manifest.version}\n` +
    '  Read the diff before committing. A kit change usually means a new class of bug\n' +
    '  was found elsewhere in the fleet.',
)
