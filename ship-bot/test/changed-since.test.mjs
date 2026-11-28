import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { changedSince, matchingFiles } from '../lib/deploy.mjs'
import { realRunner } from '../lib/runner.mjs'

// Real git: a fake runner cannot tell whether git lists a rename's old path.
const dir = mkdtempSync(join(tmpdir(), 'changed-since-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim()
const ctx = { runner: realRunner, baseEnv: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, gitAuth: 'x' }
const log = { write() {} }

describe('changedSince lists both sides of a rename', () => {
  it('a file moved out of a pausedIfChanged path still counts as changed there', async () => {
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 't')
    mkdirSync(join(dir, 'server'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'server', 'db.sql'), 'create table t (a int, b int, c int);\n'.repeat(20))
    writeFileSync(join(dir, 'src', 'app.js'), 'x\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'one')
    const base = g('rev-parse', 'HEAD')
    renameSync(join(dir, 'server', 'db.sql'), join(dir, 'src', 'db.sql'))
    g('add', '-A')
    g('commit', '-q', '-m', 'move')
    const head = g('rev-parse', 'HEAD')
    assert.match(g('diff', '--name-status', base, head), /^R\d+\s+server\/db\.sql\s+src\/db\.sql/, 'git does see a rename here')
    const changed = await changedSince(ctx, log, dir, base, head)
    assert.deepEqual(changed.sort(), ['server/db.sql', 'src/db.sql'])
    assert.deepEqual(matchingFiles(changed, ['server/']), ['server/db.sql'])
  })
})
