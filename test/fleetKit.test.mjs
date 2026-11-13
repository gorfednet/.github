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
  it('fails far behind, ahead and unreadable; passes one minor behind; ignores unadopted and unavailable', () => {
    const repos = [
      { slug: 'o/a', kitVersion: '0.60.0' },
      { slug: 'o/b', kitVersion: '0.49.0' },
      { slug: 'o/c', kitVersion: '0.70.0' },
      { slug: 'o/d', kitVersion: '' },
      { slug: 'o/e', kitVersion: null },
      { slug: 'o/f', unavailable: 'x' },
    ]
    assert.deepEqual(kitFailures(repos, '0.61.0').map((r) => r.slug), ['o/b', 'o/c', 'o/d'])
  })
  it('fails a missing kit at tier 1 and above, exempts dormant, allows tier 0', () => {
    const projects = [
      { slug: 'o/t1', tier: 1, monitorClass: 'active-site' },
      { slug: 'o/t0', tier: 0, monitorClass: 'active-site' },
      { slug: 'o/dorm', tier: 0, monitorClass: 'dormant' },
    ]
    const repos = [{ slug: 'o/t1', kitVersion: null }, { slug: 'o/t0', kitVersion: null }, { slug: 'o/dorm', kitVersion: '0.20.0' }]
    assert.deepEqual(kitFailures(repos, '0.61.0', projects).map((r) => r.slug), ['o/t1'])
  })
  it('the summary names the repositories that are not current', () => {
    const line = kitSummary([{ slug: 'o/a', kitVersion: '0.61.0' }, { slug: 'o/b', kitVersion: '0.49.0' }, { slug: 'o/c', kitVersion: null }], '0.61.0')
    assert.match(line, /o\/b 0\.49\.0 \(far-behind\)/)
    assert.match(kitSummary([{ slug: 'o/c', kitVersion: '0.70.0' }, { slug: 'o/d', kitVersion: '' }], '0.61.0'), /o\/c 0\.70\.0 \(ahead\), o\/d \(unreadable\) \(unknown\)/)
    assert.match(line, /no kit: o\/c/)
  })
})

describe('fleet-kit-versions CLI', () => {
  it('exits 1 on a repository ten minors behind, 0 when every repository is within one', () => {
    assert.equal(run([{ slug: 'o/a', kitVersion: '0.61.0' }, { slug: 'o/b', kitVersion: '0.49.0' }]).status, 1)
    assert.equal(run([{ slug: 'o/a', kitVersion: '0.61.0' }, { slug: 'o/b', kitVersion: '0.60.0' }]).status, 0)
  })
  it('exits 1 for a missing kit at tier 1, read through the fleet.json wiring', () => {
    assert.equal(run([{ slug: 'o/a', kitVersion: null }, { slug: 'o/b', kitVersion: '0.61.0' }]).status, 1)
  })
  it('exits 1 when nothing carried a version, rather than printing a tick', () => {
    assert.equal(run([{ slug: 'o/a' }]).status, 1)
  })
})

describe('kitPathFor', () => {
  it('follows evidencePaths where the repository keeps the kit elsewhere', () => {
    assert.equal(kitPathFor({ evidencePaths: { 'verification-kit/MANIFEST.json': 'templates/verification-kit/MANIFEST.json' } }), 'templates/verification-kit/MANIFEST.json')
    assert.equal(kitPathFor({}), 'verification-kit/MANIFEST.json')
    assert.equal(kitPathFor(undefined), 'verification-kit/MANIFEST.json')
  })
})
