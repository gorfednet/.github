/**
 * Behavioural tests for the three plain-node CLIs. Each asserts the failing
 * direction first, because a check nobody has watched go red is an assumption.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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

  /*
   * A retry that passes. Playwright exits 0, the aggregate line says
   * "flaky: 1", and the name of the test is nowhere — so an intermittent
   * failure is visible only to somebody who downloads the JSON report and
   * reads `retry` fields. The fixture below is the shape a real run produces,
   * taken from one built on purpose: status "flaky", one failed attempt then a
   * passed one.
   */
  const flakyReport = (title = 'holds the anchor') => ({
    suites: [
      {
        specs: [
          {
            file: 'e2e/regenerate-scroll.spec.ts',
            title,
            tests: [{ status: 'flaky', results: [{ retry: 0, status: 'failed' }, { retry: 1, status: 'passed' }] }],
          },
        ],
      },
    ],
  })

  it('names the test that only passed on a retry', () => {
    const report = writeReport(flakyReport())
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '1'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /passed only on a retry/)
    assert.match(result.stderr, /regenerate-scroll\.spec\.ts › holds the anchor \(failed then passed\)/)
  })

  it('says nothing about retries when there were none', () => {
    const report = writeReport(playwright(['passed', 'passed']))
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '2'])
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /retry/)
  })

  /*
   * `test.fail()` — a test asserting that something is broken. Playwright marks
   * it `expected` with a failed attempt, and the first version of this counted
   * any failed attempt as a retry, so it reported a passing suite as flaky and a
   * repository with a budget of 0 would have gone red over tests behaving as
   * written. Bugbot found this on nine consumer pull requests simultaneously.
   */
  it('does not report an expected failure as having needed a retry', () => {
    const report = writeReport({
      suites: [
        {
          specs: [
            {
              file: 'e2e/known-broken.spec.ts',
              title: 'documents the bug',
              tests: [{ status: 'expected', results: [{ retry: 0, status: 'failed' }] }],
            },
          ],
        },
      ],
    })
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '1'])
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /retry/)

    // And a declared budget of zero must not be spent on it.
    const budgeted = runCli('assert-tests-executed.mjs', [
      '--report', report, '--min', '1', '--max-flaky', '0',
    ])
    assert.equal(budgeted.status, 0, budgeted.stderr)
  })

  // The commonest intermittent shape there is, and the first version missed it.
  it('names a test that timed out and passed on the retry', () => {
    const report = writeReport({
      suites: [
        {
          specs: [
            {
              file: 'e2e/slow.spec.ts',
              title: 'waits for fonts',
              tests: [
                {
                  status: 'expected',
                  results: [{ retry: 0, status: 'timedOut' }, { retry: 1, status: 'passed' }],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '1'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /slow\.spec\.ts › waits for fonts \(timedOut then passed\)/)
  })

  // A budget is enforceable only if exceeding it is a failure.
  it('fails once a declared retry budget is exceeded, and passes within it', () => {
    const report = writeReport(flakyReport())
    const over = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '1', '--max-flaky', '0'])
    assert.equal(over.status, 1)
    assert.match(over.stderr, /budget is 0/)
    assert.match(over.stderr, /regenerate-scroll\.spec\.ts › holds the anchor/)

    const within = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '1', '--max-flaky', '1'])
    assert.equal(within.status, 0, within.stderr)
  })

  // A test that failed every attempt is a failure, not a retry to report.
  it('does not report a test that never passed as having needed a retry', () => {
    const report = writeReport({
      suites: [
        {
          specs: [
            {
              file: 'e2e/broken.spec.ts',
              title: 'always fails',
              tests: [
                { status: 'unexpected', results: [{ retry: 0, status: 'failed' }, { retry: 1, status: 'failed' }] },
              ],
            },
          ],
        },
      ],
    })
    const result = runCli('assert-tests-executed.mjs', ['--report', report, '--min', '1'])
    assert.doesNotMatch(result.stderr, /passed only on a retry/)
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

  /**
   * `--verify-prs`, which asks GitHub whether the statuses are still true.
   *
   * Driven through a stub `gh` on PATH rather than a mocked module, so what runs
   * is the real `gh api` path with a different `gh`. The stub answers by
   * filename, one per API path, and anything it was not given a file for exits
   * like `gh` does on a 404.
   */
  describe('--verify-prs', () => {
    function entry(overrides) {
      return {
        id: 'x',
        title: PROSE,
        status: 'in-review',
        assignee: 'main-model',
        userSymptom: PROSE,
        evidence: PROSE,
        pr: 7,
        ...overrides,
      }
    }

    function stubGh(dir, responses, { transportFailure = false } = {}) {
      const binDir = join(dir, 'stub-bin')
      mkdirSync(binDir, { recursive: true })
      const replies = join(dir, 'replies')
      mkdirSync(replies, { recursive: true })
      for (const [path, body] of Object.entries(responses)) {
        writeFileSync(join(replies, path.replaceAll('/', '_')), JSON.stringify(body), 'utf8')
      }
      const script = transportFailure
        ? '#!/bin/sh\necho "dial tcp: lookup api.github.com: no such host" >&2\nexit 1\n'
        : `#!/bin/sh
# $1 is "api", $2 the path.
file="${replies}/$(echo "$2" | tr '/' '_')"
if [ -f "$file" ]; then cat "$file"; exit 0; fi
echo "gh: Not Found (HTTP 404)" >&2
exit 1
`
      const path = join(binDir, 'gh')
      writeFileSync(path, script, 'utf8')
      chmodSync(path, 0o755)
      return { PATH: `${binDir}${delimiter}${process.env.PATH}` }
    }

    function runVerify(dir, env) {
      return spawnSync('node', [bin('check-backlog.mjs'), '--verify-prs', '--repo', 'o/r'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      })
    }

    it('passes when an in-review entry names an open pull request', () => {
      const dir = backlogAt({ entries: [entry({})] })
      const env = stubGh(dir, {
        'repos/o/r': { full_name: 'o/r' },
        'repos/o/r/pulls/7': { state: 'open', merged: false },
      })
      const result = runVerify(dir, env)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /1 of 1 pull request\(s\) agree/)
    })

    /*
     * The entry describing the pull request being reviewed. There is no status
     * that is true on both sides of its own merge, so one form is exempt and the
     * other is refused where the author can see it. Learned by shipping the
     * option without this and turning the kit repository's own main red.
     */
    describe('the entry for the pull request under review', () => {
      it('exempts a landed entry naming the pull request under review', () => {
        const dir = backlogAt({ entries: [entry({ status: 'landed' })] })
        const env = stubGh(dir, { 'repos/o/r': { full_name: 'o/r' } })
        const result = runVerify(dir, { ...env, GITHUB_REF: 'refs/pull/7/merge' })
        assert.equal(result.status, 0, result.stderr)
        // And says so, rather than reading like a run that checked it.
        assert.match(result.stdout, /1 exempt as the entry for #7/)
      })

      it('refuses an in-review entry naming the pull request under review', () => {
        const dir = backlogAt({ entries: [entry({})] })
        const env = stubGh(dir, { 'repos/o/r': { full_name: 'o/r' } })
        const result = runVerify(dir, { ...env, GITHUB_REF: 'refs/pull/7/merge' })
        assert.equal(result.status, 1)
        assert.match(result.stderr, /in-review about #7, the pull request under review/)
        assert.match(result.stderr, /Write landed instead/)
      })

      it('takes the number explicitly, for callers with no GITHUB_REF', () => {
        const dir = backlogAt({ entries: [entry({ status: 'landed' })] })
        const env = stubGh(dir, { 'repos/o/r': { full_name: 'o/r' } })
        const result = spawnSync(
          'node',
          [bin('check-backlog.mjs'), '--verify-prs', '--repo', 'o/r', '--current-pr', '7'],
          { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } },
        )
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /1 exempt as the entry for #7/)
      })

      // The exemption is for one pull request, not for the concept of one.
      it('still checks a landed entry naming a different pull request', () => {
        const dir = backlogAt({ entries: [entry({ status: 'landed', pr: 4 })] })
        const env = stubGh(dir, {
          'repos/o/r': { full_name: 'o/r' },
          'repos/o/r/pulls/4': { state: 'open', merged: false },
        })
        const result = runVerify(dir, { ...env, GITHUB_REF: 'refs/pull/7/merge' })
        assert.equal(result.status, 1)
        assert.match(result.stderr, /is landed but PR #4 is open/)
      })
    })

    // The case that motivated the option: two entries in this repository's own
    // backlog claimed in-review for pull requests that had merged.
    it('fails when an in-review entry names a merged pull request', () => {
      const dir = backlogAt({ entries: [entry({})] })
      const env = stubGh(dir, {
        'repos/o/r': { full_name: 'o/r' },
        'repos/o/r/pulls/7': { state: 'closed', merged: true, merged_at: '2026-09-01T00:00:00Z' },
      })
      const result = runVerify(dir, env)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /in-review but PR #7 is merged/)
    })

    it('fails when a landed entry names a pull request that is still open', () => {
      const dir = backlogAt({ entries: [entry({ status: 'landed' })] })
      const env = stubGh(dir, {
        'repos/o/r': { full_name: 'o/r' },
        'repos/o/r/pulls/7': { state: 'open', merged: false },
      })
      const result = runVerify(dir, env)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /landed but PR #7 is open, not merged/)
    })

    it('fails when an in-review entry names a pull request closed without merging', () => {
      const dir = backlogAt({ entries: [entry({})] })
      const env = stubGh(dir, {
        'repos/o/r': { full_name: 'o/r' },
        'repos/o/r/pulls/7': { state: 'closed', merged: false },
      })
      const result = runVerify(dir, env)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /closed without merging/)
    })

    /*
     * A 404 on the pull request means the same thing as a token that cannot see
     * the repository, so the repository is probed first. With that probe
     * answered, a missing pull request is a real disagreement.
     */
    it('fails when the entry names a pull request that does not exist', () => {
      const dir = backlogAt({ entries: [entry({ pr: 9999 })] })
      const env = stubGh(dir, { 'repos/o/r': { full_name: 'o/r' } })
      const result = runVerify(dir, env)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /names PR #9999, which does not exist/)
    })

    // And the same 404 with the repository itself unreadable is a skip, not a
    // verdict — the distinction the probe exists to draw.
    it('skips, counted, when the repository itself cannot be read', () => {
      const dir = backlogAt({ entries: [entry({})] })
      const env = stubGh(dir, {})
      const result = runVerify(dir, env)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /SKIPPED all 1 entry/)
      assert.match(result.stdout, /GitHub unreachable/)
    })

    it('skips, counted, when GitHub is unreachable', () => {
      const dir = backlogAt({ entries: [entry({})] })
      const env = stubGh(dir, {}, { transportFailure: true })
      const result = runVerify(dir, env)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /SKIPPED all 1 entry/)
      assert.match(result.stdout, /no such host/)
    })

    // Opt-in: the schema half must keep working for a project that never turns
    // this on, and for one running with no network at all.
    it('does not touch GitHub unless asked', () => {
      const dir = backlogAt({ entries: [entry({})] })
      const env = stubGh(dir, {}, { transportFailure: true })
      const result = runCli('check-backlog.mjs', [], dir)
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout, /verify-prs/)
      void env
    })

    it('says so when no entry names a pull request', () => {
      const dir = backlogAt({ entries: [entry({ status: 'confirmed-bug', pr: undefined })] })
      const env = stubGh(dir, { 'repos/o/r': { full_name: 'o/r' } })
      const result = runVerify(dir, env)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /0 entries name a pull request/)
    })
  })
})
