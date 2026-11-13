// Plan row 5.10: the gh polling guard, a PreToolUse hook on Bash in every session.
// The 3 "real" fixtures are the commands that ran on 13 November 2026 while the
// GitHub quota sat at 0 (desk log, 15:02 ET): the 2.1 session's busy-wait, the
// backlog-triage session's poll2.sh and a merge poll. Each is copied verbatim
// from its session transcript, with home and scratchpad paths redacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'docs', 'claude-home', 'hooks', 'gh-poll-guard.py');
const fixture = (name) => readFileSync(join(here, 'fixtures', 'gh-poll-guard', name), 'utf8');

function run(command, extra = {}) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...extra });
  const r = spawnSync('python3', ['-I', HOOK], { input, encoding: 'utf8' });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  if (!r.stdout.trim()) return null;
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  return out.permissionDecisionReason;
}

const blocked = (command) => {
  const reason = run(command);
  assert.ok(reason, `expected a refusal for: ${command.slice(0, 120)}`);
  assert.match(reason, /gh run watch <id> --interval 60 --exit-status/);
  assert.match(reason, /run_in_background/);
  return reason;
};
const allowed = (command) => assert.equal(run(command), null, `expected to pass: ${command}`);

test('blocks the 2.1 busy-wait that spun a core for 3.5 h', () => {
  assert.match(blocked(fixture('busy-wait-2.1.sh')), /busy-wait/);
});

test('blocks poll2.sh, a review-status and gh loop written through a heredoc', () => {
  assert.match(blocked(fixture('poll2-backlog-triage.sh')), /`for` loop/);
});

test('blocks the merge poll (gh pr view every 120 s, up to 60 times per PR)', () => {
  blocked(fixture('merge-poll.sh'));
});

test('blocks other 13 November loop shapes', () => {
  // until-condition polls gh, body only sleeps (MoonMan, 01:52 UTC)
  blocked('H=$(git rev-parse HEAD); until [ "$(gh run list --commit $H --json status -q \'.[0].status\')" = completed ]; do sleep 60; done');
  // review-status alone in a loop (ops 62)
  blocked('for i in $(seq 1 36); do o=$(node scripts/review-status.mjs --pr 62 2>&1); echo "$o" | grep -q reviewed && break; sleep 15; done');
  // while true with gh api
  blocked('while true; do gh api rate_limit -q .resources.core.remaining; sleep 30; done');
  // busy-wait with `true` as the body
  blocked('until test -f /tmp/x; do true; done');
  // multi-line loop
  blocked('while :\ndo\n  gh pr checks 12\n  sleep "$WAIT"\ndone');
});

test('passes the waits and reads the rules tell sessions to use', () => {
  allowed('gh run watch 123456 --repo gorfednet/.github --interval 60 --exit-status');
  allowed('gh pr view 162 --repo gorfednet/.github --json state');
  allowed('sleep 5');
  allowed('sleep 30; gh run list --limit 1 --json databaseId');
});

test('passes loops that do not poll GitHub', () => {
  allowed('for f in *.md; do wc -l "$f"; done');
  allowed('for p in 1 2 3; do gh pr view $p --json state; done'); // no sleep: a one-pass read
  allowed('until curl -sf localhost:5173 >/dev/null; do sleep 1; done'); // local dev server
  allowed('until [ "$(TZ=America/Toronto date +%H%M)" -ge 1025 ]; do sleep 60; done; gh api rate_limit');
  allowed("git log --format='%h %s' | while read h rest; do :; done");
  allowed('echo "for each PR, gh pr view, then sleep 60 and done"');
});

test('fails open on input it cannot read', () => {
  const r = spawnSync('python3', ['-I', HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(run('while true; do gh api x; sleep 1; done', { tool_name: 'Read' }), null);
});
