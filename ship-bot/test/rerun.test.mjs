/**
 * Plan row 1.59, rule 1: a cancelled workflow run that alone keeps a labelled head from green is rerun once.
 * The rule is `cancelledRunsToRerun` (lib/gates.mjs) and `rerunCancelled` (lib/bot.mjs).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeGitHub, HEAD, SLUG, makePr, repoEntry, scenario } from './fakes.mjs'
import { MAX_ANNOTATION_READS, MAX_RERUN_ATTEMPT, RERUN_SETTLE_MINUTES, TIMEOUT_ANNOTATION, cancelledRunsToRerun } from '../lib/gates.mjs'
import { RateLimitError, createGitHubClient, guardWrites } from '../lib/github.mjs'

const NOW = new Date('2026-10-09T12:00:00Z')
const SETTLED = '2026-10-09T11:40:00Z'
const jobRun = (name, conclusion, runId, id, extra = {}) => ({ name, status: 'completed', conclusion, started_at: '2026-10-09T11:30:00Z', id, details_url: `https://actions.example/gorfednet/site/actions/runs/${runId}/job/${id}`, ...extra })
const wf = (id, extra = {}) => ({ id, workflow_id: 900, event: 'pull_request', head_sha: HEAD, status: 'completed', conclusion: 'cancelled', run_attempt: 1, updated_at: SETTLED, ...extra })
/** A green `check / check` from run 2 and a cancelled `e2e` from run 1: nothing replaced run 1. */
const runs = (...more) => [jobRun('check / check', 'success', 2, 11), jobRun('e2e', 'cancelled', 1, 10), ...more]
const flows = (...more) => [wf(1), wf(2, { workflow_id: 901, conclusion: 'success' }), ...more]
const plan = (over = {}) => cancelledRunsToRerun({ runs: runs(), statuses: [], workflowRuns: flows(), sha: HEAD, now: NOW, ...over })
const offer = (over = {}) => plan(over).ids
const NONE = { ids: [], settling: false, checks: {} }
const SETTLING = { ids: [], settling: true, checks: {} }
const OFFER = { ids: [1], settling: false, checks: { 1: [10] } }

