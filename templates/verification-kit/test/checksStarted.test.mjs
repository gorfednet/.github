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
    assert.equal(resolveStartupState(7, repo, read).state, 'no-runs')
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
})
