/** fleet-status reads the kit pin from workflow `uses:` lines (plan row 2.9): readKitPin, resolveKitPin, and a repository row end to end. */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { collectRepo, readKitPin, redactPin, resolveKitPin } from '../scripts/fleet-status.mjs'
import { pinnedRefs } from '../scripts/fleet-report.mjs'
import { kitFailures, kitSummary } from '../scripts/lib/kit-version.mjs'

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
  it('reads every active workflow file, caller-like names first', () => {
    const asked = []
    const texts = { '.github/workflows/zz-misc.yml': 'on: push\n', '.github/workflows/pr-check.yml': gate('main') }
    const pin = readKitPin([wf('.github/workflows/zz-misc.yml'), wf('.github/workflows/pr-check.yml'), wf('.github/workflows/other.yml')], (p) => { asked.push(p); return texts[p] ?? 'on: push\n' })
    assert.deepEqual(pin, { ref: 'main' })
    assert.equal(asked[0], '.github/workflows/pr-check.yml')
    assert.equal(asked.length, 3)
  })
  it('skips disabled workflows and files outside .github/workflows', () => {
    const asked = []
    const pin = readKitPin([wf('.github/workflows/ci.yml', 'disabled_manually'), wf('dynamic/copilot')], (p) => { asked.push(p); return gate('main') }, { tier: 1 })
    assert.equal(asked.length, 0)
    assert.match(pin.error, /no active workflow calls the shared gate/)
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml', 'disabled_manually')], () => gate('main'), { tier: 0 }), { none: true })
  })
  it('a workflow calling only other shared actions never ends the search: the gate caller after it is still read', () => {
    const texts = {
      '.github/workflows/ci.yml': 'steps:\n  - uses: gorfednet/.github/.github/actions/setup-node@main\n',
      '.github/workflows/claude-review-pr.yml': 'jobs:\n  r:\n    uses: gorfednet/.github/.github/workflows/claude-review.yml@main\n',
      '.github/workflows/zz-build.yml': gate(SHA),
    }
    const asked = []
    const pin = readKitPin(Object.keys(texts).map((p) => wf(p)), (p) => { asked.push(p); return texts[p] })
    assert.deepEqual(pin, { ref: SHA })
    assert.equal(asked.length, 3)
  })
  it('a pr-check reusable workflow call is gate-bearing', () => {
    const text = `jobs:\n  g:\n    uses: gorfednet/.github/.github/workflows/pr-check-static.yml@${SHA}\n`
    const asked = []
    const pin = readKitPin([wf('.github/workflows/pr-check.yml'), wf('.github/workflows/ci.yml')], (p) => { asked.push(p); return text })
    assert.deepEqual(pin, { ref: SHA })
    assert.equal(asked.length, 2)
  })
  it('quoted uses lines are read: an old pin does not slip into none', () => {
    for (const q of ['"', "'"]) {
      const text = `steps:\n  - uses: ${q}gorfednet/.github/.github/actions/verification-gate@${SHA}${q}\n`
      assert.deepEqual(pinnedRefs([text]), [{ target: '.github/actions/verification-gate', ref: SHA }])
      assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => text), { ref: SHA })
    }
  })
  it('a commented-out uses line is not a pin', () => {
    const text = `steps:\n  # - uses: gorfednet/.github/.github/actions/verification-gate@${SHA}\n  - uses: gorfednet/.github/.github/actions/verification-gate@main\n`
    assert.deepEqual(pinnedRefs([text]), [{ target: '.github/actions/verification-gate', ref: 'main' }])
    assert.deepEqual(pinnedRefs([`# uses: gorfednet/.github/.github/actions/verification-gate@${SHA}\n`]), [])
  })
  it('an empty workflow list, an unreadable file and a 404 are errors at every tier', () => {
    for (const tier of [0, 1, undefined]) {
      assert.match(readKitPin([], () => null, { tier }).error, /list empty/)
      assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => null, { tier }).error ?? 'none', /no active workflow calls|none/)
    }
  })
  it('a listed file that 404s is skipped, not an error: a renamed or PR-branch-only workflow pins nothing', () => {
    const files = [wf('.github/workflows/old-name.yml'), wf('.github/workflows/ci.yml')]
    const text = (p) => (p.endsWith('old-name.yml') ? null : gate('main'))
    assert.deepEqual(readKitPin(files, text, { tier: 1 }), { ref: 'main' })
    assert.deepEqual(kitFailures([{ slug: 'o/r', kitPin: readKitPin(files, text, { tier: 1 }) }], '0.61.0', [{ slug: 'o/r', tier: 1 }]), [])
  })
  it('a read that throws still propagates; it is not skipped like a 404', () => {
    const boom = () => { throw new Error('gh: Server Error (HTTP 500)') }
    assert.throws(() => readKitPin([wf('.github/workflows/ci.yml')], boom, { tier: 1 }), /500/)
  })
  it('tier 1 and above with no gate caller is an error row; tier 0 is none', () => {
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => 'on: push\n', { tier: 1 }).error, /no active workflow calls/)
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => 'on: push\n', { tier: 3 }).error, /no active workflow calls/)
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => 'on: push\n', { tier: 0 }), { none: true })
  })
  it('prefers the verification-gate pin when a file pins other actions elsewhere', () => {
    const text = `${gate('main')}      - uses: gorfednet/.github/.github/actions/no-smb-guard@${SHA}\n`
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => text), { ref: 'main' })
  })
  it('is an error, never current, with an unreadable ref, a ref expression or mixed refs on the gate call', () => {
        assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => gate('${{ inputs.ref }}')).error, /unreadable ref/)
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => gate('../x')).error, /unreadable ref/)
    const mixed = `${gate('main')}      - uses: gorfednet/.github/.github/actions/verification-gate@${SHA}\n`
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => mixed).error, /2 different refs/)
  })
})

