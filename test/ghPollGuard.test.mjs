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

test('blocks loops handed to another shell, and gh loops with no sleep', () => {
  blocked("bash -c 'while true; do gh pr checks 12; sleep 30; done'");
  blocked('zsh -c "until gh run view 5 --exit-status; do sleep 30; done"');
  blocked("hc run --bg --name poll --cwd . -- bash -c 'while true; do gh pr view 5 --json state; sleep 60; done'");
  blocked("hc run --bg --name poll -- zsh -lc 'for i in $(seq 60); do gh pr view 5; sleep 120; done'");
  blocked('ssh dapyllil "while true; do gh api rate_limit; sleep 10; done"');
  blocked("eval 'while :; do gh pr checks 3; sleep 20; done'");
  blocked('while true; do gh pr view 5 --json state -q .state | grep -q MERGED && break; done');
  blocked('until gh run view 9 --exit-status >/dev/null; do echo waiting; done');
  blocked('while true; do /opt/homebrew/bin/gh pr checks 5; sleep 30; done');
  blocked('cat > $TMPDIR/w.sh <<\'EOF\'\nwhile true; do gh pr view 5; sleep 60; done\nEOF\nzsh $TMPDIR/w.sh');
  blocked('bash <<EOF\nuntil gh pr view 5 | grep -q MERGED; do sleep 60; done\nEOF');
});

test('blocks stray keywords and comments inside a real poll loop', () => {
  blocked('while true; do gh pr checks 5; echo "(for PR 5)"; sleep 60; done');
  blocked('while true; do gh pr checks 5 && break; echo "pending; while waiting"; sleep 60; done');
  blocked("while true; do s=$(gh run view 9 --json status -q .status); echo \"$s\" | grep -qE 'completed|done' && break; sleep 30; done");
  blocked('while true; do\n  # check; for each PR\n  gh pr checks 5\n  sleep 60\ndone');
});

test('blocks default-interval watchers and watch(1) on gh', () => {
  assert.match(blocked('gh run watch 123 --exit-status'), /--interval 60/);
  blocked('gh run watch 123 --interval 3 --exit-status');
  blocked('gh pr checks 12 --watch');
  blocked('watch -n 30 gh pr checks 12');
  allowed('gh pr checks 12 --watch --interval 60');
  allowed('gh pr checks 12');
});

test('passes loop text that is data: quotes, data heredocs, searches', () => {
  allowed('gh pr comment 163 --body "Blocked shape; while true; do gh api x; sleep 1; done"');
  allowed("gh pr create --title x --body \"$(cat <<'EOF'\nThe loop was:\n    while true; do gh pr checks 12; sleep 30; done\nand `until ...; do :; done`\nEOF\n)\"");
  allowed("git commit -m \"$(cat <<'EOF'\ngh-poll-guard: refuse `until ...; do :; done` busy-waits\nEOF\n)\"");
  allowed("cat >> docs/handoff/2026-11-13-quota.md <<'EOF'\nThe loop was:\nuntil [ -f x ]; do :; done\nEOF");
  allowed(`cat > ~/.claude/hooks/gh-poll-guard.py <<'EOF'\n${readFileSync(HOOK, 'utf8')}\nEOF`);
  allowed('grep -rnE "(for|while|until) .*; do :; done" scripts/');
  allowed("grep -rn '`until ...; do :; done`' docs/");
  allowed(`grep -rnF '${fixture('merge-poll.sh').trim().replace(/'/g, '')}' ~/.claude/projects`);
  allowed("printf '%s' 'x; until false; do :; done' | wc -c");
});

test('passes one-pass loops that throttle or retry', () => {
  allowed('for r in ops ssatcy.com gorfed.net; do gh pr list -R gorfednet/$r --json number; sleep 1; done');
  allowed('for i in 1 2 3; do gh pr comment 5 --body-file b.md && break; sleep 5; done');
  allowed('while read -r n; do gh pr view $n --json title -q .title; sleep 1; done < prs.txt');
  allowed('while wait -n; do :; done');
  allowed('until grep -q "Ready in" dev.log; do sleep 0.5; done');
});

test('a whitespace-heavy command finishes well inside the 5 s timeout', () => {
  const started = Date.now();
  allowed('echo start' + '\n'.repeat(40000) + 'while true\ndo' + ' '.repeat(40000) + 'sleep 1; done');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('covers the Monitor tool too', () => {
  const r = spawnSync('python3', ['-I', HOOK], {
    input: JSON.stringify({ tool_name: 'Monitor', tool_input: { command: 'while true; do gh pr checks 5; sleep 30; done' } }),
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('fails open on input it cannot read', () => {
  const r = spawnSync('python3', ['-I', HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(run('while true; do gh api x; sleep 1; done', { tool_name: 'Read' }), null);
});
