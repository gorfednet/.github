/** The fleet-wide kit version check (scripts/fleet-kit-versions.mjs, scripts/lib/kit-version.mjs). */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { kitPathFor } from '../scripts/fleet-status.mjs'
import { kitFailures, kitGap, kitSummary } from '../scripts/lib/kit-version.mjs'

const run = (repos, canonical = '0.61.0') => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetkit-'))
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ repos }))
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ version: canonical }))
  writeFileSync(join(dir, 'fleet.json'), JSON.stringify({ projects: [{ slug: 'o/a', tier: 1 }, { slug: 'o/b', tier: 1 }] }))
  return spawnSync(process.execPath, ['scripts/fleet-kit-versions.mjs', '--in', join(dir, 'status.json')], {
    encoding: 'utf8',
    env: { ...process.env, KIT_CANONICAL_MANIFEST: join(dir, 'MANIFEST.json'), KIT_FLEET_JSON: join(dir, 'fleet.json') },
  })
}

describe('kitGap', () => {
  it('names the distance', () => {
    assert.equal(kitGap('0.61.0', '0.61.0'), 'current')
    assert.equal(kitGap('0.60.3', '0.61.0'), 'behind')
    assert.equal(kitGap('0.61.0', '0.61.4'), 'behind')
    assert.equal(kitGap('0.59.0', '0.61.0'), 'far-behind')
    assert.equal(kitGap('0.49.0', '0.61.0'), 'far-behind')
    assert.equal(kitGap('0.99.0', '1.0.0'), 'far-behind')
    assert.equal(kitGap('0.62.0', '0.61.0'), 'ahead')
    assert.equal(kitGap('', '0.61.0'), 'unknown')
  })
})

describe('kitFailures', () => {
  const pin = (version, ref = 'v1') => ({ ref, version })
  it('fails far behind, ahead and unreadable pins; passes one minor behind and @main; ignores unavailable', () => {
    const repos = [
      { slug: 'o/a', kitPin: pin('0.60.0') },
      { slug: 'o/b', kitPin: pin('0.49.0') },
      { slug: 'o/c', kitPin: pin('0.70.0') },
      { slug: 'o/d', kitPin: pin('') },
      { slug: 'o/e', kitPin: { ref: 'main' } },
      { slug: 'o/f', unavailable: 'x' },
    ]
    assert.deepEqual(kitFailures(repos, '0.61.0').map((r) => r.slug), ['o/b', 'o/c', 'o/d'])
  })
  it('fails a repository whose pin could not be read, and exempts dormant', () => {
    const projects = [{ slug: 'o/t1', tier: 1, monitorClass: 'active-site' }, { slug: 'o/dorm', tier: 0, monitorClass: 'dormant' }]
    const repos = [{ slug: 'o/t1', kitPin: { error: 'no workflow pins gorfednet/.github' } }, { slug: 'o/dorm', kitPin: pin('0.20.0') }]
    assert.deepEqual(kitFailures(repos, '0.61.0', projects).map((r) => r.slug), ['o/t1'])
  })
  it('the summary names the repositories whose pin is not current', () => {
    const line = kitSummary([{ slug: 'o/a', kitPin: { ref: 'main' } }, { slug: 'o/b', kitPin: pin('0.49.0', 'v0.49.0') }], '0.61.0')
    assert.match(line, /o\/b @v0\.49\.0 \(kit 0\.49\.0\) \(far-behind\)/)
    assert.match(kitSummary([{ slug: 'o/c', kitPin: pin('0.70.0') }, { slug: 'o/d', kitPin: pin('') }], '0.61.0'), /o\/c @v1 \(kit 0\.70\.0\) \(ahead\), o\/d @v1 \(kit unreadable\) \(unknown\)/)
  })
})

describe('fleet-kit-versions CLI', () => {
  it('exits 1 on a repository pinned ten minors behind, 0 when every pin is within one or at main', () => {
    assert.equal(run([{ slug: 'o/a', kitPin: { ref: 'main' } }, { slug: 'o/b', kitPin: { ref: 'abc1234', version: '0.49.0' } }]).status, 1)
    assert.equal(run([{ slug: 'o/a', kitPin: { ref: 'main' } }, { slug: 'o/b', kitPin: { ref: 'abc1234', version: '0.60.0' } }]).status, 0)
  })
  it('does not fail a stale vendored copy behind an @main pin', () => {
    assert.equal(run([{ slug: 'o/a', kitVersion: '0.49.0', kitPin: { ref: 'main' } }, { slug: 'o/b', kitVersion: null, kitPin: { ref: 'main' } }]).status, 0)
  })
  it('exits 1 for an unreadable pin', () => {
    assert.equal(run([{ slug: 'o/a', kitPin: { error: 'no workflow pins gorfednet/.github' } }, { slug: 'o/b', kitPin: { ref: 'main' } }]).status, 1)
  })
  it('exits 1 when only none, untiered or error rows came back: nothing measured is not a tick', () => {
    assert.equal(run([{ slug: 'o/a', kitPin: { none: true } }, { slug: 'o/b', kitPin: { untiered: true } }]).status, 1)
  })
  it('counts a vendored row with a version as measured', () => {
    assert.equal(run([{ slug: 'o/a', kitPin: { vendored: true, version: '0.61.0' } }]).status, 0)
  })
  it('exits 1 when nothing carried a pin, rather than printing a tick', () => {
    assert.equal(run([{ slug: 'o/a', kitVersion: '0.61.0' }]).status, 1)
  })
})

