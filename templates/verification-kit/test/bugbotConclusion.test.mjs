import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  classifyBugbotRun,
  resolveCommitReview,
  resolvePullRequestReview,
} from '../lib/bugbotConclusion.mjs'

describe('classifyBugbotRun', () => {
  it('reads a success conclusion as clean', () => {
    const result = classifyBugbotRun({
      conclusion: 'success',
      output: { summary: 'Bugbot completed review - no issues found! ✅' },
    })
    assert.equal(result.state, 'clean')
  })

  // The whole reason this file exists. Verbatim payload shape from
  // bindercurve.com #172, which reported neutral while carrying two findings.
  it('reads neutral WITH a completed-review summary as findings, not as skipped', () => {
    const result = classifyBugbotRun({
      conclusion: 'neutral',
      output: {
        summary:
          'Bugbot completed review and found 2 potential issues.\n' +
          '**Final Result:** 2 issues found',
      },
    })
    assert.equal(result.state, 'findings')
    assert.equal(result.detail, '2 issues found')
  })

  it('reads neutral with unresolved prior findings as findings', () => {
    const result = classifyBugbotRun({
      conclusion: 'neutral',
      output: {
        summary:
          'Bugbot completed review - no issues found. 1 previously reported issue remain unresolved.',
      },
    })
    assert.equal(result.state, 'findings')
  })

  it('reads neutral WITHOUT a completed-review summary as not run', () => {
    const result = classifyBugbotRun({ conclusion: 'neutral', output: { summary: '' } })
    assert.equal(result.state, 'not-run')
  })

  it('reads a missing check run as not run', () => {
    assert.equal(classifyBugbotRun(undefined).state, 'not-run')
    assert.equal(classifyBugbotRun(null).state, 'not-run')
  })
})

describe('resolvePullRequestReview', () => {
  function reader(map) {
    return (path) =>
      path in map ? { ok: true, data: map[path] } : { ok: false, error: `no stub for ${path}` }
  }

  const repo = 'gorfednet/example'

  it('resolves a clean review through the head sha', () => {
    const read = reader({
      [`repos/${repo}/pulls/7`]: { head: { sha: 'abc' } },
      [`repos/${repo}/commits/abc/check-runs?per_page=100`]: {
        total_count: 2,
        check_runs: [
          { name: 'build' },
          {
            name: 'Cursor Bugbot',
            conclusion: 'success',
            output: { summary: 'Bugbot completed review - no issues found! ✅' },
          },
        ],
      },
    })
    assert.equal(resolvePullRequestReview(7, repo, read).state, 'clean')
  })

  // An API error must never read as a pass. Collapsing failures to null is how
  // a detector reports green during an outage.
  it('reports undetermined rather than clean when the API fails', () => {
    const read = () => ({ ok: false, error: 'HTTP 401' })
    const result = resolvePullRequestReview(7, repo, read)
    assert.equal(result.state, 'undetermined')
    assert.match(result.detail, /401/)
  })

  it('refuses to answer when check runs are paginated beyond what it read', () => {
    const read = reader({
      [`repos/${repo}/pulls/7`]: { head: { sha: 'abc' } },
      [`repos/${repo}/commits/abc/check-runs?per_page=100`]: {
        total_count: 140,
        check_runs: [{ name: 'build' }],
      },
    })
    const result = resolvePullRequestReview(7, repo, read)
    assert.equal(result.state, 'undetermined')
    assert.match(result.detail, /page this did not read/)
  })

  it('reports undetermined when the pull request has no head sha', () => {
    const read = reader({ [`repos/${repo}/pulls/7`]: {} })
    assert.equal(resolvePullRequestReview(7, repo, read).state, 'undetermined')
  })
})

describe('resolveCommitReview', () => {
  function reader(map) {
    return (path) =>
      path in map ? { ok: true, data: map[path] } : { ok: false, error: `no stub for ${path}` }
  }

  const repo = 'gorfednet/example'
  const cleanRuns = {
    total_count: 1,
    check_runs: [
      {
        name: 'Cursor Bugbot',
        conclusion: 'success',
        output: { summary: 'Bugbot completed review - no issues found! ✅' },
      },
    ],
  }

  it('goes through the pull request head, not the commit on main', () => {
    // A squash merge gives main a different SHA, and check runs attach to the
    // pull request head. Asking about the main commit directly returns nothing,
    // which reads as "never reviewed" for every commit in the release.
    const read = reader({
      [`repos/${repo}/commits/squashed/pulls`]: [{ number: 12 }],
      [`repos/${repo}/pulls/12`]: { head: { sha: 'prhead' } },
      [`repos/${repo}/commits/prhead/check-runs?per_page=100`]: cleanRuns,
    })
    const result = resolveCommitReview('squashed', repo, read)
    assert.equal(result.state, 'clean')
    assert.equal(result.pr, 12)
  })

  it('names a commit with no pull request rather than passing over it', () => {
    const read = reader({ [`repos/${repo}/commits/direct/pulls`]: [] })
    assert.equal(resolveCommitReview('direct', repo, read).state, 'no-pr')
  })

  it('reports a failed pull-request lookup as undetermined, never as no-pr', () => {
    // The bug this guards: collapsing an API failure to an empty list made an
    // expired token read as "this commit has no pull request", which the
    // caller treats as benign. The detector then printed "all reviewed" during
    // an outage — the exact silent green it exists to catch.
    const read = () => ({ ok: false, error: 'HTTP 401: Bad credentials' })
    const result = resolveCommitReview('any', repo, read)
    assert.equal(result.state, 'undetermined')
    assert.match(result.detail, /401/)
  })
})
