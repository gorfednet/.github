// The GitHub quota sampler and the guard's call log: a burn can be matched to its callers (row 1.14 follow-up).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPIKE, makeSample } from '../scripts/gh-quota-sample.mjs'

test('a drop of SPIKE or more in one window carries the callers; a quiet minute or a new window does not', () => {
  const ps = () => ['1 00:10 gh run watch 5 --interval 60']
  const prev = { remaining: 4000, resetAt: 100 }
  assert.deepEqual(makeSample({ prev, remaining: 3000, resetAt: 100, now: 't', ps }).callers, ps())
  assert.equal(makeSample({ prev, remaining: 4000 - (SPIKE - 1), resetAt: 100, now: 't', ps }).callers, undefined)
  const fresh = makeSample({ prev, remaining: 5000, resetAt: 200, now: 't', ps })
  assert.equal(fresh.spent, undefined)
  assert.equal(fresh.callers, undefined)
  assert.equal(makeSample({ prev: null, remaining: 5000, resetAt: 200, now: 't', ps }).spent, undefined)
})

test('the guard logs a command that calls GitHub with its session, and nothing else', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ghlog-')), 'calls.log')
  const hook = new URL('../docs/claude-home/hooks/gh-poll-guard.py', import.meta.url).pathname
  const run = (command) => spawnSync('python3', ['-I', hook], { input: JSON.stringify({ tool_name: 'Bash', session_id: 'S1', cwd: '/x', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, GH_GUARD_LOG: log } })
  assert.equal(run('ls -la').status, 0)
  assert.equal(run('gh pr view 5 --repo a/b').status, 0)
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.deepEqual([lines[0].session, lines[0].cwd], ['S1', '/x'])
  assert.match(lines[0].cmd, /gh pr view 5/)
})
