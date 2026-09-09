#!/usr/bin/env node
/**
 * The gate that keeps the plan of record honest.
 *
 * A backlog nothing checks becomes fiction. Run this in CI so the file cannot
 * quietly stop describing reality.
 *
 * Usage:
 *   node verification-kit/bin/check-backlog.mjs [--file docs/backlog.json]
 */
import { readFileSync } from 'node:fs'
import { validateBacklog } from '../lib/backlogSchema.mjs'

function parseArgs(argv) {
  const args = { file: 'docs/backlog.json' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') {
      args.file = argv[i + 1]
      i += 1
    }
  }
  return args
}

const { file } = parseArgs(process.argv.slice(2))

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (cause) {
  // Fail closed: a missing plan of record is the condition this exists to
  // catch, not a reason to pass.
  console.error(
    `\n✗ check-backlog: cannot read ${file} (${cause.message})\n\n` +
      '  Every project carries a backlog, even an empty one. Create it from\n' +
      '  verification-kit/templates/backlog.json.\n',
  )
  process.exit(1)
}

const problems = validateBacklog(doc)

if (problems.length > 0) {
  console.error(`\n✗ ${file} has ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const entries = doc.entries ?? []
const byStatus = {}
for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
const summary =
  Object.entries(byStatus)
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ') || 'empty'

console.log(`✓ ${file}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${summary})`)
