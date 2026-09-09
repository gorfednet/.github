#!/usr/bin/env node
/**
 * A `.gitignore` line is a claim, and normally nothing checks it.
 *
 * `tmp/` had been ignored on bindercurve.com for months. `.tmp/` had not,
 * because a leading dot makes it a different path, and it is the one the
 * toolchain actually uses: a sandboxed run redirects TMPDIR into the
 * workspace, so `npx tsx` writes its V8 compile cache to
 * `.tmp/node-compile-cache`. 548 cache blobs reached main inside a
 * `git add -A`, and every reviewer — human and Bugbot — scrolled past them,
 * because a wall of binary noise is exactly what review skips.
 *
 * The ignore rule is the fix. This is the check that the ignore rule is true.
 *
 * Usage:
 *   node verification-kit/bin/check-tracked-artifacts.mjs [--min-files <n>]
 *                                                         [--source <dir> ...]
 *
 * `--source` says a directory on the list below holds hand-written code in
 * this repository. `build/` is output almost everywhere and is where gorfed.net
 * keeps its Python build scripts, so the list cannot simply drop it. Each
 * allowance is printed on every run, because an exception nobody sees is
 * indistinguishable from the check not looking.
 */
import { execFileSync } from 'node:child_process'

const NEVER_TRACKED = [
  '.tmp/',
  'tmp/',
  'node_modules/',
  'dist/',
  'build/',
  'test-results/',
  'playwright-report/',
  'coverage/',
  '.nas-deploy-clean/',
  '__pycache__/',
  '.pytest_cache/',
  '.venv/',
]

function parseArgs(argv) {
  // Deliberately low so the smallest site in the fleet (23 tracked files)
  // clears it. The point of the floor is to catch `git ls-files` returning
  // nothing — a broken invocation, or being run outside a repository — not to
  // assert a repository is large.
  const args = { minFiles: 5, source: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--min-files') {
      args.minFiles = Number.parseInt(argv[i + 1] ?? '', 10)
      i += 1
    } else if (argv[i] === '--source') {
      const dir = argv[i + 1] ?? ''
      args.source.push(dir.endsWith('/') ? dir : `${dir}/`)
      i += 1
    }
  }
  return args
}

const { minFiles, source } = parseArgs(process.argv.slice(2))

// An allowance for something that was never on the list is a typo that reads
// as protection, so it is refused rather than ignored.
const unknown = source.filter((dir) => !NEVER_TRACKED.includes(dir))
if (unknown.length > 0) {
  console.error(
    `\n✗ check-tracked-artifacts: --source ${unknown.join(', ')} names ` +
      'a path this check never flags anyway.\n  Drop the flag: it is exempting ' +
      'nothing, and reads as though it were.\n',
  )
  process.exit(1)
}

let tracked
try {
  tracked = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((line) => line !== '')
} catch (cause) {
  console.error(`\n✗ check-tracked-artifacts: cannot list tracked files: ${cause.message}\n`)
  process.exit(1)
}

// Fail closed. Without this the whole check passes by matching nothing, which
// is the failure mode the kit exists to stop.
if (tracked.length < minFiles) {
  console.error(
    `\n✗ check-tracked-artifacts: git ls-files returned ${tracked.length} file(s), ` +
      `fewer than the ${minFiles} floor.\n` +
      `  Every assertion below would pass vacuously on this list, so the check refuses to run.\n`,
  )
  process.exit(1)
}

const offenders = []
for (const prefix of NEVER_TRACKED) {
  if (source.includes(prefix)) continue
  const hits = tracked.filter((file) => file === prefix.slice(0, -1) || file.startsWith(prefix))
  if (hits.length > 0) {
    offenders.push({ prefix, count: hits.length, sample: hits.slice(0, 5) })
  }
}

if (offenders.length > 0) {
  console.error('\n✗ generated files are tracked in git:\n')
  for (const { prefix, count, sample } of offenders) {
    console.error(`  ${prefix}  ${count} file(s)`)
    for (const file of sample) console.error(`    ${file}`)
    if (count > sample.length) console.error(`    ... and ${count - sample.length} more`)
    console.error(`    fix: git rm -r --cached ${prefix} && echo '${prefix}' >> .gitignore\n`)
  }
  process.exit(1)
}

console.log(
  `✓ tracked files: ${tracked.length}, none under generated paths` +
    (source.length > 0
      ? `\n  not checked, declared as source here: ${source.join(', ')}`
      : ''),
)
