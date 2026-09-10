#!/usr/bin/env node
/**
 * Rule numbers are cited from code, so the numbering is an API rather than
 * formatting.
 *
 * Nothing checked it on bindercurve.com, and nine branches merging at once
 * produced exactly the failure that predicts: the list reached `…20, 25` with
 * 21 to 24 never written, two different rules both numbered 25, and registry
 * entries citing rules that had moved. A citation pointing at the wrong rule is
 * worse than no citation, because it reads as a verified cross-reference.
 *
 * Two sequences, which is how a project adds a rule without touching the shared
 * numbering:
 *
 *   V1..Vn        docs/verification-rules.md — shared, append-only
 *   PREFIX-1..m   docs/verification-rules.local.md — this project's own
 *
 * Usage:
 *   node verification-kit/bin/check-rule-citations.mjs \
 *     [--shared docs/verification-rules.md] \
 *     [--local docs/verification-rules.local.md] \
 *     [--source <glob>]...
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh'])
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv',
  '__pycache__', 'test-results', 'playwright-report', '.tmp', 'tmp',
])

/**
 * Is this a directory of somebody else's code?
 *
 * Named directories were not enough twice over. `venv` — the commoner spelling,
 * and the one sitting unignored at towit.io's root — was missing beside
 * `.venv`, so the walk descended into a whole site-packages tree. Worse, CI
 * checks `gorfednet/.github` out to `.gorfednet-github` *inside* the workspace,
 * because actions/checkout refuses a path outside it. Every project therefore
 * scanned the org repository's own source, and the moment a shared rule was
 * added there, every project whose vendored rules document was one version
 * behind failed on a citation in a file it does not own. That is a fleet-wide
 * red caused by writing a rule.
 *
 * So: any dot-directory is tooling rather than project source. That covers the
 * checkout, .cursor, .venv and whatever the next one is called, which is the
 * point — an enumerated list is what failed here twice.
 */
function isForeignDirectory(name) {
  return SKIP_DIRECTORIES.has(name) || name.startsWith('.')
}

function parseArgs(argv) {
  const args = {
    shared: 'docs/verification-rules.md',
    local: 'docs/verification-rules.local.md',
    roots: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--shared') { args.shared = argv[i + 1]; i += 1 }
    else if (argv[i] === '--local') { args.local = argv[i + 1]; i += 1 }
    else if (argv[i] === '--source') { args.roots.push(argv[i + 1]); i += 1 }
  }
  if (args.roots.length === 0) args.roots = ['.']
  return args
}

/**
 * Every directory this run declined to read, so the skip is reported rather
 * than assumed. Broadening the rule to all dot-directories takes `.githooks`
 * with it, and a check that quietly stops looking at a place citations could
 * live is the shape of defect this kit exists to find.
 */
const skipped = new Set()

function walk(dir, found = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (isForeignDirectory(entry)) {
        skipped.add(path)
        continue
      }
      walk(path, found)
    } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
      found.push(path)
    }
  }
  return found
}

/** Shared rules are headed `**V12. ...`; local ones `**BC-3. ...`. */
function ruleNumbers(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]))
}

function checkSequence(numbers, label, problems) {
  if (numbers.length === 0) {
    // A document present but unparseable would otherwise certify an empty
    // sequence, against which every citation dangles or none does.
    problems.push(`${label}: no rules found. Rules are headed like "**V1. ..." at line start.`)
    return
  }
  const expected = numbers.map((_, index) => index + 1)
  if (numbers.join(',') !== expected.join(',')) {
    const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i)
    problems.push(
      `${label}: expected 1..${numbers.length} in order, read ${numbers.join(', ')}.` +
        (duplicates.length > 0 ? ` Duplicated: ${[...new Set(duplicates)].join(', ')}.` : '') +
        ' Rules are append-only; renumbering dangles citations in other repositories.',
    )
  }
}

const { shared, local, roots } = parseArgs(process.argv.slice(2))
const problems = []

if (!existsSync(shared)) {
  console.error(
    `\n✗ check-rule-citations: ${shared} is missing.\n\n` +
      '  Refresh it from gorfednet/.github, or pass --shared. A project with no\n' +
      '  shared rules document cannot have its citations checked, and that is a\n' +
      '  failure rather than a pass.\n',
  )
  process.exit(1)
}

