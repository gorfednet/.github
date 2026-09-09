#!/usr/bin/env node
/**
 * Fails when this project's copy of the kit is stale, or has been edited here.
 *
 * The kit is distributed by copying, which is the only mechanism available to
 * a project with no package manager. Copying has one failure mode and it is
 * the fleet's own thesis turned inward: fifteen copies drift apart one fix at
 * a time, every one of them still printing ticks, and the copy that matters
 * least is the one everybody reads.
 *
 * Two different problems, reported differently, because the fixes differ:
 *
 *   locally modified  someone edited a copied file. Either upstream it or
 *                     move the change to a project-local script.
 *   stale             upstream moved. Refresh, and read what changed.
 *
 * Usage:
 *   node verification-kit/bin/check-kit-drift.mjs [--kit verification-kit] [--offline]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const CANONICAL =
  'https://raw.githubusercontent.com/gorfednet/.github/main/templates/verification-kit/MANIFEST.json'
const NOT_TRACKED = new Set(['MANIFEST.json'])
const NOT_TRACKED_DIRS = new Set(['templates'])

function parseArgs(argv) {
  const args = { kit: 'verification-kit', offline: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kit') { args.kit = argv[i + 1]; i += 1 }
    else if (argv[i] === '--offline') args.offline = true
  }
  return args
}

function localFiles(root) {
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

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function die(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const { kit, offline } = parseArgs(process.argv.slice(2))

// Built from the kit path actually in use, not the default. Every message
// below hands somebody a command to paste at the moment they are least
// inclined to check it, and a command that fails because it names the wrong
// directory teaches them the tool is unreliable rather than that their kit
// lives somewhere else.
const REFRESH = `node ${kit}/bin/refresh-kit.mjs${kit === 'verification-kit' ? '' : ` --kit ${kit}`}`

if (!existsSync(kit)) die(`check-kit-drift: no kit at ${kit}. Pass --kit, or install it.`)

const manifestPath = join(kit, 'MANIFEST.json')
let vendored
try {
  vendored = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (cause) {
  die(
    `check-kit-drift: cannot read ${manifestPath} (${cause.message}).\n` +
      '  A kit with no manifest cannot be told apart from a stale one, so this is\n' +
      `  a failure rather than a skip. Refresh with:\n    ${REFRESH}`,
  )
}

// 1. Local integrity. This half needs no network, so it runs first and always:
//    a check that only works online is a check that stops working.
const present = localFiles(kit)
if (present.length === 0) {
  die(`check-kit-drift: ${kit} contains no files. Every comparison below would be vacuous.`)
}

const expected = vendored.files ?? {}
if (Object.keys(expected).length === 0) {
  die(`check-kit-drift: ${manifestPath} lists no files, so it certifies nothing.`)
}

const modified = []
const missing = []
const extra = []

for (const [rel, want] of Object.entries(expected)) {
  const path = join(kit, rel)
  if (!existsSync(path)) missing.push(rel)
  else if (hash(path) !== want) modified.push(rel)
}
for (const rel of present) if (!(rel in expected)) extra.push(rel)

if (modified.length > 0 || missing.length > 0 || extra.length > 0) {
  const lines = [
    ...modified.map((f) => `  edited here   ${kit}/${f}`),
    ...missing.map((f) => `  missing       ${kit}/${f}`),
    ...extra.map((f) => `  not upstream  ${kit}/${f}`),
  ]
  die(
    `check-kit-drift: this project's kit does not match its own manifest.\n\n${lines.join('\n')}\n\n` +
      '  A locally edited kit file is a fix that fifteen other projects will not get,\n' +
      '  and a divergence the next refresh silently overwrites. Upstream the change to\n' +
      '  gorfednet/.github, or move it into a project-local script outside the kit.\n\n' +
      `  To discard local edits:\n    ${REFRESH}`,
  )
}

if (offline) {
  // Loud and named, never a silent default: a run that skipped the staleness
  // half must not print the same tick as one that did it.
  console.log(
    `✓ kit v${vendored.version}: ${present.length} file(s) match the vendored manifest.\n` +
      '  --offline: did NOT check whether upstream has moved.',
  )
  process.exit(0)
}

// 2. Staleness. Fail closed: a fetch that did not happen tells us nothing, and
//    "could not check" must never print as "up to date".
let canonical
try {
  const body = execFileSync('curl', ['-fsSL', '--max-time', '20', CANONICAL], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  canonical = JSON.parse(body)
} catch (cause) {
  die(
    `check-kit-drift: could not read the canonical manifest (${cause.message}).\n\n` +
      `  ${CANONICAL}\n\n` +
      '  This is reported as a failure on purpose. A staleness check that passes when\n' +
      '  it cannot reach the source is a check that reports "current" during an outage,\n' +
      '  which is the exact silent-green shape this kit exists to find.\n\n' +
      '  If this run genuinely has no network, say so:\n' +
      '    node verification-kit/bin/check-kit-drift.mjs --offline',
  )
}

const upstream = canonical.files ?? {}
if (Object.keys(upstream).length === 0) {
  die('check-kit-drift: the canonical manifest lists no files, so it certifies nothing.')
}

const stale = Object.keys(upstream).filter((f) => upstream[f] !== expected[f])
const dropped = Object.keys(expected).filter((f) => !(f in upstream))

if (stale.length > 0 || dropped.length > 0) {
  const lines = [
    ...stale.map((f) => `  ${f in expected ? 'changed upstream' : 'added upstream  '}  ${f}`),
    ...dropped.map((f) => `  removed upstream  ${f}`),
  ]
  die(
    `check-kit-drift: kit is stale. Vendored v${vendored.version}, upstream v${canonical.version}.\n\n` +
      `${lines.join('\n')}\n\n` +
      '  Every one of these is a fix or a rule this project is not getting.\n\n' +
      `  Refresh:\n    ${REFRESH}\n` +
      '  Then read the diff — a kit change usually means a new class of bug was found\n' +
      '  somewhere else in the fleet, and the reasoning is in the upstream commit.',
  )
}

console.log(
  `✓ kit v${vendored.version}: ${present.length} file(s), matching canonical v${canonical.version}`,
)
