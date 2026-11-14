// The GitHub quota sampler and the guard's call log: a burn can be matched to its callers (row 1.14 follow-up).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALLER, SPIKE, makeSample } from '../scripts/gh-quota-sample.mjs'

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

test('the call log redacts tokens and --body values, is owner-only, and marks a refused command as denied', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ghlog-')), 'calls.log')
  const hook = new URL('../docs/claude-home/hooks/gh-poll-guard.py', import.meta.url).pathname
  const run = (command) => spawnSync('python3', ['-I', hook], { input: JSON.stringify({ tool_name: 'Bash', session_id: 'S2', cwd: '/x', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, GH_GUARD_LOG: log } })
  run('GH_TOKEN=ghp_abc123 gh api user')
  run("gh secret set X --body 'hunter2hunter2'")
  run('echo github_pat_11AAA | gh auth login --with-token')
  const refused = run('while true; do gh api x; sleep 1; done')
  assert.match(refused.stdout, /deny/)
  const text = readFileSync(log, 'utf8')
  for (const secret of ['ghp_abc123', 'hunter2hunter2', 'github_pat_11AAA']) assert.ok(!text.includes(secret), `${secret} leaked into the call log`)
  const lines = text.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4)
  assert.deepEqual(lines.map((l) => l.denied), [false, false, false, true])
  assert.equal(statSync(log).mode & 0o077, 0)
})

test('the sampler lists a plain node or python script, not only gh and our tools', () => {
  assert.ok(CALLER.test('812 00:40 node /Users/x/scratch/poll.mjs'))
  assert.ok(CALLER.test('813 00:40 python3 /tmp/loop.py'))
  assert.ok(CALLER.test('814 00:05 gh run watch 5 --interval 60'))
  assert.ok(!CALLER.test('815 00:05 /usr/bin/vim notes.md'))
})