describe('cancelledRunsToRerun: which cancelled workflow runs the bot may rerun', () => {
  it('offers the cancelled run when every other check on the head is green', () => {
    assert.deepEqual(offer(), [1])
    assert.deepEqual(offer({ statuses: [{ context: 'deploy/preview', state: 'success', created_at: SETTLED }] }), [1])
  })

  it('offers nothing beside a red, timed-out or still-running check', () => {
    for (const conclusion of ['failure', 'timed_out', 'action_required', null]) {
      assert.deepEqual(offer({ runs: runs(jobRun('lint', conclusion, 2, 12)) }), [], String(conclusion))
    }
    assert.deepEqual(offer({ runs: runs(jobRun('lint', null, 2, 12, { status: 'in_progress' })) }), [])
  })

  it('offers nothing beside a failing or pending commit status', () => {
    for (const state of ['failure', 'error', 'pending']) {
      assert.deepEqual(offer({ statuses: [{ context: 'deploy/preview', state, created_at: SETTLED }] }), [], state)
    }
  })

  it('offers nothing when a read is missing', () => {
    assert.deepEqual(offer({ workflowRuns: null }), [], 'the workflow runs could not be read')
    assert.deepEqual(offer({ workflowRuns: undefined }), [], 'the workflow runs were not read')
    assert.deepEqual(offer({ runs: null }), [])
    assert.deepEqual(offer({ statuses: null }), [])
    assert.deepEqual(offer({ sha: undefined }), [])
    assert.deepEqual(offer({ now: undefined }), [], 'no clock, so nothing says the cancel has settled')
  })

  it('offers nothing when the cancelled check maps to no cancelled workflow run on this head', () => {
    assert.deepEqual(offer({ runs: [jobRun('e2e', 'cancelled', 1, 10, { details_url: undefined })] }), [], 'no details_url')
    assert.deepEqual(offer({ runs: [jobRun('e2e', 'cancelled', 999, 10)] }), [], 'an unknown run id')
    assert.deepEqual(offer({ workflowRuns: [wf(1, { head_sha: 'd'.repeat(40) })] }), [], 'a run on another head')
    assert.deepEqual(offer({ workflowRuns: [wf(1, { conclusion: 'failure' })] }), [], 'the run failed; one job in it was cancelled')
    assert.deepEqual(offer({ workflowRuns: [wf(1, { status: 'in_progress', conclusion: null })] }), [], 'the run is going again')
    assert.deepEqual(offer({ workflowRuns: [wf(1, { workflow_id: undefined })] }), [], 'no workflow id')
  })

  it('a young cancel is settling, not refused: a label cancels a run and starts its replacement moments later', () => {
    const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString()
    const at = (updated_at) => plan({ workflowRuns: [wf(1, { updated_at })] })
    assert.deepEqual(at(minutesAgo(RERUN_SETTLE_MINUTES - 1)), SETTLING)
    assert.deepEqual(at(minutesAgo(0)), SETTLING)
    assert.deepEqual(at(minutesAgo(-2)), SETTLING, 'a clock a little behind GitHub’s')
    assert.deepEqual(at(minutesAgo(RERUN_SETTLE_MINUTES)), OFFER)
    assert.deepEqual(at(undefined), NONE, 'no time')
    assert.deepEqual(at('yesterday'), NONE, 'an unreadable time')
    assert.deepEqual(at(minutesAgo(-30)), NONE, 'a time well in the future')
    // One settled and one young cancel: nothing is rerun until both have settled.
    const two = { runs: [jobRun('a', 'cancelled', 1, 10), jobRun('b', 'cancelled', 2, 11)], workflowRuns: [wf(1), wf(2, { workflow_id: 901, updated_at: minutesAgo(1) })] }
    assert.deepEqual(plan(two), SETTLING)
  })

  it('settling is only for a head that would be rerun: anything else in the way is not a wait', () => {
    const young = wf(1, { updated_at: new Date(NOW.getTime() - 60000).toISOString() })
    assert.deepEqual(plan({ workflowRuns: [young] }), SETTLING)
    assert.deepEqual(plan({ workflowRuns: [young], runs: runs(jobRun('lint', 'failure', 2, 12)) }), NONE, 'a red check')
    assert.deepEqual(plan({ workflowRuns: [{ ...young, run_attempt: MAX_RERUN_ATTEMPT }] }), NONE, 'out of attempts')
    assert.deepEqual(plan({ workflowRuns: [young], asked: [1] }), NONE, 'the bot already asked for this run')
    assert.deepEqual(plan({ workflowRuns: [young], asked: [8, 9] }), NONE, 'the head has had its 2 reruns')
    assert.deepEqual(plan({ workflowRuns: [young], asked: null }), NONE, 'unreadable memory')
  })

  it('offers nothing while a required check is missing or was skipped: no rerun of another run lifts that', () => {
    assert.deepEqual(plan({ expectedChecks: ['check / check'] }), OFFER, 'present and green')
    assert.deepEqual(plan({ expectedChecks: ['check / check', 'e2e'] }), OFFER, 'the cancelled check is itself required')
    assert.deepEqual(plan({ expectedChecks: ['check / check', 'deploy'] }), NONE, 'missing')
    assert.deepEqual(plan({ expectedChecks: ['deploy'], statuses: [{ context: 'deploy', state: 'success', created_at: SETTLED }] }), OFFER, 'present as a status')
    for (const conclusion of ['skipped', 'neutral']) assert.deepEqual(plan({ expectedChecks: ['lint'], runs: runs(jobRun('lint', conclusion, 2, 12)) }), NONE, conclusion)
    assert.deepEqual(plan({ expectedChecks: null }), NONE, 'unreadable')
    // Still settling: the missing check is refused now, not hidden behind a 10-minute wait.
    const young = wf(1, { updated_at: new Date(NOW.getTime() - 60000).toISOString() })
    assert.deepEqual(plan({ workflowRuns: [young], expectedChecks: ['check / check', 'deploy'] }), NONE)
  })

  it('never offers a run the bot already asked for, nor one past the head’s cap of 2', () => {
    assert.deepEqual(offer({ asked: [1] }), [])
    assert.deepEqual(offer({ asked: [8] }), [1])
    assert.deepEqual(offer({ asked: [8, 9] }), [])
  })

  it('never offers a run already on its last allowed attempt, or one with no attempt number', () => {
    assert.deepEqual(offer({ workflowRuns: [wf(1, { run_attempt: MAX_RERUN_ATTEMPT - 1 })] }), [1])
    assert.deepEqual(offer({ workflowRuns: [wf(1, { run_attempt: MAX_RERUN_ATTEMPT })] }), [])
    assert.deepEqual(offer({ workflowRuns: [wf(1, { run_attempt: undefined })] }), [])
    assert.deepEqual(offer({ workflowRuns: [wf(1, { run_attempt: '1' })] }), [])
  })

  it('leaves a cancel alone while a later run of its workflow is going, green or red', () => {
    assert.deepEqual(offer({ workflowRuns: flows(wf(3, { status: 'in_progress', conclusion: null })) }), [], 'the replacement is running')
    assert.deepEqual(offer({ workflowRuns: flows(wf(3, { conclusion: 'success' })) }), [], 'superseded: nothing cancelled stands')
    assert.deepEqual(offer({ workflowRuns: flows(wf(3, { conclusion: 'failure' })) }), [], 'the replacement went red')
  })

  it('offers only the newest cancelled run of a workflow', () => {
    assert.deepEqual(plan({ workflowRuns: flows(wf(3)), runs: runs(jobRun('setup', 'cancelled', 3, 13)) }), { ids: [3], settling: false, checks: { 3: [13] } })
    assert.deepEqual(offer({ workflowRuns: flows(wf(3)) }), [], 'the newest run has no cancelled check run to read annotations from')
    assert.deepEqual(offer({ workflowRuns: flows(wf(3, { event: 'push' })) }), [1], 'another event is another series')
  })

  it('offers nothing when more than 2 workflow runs on the head stand cancelled', () => {
    const three = [jobRun('a', 'cancelled', 1, 10), jobRun('b', 'cancelled', 2, 11), jobRun('c', 'cancelled', 3, 12)]
    const list = [wf(1), wf(2, { workflow_id: 901 }), wf(3, { workflow_id: 902 })]
    assert.deepEqual(offer({ runs: three.slice(0, 2), workflowRuns: list }), [1, 2])
    assert.deepEqual(offer({ runs: three, workflowRuns: list }), [])
  })
})

