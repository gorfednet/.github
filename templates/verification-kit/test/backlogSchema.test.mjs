import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { PLACEHOLDER_ID, lapsedReviewDates, validateBacklog } from '../lib/backlogSchema.mjs'

const PROSE = 'a sentence long enough to clear the twenty character floor'

function entry(overrides = {}) {
  return {
    id: 'an-id',
    title: PROSE,
    status: 'confirmed-bug',
    assignee: 'main-model',
    userSymptom: PROSE,
    evidence: PROSE,
    ...overrides,
  }
}

describe('validateBacklog', () => {
  it('accepts a well-formed entry', () => {
    assert.deepEqual(validateBacklog({ entries: [entry()] }), [])
  })

  it('rejects a document that is not an object with entries', () => {
    assert.match(validateBacklog([])[0], /must be a JSON object/)
    assert.match(validateBacklog({})[0], /no "entries" array/)
  })

  // An empty file and a truncated one look identical unless emptiness is
  // stated, so silence is not allowed to mean "nothing to do".
  it('requires an empty backlog to say it is empty on purpose', () => {
    assert.match(validateBacklog({ entries: [] })[0], /emptyReason/)
    assert.deepEqual(validateBacklog({ entries: [], emptyReason: 'new project' }), [])
  })

  it('rejects duplicate ids', () => {
    const problems = validateBacklog({ entries: [entry(), entry()] })
    assert.ok(problems.some((p) => /duplicate id "an-id"/.test(p)))
  })

  it('rejects a symptom nobody could act on', () => {
    const problems = validateBacklog({ entries: [entry({ userSymptom: 'broken' })] })
    assert.ok(problems.some((p) => /userSymptom/.test(p) && /preference, not a bug/.test(p)))
  })

  it('rejects evidence that is a guess rather than a citation', () => {
    const problems = validateBacklog({ entries: [entry({ evidence: 'probably' })] })
    assert.ok(problems.some((p) => /evidence/.test(p)))
  })

  it('rejects unknown status and assignee values', () => {
    const problems = validateBacklog({
      entries: [entry({ status: 'wontfix', assignee: 'unassigned' })],
    })
    assert.ok(problems.some((p) => /status "wontfix"/.test(p)))
    assert.ok(problems.some((p) => /assignee "unassigned"/.test(p)))
  })

  it('requires a pull request once work is in review or landed', () => {
    for (const status of ['in-review', 'landed']) {
      const problems = validateBacklog({ entries: [entry({ status })] })
      assert.ok(
        problems.some((p) => /names no pull request/.test(p)),
        `${status} should require a PR`,
      )
    }
    assert.deepEqual(validateBacklog({ entries: [entry({ status: 'landed', pr: 12 })] }), [])
  })

  it('rejects a pull request attached to work that has not started', () => {
    const problems = validateBacklog({ entries: [entry({ status: 'suspected', pr: 12 })] })
    assert.ok(problems.some((p) => /names pull request #12/.test(p)))
  })

  /*
   * The template's example clears every other rule in this file, because it
   * was written to demonstrate them. Installing the kit and never editing the
   * backlog therefore produced a green check describing a bug nobody has —
   * found while rolling the kit out to anal0g.org, before it reached the
   * remaining repositories.
   */
  describe('the template placeholder', () => {
    it('is rejected even though it satisfies every other rule', () => {
      const problems = validateBacklog({ entries: [entry({ id: PLACEHOLDER_ID })] })
      assert.ok(problems.some((p) => /still the template's example/.test(p)), problems.join('\n'))
    })

    // The companion assertion — that the shipped templates/backlog.json
    // actually uses this id — lives in the organisation repository's own
    // suite, not here. templates/ is deliberately outside the manifest,
    // because a project edits its copy and it would read as drift forever, so
    // a vendored kit has no templates/ directory and this test failed with
    // ENOENT in three repositories at once the moment v0.22.0 landed.
    //
    // Making it skip when the file is absent was the tempting fix and the
    // wrong one: it would then skip in the one place it needs to run, the
    // canonical repository being the only place that has the file.
  })

  it('rejects an unparseable review date', () => {
    const problems = validateBacklog({ entries: [entry({ reviewBy: 'next tuesday' })] })
    assert.ok(problems.some((p) => /unparseable reviewBy/.test(p)))
  })

  // A pull request cannot change the date, so a lapsed one is not a problem
  // with the file's shape. gorfednet/.github#55 failed on seven of them.
  it('does not fail an entry because its review date has passed', () => {
    assert.deepEqual(validateBacklog({ entries: [entry({ reviewBy: '2000-01-01' })] }), [])
  })

  // The near miss: dropping the date rule must not drop the shape rule with it.
  it('still rejects a malformed review date even when it would have lapsed', () => {
    const problems = validateBacklog({ entries: [entry({ reviewBy: '2000-1-1' })] })
    assert.ok(problems.some((p) => /unparseable reviewBy/.test(p)))
  })
})

describe('lapsedReviewDates', () => {
  const now = new Date('2026-06-15T12:00:00Z')

  // Deferral is fine; undated deferral becomes permanent by accident. So the
  // date is still read, and reported, just never enforced on a pull request.
  it('lists an entry once its dated commitment has lapsed, and not before', () => {
    assert.deepEqual(
      lapsedReviewDates({ entries: [entry({ id: 'late', reviewBy: '2026-06-14', status: 'landed', pr: 3 })] }, { now }),
      [{ id: 'late', status: 'landed', reviewBy: '2026-06-14' }],
    )

    // Today is not yet lapsed: the comparison is at day resolution.
    assert.deepEqual(lapsedReviewDates({ entries: [entry({ reviewBy: '2026-06-15' })] }, { now }), [])
    assert.deepEqual(lapsedReviewDates({ entries: [entry({ reviewBy: '2026-06-16' })] }, { now }), [])
    assert.deepEqual(lapsedReviewDates({ entries: [entry({})] }, { now }), [])
  })

  // A malformed date is validateBacklog's to reject; reporting it here as well
  // would print one defect twice, once as a warning that sounds optional.
  it('leaves malformed dates and malformed documents to validateBacklog', () => {
    assert.deepEqual(lapsedReviewDates({ entries: [entry({ reviewBy: 'last week' })] }, { now }), [])
    assert.deepEqual(lapsedReviewDates({ entries: [null, 'x'] }, { now }), [])
    assert.deepEqual(lapsedReviewDates([], { now }), [])
  })
})