const sharedNumbers = ruleNumbers(readFileSync(shared, 'utf8'), /^\*\*V(\d+)\. /gm)
checkSequence(sharedNumbers, shared, problems)

let localNumbers = []
let localPrefix = null
if (existsSync(local)) {
  const text = readFileSync(local, 'utf8')
  localPrefix = /^\*\*([A-Z0-9]+)-\d+\. /m.exec(text)?.[1] ?? null
  if (localPrefix === null) {
    problems.push(
      `${local}: no local rules found. Local rules are headed "**PREFIX-1. ..." ` +
        'with a prefix this project picks once.',
    )
  } else {
    localNumbers = ruleNumbers(text, new RegExp(`^\\*\\*${localPrefix}-(\\d+)\\. `, 'gm'))
    checkSequence(localNumbers, `${local} (${localPrefix}-)`, problems)
  }
}

const sources = roots.flatMap((root) => walk(root))

// Every check below is "no citation exceeds the highest rule", which is
// vacuously true of an empty file list. A broken --source glob would print a
// tick over having read nothing.
if (sources.length === 0) {
  console.error(
    `\n✗ check-rule-citations: found no source files under ${roots.join(', ')}.\n` +
      '  Every assertion would pass vacuously, so the check refuses to run.\n',
  )
  process.exit(1)
}

// Matches a shared citation (the letter V and a number), a project-prefixed
// one, and a bare number, each optionally introduced by "teardown", "class" or
// "verification". Prose in this file is scanned like any other source, which
// is why the forms above are described rather than quoted: a quoted example
// would be a citation, and would dangle the day the sequence it names ends.
//
// The `V` form is matched case-sensitively and refuses a following `.<digit>`,
// because `Comprehensive Rules v1.1` is a game's rulebook version and not a
// citation of V1. That near-miss was live in this file — the check written to
// enforce "prove your matcher rejects a near-miss", failing to.
const CITATION = /\b(?:teardown |class |verification )?rules?\s+((?:[A-Z0-9]+-)?\d+|V\d+)\b(?!\.\d)/gi

for (const file of sources) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const match of text.matchAll(CITATION)) {
    const raw = match[1]

    // Lowercase `v` is a version number in prose, never a citation. The regex
    // has to stay case-insensitive for the introducer words, so the case test
    // happens here.
    if (/^v\d+$/.test(raw)) continue

    const shared_ = /^V(\d+)$/.exec(raw)
    if (shared_) {
      const cited = Number(shared_[1])
      if (cited < 1 || cited > sharedNumbers.length) {
        problems.push(`${file}: cites rule V${cited}, but ${shared} ends at V${sharedNumbers.length}`)
      }
      continue
    }
    const prefixed = /^([A-Z0-9]+)-(\d+)$/.exec(raw)
    if (prefixed) {
      const [, prefix, number] = prefixed
      if (prefix !== localPrefix) {
        problems.push(`${file}: cites rule ${raw}, but this project's local prefix is ${localPrefix ?? 'unset'}`)
      } else if (Number(number) < 1 || Number(number) > localNumbers.length) {
        problems.push(`${file}: cites rule ${raw}, but ${local} ends at ${prefix}-${localNumbers.length}`)
      }
      continue
    }
    // A bare number cites whichever sequence this project numbers its own
    // rules in. Projects that never adopted a prefix keep citing bare numbers
    // against the shared document.
    const cited = Number(raw)
    const ceiling = localNumbers.length > 0 ? localNumbers.length : sharedNumbers.length
    const against = localNumbers.length > 0 ? local : shared
    if (cited < 1 || cited > ceiling) {
      problems.push(`${file}: cites rule ${cited}, but ${against} ends at ${ceiling}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} rule-numbering problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(
  `✓ rules: ${sharedNumbers.length} shared` +
    (localPrefix ? `, ${localNumbers.length} local (${localPrefix}-)` : '') +
    `; every citation in ${sources.length} source file(s) resolves`,
)

if (skipped.size > 0) {
  console.log(
    `  not read (${skipped.size}): ${[...skipped].sort().join(', ')}`,
  )
}
