// scripts/node-update.sh: the user-owned Node on the Mac that a session can patch without sudo (plan row 3.20k).
// Runs against a fake dist tree over file:// so no network and no Mac are needed; NODE_PLATFORM stands in for uname.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, rmSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const script = new URL('../scripts/node-update.sh', import.meta.url).pathname
const PLAT = 'darwin-arm64'

/** A dist tree with latest-v<major>.x/{SHASUMS256.txt, node-vX-darwin-arm64.tar.gz}; the fake node prints its version. */
function dist(top, major, version, { badSum = false, lie = false, lieViaLink = false } = {}) {
  const dir = join(top, 'dist', `latest-v${major}.x`)
  mkdirSync(dir, { recursive: true })
  const pkg = join(top, 'pkg', `node-${version}-${PLAT}`)
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  // lieViaLink: runs fine from its own v<version> directory but reports a wrong version when called through the stable <major> link.
  writeFileSync(join(pkg, 'bin', 'node'), lieViaLink ? `#!/bin/sh\ncase "$0" in */${major}/bin/node) echo v0.0.0 ;; *) echo ${version} ;; esac\n` : `#!/bin/sh\necho ${lie ? 'v0.0.0' : version}\n`)
  chmodSync(join(pkg, 'bin', 'node'), 0o755)
  const tarball = `node-${version}-${PLAT}.tar.gz`
  const r = spawnSync('tar', ['-czf', join(dir, tarball), '-C', join(top, 'pkg'), `node-${version}-${PLAT}`])
  assert.equal(r.status, 0)
  const sum = badSum ? '0'.repeat(64) : createHash('sha256').update(readFileSync(join(dir, tarball))).digest('hex')
  writeFileSync(join(dir, 'SHASUMS256.txt'), `${sum}  ${tarball}\n${'1'.repeat(64)}  node-${version}-linux-x64.tar.gz\n`)
}

function env() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'node-update-')))
  const root = join(top, 'home', '.local', 'share', 'node')
  const bin = join(top, 'home', '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const run = (...args) =>
    spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(top, 'home'), NODE_DIST_BASE: `file://${join(top, 'dist')}`, NODE_ROOT: root, NODE_SHELL_BIN: bin, NODE_LAUNCH_AGENTS: join(top, 'agents'), NODE_PLATFORM: PLAT },
    })
  return { top, root, bin, run }
}