describe('cancelledRunsToRerun: the run must be the labelled one, and its cancelled check runs readable', () => {
  const LABELLED = '2026-10-09T11:35:00Z'
  const labelled = (createdAt, over = {}) => plan({ requireAfterLabel: true, labeledAt: LABELLED, workflowRuns: [wf(1, { created_at: createdAt }), wf(2, { workflow_id: 901, conclusion: 'success' })], ...over })

  it('where checks must start after the label, a run created before the label is never offered: its rerun would pass for the labelled run', () => {
    assert.deepEqual(labelled('2026-10-09T11:34:59Z'), NONE, 'created a second before the label')
    assert.deepEqual(labelled(undefined), NONE, 'no creation time')
    assert.deepEqual(labelled('2026-10-09T11:36:00Z', { labeledAt: undefined }), NONE, 'the label time could not be read')
  })

  it('near miss: a run created at or after the label is offered, and so is an older run where the repository does not ask', () => {
    assert.deepEqual(labelled(LABELLED), OFFER)
    assert.deepEqual(labelled('2026-10-09T11:36:00Z'), OFFER)
    assert.deepEqual(labelled('2026-10-09T11:00:00Z', { requireAfterLabel: false }), OFFER)
  })

  it('names the cancelled check runs of each offered run, and offers nothing when one has no id or there are too many to read', () => {
    const many = (n) => runs(...Array.from({ length: n - 1 }, (_, i) => jobRun(`e2e (${i})`, 'cancelled', 1, 100 + i)))
    assert.deepEqual(plan({ runs: many(3) }).checks, { 1: [10, 100, 101] })
    assert.equal(plan({ runs: many(MAX_ANNOTATION_READS) }).checks[1].length, MAX_ANNOTATION_READS)
    assert.deepEqual(plan({ runs: many(MAX_ANNOTATION_READS + 1) }), NONE, 'one read too many')
    assert.deepEqual(plan({ runs: [jobRun('check / check', 'success', 2, 11), jobRun('e2e', 'cancelled', 1, undefined)] }), NONE, 'no check run id')
    assert.deepEqual(plan({ runs: [jobRun('check / check', 'success', 2, 11), jobRun('e2e', 'cancelled', 1, '10')] }), NONE, 'an id that is not a number')
  })
})

