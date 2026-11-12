/** The fleet-wide kit version check (scripts/fleet-kit-versions.mjs, scripts/lib/kit-version.mjs). */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { kitFailures, kitGap, kitSummary } from '../scripts/lib/kit-version.mjs'

const run = (repos, canonical = '0.61.0') => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetkit-'))
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ repos }))
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ version: canonical }))
  return spawnSync(process.execPath, ['scripts/fleet-kit-versions.mjs', '--in', join(dir, 'status.json')], {
    encoding: 'utf8',
    env: { ...process.env, KIT_CANONICAL_MANIFEST: join(dir, 'MANIFEST.json') },
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
  it('the summary names the repositories that are not current', () => {
    const line = kitSummary([{ slug: 'o/a', kitVersion: '0.61.0' }, { slug: 'o/b', kitVersion: '0.49.0' }, { slug: 'o/c', kitVersion: null }], '0.61.0')
    assert.match(line, /behind: o\/b 0\.49\.0/)
    assert.match(line, /no kit: o\/c/)
  })
})

describe('fleet-kit-versions CLI', () => {
  it('exits 1 on a repository ten minors behind, 0 when every repository is within one', () => {
    assert.equal(run([{ slug: 'o/a', kitVersion: '0.61.0' }, { slug: 'o/b', kitVersion: '0.49.0' }]).status, 1)
    assert.equal(run([{ slug: 'o/a', kitVersion: '0.61.0' }, { slug: 'o/b', kitVersion: '0.60.0' }]).status, 0)
  })
  it('exits 1 when nothing carried a version, rather than printing a tick', () => {
    assert.equal(run([{ slug: 'o/a' }]).status, 1)
  })
})
