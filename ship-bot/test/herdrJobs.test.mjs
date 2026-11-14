import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { JOBS_SUBDIR, diagnosisJob, writeJobOnce } from '../lib/herdr-jobs.mjs'
import { FakeGitHub, SLUG, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const jobsOf = (s) => {
  const dir = join(s.home, 'src', JOBS_SUBDIR)
  return existsSync(dir) ? readdirSync(dir) : []
}
const withJobsDir = (s) => mkdirSync(join(s.home, 'src', JOBS_SUBDIR), { recursive: true })
const writes = (gh, name) => gh.writes.filter((w) => w.name === name)

describe('a repo block queues one diagnosis job (row 1.14)', () => {
  const blockedScenario = () => {
    const gh = new FakeGitHub()
    gh.mergeResult = () => new Error('The operation was aborted due to timeout')
    const s = scenario({ github: gh })
    withJobsDir(s)
    return s
  }
  it('writes a valid queued job once, however many passes see the block', async () => {
    const s = blockedScenario()
    await s.run() // the merge ends unclear: the repo is blocked
    assert.deepEqual(jobsOf(s), [], 'the pass that blocks writes nothing; the next one sees the block')
    await s.run()
    await s.run()
    await s.run()
    const files = jobsOf(s)
    assert.equal(files.length, 1)
    const job = JSON.parse(readFileSync(join(s.home, 'src', JOBS_SUBDIR, files[0]), 'utf8'))
    assert.equal(job.id, files[0].replace('.json', ''))
    assert.match(job.id, /^[a-z0-9][a-z0-9_-]{0,31}$/)
    assert.deepEqual([job.status, job.kind, job.owner, job.priority, job.run.role, job.run.pr], ['queued', 'claude', 'herdr', 1, 'builder', true])
    assert.match(job.run.task, /may or may not be merged/)
    assert.match(job.run.task, /Never run ship-bot --unblock/)
    assert.ok(job.next)
  })
  it('a second block on the same repo is a second job', async () => {
    const s = blockedScenario()
    await s.run()
    await s.run()
    await s.run('live', {}) // same block
    assert.equal(jobsOf(s).length, 1)
    const st = s.state()
    delete st.repo(SLUG).blocked
    st.repo(SLUG).blocked = { reason: 'another', at: '2026-10-10T01:00:00.000Z', pr: 8 }
    st.save()
    await s.run()
    assert.equal(jobsOf(s).length, 2)
  })
  it('a repo row without sourceDir (merge-only) still gets a working directory in its job', async () => {
    const s = scenario({ repos: [{ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'r', live: true, claudeReview: false, expectedChecks: ['check / check'] }] })
    withJobsDir(s)
    const st = s.state()
    st.repo(SLUG).blocked = { reason: 'seeded', at: '2026-10-09T11:00:00.000Z', pr: 7 }
    st.save()
    await s.run()
    const [f] = jobsOf(s)
    assert.equal(JSON.parse(readFileSync(join(s.home, 'src', JOBS_SUBDIR, f), 'utf8')).run.cwd, join(s.home, 'src', 'site'))
  })
  it('a dry run and a machine without the ops clone write nothing', async () => {
    const s = blockedScenario()
    await s.run()
    await s.run('dry-run')
    assert.deepEqual(jobsOf(s), [])
    assert.ok(s.logs.some((l) => /would queue diagnosis job blk-/.test(l)))
    const bare = scenario({ github: Object.assign(new FakeGitHub(), { mergeResult: () => new Error('timeout') }) })
    await bare.run()
    await bare.run()
    assert.ok(bare.logs.some((l) => /no Herdr jobs folder/.test(l)))
  })
  it('writeJobOnce never overwrites a claimed job', () => {
    const calls = []
    const write = (p, c, o) => { calls.push(o.flag); throw Object.assign(new Error('x'), { code: 'EEXIST' }) }
    assert.equal(writeJobOnce('/x', { id: 'a' }, write), 'exists')
    assert.deepEqual(calls, ['wx'])
    assert.equal(diagnosisJob({ slug: 'gorfednet/MoonMan' }, { at: 't', reason: 'r' }, '/d').id.startsWith('blk-moonman-'), true)
  })
})

describe('unanswered reviewer findings get needs-fix (row 1.14)', () => {
  const findings = (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined)
  const thread = { isResolved: false, author: 'github-actions', path: 'src/a.ts', line: 3, url: 'https://github.com/x/1' }
  const setup = () => {
    const gh = new FakeGitHub({ threads: [thread] })
    return { gh, s: scenario({ repos: [repoEntry({ claudeReview: true })], github: gh, runner: makeRunner({ handle: findings }) }) }
  }
  it('adds the label once, and takes it off when every thread is answered', async () => {
    const { gh, s } = setup()
    await s.run()
    assert.deepEqual(writes(gh, 'addLabels'), [{ name: 'addLabels', slug: SLUG, n: 7, labels: ['needs-fix'] }])
    gh.pulls[0] = makePr({ labels: [{ name: 'ready-to-merge' }, { name: 'needs-fix' }] })
    await s.run()
    await s.run()
    assert.equal(writes(gh, 'addLabels').length, 1, 'already labelled: no second add')
    assert.equal(writes(gh, 'removeLabel').length, 0, 'the threads are still open')
    gh.threads = [{ ...thread, isResolved: true }]
    await s.run()
    assert.deepEqual(writes(gh, 'removeLabel').map((w) => w.label), ['needs-fix'])
  })
  it('a PR the owner puts on hold, or that loses ready-to-merge, loses needs-fix', async () => {
    for (const labels of [['ready-to-merge', 'needs-fix', 'hold'], ['needs-fix']]) {
      const gh = new FakeGitHub({ pulls: [makePr({ labels: labels.map((name) => ({ name })) })] })
      await scenario({ repos: [repoEntry({ claudeReview: true })], github: gh }).run()
      assert.deepEqual(writes(gh, 'removeLabel').map((w) => w.label), ['needs-fix'], labels.join())
    }
  })
  it('a dry run only says so, and a block that hides the review gate keeps the label', async () => {
    const { gh, s } = setup()
    await s.run('dry-run')
    assert.equal(writes(gh, 'addLabels').length, 0)
    assert.ok(s.logs.some((l) => /would add needs-fix/.test(l)))
    const red = new FakeGitHub({ pulls: [makePr({ labels: [{ name: 'ready-to-merge' }, { name: 'needs-fix' }] })], runs: [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' }] })
    await scenario({ repos: [repoEntry({ claudeReview: true })], github: red }).run()
    assert.equal(writes(red, 'removeLabel').length, 0, 'failing checks stop the gates before the review one: the label is not judged')
  })
})

describe('a labelled PR refused for the same reason over 2 hours becomes a job (row 1.14)', () => {
  const red = (name = 'check / check') => [{ name, status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' }]
  const setup = () => {
    const gh = new FakeGitHub({ runs: red() })
    const s = scenario({ github: gh })
    withJobsDir(s)
    return { gh, s }
  }
  it('writes exactly one job once the same refusal is 2 hours old, not before', async () => {
    const { s } = setup()
    await s.run()
    s.clock.advance(119)
    await s.run()
    assert.deepEqual(jobsOf(s), [])
    s.clock.advance(2)
    await s.run()
    await s.run()
    s.clock.advance(60)
    await s.run()
    const files = jobsOf(s)
    assert.equal(files.length, 1)
    const job = JSON.parse(readFileSync(join(s.home, 'src', JOBS_SUBDIR, files[0]), 'utf8'))
    assert.match(job.id, /^stl-site-7-/)
    assert.equal(job.next, 'https://github.com/gorfednet/site/pull/7')
    assert.equal(job.run.pr, true)
  })
  it('a changed reason restarts the clock', async () => {
    const { gh, s } = setup()
    await s.run()
    s.clock.advance(100)
    gh.runs = []
    await s.run()
    s.clock.advance(100)
    await s.run()
    assert.deepEqual(jobsOf(s), [], 'two refusals of 100 minutes each, for different reasons')
  })
})
