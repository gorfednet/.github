// install.sh and capacity/install.sh pick their Node with scripts/lib/resolve-node.sh (14 November 2026,
// INCIDENTS.md): a Node inside another tool's private folder (~/.hermes) is refused, because archiving
// that tool would stop the only merger.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

const lib = new URL('../../scripts/lib/resolve-node.sh', import.meta.url).pathname
const fake = (path, version) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`)
  chmodSync(path, 0o755)
}
const resolve = (home, env) =>
  spawnSync('bash', ['-c', `source "${lib}"; resolve_node`], { encoding: 'utf8', env: { PATH: `${home}/.local/bin:/usr/bin:/bin`, HOME: home, ...env } })

function mac() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-node-')))
  fake(join(home, '.hermes', 'node', 'bin', 'node'), '22')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  symlinkSync(join(home, '.hermes', 'node', 'bin', 'node'), join(home, '.local', 'bin', 'node'))
  return home
}

describe('resolve_node', () => {
  it('refuses a PATH node that is a symlink into ~/.hermes, with a clear message and non-zero exit', () => {
    const home = mac()
    const r = resolve(home, { RESOLVE_NODE_CANDIDATES: join(home, 'no-such-node') })
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /refusing .*\.hermes\/node\/bin\/node: it lives in another tool's private folder/)
  })

  it('prefers a system node over a private one earlier on PATH, and prints its path', () => {
    const home = mac()
    const sys = join(home, 'usr', 'bin', 'node')
    fake(sys, '24')
    const r = resolve(home, { RESOLVE_NODE_CANDIDATES: sys })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), sys)
  })

  it('prints a stable symlink, not the versioned keg it points at', () => {
    const home = mac()
    const keg = join(home, 'opt', 'Cellar', 'node', '24.1.0', 'bin', 'node')
    fake(keg, '24')
    const link = join(home, 'opt', 'bin', 'node')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(keg, link)
    const r = resolve(home, { RESOLVE_NODE_CANDIDATES: link })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), link)
  })

  it('skips a candidate below the version floor', () => {
    const home = mac()
    const old = join(home, 'usr', 'bin', 'node')
    fake(old, '20')
    const r = resolve(home, { RESOLVE_NODE_CANDIDATES: old })
    assert.notEqual(r.status, 0)
  })

  it('NODE_BIN overrides the private-folder refusal, but not the version floor or a missing file', () => {
    const home = mac()
    const priv = join(home, '.hermes', 'node', 'bin', 'node')
    const ok = resolve(home, { NODE_BIN: priv })
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.stdout.trim(), priv)
    const old = join(home, 'old-node')
    fake(old, '18')
    assert.match(resolve(home, { NODE_BIN: old }).stderr, /needs Node 22 or newer/)
    assert.notEqual(resolve(home, { NODE_BIN: join(home, 'missing') }).status, 0)
  })

  it('both installers use it and stop when it refuses', () => {
    for (const f of ['../install.sh', '../../capacity/install.sh']) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.match(s, /source "\$\{HERE\}\/\.\.\/scripts\/lib\/resolve-node\.sh"/, f)
      assert.match(s, /NODE_BIN="\$\(resolve_node\)" \|\| \{[^}]*exit 1/, f)
      assert.ok(!s.includes("node -p 'process.execPath'"), `${f} still records process.execPath`)
    }
  })
})