describe('a job that hit its timeout reports cancelled, and is not rerun', () => {
  const reruns = (gh) => gh.writes.filter((w) => w.name === 'rerunFailedJobs')
  const reads = (gh) => gh.calls.filter((c) => c.name === 'listCheckRunAnnotations')
  const world = (annotations, over = {}) => Object.assign(new FakeGitHub({ runs: runs(), workflowRuns: flows(), ...over }), { annotations })
  // What GitHub wrote on a job that ran past timeout-minutes (read from a real run, 21 November 2026), and on a plain cancel.
  const TIMED_OUT = [{ annotation_level: 'failure', path: '.github', title: '', message: 'The job has exceeded the maximum execution time of 45m0s' }, { annotation_level: 'failure', path: '.github', title: '', message: 'The operation was canceled.' }]
  const CANCELLED = [{ annotation_level: 'failure', path: '.github', title: '', message: 'The operation was canceled.' }]

  it('the pattern matches both of GitHub’s wordings and not a plain cancel', () => {
    assert.match('The job has exceeded the maximum execution time of 45m0s', TIMEOUT_ANNOTATION)
    assert.match('The job running on runner pool-1 has exceeded the maximum execution time of 35 minutes.', TIMEOUT_ANNOTATION)
    assert.doesNotMatch('The operation was canceled.', TIMEOUT_ANNOTATION)
    assert.doesNotMatch('Canceling since a higher priority waiting request for this concurrency group exists', TIMEOUT_ANNOTATION)
  })

  it('a timeout annotation on the cancelled check run refuses the rerun, once, with a warning and the usual refusal', async () => {
    const gh = world({ 10: TIMED_OUT })
    const s = scenario({ github: gh })
    await s.run()
    await s.run()
    assert.equal(reruns(gh).length, 0)
    assert.deepEqual(reads(gh).map((c) => c.args), [[SLUG, 10]], '1 read, never repeated')
    assert.ok(s.logs.some((l) => /^warn .*not rerunning cancelled workflow run 1: check run 10 hit its timeout/.test(l)), s.logs.join('\n'))
    assert.match(s.state().data.prs[`${SLUG}#7`].heads[HEAD].reruns[1].refused, /hit its timeout/)
    assert.match(gh.commentsPosted()[0].body, /checks did not pass on this head: e2e \(cancelled\)/)
  })

  it('a timeout on any one of a run’s cancelled check runs refuses the whole run', async () => {
    const gh = world({ 12: TIMED_OUT, 10: CANCELLED }, { runs: runs(jobRun('e2e (2)', 'cancelled', 1, 12)) })
    await scenario({ github: gh }).run()
    assert.equal(reruns(gh).length, 0)
    assert.deepEqual(reads(gh).map((c) => c.args[1]), [10, 12])
  })

  it('near miss: a plain cancel annotation, or none, is rerun after 1 read', async () => {
    for (const annotations of [{ 10: CANCELLED }, {}]) {
      const gh = world(annotations)
      await scenario({ github: gh }).run()
      assert.deepEqual(reruns(gh).map((w) => w.runId), [1])
      assert.equal(reads(gh).length, 1)
    }
  })

  it('fails closed when the annotations cannot be read: no rerun, and no second read on this head', async () => {
    for (const broken of [async () => { throw new Error('GET /repos/x/check-runs/10/annotations -> 502: Bad Gateway') }, async () => null, async () => Array.from({ length: 100 }, () => CANCELLED[0])]) {
      const gh = world({})
      let asks = 0
      gh.listCheckRunAnnotations = async () => {
        asks += 1
        return broken()
      }
      const s = scenario({ github: gh })
      await s.run()
      await s.run()
      assert.equal(reruns(gh).length, 0)
      assert.equal(asks, 1)
      assert.ok(s.logs.some((l) => /^warn .*not rerunning cancelled workflow run 1: .*nothing says it was a cancel and not a timeout/.test(l)), s.logs.join('\n'))
      assert.equal(gh.commentsPosted().length, 1)
    }
  })

  it('an annotation read the quota refused was never made, so the next pass reads again', async () => {
    const gh = world({})
    const real = gh.listCheckRunAnnotations.bind(gh)
    gh.listCheckRunAnnotations = async () => {
      throw new RateLimitError({ remaining: 0, resetAt: null, resource: 'core', status: 403 })
    }
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(s.state().data.prs[`${SLUG}#7`]?.heads?.[HEAD]?.reruns?.[1], undefined)
    gh.listCheckRunAnnotations = real
    s.clock.advance(120)
    const store = s.state()
    delete store.data.rateLimits
    store.save()
    await s.run()
    assert.equal(reruns(gh).length, 1)
  })

  it('a run from before the label is not rerun where the repository requires checks after the label', async () => {
    const events = [{ event: 'labeled', label: { name: 'ready-to-merge' }, created_at: '2026-10-09T11:35:00Z' }]
    const before = world({}, { events, workflowRuns: [wf(1, { created_at: '2026-10-09T11:30:00Z' }), wf(2, { workflow_id: 901, conclusion: 'success' })] })
    await scenario({ github: before, repos: [repoEntry({ requireChecksAfterLabel: true })] }).run()
    assert.equal(reruns(before).length, 0)
    assert.equal(reads(before).length, 0)
    // Near miss: the same run, created after the label.
    const after = world({}, { events, workflowRuns: [wf(1, { created_at: '2026-10-09T11:36:00Z' }), wf(2, { workflow_id: 901, conclusion: 'success' })] })
    await scenario({ github: after, repos: [repoEntry({ requireChecksAfterLabel: true })] }).run()
    assert.deepEqual(reruns(after).map((w) => w.runId), [1])
  })
})

