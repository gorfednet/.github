#!/usr/bin/env node
/**
 * Fails when a test job did not actually execute the tests it claims to run.
 *
 * On bindercurve.com, a CI job named nine specs, ran them across three
 * browsers, and reported green for months. Every one of them skipped itself:
 * the guard read a build-time variable from the Node process, where nothing
 * set it, so it always fell back to a default that excluded them. Nine specs,
 * zero assertions, one green check — and it was the stated compensating
 * control for pulling those specs out of the deploy gate. A feature that was
 * broken on six of ten configurations shipped straight through it.
 *
 * Exit codes cannot catch that, because a fully-skipped suite exits 0. The
 * only thing that can is counting what ran. This asserts an executed floor,
 * so the next inert job announces itself instead of going quiet.
 *
 * Usage:
 *   node .../assert-tests-executed.mjs --report <json> --min <n> [--label <text>]
 *                                      [--hint <repo-specific pointer>]
 *                                      [--max-flaky <n>]
 *
 * Accepts Playwright JSON (`suites`) and Vitest JSON (`testResults`).
 */
import { readFileSync } from 'node:fs'

function parseArgs(argv) {
  const args = { label: 'test job' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--report') args.report = value
    else if (flag === '--min') args.min = Number.parseInt(value ?? '', 10)
    else if (flag === '--label') args.label = value
    else if (flag === '--hint') args.localHint = value
    else if (flag === '--max-flaky') args.maxFlaky = Number.parseInt(value ?? '', 10)
    else continue
    i += 1
  }
  return args
}

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const { report, min, label, localHint, maxFlaky } = parseArgs(process.argv.slice(2))

if (!report) fail('assert-tests-executed: --report <json report> is required')
if (!Number.isFinite(min) || min < 1) {
  fail('assert-tests-executed: --min <n> is required and must be at least 1')
}

let parsed
try {
  parsed = JSON.parse(readFileSync(report, 'utf8'))
} catch (cause) {
  fail(
    `assert-tests-executed: cannot read the JSON report at ${report} ` +
      `(${cause.message}). A missing report means the run did not happen, which is ` +
      `the condition this check exists to catch.`,
  )
}

function isVitestReport(reportJson) {
  return typeof reportJson.numTotalTests === 'number' && Array.isArray(reportJson.testResults)
}

/**
 * Walks the Playwright suite tree and tallies outcomes.
 *
 * "Executed" means a test produced a real result. `skipped` does not count,
 * which is the entire point: nine skipped specs must not read as nine specs.
 */
function tallyPlaywright(node, counts) {
  for (const spec of node.specs ?? []) {
    for (const testCase of spec.tests ?? []) {
      const status = testCase.status ?? 'unknown'
      if (status === 'skipped') counts.skipped += 1
      else counts.executed += 1
      counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1

      /*
       * A test that failed and passed on a retry. Playwright exits 0 for these
       * and the aggregate line reads "flaky: 1", which says a count and not a
       * name — so the one thing needed to act on it, which test, is the one
       * thing not printed. A run of gorfed.net's suite sat in that state for
       * weeks: green every time, and the failing assertion only findable by
       * downloading the JSON report and reading `retry` fields by hand.
       *
       * The attempt list is the evidence. `results` holds one entry per attempt,
       * so a name plus "failed then passed" is enough to go and look.
       */
      const attempts = testCase.results ?? []
      if (status === 'flaky' || attempts.filter((a) => a.status === 'failed').length > 0) {
        if (status !== 'unexpected') {
          counts.retried.push({
            name: `${spec.file ?? node.file ?? '?'} › ${spec.title ?? '?'}`,
            attempts: attempts.map((a) => a.status ?? 'unknown'),
          })
        }
      }
    }
  }
  for (const child of node.suites ?? []) tallyPlaywright(child, counts)
}

function tallyVitest(reportJson, counts) {
  const total = reportJson.numTotalTests ?? 0
  const pending = reportJson.numPendingTests ?? 0
  counts.executed = total - pending
  counts.skipped = pending
  counts.byStatus = {
    passed: reportJson.numPassedTests ?? 0,
    failed: reportJson.numFailedTests ?? 0,
    pending,
    todo: reportJson.numTodoTests ?? 0,
  }
}

const counts = { executed: 0, skipped: 0, byStatus: {}, retried: [] }
if (isVitestReport(parsed)) tallyVitest(parsed, counts)
else {
  for (const suite of parsed.suites ?? []) tallyPlaywright(suite, counts)
}

const summary =
  `executed ${counts.executed}, skipped ${counts.skipped} ` +
  `(${Object.entries(counts.byStatus)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'none'})`

if (counts.executed < min) {
  const hint = isVitestReport(parsed)
    ? 'Either the include globs no longer match files on disk, or `describe.runIf` / `it.skip` guards are skipping the whole suite.'
    : 'Either the specs are skipping themselves — check their skip guards, and be suspicious of any guard reading a build-time variable from the Node process, which is the class of bug that caused this before — or the spec list no longer matches the files on disk.'
  fail(
    `${label} executed ${counts.executed} test(s) but at least ${min} were expected.\n` +
      `  ${summary}\n\n` +
      `  A job that runs nothing must not report success. ${hint}` +
      // The general advice above is where to look; a project knows the exact
      // file. Passing it in beats forking this script for one sentence, which
      // is how a shared file stops being shared.
      (localHint ? `\n\n  In this repository: ${localHint}` : ''),
  )
}

if (isVitestReport(parsed) && parsed.snapshot?.unchecked > 0) {
  const keys =
    parsed.snapshot.uncheckedKeysByFile
      ?.flatMap((entry) => entry.keys?.map((key) => `${entry.file}: ${key}`) ?? [])
      .join('\n  ') ?? '(keys unavailable)'
  fail(
    `${label} left ${parsed.snapshot.unchecked} obsolete Vitest snapshot(s).\n` +
      `  ${keys}\n\n` +
      `  Obsolete snapshots lock code that no longer exists. Remove them with\n` +
      `  \`vitest run -u\` on the owning file, or delete the orphan keys by hand.`,
  )
}

/*
 * Retries, named. A budget is a decision a repository makes out loud, so
 * exceeding one fails; without `--max-flaky` this only reports, because turning
 * every retry into a red build across the fleet is a separate decision from
 * being able to see them.
 */
if (counts.retried.length > 0) {
  const named = counts.retried
    .map(({ name, attempts }) => `  - ${name} (${attempts.join(' then ')})`)
    .join('\n')

  if (Number.isFinite(maxFlaky) && counts.retried.length > maxFlaky) {
    fail(
      `${label}: ${counts.retried.length} test(s) needed a retry, budget is ${maxFlaky}.\n${named}\n\n` +
        '  A retry that passes is not a pass; it is an intermittent failure the\n' +
        '  exit code hides. Fix the race, or raise the budget in the same change\n' +
        '  that explains why.',
    )
  }

  console.error(
    `\n⚠ ${label}: ${counts.retried.length} test(s) passed only on a retry.\n${named}\n\n` +
      '  Reported by name because the exit code is 0 and the summary line gives a\n' +
      '  count. Pass --max-flaky <n> to make a budget enforceable.\n',
  )
}

console.log(`✓ ${label}: ${summary}`)
