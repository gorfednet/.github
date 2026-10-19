// setup-playwright must behave differently on the self-hosted pool (no sudo, no apt, a
// root-owned browser path) than on hosted runners, and the two must never swap: a pool job
// running `install --with-deps` fails on sudo, and a hosted job skipping its install has
// no browsers. The decision lives in resolve.sh; npx is stubbed to record what it was asked.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ACTION = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'actions', 'setup-playwright')

function run({ locked = '1.64.1', pkg = '@playwright/test', preinstalled, browsers = 'chromium' }) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-pw-'))
  if (locked) {
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true })
    writeFileSync(join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: locked }))
  }
  mkdirSync(join(dir, 'bin'))
  const calls = join(dir, 'npx-calls')
  writeFileSync(join(dir, 'bin', 'npx'), `#!/bin/sh\necho "PATH=$PLAYWRIGHT_BROWSERS_PATH ARGS=$*" >> "${calls}"\n`)
  chmodSync(join(dir, 'bin', 'npx'), 0o755)
  const env = {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    HOME: dir,
    BROWSERS: browsers,
    RUNNER_TEMP: join(dir, 'tmp'),
    GITHUB_OUTPUT: join(dir, 'out'),
    GITHUB_ENV: join(dir, 'env'),
  }
  if (preinstalled !== undefined) env.BC_PREINSTALLED_PLAYWRIGHT_VERSION = preinstalled
  const r = spawnSync('bash', [join(ACTION, 'resolve.sh')], { cwd: dir, env, encoding: 'utf8' })
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  return { r, dir, out: read(env.GITHUB_OUTPUT), envFile: read(env.GITHUB_ENV), calls: read(calls) }
}

describe('setup-playwright resolve.sh', () => {
  it('hosted (env unset): mode=hosted and the script installs nothing itself', () => {
    const x = run({})
    assert.equal(x.r.status, 0, x.r.stderr)
    assert.match(x.out, /mode=hosted/)
    assert.match(x.out, /version=1\.64\.1/)
    assert.equal(x.calls, '')
    assert.equal(x.envFile, '')
  })

  it('hosted: action.yml still installs with system deps, only in hosted mode', () => {
    const yml = readFileSync(join(ACTION, 'action.yml'), 'utf8')
    assert.match(yml, /if: steps\.playwright\.outputs\.mode == 'hosted' && [^\n]*!= 'true'\n[^]*?npx playwright install --with-deps/)
    assert.match(yml, /id: playwright-cache\n\s+if: steps\.playwright\.outputs\.mode == 'hosted'/)
  })

  it('pool, image carries the locked version: skip', () => {
    const x = run({ preinstalled: '1.64.1' })
    assert.equal(x.r.status, 0, x.r.stderr)
    assert.match(x.out, /mode=pool-skip/)
    assert.match(x.r.stdout, /skipping browser install/)
    assert.equal(x.calls, '')
    assert.equal(x.envFile, '')
  })

  it('pool, image carries a list containing it: skip (comma and space separated)', () => {
    for (const list of ['1.62.1,1.64.1,1.63.0', '1.62.1 1.64.1', '1.62.1, 1.64.1']) {
      const x = run({ preinstalled: list })
      assert.match(x.out, /mode=pool-skip/, list)
      assert.equal(x.calls, '', list)
    }
  })

  it('pool, near-miss: 1.64.10 or 1.64 does not satisfy 1.64.1', () => {
    for (const list of ['1.64.10', '1.64', '11.64.1']) {
      const x = run({ preinstalled: list })
      assert.match(x.out, /mode=pool-install/, list)
    }
  })

  it('pool, image carries other versions: no-deps install into RUNNER_TEMP, GITHUB_ENV set', () => {
    const x = run({ preinstalled: '1.62.1', browsers: 'chromium firefox' })
    assert.equal(x.r.status, 0, x.r.stderr)
    assert.match(x.out, /mode=pool-install/)
    const target = join(x.dir, 'tmp', 'ms-playwright')
    assert.equal(x.calls.trim(), `PATH=${target} ARGS=playwright install chromium firefox`)
    assert.ok(!x.calls.includes('--with-deps'))
    assert.equal(x.envFile.trim(), `PLAYWRIGHT_BROWSERS_PATH=${target}`)
    assert.match(x.r.stdout, /::notice::.*1\.64\.1.*1\.62\.1.*image/)
  })

  it('falls back to the playwright package, and fails clearly when neither resolves', () => {
    assert.match(run({ pkg: 'playwright', locked: '1.63.0' }).out, /version=1\.63\.0/)
    const x = run({ locked: null })
    assert.notEqual(x.r.status, 0)
    assert.match(x.r.stdout, /::error::.*neither @playwright\/test nor playwright/)
  })
})
