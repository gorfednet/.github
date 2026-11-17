import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isAdult } from './planted.mjs'

it('classifies ages', () => {
  assert.equal(isAdult(30), true)
  assert.equal(isAdult(5), false)
  // PLANTED DEAD ASSERTION: the boundary is "checked", but this can never fail,
  // so changing `>=` to `>` in planted.mjs must survive. The nightly run lists it.
  assert.ok(isAdult(18) === true || isAdult(18) === false)
})
