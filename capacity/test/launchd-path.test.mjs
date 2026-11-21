// The installed plist's PATH must reach gh (21 November 2026): launchd's bare PATH has none, so the first
// installed pool check wrote state "unknown" and began pushing "pool check failed". install.sh now resolves
// gh when it installs and refuses to install without it. Nothing here touches the real ~/Library or ~/.desk.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('../../', import.meta.url).pathname
const BARE = '/usr/bin:/bin:/usr/sbin:/sbin'
const isMac = process.platform === 'darwin'

const exe = (path, body = '#!/bin/sh\nexit 0\n') => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'capacity-path-')))

function launchdPath(env) {
  return spawnSync('bash', ['-c', `source "${repo}capacity/launchd-path.sh"; capacity_launchd_path`], { encoding: 'utf8', env })
}

/** The installer in a scratch tree: the real install.sh and helper, a stub check.sh (the real one runs these tests), a fake launchctl. */
function scratch({ gh }) {
  const root = tmp()
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(home, { recursive: true })
  const copy = (rel) => { mkdirSync(join(root, 'tree', rel, '..'), { recursive: true }); cpSync(join(repo, rel), join(root, 'tree', rel)) }
  for (const f of ['capacity/install.sh', 'capacity/launchd-path.sh', 'capacity/capacity.mjs', 'capacity/pool.mjs', 'ship-bot/lib/heartbeat.mjs', 'scripts/lib/usageAlert.mjs', 'scripts/lib/installedDrift.mjs', 'scripts/lib/installed-tools.mjs', 'scripts/lib/resolve-node.sh']) copy(f)
  exe(join(root, 'tree', 'capacity', 'check.sh'))
  exe(join(bin, 'launchctl'))
  if (gh) exe(join(gh, 'gh'))
  const run = spawnSync('bash', [join(root, 'tree', 'capacity', 'install.sh')], {
    encoding: 'utf8',
    env: { PATH: [gh, bin, '/usr/bin', '/bin'].filter(Boolean).join(':'), HOME: home, CAPACITY_INSTALL_ANY_CHECKOUT: '1', NODE_BIN: process.execPath },
  })
  return { run, home, plist: join(home, 'Library', 'LaunchAgents', 'net.gorfed.capacity.plist') }
}

test('capacity_launchd_path: gh\'s own folder first, then the bare launchd PATH', () => {
  const dir = join(tmp(), 'home-bin')
  exe(join(dir, 'gh'))
  const r = launchdPath({ PATH: `${dir}:/usr/bin:/bin` })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, `${dir}:${BARE}\n`)
})

test('capacity_launchd_path: no gh on PATH is an error with a clear message, never the bare PATH', () => {
  const r = launchdPath({ PATH: '/usr/bin:/bin' })
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /gh is not on PATH.*Nothing was installed/)
})

test('capacity_launchd_path: a gh that is not executable does not count', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\n')
  chmodSync(join(dir, 'gh'), 0o644)
  assert.notEqual(launchdPath({ PATH: `${dir}:/usr/bin:/bin` }).status, 0)
})

test('install.sh: the plist PATH carries the folder gh was found in, and no token', { skip: !isMac && 'macOS only' }, () => {
  const gh = join(tmp(), 'home-bin')
  const { run, plist } = scratch({ gh })
  assert.equal(run.status, 0, run.stderr)
  const text = readFileSync(plist, 'utf8')
  assert.ok(text.includes(`<key>PATH</key><string>${gh}:${BARE}</string>`), text)
  assert.doesNotMatch(text, /GH_TOKEN|GITHUB_TOKEN|ghp_|gho_/)
})

test('install.sh: no gh stops the install before it writes the plist or copies the app', { skip: !isMac && 'macOS only' }, () => {
  const { run, home, plist } = scratch({ gh: null })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /gh is not on PATH/)
  assert.equal(existsSync(plist), false)
  assert.equal(existsSync(join(home, '.desk')), false)
})
