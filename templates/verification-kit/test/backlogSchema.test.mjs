import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { validateBacklog } from '../lib/backlogSchema.mjs'

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

  it('rejects an unparseable review date', () => {
    const problems = validateBacklog({ entries: [entry({ reviewBy: 'next tuesday' })] })
    assert.ok(problems.some((p) => /unparseable reviewBy/.test(p)))
  })

  // Deferral is fine; undated deferral becomes permanent by accident.
  it('fails once a dated commitment has lapsed, and not before', () => {
    const now = new Date('2026-06-15T12:00:00Z')

    const lapsed = validateBacklog({ entries: [entry({ reviewBy: '2026-06-14' })] }, { now })
    assert.ok(lapsed.some((p) => /has passed/.test(p)))

    // Today is not yet lapsed: the comparison is at day resolution.
    assert.deepEqual(validateBacklog({ entries: [entry({ reviewBy: '2026-06-15' })] }, { now }), [])
    assert.deepEqual(validateBacklog({ entries: [entry({ reviewBy: '2026-06-16' })] }, { now }), [])
  })
})
