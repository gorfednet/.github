// The GitHub quota sampler and the guard's call log: a burn can be matched to its callers (row 1.14 follow-up).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALLER, SPIKE, makeSample, redact } from '../scripts/gh-quota-sample.mjs'

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
  run('gh secret set DEPLOY_KEY -b s3cr3tshort')
  run("echo 'hunter2longpass' | gh secret set DEPLOY_KEY")
  run('gh auth login --with-token <<< plainvalue99')
  run("gh secret set Z <<'EOF'\nheredocsecret77\nEOF")
  run('gh secret set Y --body "two words secret"')
  const refused = run('while true; do gh api x; sleep 1; done')
  assert.match(refused.stdout, /deny/)
  const text = readFileSync(log, 'utf8')
  for (const secret of ['ghp_abc123', 'hunter2hunter2', 'github_pat_11AAA', 's3cr3tshort', 'two words secret', 'words secret', 'hunter2longpass', 'plainvalue99', 'heredocsecret77']) assert.ok(!text.includes(secret), `${secret} leaked into the call log`)
  const lines = text.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 9)
  assert.deepEqual(lines.map((l) => l.denied), [false, false, false, false, false, false, false, false, true])
  assert.equal(statSync(log).mode & 0o077, 0)
})

test('the sampler lists a plain node or python script, not only gh and our tools', () => {
  assert.ok(CALLER.test('812 00:40 node scratch/poll.mjs'))
  assert.ok(CALLER.test('813 00:40 python3 /tmp/loop.py'))
  assert.ok(CALLER.test('814 00:05 gh run watch 5 --interval 60'))
  assert.ok(!CALLER.test('815 00:05 /usr/bin/vim notes.md'))
})

test('the sampler redacts tokens in a process line before saving it, and writes owner-only', () => {
  const line = 'curl -s -H "Authorization: token ghp_test123" https://api.github.com/rate_limit'
  assert.ok(!redact(line).includes('ghp_test123'))
  assert.ok(!redact('node poll.mjs GH_TOKEN=abc123def').includes('abc123def'))
  assert.ok(!redact('gh secret set X -b "two words"').includes('words'))
  assert.ok(!redact("gh secret set Z <<'EOF'\nheredocsecret77\nEOF").includes('heredocsecret77'))
  assert.ok(!redact("echo 'hunter2longpass' | gh secret set X").includes('hunter2'))
  assert.match(redact('gh run watch 5 --interval 60'), /--interval 60/)
  const dir = mkdtempSync(join(tmpdir(), 'ghq-'))
  const file = join(dir, 'sub', 'samples.jsonl')
  // A fake gh first on PATH: the test never calls GitHub, and the run must succeed so the mode checks always run.
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho \'{"resources":{"core":{"remaining":4000,"reset":1}}}\'\n')
  chmodSync(join(dir, 'gh'), 0o755)
  const r = spawnSync(process.execPath, [new URL('../scripts/gh-quota-sample.mjs', import.meta.url).pathname], { env: { ...process.env, GH_QUOTA_LOG: file, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(statSync(file).mode & 0o077, 0)
  assert.equal(statSync(join(dir, 'sub')).mode & 0o077, 0)
})