describe('node-update.sh', () => {
  it('installs a major line with no earlier install, links it, and needs no sudo', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    const r = e.run('24')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readlinkSync(join(e.root, '24')), 'v24.22.3')
    assert.equal(spawnSync(join(e.root, '24', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim(), 'v24.22.3')
    assert.match(r.stdout, /node 24: none -> v24\.22\.3/)
  })

  it('patches in place: the stable link moves, the previous patch stays for rollback, the shell npmrc is carried over', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    assert.equal(e.run('24').status, 0)
    mkdirSync(join(e.root, 'v24.22.3', 'etc'), { recursive: true })
    writeFileSync(join(e.root, 'v24.22.3', 'etc', 'npmrc'), 'prefix=/x\n')
    dist(e.top, 24, 'v24.22.4')
    const r = e.run('24')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readlinkSync(join(e.root, '24')), 'v24.22.4')
    assert.ok(existsSync(join(e.root, 'v24.22.3', 'bin', 'node')), 'previous patch kept')
    assert.equal(readFileSync(join(e.root, 'v24.22.4', 'etc', 'npmrc'), 'utf8'), 'prefix=/x\n')
    assert.match(r.stdout, /rollback: ln -sfn v24\.22\.3 /)
    // A third patch prunes the one before the previous, never the one a shell link still names.
    symlinkSync(join(e.root, 'v24.22.3', 'bin', 'node'), join(e.bin, 'node'))
    dist(e.top, 24, 'v24.22.5')
    assert.equal(e.run('24').status, 0)
    assert.ok(existsSync(join(e.root, 'v24.22.3')), 'kept: a shell link names it')
    assert.ok(existsSync(join(e.root, 'v24.22.4')) && existsSync(join(e.root, 'v24.22.5')))
  })

  it('prunes a patch two behind that nothing names', () => {
    const e = env()
    for (const v of ['v24.22.3', 'v24.22.4', 'v24.22.5']) {
      dist(e.top, 24, v)
      assert.equal(e.run('24').status, 0)
    }
    assert.deepEqual(readdirSync(e.root).sort(), ['24', 'v24.22.4', 'v24.22.5'])
  })

  it('a rerun with nothing newer keeps the rollback target and still prints the rollback line', () => {
    const e = env()
    for (const v of ['v24.22.3', 'v24.22.4']) {
      dist(e.top, 24, v)
      assert.equal(e.run('24').status, 0)
    }
    const again = e.run('24')
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /already unpacked/)
    assert.ok(existsSync(join(e.root, 'v24.22.3', 'bin', 'node')), 'the patch before the latest is still there to roll back to')
    assert.match(again.stdout, /rollback: ln -sfn v24\.22\.3 /)
    assert.equal(readlinkSync(join(e.root, '24')), 'v24.22.4')
  })

  it('is a no-op when already on the latest, and --check reads without writing', () => {
    const e = env()
    dist(e.top, 22, 'v22.23.5')
    const c0 = e.run('22', '--check')
    assert.equal(c0.status, 1)
    assert.match(c0.stdout, /installed none, latest v22\.23\.5/)
    assert.ok(!existsSync(e.root), '--check wrote nothing')
    assert.equal(e.run('22').status, 0)
    const again = e.run('22')
    assert.equal(again.status, 0)
    assert.match(again.stdout, /already unpacked/)
    assert.equal(e.run('22', '--check').status, 0)
  })

  it('refuses a tarball whose SHA-256 is not the list\'s, and leaves the old link and install alone', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    assert.equal(e.run('24').status, 0)
    dist(e.top, 24, 'v24.22.4', { badSum: true })
    const r = e.run('24')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /SHA-256 mismatch/)
    assert.equal(readlinkSync(join(e.root, '24')), 'v24.22.3')
    assert.ok(!existsSync(join(e.root, 'v24.22.4')))
  })

  it('puts the old link back when the node checks out on its own but fails through the stable link', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    assert.equal(e.run('24').status, 0)
    dist(e.top, 24, 'v24.22.4', { lieViaLink: true })
    const r = e.run('24')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /the link was put back/)
    assert.equal(readlinkSync(join(e.root, '24')), 'v24.22.3')
    // First install, nothing to go back to: the link is removed rather than left on a bad node.
    const f = env()
    dist(f.top, 24, 'v24.22.3', { lieViaLink: true })
    assert.notEqual(f.run('24').status, 0)
    assert.ok(!existsSync(join(f.root, '24')))
  })

  it('refuses a list that names a version outside the requested line, changing nothing', () => {
    const e = env()
    dist(e.top, 24, 'v25.0.0') // published under latest-v24.x
    const r = e.run('24')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /not in line 24/)
    assert.ok(!existsSync(e.root), 'nothing written')
  })

  it('refuses a node that does not report the version the list named', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3', { lie: true })
    const r = e.run('24')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /does not report v24\.22\.3/)
    assert.ok(!existsSync(join(e.root, '24')))
  })

  it('exits 2, changing nothing, when the list cannot be read or has no tarball for this platform', () => {
    const e = env()
    assert.equal(e.run('24').status, 2)
    assert.equal(e.run('24', '--check').status, 2)
    dist(e.top, 24, 'v24.22.3')
    const r = spawnSync('bash', [script, '24'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: e.top, NODE_DIST_BASE: `file://${join(e.top, 'dist')}`, NODE_ROOT: e.root, NODE_PLATFORM: 'darwin-x64' } })
    assert.equal(r.status, 2)
    assert.ok(!existsSync(join(e.root, '24')))
  })

  it('--link-shell points node, npm and npx at the stable link, so the next patch reaches new shells', () => {
    const e = env()
    dist(e.top, 22, 'v22.23.5')
    const old = join(e.root, 'v22.23.1', 'bin')
    mkdirSync(old, { recursive: true })
    mkdirSync(join(e.root, 'v22.23.1', 'etc'))
    writeFileSync(join(e.root, 'v22.23.1', 'etc', 'npmrc'), 'prefix=/home\n')
    for (const t of ['node', 'npm', 'npx']) symlinkSync(join(old, t), join(e.bin, t))
    const r = e.run('22', '--link-shell')
    assert.equal(r.status, 0, r.stderr)
    for (const t of ['node', 'npm', 'npx']) assert.equal(readlinkSync(join(e.bin, t)), join(e.root, '22', 'bin', t))
    assert.ok(lstatSync(join(e.bin, 'node')).isSymbolicLink())
    // The hand-made install this replaces (no 22 link yet) is the rollback target, and its npmrc carries over.
    assert.ok(readdirSync(e.root).includes('v22.23.1'), 'the install it replaces is kept')
    assert.equal(readFileSync(join(e.root, 'v22.23.5', 'etc', 'npmrc'), 'utf8'), 'prefix=/home\n')
    assert.match(r.stdout, /rollback: ln -sfn v22\.23\.1 /)
  })

  it('never links a directory whose node does not run: a broken earlier unpack is replaced, a stale .part is cleared', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    assert.equal(e.run('24').status, 0)
    dist(e.top, 24, 'v24.22.4')
    mkdirSync(join(e.root, 'v24.22.4', 'bin'), { recursive: true })
    writeFileSync(join(e.root, 'v24.22.4', 'bin', 'node'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(e.root, 'v24.22.4', 'bin', 'node'), 0o755)
    mkdirSync(join(e.root, 'v24.22.4.part', 'junk'), { recursive: true })
    const r = e.run('24')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(spawnSync(join(e.root, '24', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim(), 'v24.22.4')
    assert.ok(!existsSync(join(e.root, 'v24.22.4.part')))
    assert.ok(!existsSync(join(e.root, 'v24.22.4', 'node-v24.22.4-darwin-arm64')), 'nothing nested')
    assert.ok(!existsSync(join(e.root, 'v24.22.4.bad')), 'the set-aside copy is removed')
  })

  it('repairing the install the stable link names carries its npmrc over (read from the set-aside copy)', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    assert.equal(e.run('24').status, 0)
    mkdirSync(join(e.root, 'v24.22.3', 'etc'), { recursive: true })
    writeFileSync(join(e.root, 'v24.22.3', 'etc', 'npmrc'), 'prefix=/kept\n')
    writeFileSync(join(e.root, 'v24.22.3', 'bin', 'node'), '#!/bin/sh\nexit 1\n') // broken: fails the version check
    const r = e.run('24')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(e.root, 'v24.22.3', 'etc', 'npmrc'), 'utf8'), 'prefix=/kept\n')
    assert.equal(spawnSync(join(e.root, '24', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim(), 'v24.22.3')
  })

  it('puts a set-aside broken install back when the replacement cannot be fetched, so the stable link never dangles', () => {
    const e = env()
    dist(e.top, 24, 'v24.22.3')
    assert.equal(e.run('24').status, 0)
    writeFileSync(join(e.root, 'v24.22.3', 'bin', 'node'), '#!/bin/sh\nexit 1\n') // looks broken to the check
    rmSync(join(e.top, 'dist', 'latest-v24.x', 'node-v24.22.3-darwin-arm64.tar.gz'))
    const r = e.run('24')
    assert.notEqual(r.status, 0)
    assert.ok(existsSync(join(e.root, 'v24.22.3', 'bin', 'node')), 'the install came back')
    assert.ok(!existsSync(join(e.root, 'v24.22.3.bad')))
    assert.equal(readlinkSync(join(e.root, '24')), 'v24.22.3')
  })

  it('keeps a patch that a relative shell link or a LaunchAgent plist still names', () => {
    const e = env()
    for (const v of ['v24.22.3', 'v24.22.4', 'v24.22.5', 'v24.22.6']) {
      dist(e.top, 24, v)
      if (v === 'v24.22.4') {
        assert.equal(e.run('24').status, 0)
        symlinkSync('../share/node/v24.22.4/bin/node', join(e.bin, 'node'))
        const agents = join(e.top, 'agents')
        mkdirSync(agents)
        writeFileSync(join(agents, 'net.gorfed.x.plist'), `<string>${e.root}/v24.22.3/bin/node</string>`)
      } else {
        assert.equal(e.run('24').status, 0)
      }
    }
    assert.deepEqual(readdirSync(e.root).sort(), ['24', 'v24.22.3', 'v24.22.4', 'v24.22.5', 'v24.22.6'])
  })

  it('takes only 22 or 24 and never touches /usr/local', () => {
    const e = env()
    assert.equal(e.run('20').status, 64)
    assert.equal(e.run().status, 64)
    const s = readFileSync(script, 'utf8')
    assert.ok(!/\bsudo\b\s/.test(s.replace(/^#.*$/gm, '')), 'no sudo in the code')
    assert.ok(!s.replace(/^#.*$/gm, '').includes('/usr/local'), 'never writes /usr/local')
  })
})
