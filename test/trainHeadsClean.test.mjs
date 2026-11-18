/**
 * A train carries only heads the reviewer has read. Dependabot pull requests get no review job of
 * their own, so a train built over them said "reviewed on their own pull requests" about unread code
 * (2026-11-17, three carried heads). The guard reads the same verdict as the merge gate.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { trainHeadsVerdict } from '../scripts/train-heads-clean.mjs'

describe('trainHeadsVerdict', () => {
  it('passes when every carried head is clean', () => {
    assert.equal(trainHeadsVerdict([{ pr: 1, state: 'clean', findings: 0 }, { pr: 2, state: 'clean', findings: 0 }]).ok, true)
  })
  it('blocks a head nobody reviewed, and names it', () => {
    const v = trainHeadsVerdict([{ pr: 1, state: 'clean', findings: 0 }, { pr: 2, state: 'not-run', findings: 0 }])
    assert.equal(v.ok, false)
    assert.deepEqual(v.blocked.map((b) => b.pr), [2])
  })
  it('blocks a head with findings', () => {
    assert.equal(trainHeadsVerdict([{ pr: 3, state: 'findings', findings: 2 }]).ok, false)
  })
  it('blocks an empty list, since nothing was checked', () => {
    assert.equal(trainHeadsVerdict([]).ok, false)
  })
})