describe('a labelled head blocked only by a cancelled run', () => {
  const reruns = (gh) => gh.writes.filter((w) => w.name === 'rerunFailedJobs')
  const world = (over = {}) => new FakeGitHub({ runs: runs(), workflowRuns: flows(), ...over })

  it('is rerun once, with no refusal comment, and never a second time for the same run and head', async () => {
    const gh = world()
    const s = scenario({ github: gh })
    await s.run()
    assert.deepEqual(gh.writes, [{ name: 'rerunFailedJobs', slug: SLUG, runId: 1 }])
    assert.ok(s.state().data.prs[`${SLUG}#7`].heads[HEAD].reruns[1].at)
    // The rerun was cancelled again: the same picture on the next pass.
    await s.run()
    assert.equal(reruns(gh).length, 1, 'not asked for twice')
    assert.match(gh.commentsPosted()[0].body, /checks did not pass on this head: e2e \(cancelled\)/)
    assert.equal(gh.writes.filter((w) => w.name === 'mergePull').length, 0, 'cancelled is never a pass')
  })

  it('the cap of 2 counts every rerun the head ever had, not one pass', async () => {
    const gh = world()
    const s = scenario({ github: gh })
    await s.run()
    assert.deepEqual(reruns(gh).map((w) => w.runId), [1])
    // Run 1 went green. Later, runs 5 and 6 of two other workflows are cancelled on the same head.
    const later = () => [jobRun('check / check', 'success', 2, 11), jobRun('e2e (1)', 'success', 1, 20), jobRun('lint', 'cancelled', 5, 30), jobRun('types', 'cancelled', 6, 31)]
    gh.runs = later()
    gh.workflowRuns = [wf(1, { conclusion: 'success', run_attempt: 2 }), wf(2, { workflow_id: 901, conclusion: 'success' }), wf(5, { workflow_id: 902 }), wf(6, { workflow_id: 903 })]
    await s.run()
    assert.deepEqual(reruns(gh).map((w) => w.runId), [1], '1 already asked plus 2 new would be 3')
    assert.match(gh.commentsPosted()[0].body, /lint \(cancelled\), types \(cancelled\)/)
    // One more cancelled run is the head's second and last.
    const one = world()
    const t = scenario({ github: one })
    await t.run()
    one.runs = later().slice(0, 3)
    one.workflowRuns = [wf(1, { conclusion: 'success', run_attempt: 2 }), wf(2, { workflow_id: 901, conclusion: 'success' }), wf(5, { workflow_id: 902 })]
    await t.run()
    assert.deepEqual(reruns(one).map((w) => w.runId), [1, 5])
  })

  it('a fresh cancel waits out the settle time in silence, is rerun, and only a second cancel gets the refusal', async () => {
    const cancelledAt = (iso, attempt = 1) => [wf(1, { updated_at: iso, run_attempt: attempt }), wf(2, { workflow_id: 901, conclusion: 'success' })]
    const gh = world({ workflowRuns: cancelledAt('2026-10-09T11:58:00Z') })
    const s = scenario({ github: gh })
    await s.run()
    assert.deepEqual(gh.writes, [], 'no comment and no rerun while it settles')
    assert.ok(s.logs.some((l) => /^debug .*a cancelled workflow run is all that blocks this head/.test(l)), 'a wait, said at debug')
    assert.equal(s.state().data.prs[`${SLUG}#7`].heads[HEAD].stall, undefined, 'no stall clock')
    s.clock.advance(RERUN_SETTLE_MINUTES)
    await s.run()
    assert.deepEqual(gh.writes, [{ name: 'rerunFailedJobs', slug: SLUG, runId: 1 }])
    // The rerun is cancelled too, just now: the bot asked once, so this is a person's, and the comment says so at once.
    gh.workflowRuns = cancelledAt('2026-10-09T12:11:00Z', 2)
    s.clock.advance(2)
    await s.run()
    assert.equal(reruns(gh).length, 1)
    assert.match(gh.commentsPosted()[0].body, /checks did not pass on this head: e2e \(cancelled\)/)
  })

  it('a draft with a fresh cancel is not held as settling: the bot never reruns for a draft', async () => {
    const gh = world({ pulls: [makePr({ draft: true, labels: [], node_id: 'PR_node7', body: '## Next\n- [ ] Merge.' })], workflowRuns: [wf(1, { updated_at: '2026-10-09T11:58:00Z' })] })
    const s = scenario({ github: gh, repos: [{ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'r', live: true, claudeReview: false, expectedChecks: ['check / check'] }] })
    await s.run()
    assert.equal(reruns(gh).length, 0)
    assert.equal(s.logs.some((l) => /a cancelled workflow run is all that blocks this head/.test(l)), false)
    assert.ok(s.logs.some((l) => /draft/.test(l) && /e2e \(cancelled\)/.test(l)), s.logs.join('\n'))
  })

  it('a required check that never appeared is refused as usual, and nothing is rerun for it', async () => {
    const gh = world()
    const s = scenario({ github: gh, repos: [repoEntry({ expectedChecks: ['check / check', 'deploy'] })] })
    s.clock.advance(60)
    await s.run()
    assert.equal(reruns(gh).length, 0)
    assert.match(gh.commentsPosted()[0].body, /required checks never appeared on this head: deploy/)
  })

  it('merges on a later pass once the rerun is green', async () => {
    const gh = world()
    const s = scenario({ github: gh })
    await s.run()
    gh.runs = [jobRun('check / check', 'success', 2, 11), jobRun('e2e (1)', 'success', 1, 20)]
    await s.run()
    assert.equal(gh.writes.filter((w) => w.name === 'mergePull').length, 1)
  })

  it('near miss: one red check beside the cancel, and nothing is rerun', async () => {
    const gh = world({ runs: runs(jobRun('lint', 'failure', 2, 12)) })
    await scenario({ github: gh }).run()
    assert.equal(reruns(gh).length, 0)
    assert.match(gh.commentsPosted()[0].body, /lint \(failure\)/)
  })

  it('near miss: unreadable workflow runs wait, and nothing is rerun', async () => {
    const gh = world()
    gh.listWorkflowRuns = async () => {
      throw new Error('boom')
    }
    await scenario({ github: gh }).run()
    assert.equal(gh.writes.length, 0)
  })

  it('is not rerun without the label, with hold, or as a draft', async () => {
    for (const pr of [makePr({ labels: [] }), makePr({ labels: [{ name: 'ready-to-merge' }, { name: 'hold' }] }), makePr({ draft: true, body: '## Next\n- [ ] Merge.' })]) {
      const gh = world({ pulls: [pr] })
      await scenario({ github: gh }).run()
      assert.equal(reruns(gh).length, 0, JSON.stringify(pr.labels))
    }
  })

  it('a dry run and a repository that is not live only say so', async () => {
    const dry = world()
    const s = scenario({ github: dry })
    await s.run('dry-run')
    assert.equal(dry.writes.length, 0)
    const would = /would rerun cancelled workflow run\(s\) 1/
    assert.ok(s.logs.some((l) => l.startsWith('debug ') && would.test(l)), JSON.stringify(s.logs.slice(-3)))
    const observed = world()
    const o = scenario({ github: observed, repos: [repoEntry({ live: false })] })
    await o.run()
    await o.run()
    assert.equal(observed.writes.length, 0)
    // Nothing is remembered for a repository that is not live, so the line would repeat every pass: debug only, and no annotation read.
    assert.equal(o.logs.filter((l) => would.test(l) && !l.startsWith('debug ')).length, 0, o.logs.join('\n'))
    assert.ok(o.logs.some((l) => would.test(l)))
    for (const gh of [dry, observed]) assert.equal(gh.calls.filter((c) => c.name === 'listCheckRunAnnotations').length, 0)
  })

  it('a refused rerun is said once as a warning, is not tried again, and the head gets the usual refusal', async () => {
    const gh = world()
    let asks = 0
    gh.rerunFailedJobs = async () => {
      asks += 1
      throw Object.assign(new Error('POST /repos/x/actions/runs/1/rerun-failed-jobs -> 403: Resource not accessible by integration'), { status: 403 })
    }
    const s = scenario({ github: gh })
    await s.run()
    await s.run()
    assert.equal(asks, 1)
    assert.ok(s.logs.some((l) => /could not rerun cancelled workflow run 1 \(the GitHub App needs the Actions permission set to write\)/.test(l.text ?? l)))
    assert.equal(gh.commentsPosted().length, 1)
    assert.equal(s.state().data.prs[`${SLUG}#7`].heads[HEAD].reruns[1].failed, true)
  })

  it('a rerun the quota refused was never made, so the next pass asks again', async () => {
    const gh = world()
    const real = gh.rerunFailedJobs.bind(gh)
    gh.rerunFailedJobs = async () => {
      throw new RateLimitError({ remaining: 0, resetAt: null, resource: 'core', status: 403 })
    }
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(s.state().data.prs[`${SLUG}#7`]?.heads?.[HEAD]?.reruns?.[1], undefined)
    gh.rerunFailedJobs = real
    s.clock.advance(120)
    const store = s.state()
    delete store.data.rateLimits
    store.save()
    await s.run()
    assert.equal(reruns(gh).length, 1)
  })
})

