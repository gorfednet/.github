#!/usr/bin/env node
/**
 * Prove that a check can actually fail.
 *
 * A new guard is worth nothing until you have seen it go red. Every check in
 * this fleet was written by someone confident it worked, and several of them
 * did not: a grep-selected test gate that silently ran nothing, a monitor that
 * reported nine green specs against a three-month-old checkout, a coverage
 * matcher that credited a route because a different route's URL happened to
 * match its pattern.
 *
 * A canary applies a known-bad edit and asserts the named command notices.
 * If the command still passes, the guard is decoration and this says so.
 *
 * Usage:
 *   node verification-kit/bin/mutation-canary.mjs [--file canaries.json] [--only id,id] [--list]
 *
 * Canary shape:
 *   {
 *     "id":      "unique-name",
 *     "guards":  "what this proves, in a sentence",
 *     "command": "npm run lint",       // any shell command
 *     "file":    "src/thing.ts",
 *     "find":    "exact text, must appear exactly once",
 *     "replace": "the known-bad version"
 *   }
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Crash-durable revert record.
 *
 * The runner blocks on a synchronous child process, so a SIGKILL or an OOM
 * kill lands while the working tree still holds a deliberately broken file,
 * and no signal handler can run to undo it. A JS-only cleanup handler is
 * decoration for exactly the failure it is meant to survive. Persist the
 * intent before mutating, and recover on the next start.
 */
const DIRTY_RECORD = '.mutation-canary-dirty.json'

function parseArgs(argv) {
  const args = { file: 'canaries.json', only: null, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--list') args.list = true
    else if (flag === '--file') { args.file = argv[i + 1]; i += 1 }
    else if (flag === '--only') { args.only = (argv[i + 1] ?? '').split(','); i += 1 }
    else if (flag.startsWith('--only=')) args.only = flag.slice('--only='.length).split(',')
  }
  return args
}

function revert(file) {
  spawnSync('git', ['checkout', '--', file], { stdio: 'inherit' })
}

function recoverAbandonedRun() {
  if (!existsSync(DIRTY_RECORD)) return
  let record
  try {
    record = JSON.parse(readFileSync(DIRTY_RECORD, 'utf8'))
  } catch {
    rmSync(DIRTY_RECORD, { force: true })
    return
  }
  for (const file of record.files ?? []) {
    console.warn(`[mutation-canary] recovering abandoned mutation in ${file}`)
    revert(file)
  }
  rmSync(DIRTY_RECORD, { force: true })
}

function isClean(file) {
  const status = spawnSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' })
  return (status.stdout ?? '').trim() === ''
}

const { file: manifestPath, only, list } = parseArgs(process.argv.slice(2))

recoverAbandonedRun()

let canaries
try {
  canaries = JSON.parse(readFileSync(manifestPath, 'utf8')).canaries
} catch (cause) {
  console.error(`\n✗ mutation-canary: cannot read ${manifestPath} (${cause.message})\n`)
  process.exit(1)
}

if (!Array.isArray(canaries) || canaries.length === 0) {
  console.error(`\n✗ mutation-canary: ${manifestPath} declares no canaries.\n`)
  process.exit(1)
}

if (list) {
  for (const c of canaries) console.log(`${c.id.padEnd(34)} ${c.command}  — ${c.guards}`)
  process.exit(0)
}

const selected = only ? canaries.filter((c) => only.includes(c.id)) : canaries

// A filter that matches nothing must not report success. This is the same
// fail-closed rule the kit applies everywhere else.
if (selected.length === 0) {
  console.error(`\n✗ mutation-canary: --only matched no canaries in ${manifestPath}\n`)
  process.exit(1)
}

let failures = 0

for (const canary of selected) {
  const { id, file, find, replace, command, guards } = canary
  process.stdout.write(`\n▶ ${id}\n  guards: ${guards}\n  command: ${command}\n`)

  if (!existsSync(file)) {
    console.error(`  ✗ target ${file} does not exist — the canary has drifted from the code`)
    failures += 1
    continue
  }

  if (!isClean(file)) {
    console.error(`  ✗ ${file} has uncommitted changes; refusing to mutate it`)
    failures += 1
    continue
  }

  const original = readFileSync(file, 'utf8')
  const occurrences = original.split(find).length - 1
  if (occurrences !== 1) {
    console.error(
      `  ✗ anchor appears ${occurrences} time(s) in ${file}, expected exactly 1.\n` +
        '    An anchor that matches zero times mutates nothing and the canary passes for\n' +
        '    the wrong reason; one that matches many is not the edit you described.',
    )
    failures += 1
    continue
  }

  writeFileSync(DIRTY_RECORD, JSON.stringify({ files: [file] }), 'utf8')
  writeFileSync(file, original.replace(find, replace), 'utf8')

  let caught = false
  try {
    const result = spawnSync(command, { shell: true, stdio: 'pipe', encoding: 'utf8' })
    caught = result.status !== 0
  } finally {
    revert(file)
    rmSync(DIRTY_RECORD, { force: true })
  }

  if (caught) {
    console.log('  ✓ caught')
  } else {
    console.error(
      `  ✗ NOT CAUGHT — \`${command}\` still passed with the known-bad edit applied.\n` +
        '    The guard this canary describes is not doing the job it is credited with.',
    )
    failures += 1
  }
}

console.log(
  `\n${failures === 0 ? '✓' : '✗'} mutation-canary: ${selected.length - failures}/${selected.length} caught\n`,
)
process.exit(failures === 0 ? 0 : 1)
