import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { resolveStartupState } from '../bin/assert-checks-started.mjs'

describe('resolveStartupState', () => {
  const repo = 'gorfednet/example'
  const head = `repos/${repo}/pulls/7`
  const runsFor = (sha) => `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`

  function reader(map) {
    return (path) =>
      path in map ? { ok: true, data: map[path] } : { ok: false, error: `no stub for ${path}` }
  }

  it('passes when every run started', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: { workflow_runs: [{ name: 'CI', conclusion: 'success' }] },
    })
    assert.equal(resolveStartupState(7, repo, read).state, 'ok')
  })

  it('catches the run that never started, which produces no check runs', () => {
    // The real case: three pilot pull requests passed an input their reusable
    // workflow did not have yet. Each failed in one second and `gh pr checks`
    // listed only Bugbot, so all three looked ready to merge.
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { name: 'CI', conclusion: 'startup_failure', html_url: 'https://example/run/1' },
        ],
      },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'startup-failure')
    assert.equal(result.runs[0].name, 'CI')
  })

  it('treats action_required the same way, since it also yields no checks', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: { workflow_runs: [{ name: 'CI', conclusion: 'action_required' }] },
    })
    assert.equal(resolveStartupState(7, repo, read).state, 'startup-failure')
  })

  it('catches a run paused for approval, which has no conclusion at all', () => {
    // `action_required` as a conclusion only exists once a run has finished.
    // A run waiting on approval sits at `status: waiting` with a null
    // conclusion — blocked, no checks, somebody being waited on who does not
    // know it. That is the case V45 describes, and reading conclusion alone
    // let it come back ok.
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [{ name: 'CI', status: 'waiting', conclusion: null }],
      },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'startup-failure')
    assert.match(result.runs[0].conclusion, /waiting/)
  })

  it('lets a re-run supersede the startup failure it fixed', () => {
    // The whole recovery path: land the missing reusable-workflow input, then
    // re-run. A re-run adds an entry rather than replacing one, so judging
    // every historical run for the head leaves the PR red whatever is fixed —
    // and a guard that cannot go green is one people route around.
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { name: 'CI', workflow_id: 1, run_number: 2, conclusion: 'success' },
          { name: 'CI', workflow_id: 1, run_number: 1, conclusion: 'startup_failure' },
        ],
      },
    })
    assert.equal(resolveStartupState(7, repo, read).state, 'ok')
  })

  it('still fails when the newest attempt is the broken one', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { name: 'CI', workflow_id: 1, run_number: 1, run_attempt: 1, conclusion: 'success' },
          { name: 'CI', workflow_id: 1, run_number: 1, run_attempt: 2, conclusion: 'startup_failure' },
        ],
      },
    })
    assert.equal(resolveStartupState(7, repo, read).state, 'startup-failure')
  })

  it('does not let one healthy workflow cover for another that never started', () => {
    // Deduplication is per workflow, not global.
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { name: 'CI', workflow_id: 1, run_number: 9, conclusion: 'success' },
          { name: 'Lint', workflow_id: 2, run_number: 1, conclusion: 'startup_failure' },
        ],
      },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'startup-failure')
    assert.equal(result.runs[0].name, 'Lint')
  })

  it('refuses a head with no workflow runs at all', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: { workflow_runs: [] },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'no-runs')
    assert.equal(result.conflicting, false)
  })

  it('names a conflicting base as the reason nothing was dispatched', () => {
    // A `pull_request` event runs against the merge commit, so a branch that
    // conflicts with its base has nothing to run against and GitHub dispatches
    // no run at all — not queued, not failed, absent. #217 sat like that for
    // four minutes while the workflows were checked for a broken trigger,
    // because the old message named the two causes it knew and this was
    // neither. Closing and reopening the PR does not help; a rebase does.
    const read = reader({
      [head]: { head: { sha: 'abc' }, mergeable: false },
      [runsFor('abc')]: { workflow_runs: [] },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'no-runs')
    assert.equal(result.conflicting, true)
  })

  it('does not claim a conflict when GitHub has not computed mergeability yet', () => {
    // `mergeable` is null while the merge ref is still being computed. Guessing
    // "conflict" there would send the reader to rebase a branch that is fine.
    const read = reader({
      [head]: { head: { sha: 'abc' }, mergeable: null },
      [runsFor('abc')]: { workflow_runs: [] },
    })
    assert.equal(resolveStartupState(7, repo, read).conflicting, false)
  })

  it('reports an unreadable API as undetermined, never as ok', () => {
    // Rebuilding the fault one level up would be the funniest possible
    // outcome for this particular file.
    const read = () => ({ ok: false, error: 'HTTP 403: rate limited' })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'undetermined')
    assert.match(result.detail, /403/)
  })

  it('reports a pull request with no head sha as undetermined', () => {
    const read = reader({ [head]: {} })
    assert.equal(resolveStartupState(7, repo, read).state, 'undetermined')
  })

  // From 2026-09-29 GitHub refused to start any job on bindercurve.com while the
  // account's payment was failing. Every workflow run existed and concluded
  // failure in two seconds, each job with zero steps and the annotation "The job
  // was not started because recent account payments have failed or your
  // spending limit needs to be increased". This check said "all started"
  // because runs existed, and the checks panel showed a red branch that had
  // never been tested.
  const jobsFor = (id) => `repos/${repo}/actions/runs/${id}/jobs?per_page=100&filter=latest`

  it('catches jobs that failed without running a single step', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          {
            id: 11,
            name: 'deploy-check',
            workflow_id: 1,
            run_number: 3,
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://example/run/11',
          },
        ],
      },
      [jobsFor(11)]: {
        jobs: [
          { name: 'heavy-runner-preflight', conclusion: 'failure', steps: [] },
          { name: 'check', conclusion: 'skipped', steps: [] },
        ],
      },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'jobs-not-started')
    assert.deepEqual(
      result.jobs.map((job) => job.name),
      ['heavy-runner-preflight'],
    )
    assert.equal(result.jobs[0].run, 'deploy-check')
  })

  it('accepts a failed run whose jobs ran and failed, which is a real verdict', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { id: 12, name: 'CI', workflow_id: 1, status: 'completed', conclusion: 'failure' },
        ],
      },
      [jobsFor(12)]: {
        jobs: [
          {
            name: 'test',
            conclusion: 'failure',
            steps: [{ name: 'Set up job' }, { name: 'npm test' }],
          },
        ],
      },
    })
    assert.equal(resolveStartupState(7, repo, read).state, 'ok')
  })

  it('does not read jobs for runs that succeeded or are still running', () => {
    // Only a failed run can hide a refusal, and reading every run's jobs would
    // spend the rate limit on the common case. The reader has no jobs stubs, so
    // any read of them would come back undetermined.
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { id: 13, name: 'CI', workflow_id: 1, status: 'completed', conclusion: 'success' },
          { id: 14, name: 'Lint', workflow_id: 2, status: 'in_progress', conclusion: null },
        ],
      },
    })
    assert.equal(resolveStartupState(7, repo, read).state, 'ok')
  })

  it('reports unreadable jobs for a failed run as undetermined, never as ok', () => {
    const read = reader({
      [head]: { head: { sha: 'abc' } },
      [runsFor('abc')]: {
        workflow_runs: [
          { id: 15, name: 'CI', workflow_id: 1, status: 'completed', conclusion: 'failure' },
        ],
      },
    })
    const result = resolveStartupState(7, repo, read)
    assert.equal(result.state, 'undetermined')
    assert.match(result.detail, /jobs/)
  })
})
