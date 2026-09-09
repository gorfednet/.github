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

/**
 * Restore a mutated file, and say so when it did not work.
 *
 * This tool deliberately writes known-bad code into the working tree, so the
 * restore is the only thing standing between a canary run and a repository
 * left holding a defect on purpose. Ignoring `git checkout`'s exit status
 * meant a failed restore was indistinguishable from a successful one — and the
 * caller then deleted the crash record, which is the only note the next run
 * would have had to undo it.
 */
function revert(file) {
  const result = spawnSync('git', ['checkout', '--', file], { stdio: 'inherit' })
  return result.status === 0
}

function recoverAbandonedRun() {
  if (!existsSync(DIRTY_RECORD)) return
  let record
  try {
    record = JSON.parse(readFileSync(DIRTY_RECORD, 'utf8'))
  } catch {
    console.error(
      `\n✗ ${DIRTY_RECORD} exists but cannot be parsed, so a previous run left a ` +
        'known-bad edit somewhere and this one cannot tell where.\n\n' +
        '  Check `git status`, restore by hand, then delete that file.\n',
    )
    process.exit(1)
  }
  const stuck = []
  for (const file of record.files ?? []) {
    console.warn(`[mutation-canary] recovering abandoned mutation in ${file}`)
    if (!revert(file)) stuck.push(file)
  }
  if (stuck.length > 0) {
    console.error(
      `\n✗ could not restore ${stuck.join(', ')} from a previous run.\n\n` +
        `  ${DIRTY_RECORD} is being kept so the next run tries again. Do not delete\n` +
        '  it until `git status` is clean — it is the only record of what was edited.\n',
    )
    process.exit(1)
  }
  rmSync(DIRTY_RECORD, { force: true })
}

/**
 * A `git status` that failed tells us nothing about the tree, and answering
 * "clean" to a question that could not be asked is how this tool would come to
 * overwrite work it was supposed to refuse to touch.
 */
function isClean(file) {
  const status = spawnSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' })
  if (status.status !== 0) {
    console.error(
      `\n✗ could not read git status for ${file} ` +
        `(${(status.stderr ?? '').trim() || `exit ${status.status}`}).\n\n` +
        '  Refusing to mutate a file whose state is unknown: this tool writes\n' +
        '  known-bad code and relies on git to put it back.\n',
    )
    process.exit(1)
  }
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
    /**
     * A mutation that leaves the file unparseable is red for a reason that has
     * nothing to do with the guard. The command fails, the canary reports
     * "caught", and the whole exercise certifies a guard that may not exist —
     * deleting the test entirely would produce the same green tick. So the
     * mutated source has to still be a program before its behaviour means
     * anything.
     */
    if (/\.(mjs|cjs|js)$/.test(file)) {
      const parse = spawnSync('node', ['--check', file], { encoding: 'utf8' })
      if (parse.status !== 0) {
        console.error(
          `  ✗ INVALID CANARY — the edit leaves ${file} unparseable.\n` +
            `    ${(parse.stderr ?? '').split('\n').find((l) => l.includes('Error')) ?? ''}\n` +
            '    A syntax error fails the command for the wrong reason, so this proves\n' +
            '    nothing about the guard. Make the mutation a valid program that behaves\n' +
            '    badly, not a broken one.',
        )
        failures += 1
        continue
      }
    }
    const result = spawnSync(command, { shell: true, stdio: 'pipe', encoding: 'utf8' })
    caught = result.status !== 0
  } finally {
    // The record is deleted only once the file is genuinely back. Deleting it
    // regardless threw away the one note that would let the next run undo a
    // restore that did not happen, leaving a deliberate defect on disk with
    // nothing pointing at it.
    if (revert(file)) {
      rmSync(DIRTY_RECORD, { force: true })
    } else {
      console.error(
        `\n✗ could not restore ${file} after mutating it.\n\n` +
          `  The known-bad edit is still on disk. ${DIRTY_RECORD} has been kept so the\n` +
          '  next run retries; restore by hand if that does not work, and do not commit\n' +
          '  until `git status` is clean.\n',
      )
      process.exit(1)
    }
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
