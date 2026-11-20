// desk-event.py (Stop, StopFailure, Notification): appends one JSON line per turn end or
// prompt wait to the events file, and nothing else. It never blocks and never prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'scripts', 'claude-hooks', 'desk-event.py');

function run(input, env = {}, { raw } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deskevent-'));
  const file = join(dir, 'sub', 'events.jsonl');
  const r = spawnSync('python3', ['-I', HOOK], {
    input: raw ?? JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DESK_EVENTS_FILE: file, ...env },
  });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return { r, lines, file };
}

test('Stop writes one turn-ended line with the named session, cwd and an ET time', () => {
  const { r, lines } = run({ hook_event_name: 'Stop', session_id: 'abc', cwd: '/w/repo' }, { DESK_SESSION_NAME: 'cli-hooks' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.session, 'cli-hooks');
  assert.equal(e.cwd, '/w/repo');
  assert.equal(e.event, 'turn-ended');
  assert.match(e.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d (EST|EDT)$/);
});

test('without DESK_SESSION_NAME the session id names the line', () => {
  const { lines } = run({ hook_event_name: 'Stop', session_id: 'abc', cwd: '/w' });
  assert.equal(JSON.parse(lines[0]).session, 'abc');
});

test('a permission prompt and a question dialog are waiting-on-prompt', () => {
  for (const t of ['permission_prompt', 'elicitation_dialog']) {
    const { lines } = run({ hook_event_name: 'Notification', notification_type: t, message: 'Claude needs your permission', session_id: 's', cwd: '/w' });
    const e = JSON.parse(lines[0]);
    assert.equal(e.event, 'waiting-on-prompt');
    assert.equal(e.kind, t);
    assert.equal(e.message, 'Claude needs your permission');
  }
});

test('PermissionRequest writes waiting-on-prompt at once and prints nothing', () => {
  const { r, lines } = run({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'x' }, session_id: 's', cwd: '/w' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const e = JSON.parse(lines[0]);
  assert.equal(e.event, 'waiting-on-prompt');
  assert.equal(e.kind, 'permission_request');
  assert.equal(e.message, undefined, 'tool input is never copied');
});

test('StopFailure is a turn end that says it failed', () => {
  const e = JSON.parse(run({ hook_event_name: 'StopFailure', session_id: 's', cwd: '/w' }).lines[0]);
  assert.equal(e.event, 'turn-ended');
  assert.equal(e.kind, 'StopFailure');
});

test('near misses write nothing: other notifications and other events', () => {
  for (const input of [
    { hook_event_name: 'Notification', notification_type: 'auth_success', session_id: 's' },
    { hook_event_name: 'Notification', session_id: 's' },
    { hook_event_name: 'PreToolUse', session_id: 's' },
    {},
  ]) {
    const { r, lines } = run(input);
    assert.equal(r.status, 0);
    assert.equal(lines.length, 0, JSON.stringify(input));
  }
});

test('two events append two lines and keep the first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskevent2-'));
  const env = { PATH: process.env.PATH, DESK_EVENTS_FILE: join(dir, 'e.jsonl') };
  for (const n of ['a', 'b']) spawnSync('python3', ['-I', HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: n }), env });
  const lines = readFileSync(env.DESK_EVENTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l).session);
  assert.deepEqual(lines, ['a', 'b']);
});

test('never blocks: bad JSON, empty input and an unwritable path all exit 0 with no output', () => {
  assert.equal(run(null, {}, { raw: '{not json' }).r.status, 0);
  assert.equal(run(null, {}, { raw: '' }).r.status, 0);
  const r = spawnSync('python3', ['-I', HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop' }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DESK_EVENTS_FILE: '/dev/null/x/events.jsonl' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('the ET time follows the zone database: a January and a July instant differ in label', () => {
  const py = `import importlib.util,sys;s=importlib.util.spec_from_file_location('h',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.et_now(1768478400));print(m.et_now(1784116800))`;
  const r = spawnSync('python3', ['-c', py, HOOK], { encoding: 'utf8', env: { PATH: process.env.PATH, TZ: 'UTC' } });
  const [jan, jul] = r.stdout.trim().split('\n');
  assert.match(jan, /EST$/);
  assert.match(jul, /EDT$/);
});