describe('kitPathFor', () => {
  it('follows evidencePaths where the repository keeps the kit elsewhere', () => {
    assert.equal(kitPathFor({ evidencePaths: { 'verification-kit/MANIFEST.json': 'templates/verification-kit/MANIFEST.json' } }), 'templates/verification-kit/MANIFEST.json')
    assert.equal(kitPathFor({}), 'verification-kit/MANIFEST.json')
    assert.equal(kitPathFor(undefined), 'verification-kit/MANIFEST.json')
  })
})

describe('kit drift is read from the pin, not the vendored copy (plan row 2.9)', () => {
  it('a vendored 0.49.0 behind an @main pin is current', () => {
    const repos = [{ slug: 'o/b', kitVersion: '0.49.0', kitPin: { ref: 'main' } }]
    assert.deepEqual(kitFailures(repos, '0.61.0'), [])
    assert.match(kitSummary(repos, '0.61.0'), /all 1 repos pin the gate at main/)
  })
  it('near miss: a caller pinned to an old sha really is behind, whatever its vendored copy says', () => {
    const repos = [{ slug: 'o/b', kitVersion: '0.61.0', kitPin: { ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', version: '0.49.0' } }]
    const bad = kitFailures(repos, '0.61.0')
    assert.deepEqual(bad.map((r) => [r.slug, r.gap]), [['o/b', 'far-behind']])
    assert.match(kitSummary(repos, '0.61.0'), /o\/b @a1b2c3d \(kit 0\.49\.0\) \(far-behind\)/)
  })
  it('a pin one minor behind passes; one at an unreadable or newer version fails', () => {
    assert.deepEqual(kitFailures([{ slug: 'o/a', kitPin: { ref: 'v0.60.0', version: '0.60.0' } }], '0.61.0'), [])
    assert.deepEqual(kitFailures([{ slug: 'o/a', kitPin: { ref: 'v9', version: '' } }], '0.61.0').map((r) => r.gap), ['unknown'])
    assert.deepEqual(kitFailures([{ slug: 'o/a', kitPin: { ref: 'v9', version: '0.70.0' } }], '0.61.0').map((r) => r.gap), ['ahead'])
  })
  it('a missing or unreadable pin is an error row, never current', () => {
    for (const kitPin of [{ error: 'no workflow pins gorfednet/.github' }, { ref: 'abc', error: 'ref abc has no kit manifest' }, { ref: '' }, {}, null]) {
      assert.deepEqual(kitFailures([{ slug: 'o/a', kitVersion: '0.61.0', kitPin }], '0.61.0').map((r) => r.gap), ['error'], JSON.stringify(kitPin))
    }
    assert.match(kitSummary([{ slug: 'o/a', kitPin: { error: 'no workflow pins gorfednet/.github' } }], '0.61.0'), /o\/a unreadable pin .*\(error\)/)
  })
  it('a repository with no shared gate (kitPin.none) is informational: never fails, named apart in the summary', () => {
    const repos = [{ slug: 'o/m', kitPin: { none: true } }, { slug: 'o/a', kitPin: { ref: 'main' } }]
    assert.deepEqual(kitFailures(repos, '0.61.0'), [])
    assert.match(kitSummary(repos, '0.61.0'), /no shared gate: o\/m/)
    assert.doesNotMatch(kitSummary(repos, '0.61.0'), /not current/)
  })
  it('a row with no kitPin field at all (an older status.json) is not measured', () => {
    assert.deepEqual(kitFailures([{ slug: 'o/a', kitVersion: '0.20.0' }], '0.61.0'), [])
  })
  it('a dormant repository is reported but never fails', () => {
    assert.deepEqual(kitFailures([{ slug: 'o/d', kitPin: { error: 'x' } }], '0.61.0', [{ slug: 'o/d', monitorClass: 'dormant' }]), [])
  })
})