describe('no shared gate', () => {
  it('a tier-0 repository whose workflows never call gorfednet/.github is none, not an error', () => {
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => 'on: push\n', { tier: 0 }), { none: true })
    assert.deepEqual(resolveKitPin({ none: true }, () => { throw new Error('no call') }), { none: true })
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
  it('a tier-0 repository whose workflows call no shared gate reports none and never fails; at tier 1 it is an error row', async () => {
    const json = (args) => {
      const path = args[args.length - 1]
      if (path.endsWith('/workflows?per_page=100')) return { workflows: [] }
      return fake({ vendored: '0.62.0', pinTo: 'main', calls: [] })(args)
    }
    const row = await collectRepo('o/site', now, { json, log: () => {}, tier: 0 })
    assert.deepEqual(row.kitPin, { error: 'workflow list empty' })
    const wfs = { workflows: [{ id: 1, name: 'x', path: '.github/workflows/x.yml', state: 'active' }] }
    const none = (args) => (args[args.length - 1].endsWith('/workflows?per_page=100') ? wfs : args[args.length - 1].endsWith('/contents/.github/workflows/x.yml') ? file('on: push\n') : json(args))
    const t0 = await collectRepo('o/site', now, { json: none, log: () => {}, tier: 0 })
    assert.deepEqual(t0.kitPin, { none: true })
    assert.deepEqual(kitFailures([t0], '0.62.0'), [])
    const t1 = await collectRepo('o/site', now, { json: none, log: () => {}, tier: 1 })
    assert.match(t1.kitPin.error, /no active workflow calls/)
    assert.deepEqual(kitFailures([t1], '0.62.0').map((r) => r.gap), ['error'])
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

describe('fail closed when the workflow files cannot be read', () => {
  const now = new Date('2026-11-17T12:00:00Z')
  const wfsOnly = { workflows: [{ id: 1, name: 'x', path: '.github/workflows/pr-check.yml', state: 'active' }] }
  const base = (visibility, failure) => (args) => {
    const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
    if (path === 'repos/o/site') return { private: visibility !== 'public', visibility, default_branch: 'main' }
    if (path === 'pr list') return []
    if (path.includes('/branches')) return [[]]
    if (path.endsWith('/workflows?per_page=100')) return wfsOnly
    if (path.endsWith('/contents/.github/workflows/pr-check.yml')) throw failure
    if (path.includes('/contents/')) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' })
    if (path.endsWith('/commits/main')) return { sha: 'abc' }
    if (path.includes('/actions/runs?')) return [{ workflow_runs: [] }]
    if (path.endsWith('/status')) return { state: 'success', statuses: [] }
    if (path.includes('/dependabot/alerts?')) return [[]]
    throw new Error(`unexpected call ${args.join(' ')}`)
  }
  it('a failed read of a listed workflow gives an error row, not none and not current', async () => {
    const row = await collectRepo('o/site', now, { json: base('public', Object.assign(new Error('boom'), { stderr: 'gh: Server Error (HTTP 500)' })), log: () => {}, tier: 0 })
    assert.deepEqual(row.kitPin, { error: 'workflow files unreadable' })
    assert.deepEqual(kitFailures([row], '0.62.0').map((r) => r.gap), ['error'])
  })
  it('a rate limit is rethrown, so the repository row is unavailable rather than an error pin', async () => {
    const row = await collectRepo('o/site', now, { json: base('public', Object.assign(new Error('x'), { stderr: 'gh: API rate limit exceeded (HTTP 403)' })), log: () => {}, tier: 1 })
    assert.equal(row.unavailable, 'GitHub rate limit exceeded')
  })
})

describe('a private repository publishes ref, version and state only', () => {
  it('redactPin drops every path and message', () => {
    assert.deepEqual(redactPin({ ref: SHA, version: '0.49.0' }), { ref: SHA, version: '0.49.0' })
    assert.deepEqual(redactPin({ none: true }), { none: true })
    assert.deepEqual(redactPin({ error: 'secret/path.yml could not be read', path: '.github/workflows/secret.yml' }), { error: 'unreadable' })
  })
  it('a private row from a planted unreadable workflow carries no path or file name', async () => {
    const now = new Date('2026-11-17T12:00:00Z')
    const json = (args) => {
      const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
      if (path === 'repos/o/hidden') return { private: true, visibility: 'private', default_branch: 'main' }
      if (path === 'pr list') return []
      if (path.includes('/branches')) return [[]]
      if (path.endsWith('/workflows?per_page=100')) return { workflows: [{ id: 1, name: 'x', path: '.github/workflows/internal-secret-name.yml', state: 'active' }] }
      if (path.includes('/contents/')) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' })
      if (path.endsWith('/commits/main')) return { sha: 'abc' }
      if (path.includes('/actions/runs?')) return [{ workflow_runs: [] }]
      if (path.endsWith('/status')) return { state: 'success', statuses: [] }
      if (path.includes('/dependabot/alerts?')) return [[]]
      throw new Error(`unexpected call ${args.join(' ')}`)
    }
    const row = await collectRepo('o/hidden', now, { json, log: () => {}, tier: 1 })
    assert.equal(row.redacted, true)
    assert.deepEqual(row.kitPin, { error: 'unreadable' })
    assert.ok(!JSON.stringify(row).includes('internal-secret-name'))
  })
})

describe('vendored and untiered repositories', () => {
  const review = 'jobs:\n  r:\n    uses: gorfednet/.github/.github/workflows/claude-review.yml@main\n'
  const vendoredRun = 'jobs:\n  g:\n    steps:\n      - run: node verification-kit/bin/verify-all.mjs\n'
  it('a workflow that runs verification-kit/bin from the repository is vendored, at any tier', () => {
    for (const tier of [0, 1, 3, undefined]) assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => vendoredRun, { tier }), { vendored: true })
  })
  it('real node invocations of the vendored kit are vendored, inline, multi-line and with flags', () => {
    const yes = [
      'steps:\n  - run: node verification-kit/bin/verify-all.mjs\n',
      'steps:\n  - run: node ./verification-kit/bin/verify-all.mjs --strict\n',
      'steps:\n  - run: node --no-warnings verification-kit/bin/x.mjs # why\n',
      'steps:\n  - name: gate\n    run: |\n      npm ci\n      node verification-kit/bin/x.mjs\n',
      'steps:\n  - run: cd . && node verification-kit/bin/x.mjs\n',
      'steps:\n  - run: "node verification-kit/bin/x.mjs"\n',
    ]
    for (const text of yes) assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => text, { tier: 3 }), { vendored: true }, text)
  })
  it('near misses are not vendored: echo, test, if [ -f ], paths, comments, prefixed paths, other interpreters', () => {
    const no = [
      'steps:\n  - run: echo node verification-kit/bin/x.mjs\n',
      'steps:\n  - run: test -f verification-kit/bin/x.mjs\n',
      'steps:\n  - run: if [ -f verification-kit/bin/x.mjs ]; then echo ok; fi\n',
      'on:\n  push:\n    paths:\n      - verification-kit/bin/x.mjs\n',
      'steps:\n  - run: npm test # node verification-kit/bin/x.mjs\n',
      'steps:\n  - run: node docs/verification-kit/bin/x.mjs\n',
      'steps:\n  - run: node templates/verification-kit/bin/x.mjs\n',
      'steps:\n  - run: node ../verification-kit/bin/x.mjs\n',
      'steps:\n  - run: cat verification-kit/bin/x.mjs\n',
      'steps:\n  - name: node verification-kit/bin/x.mjs\n    run: npm test\n',
      'steps:\n  - run: |\n      echo "node verification-kit/bin/x.mjs"\n',
    ]
    for (const text of no) assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => text, { tier: 3 }).error, /no active workflow calls/, text)
  })
  it('a commented-out vendored run, or a gate caller, is not vendored', () => {
    assert.match(readKitPin([wf('.github/workflows/ci.yml')], () => '# run: node verification-kit/bin/x.mjs\n', { tier: 3 }).error, /no active workflow calls/)
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml')], () => `${vendoredRun}${gate(SHA)}`, { tier: 3 }), { ref: SHA })
  })
  it('a repository fleet.json does not list, calling only claude-review, is untiered; a listed one at tier 1 is an error', () => {
    assert.deepEqual(readKitPin([wf('.github/workflows/r.yml')], () => review), { untiered: true })
    assert.match(readKitPin([wf('.github/workflows/r.yml')], () => review, { tier: 1 }).error, /no active workflow calls/)
  })
  it('untiered never fails and is counted, not named, in the summary; vendored follows its manifest version', () => {
    const repos = [{ slug: 'o/hidden', kitPin: { untiered: true } }, { slug: 'o/m', kitPin: { ref: 'main' } }]
    assert.deepEqual(kitFailures(repos, '0.62.0'), [])
    const line = kitSummary(repos, '0.62.0')
    assert.match(line, /1 untiered repo not checked/)
    assert.doesNotMatch(line, /hidden/)
    assert.deepEqual(kitFailures([{ slug: 'o/v', kitPin: { vendored: true, version: '0.49.0' } }], '0.62.0').map((r) => r.gap), ['far-behind'])
    assert.deepEqual(kitFailures([{ slug: 'o/v', kitPin: { vendored: true, version: '0.62.0' } }], '0.62.0'), [])
    assert.deepEqual(kitFailures([{ slug: 'o/v', kitPin: { error: 'vendored kit has no manifest' } }], '0.62.0').map((r) => r.gap), ['error'])
  })
  it('a row end to end: vendored takes the repository manifest version, an untiered row carries the flag', async () => {
    const now = new Date('2026-11-17T12:00:00Z')
    const file = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') })
    const mk = (workflowText, manifest) => (args) => {
      const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
      if (path === 'repos/o/site') return { private: false, visibility: 'public', default_branch: 'main' }
      if (path === 'pr list') return []
      if (path.includes('/branches')) return [[]]
      if (path.endsWith('/workflows?per_page=100')) return { workflows: [{ id: 1, name: 'x', path: '.github/workflows/x.yml', state: 'active' }] }
      if (path.endsWith('/contents/.github/workflows/x.yml')) return file(workflowText)
      if (path.endsWith('/contents/verification-kit/MANIFEST.json') && manifest) return file(JSON.stringify({ version: manifest }))
      if (path.includes('/contents/')) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' })
      if (path.endsWith('/commits/main')) return { sha: 'abc' }
      if (path.includes('/actions/runs?')) return [{ workflow_runs: [] }]
      if (path.endsWith('/status')) return { state: 'success', statuses: [] }
      if (path.includes('/dependabot/alerts?')) return [[]]
      throw new Error(`unexpected call ${args.join(' ')}`)
    }
    const v = await collectRepo('o/site', now, { json: mk(vendoredRun, '0.49.0'), log: () => {}, tier: 3 })
    assert.deepEqual(v.kitPin, { vendored: true, version: '0.49.0' })
    assert.deepEqual(kitFailures([v], '0.62.0').map((r) => r.gap), ['far-behind'])
    const noManifest = await collectRepo('o/site', now, { json: mk(vendoredRun, null), log: () => {}, tier: 3 })
    assert.deepEqual(noManifest.kitPin, { error: 'vendored kit has no manifest' })
    const u = await collectRepo('o/site', now, { json: mk(review, null), log: () => {} })
    assert.deepEqual(u.kitPin, { untiered: true })
    assert.deepEqual(kitFailures([u], '0.62.0'), [])
  })
})

