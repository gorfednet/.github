// install.sh and capacity/install.sh pick their Node with scripts/lib/resolve-node.sh (14 November 2026,
// INCIDENTS.md): a Node inside another tool's private folder (~/.hermes) is refused, because archiving
// that tool would stop the only merger.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('refuses a private node when HOME is a symlink to the real home', () => {
    const home = mac()
    const link = `${home}-link`
    symlinkSync(home, link)
    const r = resolve(link, { RESOLVE_NODE_CANDIDATES: join(home, '.local', 'bin', 'node') })
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /another tool's private folder/)
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

  it('NODE_BIN refuses a binary whose version output is not a number', () => {
    const home = mac()
    const odd = join(home, 'odd-node')
    writeFileSync(odd, '#!/bin/sh\necho "$@"\n')
    chmodSync(odd, 0o755)
    const r = resolve(home, { NODE_BIN: odd })
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
  })

  it('skips a candidate below the version floor', () => {
    const home = mac()
    const old = join(home, 'usr', 'bin', 'node')
    fake(old, '20')
    const r = resolve(home, { RESOLVE_NODE_CANDIDATES: old })
    assert.notEqual(r.status, 0)
  })

  it('takes the user-owned ~/.local/share/node/24 install first, and prints the stable link, not the versioned directory (plan row 3.20k)', () => {
    const home = mac()
    const keg = join(home, '.local', 'share', 'node', 'v24.22.3', 'bin', 'node')
    fake(keg, '24')
    symlinkSync(join(home, '.local', 'share', 'node', 'v24.22.3'), join(home, '.local', 'share', 'node', '24'))
    const stable = join(home, '.local', 'share', 'node', '24', 'bin', 'node')
    const old = join(home, 'usr', 'local', 'bin', 'node')
    fake(old, '24')
    const r = resolve(home, { RESOLVE_NODE_CANDIDATES: `${stable} ${old}` })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), stable)
    // The default list starts with that same path under $HOME.
    const d = resolve(home, {})
    assert.equal(d.stdout.trim(), stable, d.stderr)
  })

  it('refuses the shell\'s ~/.local/bin/node link into the user-owned folder, a 24 link into another tool, a .. path and a dangling 24 link', () => {
    const home = mac()
    // The Mac's real layout: ~/.local/bin/node -> ~/.local/share/node/v22.x, first on PATH, no 24 install yet.
    fake(join(home, '.local', 'share', 'node', 'v22.23.1', 'bin', 'node'), '22')
    rmSync(join(home, '.local', 'bin', 'node'))
    symlinkSync(join(home, '.local', 'share', 'node', 'v22.23.1', 'bin', 'node'), join(home, '.local', 'bin', 'node'))
    const viaPath = resolve(home, { RESOLVE_NODE_CANDIDATES: join(home, 'no-such-node') })
    assert.notEqual(viaPath.status, 0, 'PATH node must not become the agents\' Node')
    assert.equal(viaPath.stdout, '')
    assert.match(viaPath.stderr, /another tool's private folder/)
    // A 24 link that points into another tool, a near-miss folder name, and a .. path.
    const nodeishBin = join(home, '.local', 'share', 'nodeish', 'bin')
    fake(join(nodeishBin, 'node'), '24')
    symlinkSync(join(home, '.local', 'share', 'nodeish'), join(home, '.local', 'share', 'node', '24'))
    const link = join(home, '.local', 'share', 'node', '24', 'bin', 'node')
    assert.notEqual(resolve(home, { RESOLVE_NODE_CANDIDATES: link }).status, 0)
    assert.notEqual(resolve(home, { RESOLVE_NODE_CANDIDATES: join(home, '.local', 'share', 'node', '22', '..', 'nodeish', 'bin', 'node') }).status, 0)
    assert.notEqual(resolve(home, { RESOLVE_NODE_CANDIDATES: join(nodeishBin, 'node') }).status, 0)
    // A dangling stable link is an error, not a quiet fall through to the next candidate.
    rmSync(join(home, '.local', 'share', 'node', '24'))
    symlinkSync('v24.9.9', join(home, '.local', 'share', 'node', '24'))
    const sys = join(home, 'usr', 'bin', 'node')
    fake(sys, '24')
    const d = resolve(home, { RESOLVE_NODE_CANDIDATES: `${join(home, '.local', 'share', 'node', '24', 'bin', 'node')} ${sys}` })
    assert.notEqual(d.status, 0)
    assert.match(d.stderr, /link to nothing/)
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

  it('check.sh picks its Node with the resolver and refuses, before running any test, when only a private one exists', () => {
    const s = readFileSync(new URL('../check.sh', import.meta.url), 'utf8')
    assert.ok(!s.includes("node -p 'process.execPath'"), 'check.sh still takes whatever node is first on PATH')
    const home = mac()
    const r = spawnSync(new URL('../check.sh', import.meta.url).pathname, [], {
      encoding: 'utf8',
      env: { PATH: `${home}/.local/bin:/usr/bin:/bin`, HOME: home, RESOLVE_NODE_CANDIDATES: join(home, 'no-such-node') },
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /refusing .*\.hermes\/node\/bin\/node/)
    assert.match(r.stderr, /no usable Node/)
  })

  it('install.sh records the Node check.sh passed on beside the app, after the swap', () => {
    const s = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
    assert.match(s, /"\$\{NODE_BIN\}" --version >"\$\{APP_DIR\}\.node-version"/)
    const swap = s.indexOf('"${INSTALLER}" swap')
    assert.ok(swap >= 0, 'install.sh no longer swaps through the installer')
    assert.ok(swap < s.indexOf('.node-version'), 'record must follow the swap')
  })

  // Only ship-bot's own installer here: install.sh runs these tests from a `git archive` of
  // ship-bot/ and scripts/, which has no capacity/ (test/installersNode.test.mjs checks both).
  it('ship-bot\'s installer uses it and stops when it refuses', () => {
    for (const f of ['../install.sh']) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.match(s, /source "\$\{HERE\}\/\.\.\/scripts\/lib\/resolve-node\.sh"/, f)
      assert.match(s, /NODE_BIN="\$\(resolve_node\)" \|\| \{[^}]*exit 1/, f)
      assert.ok(!s.includes("node -p 'process.execPath'"), `${f} still records process.execPath`)
    }
  })
})