describe('rerunFailedJobs on the real client', () => {
  it('is a write a dry run refuses', async () => {
    await assert.rejects(async () => guardWrites(new FakeGitHub()).rerunFailedJobs(SLUG, 1), /dry run: refused GitHub write rerunFailedJobs/)
  })

  it('posts to the run it was given, and to nothing that is not a run id', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push(`${init.method} ${url}`)
      return { status: 201, ok: true, headers: new Map(), text: async () => '' }
    }
    const client = createGitHubClient({ token: 'x', fetchImpl })
    await client.rerunFailedJobs('example-org/example-site', 42)
    assert.deepEqual(seen, ['POST https://api.github.com/repos/example-org/example-site/actions/runs/42/rerun-failed-jobs'])
    for (const bad of ['7/../../x', '42', 0, -1, 1.5, NaN, undefined]) {
      await assert.rejects(async () => client.rerunFailedJobs('example-org/example-site', bad), /a workflow run id is a positive integer/, String(bad))
    }
    assert.equal(seen.length, 1, 'no request for anything but a run id')
  })

  it('reads one check run’s annotations in 1 GET, and nothing for what is not a check run id', async () => {
    const seen = []
    let body = '[{"message":"The operation was canceled."}]'
    const fetchImpl = async (url, init) => {
      seen.push(`${init.method} ${url}`)
      return { status: 200, ok: true, headers: new Map(), text: async () => body }
    }
    const client = createGitHubClient({ token: 'x', fetchImpl })
    assert.deepEqual(await client.listCheckRunAnnotations('example-org/example-site', 10), [{ message: 'The operation was canceled.' }])
    assert.deepEqual(seen, ['GET https://api.github.com/repos/example-org/example-site/check-runs/10/annotations?per_page=100'])
    for (const bad of ['10/../../x', '10', 0, -1, 1.5, undefined]) {
      await assert.rejects(async () => client.listCheckRunAnnotations('example-org/example-site', bad), /a check run id is a positive integer/, String(bad))
    }
    assert.equal(seen.length, 1)
    body = '{"message":"unexpected"}'
    await assert.rejects(async () => client.listCheckRunAnnotations('example-org/example-site', 11), /expected an array/)
  })
})
