/** fleet-status reads the kit pin from workflow `uses:` lines (plan row 2.9): readKitPin, resolveKitPin, and a repository row end to end. */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { collectRepo, readKitPin, resolveKitPin } from '../scripts/fleet-status.mjs'
import { kitFailures } from '../scripts/lib/kit-version.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const wf = (path, state = 'active') => ({ id: 1, name: path, path, state })
const gate = (ref) => `jobs:\n  gate:\n    steps:\n      - uses: gorfednet/.github/.github/actions/setup-node@${ref}\n      - uses: gorfednet/.github/.github/actions/verification-gate@${ref}\n`

describe('readKitPin', () => {
  it('reads @main from the caller workflow', () => {
    const texts = { '.github/workflows/pr-check.yml': gate('main') }
    assert.deepEqual(readKitPin([wf('.github/workflows/pr-check.yml')], (p) => texts[p] ?? null), { ref: 'main' })
  })
  it('reads a sha and a tag as they are written', () => {
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => gate(SHA)), { ref: SHA })
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => gate('v0.49.0')), { ref: 'v0.49.0' })
  })
  it('tries caller-like workflow files first and stops at the first that pins', () => {
    const asked = []
    const texts = { '.github/workflows/zz-misc.yml': 'on: push\n', '.github/workflows/pr-check.yml': gate('main') }
    const pin = readKitPin([wf('.github/workflows/zz-misc.yml'), wf('.github/workflows/pr-check.yml'), wf('.github/workflows/other.yml')], (p) => { asked.push(p); return texts[p] ?? null })
    assert.deepEqual(pin, { ref: 'main' })
    assert.deepEqual(asked, ['.github/workflows/pr-check.yml'])
  })
  it('skips disabled workflows and files outside .github/workflows', () => {
    const asked = []
    const pin = readKitPin([wf('.github/workflows/ci.yml', 'disabled_manually'), wf('dynamic/copilot')], (p) => { asked.push(p); return gate('main') })
    assert.equal(asked.length, 0)
    assert.match(pin.error, /no workflow pins/)
  })
  it('prefers the verification-gate pin when a file pins other actions elsewhere', () => {
    const text = `${gate('main')}      - uses: gorfednet/.github/.github/actions/no-smb-guard@${SHA}\n`
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => text), { ref: 'main' })
  })
  it('is an error, never current, with no uses line, an unreadable ref, a ref expression or mixed refs', () => {
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => 'on: push\n').error, /no workflow pins/)
    assert.match(readKitPin([], () => null).error, /no workflow pins/)
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => gate('${{ inputs.ref }}')).error, /unreadable ref/)
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => gate('../x')).error, /unreadable ref/)
    const mixed = `${gate('main')}      - uses: gorfednet/.github/.github/actions/verification-gate@${SHA}\n`
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => mixed).error, /2 different refs/)
  })
})

describe('resolveKitPin', () => {
  const manifest = (version) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ version })).toString('base64') })
  it('makes no call for main, one call per ref otherwise, and caches it', () => {
    const asked = []
    const json = (args) => { asked.push(args[1]); return manifest('0.49.0') }
    const cache = new Map()
    assert.deepEqual(resolveKitPin({ ref: 'main' }, json, cache), { ref: 'main' })
    assert.equal(asked.length, 0)
    assert.deepEqual(resolveKitPin({ ref: SHA }, json, cache), { ref: SHA, version: '0.49.0' })
    resolveKitPin({ ref: SHA }, json, cache)
    assert.deepEqual(asked, [`repos/gorfednet/.github/contents/templates/verification-kit/MANIFEST.json?ref=${SHA}`])
  })
  it('a ref with no manifest or one that cannot be read is an error', () => {
    const notFound = () => { throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' }) }
    assert.match(resolveKitPin({ ref: SHA }, notFound).error, /no kit manifest/)
    const boom = () => { throw new Error('HTTP 500') }
    assert.match(resolveKitPin({ ref: SHA }, boom).error, /unreadable/)
    assert.equal(resolveKitPin({ error: 'x' }, boom).error, 'x')
  })
})

