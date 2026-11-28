import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { changedSince, matchingFiles, splitNul } from '../lib/deploy.mjs'
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

  it('a paused path with non-ASCII, quote and backslash names still matches (git would C-quote them without -z)', async () => {
    const base = g('rev-parse', 'HEAD')
    const names = ['server/\u00e9.sql', 'server/a"b.sql', 'server/c\\d.sql', 'server/sp ace.sql']
    for (const n of names) writeFileSync(join(dir, n), 'x\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'odd names')
    const head = g('rev-parse', 'HEAD')
    assert.match(g('-c', 'core.quotePath=true', 'diff', '--name-only', base, head), /"server\/\\303\\251\.sql"/, 'plain git C-quotes the name')
    const changed = await changedSince(ctx, log, dir, base, head)
    assert.deepEqual(changed.sort(), [...names].sort())
    assert.equal(matchingFiles(changed, ['server/']).length, names.length)
  })

  it('splitNul keeps whitespace in a path and drops the empty tail', () => {
    assert.deepEqual(splitNul(' a b\0c\0'), [' a b', 'c'])
    assert.deepEqual(splitNul(''), [])
  })
})
