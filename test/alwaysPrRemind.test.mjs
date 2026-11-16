// always-pr-remind.py (PostToolUse on Bash after git commit/push) read the PR with
// `gh pr view --json url state`: gh took `state` as the PR selector, exited non-zero
// and the hook said "no open GitHub PR" for branches that had one (desk-log, PR 139).
// A stub `gh` first on PATH answers only to the exact args `pr view --json url,state`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'scripts', 'claude-hooks', 'always-pr-remind.py');

function repoOnFeatureBranch() {
  const dir = mkdtempSync(join(tmpdir(), 'alwayspr-repo-'));
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'feature-x');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  return dir;
}

// The stub does this only for the exact args; any other call fails like gh does.
function stubGh({ stdout = '', stderr = '', status = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'alwayspr-gh-'));
  const file = join(dir, 'gh');
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$*" = "pr view --json url,state" ]; then
  printf '%s' '${stdout}'
  printf '%s' '${stderr}' >&2
  exit ${status}
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
  );
  chmodSync(file, 0o755);
  return dir;
}

function run(stub) {
  const cwd = repoOnFeatureBranch();
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd });
  const r = spawnSync('python3', ['-I', HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

test('an open PR gives no reminder', () => {
  const msg = run(stubGh({ stdout: '{"url":"u","state":"OPEN"}' }));
  assert.doesNotMatch(msg, /has no open GitHub PR/);
  assert.equal(msg, '');
});

test('gh says no PR for the branch: reminder to open one', () => {
  const msg = run(stubGh({ stderr: 'no pull requests found for branch "feature-x"', status: 1 }));
  assert.match(msg, /`feature-x` has no open GitHub PR/);
});

test('any other gh failure: could-not-check message, not a false "no PR"', () => {
  const msg = run(stubGh({ stderr: 'HTTP 502: Bad Gateway', status: 1 }));
  assert.match(msg, /could not check/);
  assert.doesNotMatch(msg, /has no open GitHub PR/);
});
