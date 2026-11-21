// Assessment A4: must-rules held by a PreToolUse hook. Each rule has a refused case and a near-miss that passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-hooks', 'must-rules-guard.py');
function run(payload) {
  const r = spawnSync('python3', ['-I', HOOK], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  assert.ok(!r.error, String(r.error));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null;
}
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } });
const edit = (file_path, old_string, new_string) => run({ tool_name: 'Edit', tool_input: { file_path, old_string, new_string } });

test('review trigger: inline mention is refused, whole-line trigger passes', () => {
  assert.match(bash('gh pr comment 5 --body "please claude review this"'), /line by itself/);
  assert.equal(bash('gh pr comment 5 --body "claude review"'), null);
  assert.equal(bash("gh pr comment 5 --body 'Ready.\nclaude review'"), null);
  assert.equal(bash('echo "please claude review this"'), null);
  assert.equal(bash('gh pr comment 5 --body "done"'), null);
});

test('builder brief: needs git checkout -B and builder-ok', () => {
  const agent = (prompt, subagent_type = 'builder') => run({ tool_name: 'Agent', tool_input: { subagent_type, prompt } });
  assert.match(agent('do the thing'), /Missing: git checkout -B, builder-ok/);
  assert.match(agent('run builder-ok first'), /Missing: git checkout -B\./);
  assert.equal(agent('git checkout -B x-build x; run builder-ok'), null);
  assert.equal(agent('do the thing', 'runner'), null);
});

test('skip needs a backlog id, and only new skips count', () => {
  assert.match(edit('test/a.test.mjs', '', "test.skip('x', () => {})"), /backlog id/);
  assert.equal(edit('test/a.test.mjs', '', "// backlog:some-id\ntest.skip('x', () => {})"), null);
  assert.equal(edit('test/a.test.mjs', '', "test.skip('x') // backlog:some-id"), null);
  assert.equal(edit('test/a.test.mjs', "test.skip('x')", "test.skip('x')\nfoo()"), null);
  assert.equal(edit('src/a.js', '', "test.skip('x')"), null);
});

test('bad input fails open', () => {
  const r = spawnSync('python3', ['-I', HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