describe('a repository row carries the pin and drift follows it', () => {
  const now = new Date('2026-11-17T12:00:00Z')
  const file = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') })
  const notFound = () => { throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' }) }
  /** vendored: the repository's own verification-kit manifest; pinTo: the ref its caller workflow uses. */
  const fake = ({ vendored, pinTo, calls }) => (args) => {
    calls.push(args.join(' '))
    const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
    if (path === 'repos/o/site') return { private: false, visibility: 'public', default_branch: 'main' }
    if (path === 'pr list') return []
    if (path.includes('/branches')) return [[]]
    if (path.endsWith('/workflows?per_page=100')) return { workflows: [{ id: 1, name: 'PR check', path: '.github/workflows/pr-check.yml', state: 'active' }] }
    if (path.endsWith('/contents/.github/workflows/pr-check.yml')) return file(gate(pinTo))
    if (path.endsWith('/contents/verification-kit/MANIFEST.json')) return file(JSON.stringify({ version: vendored }))
    if (path.includes('/gorfednet/.github/contents/templates/verification-kit/MANIFEST.json')) return file(JSON.stringify({ version: '0.49.0' }))
    if (path.includes('/contents/')) return notFound()
    if (path.endsWith('/commits/main')) return { sha: 'abc' }
    if (path.includes('/actions/runs?')) return [{ workflow_runs: [] }]
    if (path.endsWith('/status')) return { state: 'success', statuses: [] }
    if (path.includes('/dependabot/alerts?')) return [[]]
    throw new Error(`unexpected call ${args.join(' ')}`)
  }

  it('vendored 0.49.0 with an @main pin reports current', async () => {
    const calls = []
    const row = await collectRepo('o/site', now, { json: fake({ vendored: '0.49.0', pinTo: 'main', calls }), log: () => {} })
    assert.equal(row.kitVersion, '0.49.0')
    assert.deepEqual(row.kitPin, { ref: 'main' })
    assert.deepEqual(kitFailures([row], '0.62.0'), [])
    // The workflow listing is read once and shared with the deploy lookup.
    assert.equal(calls.filter((c) => c.endsWith('/workflows?per_page=100')).length, 1)
  })
  it('a current vendored copy behind an old sha pin reports far-behind', async () => {
    const calls = []
    const row = await collectRepo('o/site', now, { json: fake({ vendored: '0.62.0', pinTo: SHA, calls }), log: () => {} })
    assert.deepEqual(row.kitPin, { ref: SHA, version: '0.49.0' })
    assert.deepEqual(kitFailures([row], '0.62.0').map((r) => [r.slug, r.gap]), [['o/site', 'far-behind']])
  })
  it('a repository whose workflows pin nothing reports an error row', async () => {
    const json = (args) => {
      const path = args[args.length - 1]
      if (path.endsWith('/workflows?per_page=100')) return { workflows: [] }
      return fake({ vendored: '0.62.0', pinTo: 'main', calls: [] })(args)
    }
    const row = await collectRepo('o/site', now, { json, log: () => {} })
    assert.match(row.kitPin.error, /no workflow pins/)
    assert.deepEqual(kitFailures([row], '0.62.0').map((r) => r.gap), ['error'])
  })
  it('adds one request for the pinned workflow file and none for @main; a sha pin adds one more', async () => {
    const base = []
    await collectRepo('o/site', now, { json: fake({ vendored: '0.62.0', pinTo: 'main', calls: base }), log: () => {} })
    const sha = []
    await collectRepo('o/site', now, { json: fake({ vendored: '0.62.0', pinTo: SHA, calls: sha }), log: () => {} })
    assert.equal(base.filter((c) => c.includes('contents/.github/workflows/')).length, 1)
    assert.equal(sha.length - base.length, 1)
  })
})
