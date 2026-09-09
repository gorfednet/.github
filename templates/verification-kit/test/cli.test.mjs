/**
 * Behavioural tests for the three plain-node CLIs. Each asserts the failing
 * direction first, because a check nobody has watched go red is an assumption.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const bin = (name) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'))
  workspaces.push(dir)
  return dir
}

function runCli(name, args, cwd = process.cwd()) {
  return spawnSync('node', [bin(name), ...args], { cwd, encoding: 'utf8' })
}

describe('assert-tests-executed', () => {
  function writeReport(contents) {
    const dir = tempDir()
    const path = join(dir, 'report.json')
    writeFileSync(path, JSON.stringify(contents), 'utf8')
    return path
  }

  const playwright = (statuses) => ({
    suites: [{ specs: [{ tests: statuses.map((status) => ({ status })) }] }],
  })

  it('passes when enough tests actually ran', () => {
    const report = writeReport(playwright(['passed', 'passed', 'passed']))
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '3'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /executed 3, skipped 0/)
  })

  // The defect this whole file exists for: a fully-skipped suite exits 0, so
  // exit codes cannot see it and only a count can.
  it('fails when every test skipped itself, even though the suite exited 0', () => {
    const report = writeReport(playwright(['skipped', 'skipped', 'skipped']))
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '3'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /executed 0 test\(s\) but at least 3 were expected/)
    assert.match(result.stderr, /must not report success/)
  })

  it('counts a failing test as executed, since it did run', () => {
    const report = writeReport(playwright(['failed', 'passed']))
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '2'])
    assert.equal(result.status, 0, result.stderr)
  })

  it('reads Vitest reports as well as Playwright ones', () => {
    const report = writeReport({
      numTotalTests: 10,
      numPendingTests: 4,
      numPassedTests: 6,
      testResults: [],
    })
    assert.equal(runCli('assert-tests-executed.mjs', ['--report', report, '--min', '6']).status, 0)
    assert.equal(runCli('assert-tests-executed.mjs', ['--report', report, '--min', '7']).status, 1)
  })

  // A report that does not exist means the run did not happen. Treating that
  // as "nothing to check" is how a deleted step reads as a pass.
  it('fails closed when the report is missing or unparseable', () => {
    const missing = runCli('assert-tests-executed.mjs', ['--report', '/nope.json', '--min', '1'])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /did not happen/)

    const dir = tempDir()
    writeFileSync(join(dir, 'bad.json'), 'not json', 'utf8')
    const bad = runCli('assert-tests-executed.mjs', ['--report', join(dir, 'bad.json'), '--min', '1'])
    assert.equal(bad.status, 1)
  })

  it('refuses a missing or nonsensical floor rather than defaulting to zero', () => {
    const report = writeReport(playwright(['passed']))
    for (const args of [['--report', report], ['--report', report, '--min', '0']]) {
      const result = runCli('assert-tests-executed.mjs', args)
      assert.equal(result.status, 1, `expected failure for ${args.join(' ')}`)
      assert.match(result.stderr, /--min/)
    }
  })
})

describe('check-tracked-artifacts', () => {
  // Enough real source files to clear the default floor, so every case below
  // exercises the check as a project actually runs it.
  const FILLER = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`src/mod${i}.js`, `export const m = ${i}\n`]),
  )

  function repoWith(files) {
    const dir = tempDir()
    const git = (...args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    for (const [path, contents] of Object.entries({ ...FILLER, ...files })) {
      const full = join(dir, path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, contents, 'utf8')
    }
    git('add', '-A', '-f')
    git('commit', '-qm', 'initial')
    return dir
  }

  it('passes on a repo that tracks only source', () => {
    const dir = repoWith({ 'src/app.js': 'x\n', 'README.md': 'x\n' })
    const result = runCli('check-tracked-artifacts.mjs', [], dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('fails when a generated directory has been committed', () => {
    const dir = repoWith({ 'src/app.js': 'x\n', 'dist/app.js': 'built\n' })
    const result = runCli('check-tracked-artifacts.mjs', [], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /dist\/app\.js/)
  })

  // .gitignore is advice for untracked files only; git keeps tracking anything
  // already committed. So an ignore rule reads as protection it does not give.
  it('fails on a tracked artifact that .gitignore claims to exclude', () => {
    const dir = repoWith({ '.gitignore': 'node_modules/\n', 'node_modules/x/index.js': 'x\n' })
    const result = runCli('check-tracked-artifacts.mjs', [], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /node_modules/)
  })

  // Every assertion in this check is "no tracked file starts with X", which is
  // vacuously true of an empty list. Run it outside a repository, or with a
  // broken git invocation, and it would print a tick.
  it('refuses to run rather than pass vacuously on a near-empty file list', () => {
    const dir = repoWith({})
    const result = runCli('check-tracked-artifacts.mjs', ['--min-files', '500'], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pass vacuously/)
  })

  it('fails rather than reporting success when run outside a git repository', () => {
    const result = runCli('check-tracked-artifacts.mjs', [], tempDir())
    assert.equal(result.status, 1)
  })
})

describe('check-backlog', () => {
  function backlogAt(doc) {
    const dir = tempDir()
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs/backlog.json'), JSON.stringify(doc), 'utf8')
    return dir
  }

  const PROSE = 'a sentence long enough to clear the twenty character floor'

  it('passes on a valid backlog and reports the status tally', () => {
    const dir = backlogAt({
      entries: [
        {
          id: 'x',
          title: PROSE,
          status: 'confirmed-bug',
          assignee: 'main-model',
          userSymptom: PROSE,
          evidence: PROSE,
        },
      ],
    })
    const result = runCli('check-backlog.mjs', [], dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 entry \(confirmed-bug: 1\)/)
  })

  it('fails on an invalid entry and names the problem', () => {
    const dir = backlogAt({
      entries: [{ id: 'x', title: PROSE, status: 'confirmed-bug', assignee: 'main-model', userSymptom: 'bad', evidence: PROSE }],
    })
    const result = runCli('check-backlog.mjs', [], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /userSymptom/)
  })

  // A project with no plan of record is the condition the gate exists to
  // surface, so a missing file is a failure and not a skip.
  it('fails closed when the backlog file does not exist', () => {
    const result = runCli('check-backlog.mjs', [], tempDir())
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot read/)
  })
})