describe('vendored rows through the published path, and the summary count', () => {
  it('a private repository running its own kit stays {vendored, version} when redacted, never an error row', async () => {
    const now = new Date('2026-11-17T12:00:00Z')
    const file = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') })
    const json = (args) => {
      const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
      if (path === 'repos/o/hidden') return { private: true, visibility: 'private', default_branch: 'main' }
      if (path === 'pr list') return []
      if (path.includes('/branches')) return [[]]
      if (path.endsWith('/workflows?per_page=100')) return { workflows: [{ id: 1, name: 'x', path: '.github/workflows/x.yml', state: 'active' }] }
      if (path.endsWith('/contents/.github/workflows/x.yml')) return file('steps:\n  - run: node verification-kit/bin/verify-all.mjs\n')
      if (path.endsWith('/contents/verification-kit/MANIFEST.json')) return file(JSON.stringify({ version: '0.61.0' }))
      if (path.includes('/contents/')) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' })
      if (path.endsWith('/commits/main')) return { sha: 'abc' }
      if (path.includes('/actions/runs?')) return [{ workflow_runs: [] }]
      if (path.endsWith('/status')) return { state: 'success', statuses: [] }
      if (path.includes('/dependabot/alerts?')) return [[]]
      throw new Error(`unexpected call ${args.join(' ')}`)
    }
    const row = await collectRepo('o/hidden', now, { json, log: () => {}, tier: 3 })
    assert.equal(row.redacted, true)
    assert.deepEqual(row.kitPin, { vendored: true, version: '0.61.0' })
    assert.deepEqual(redactPin({ vendored: true, version: '0.61.0' }), { vendored: true, version: '0.61.0' })
    assert.deepEqual(kitFailures([row], '0.65.0').map((r) => r.gap), ['far-behind'])
  })
  it('vendored rows are not counted among the repos that pin the gate at main', () => {
    const repos = [{ slug: 'o/a', kitPin: { ref: 'main' } }, { slug: 'o/v', kitPin: { vendored: true, version: '0.65.0' } }]
    assert.match(kitSummary(repos, '0.65.0'), /all 1 repos pin the gate at main \(0\.65\.0\), 1 run their own kit copy/)
    assert.match(kitSummary([repos[0], { slug: 'o/v', kitPin: { vendored: true, version: '0.61.0' } }], '0.65.0'), /o\/v vendored kit 0\.61\.0 \(far-behind\)/)
  })
})

describe('round 4: every gate file is read, tier-1 none fails, rate limits are not cached', () => {
  it('two gate-bearing files that pin different refs are an error row, whichever is read first', () => {
    const texts = {
      '.github/workflows/ci.yml': gate('main'),
      '.github/workflows/pr-check.yml': `jobs:\n  g:\n    uses: gorfednet/.github/.github/workflows/pr-check-static.yml@${SHA}\n`,
    }
    for (const order of [Object.keys(texts), Object.keys(texts).reverse()]) {
      const pin = readKitPin(order.map((p) => wf(p)), (p) => texts[p])
      assert.match(pin.error, /2 different refs/)
    }
    const same = { ...texts, '.github/workflows/pr-check.yml': gate('main') }
    assert.deepEqual(readKitPin(Object.keys(same).map((p) => wf(p)), (p) => same[p]), { ref: 'main' })
  })
  it('a file missing from the default branch beside a pin does not change the pin', () => {
    assert.deepEqual(readKitPin([wf('.github/workflows/ci.yml'), wf('.github/workflows/other.yml')], (p) => (p.endsWith('ci.yml') ? gate('main') : null)), { ref: 'main' })
  })
  it('a tier-1 row carrying none fails in kitFailures, whoever wrote it; tier 0 passes', () => {
    const row = { slug: 'o/t1', kitPin: { none: true } }
    assert.deepEqual(kitFailures([row], '0.61.0', [{ slug: 'o/t1', tier: 1 }]).map((r) => r.gap), ['error'])
    assert.deepEqual(kitFailures([row], '0.61.0', [{ slug: 'o/t1', tier: 0 }]), [])
    assert.deepEqual(kitFailures([row], '0.61.0', []), [])
  })
  it('a rate limit while reading a ref manifest is rethrown and not cached; another failure is a row error and not cached', () => {
    const limited = () => { throw Object.assign(new Error('x'), { stderr: 'gh: API rate limit exceeded (HTTP 403)' }) }
    const cache = new Map()
    assert.throws(() => resolveKitPin({ ref: SHA }, limited, cache), /x/)
    assert.equal(cache.size, 0)
    const boom = () => { throw new Error('HTTP 500') }
    assert.match(resolveKitPin({ ref: SHA }, boom, cache).error, /unreadable/)
    assert.equal(cache.size, 0)
    const ok = () => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ version: '0.49.0' })).toString('base64') })
    assert.deepEqual(resolveKitPin({ ref: SHA }, ok, cache), { ref: SHA, version: '0.49.0' })
  })
})
