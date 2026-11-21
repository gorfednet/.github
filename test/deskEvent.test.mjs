// desk-event.py (Stop, StopFailure, Notification, PermissionRequest): appends one JSON line per turn end or
// prompt wait to the events file, and nothing else. It never blocks and never prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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
  assert.match(e.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d \S+$/); // the zone label is checked on fixed instants below
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
  assert.equal(e.message, undefined, 'no message field on a PermissionRequest');
});

test('tool input and tool name are never written: the planted command is absent from the whole line', () => {
  const planted = 'rm -rf /tmp/PLANTED-7f3a';
  const { lines } = run({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: planted, file_path: '/x/PLANTED-7f3a' }, permission_suggestions: [{ rule: planted }], session_id: 's', cwd: '/w' });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /PLANTED-7f3a|tool_input|tool_name|Bash/);
});

test('a PermissionRequest records permission_mode, the only hint at whether a dialog shows', () => {
  const e = JSON.parse(run({ hook_event_name: 'PermissionRequest', permission_mode: 'auto', session_id: 's' }).lines[0]);
  assert.equal(e.permission_mode, 'auto');
  assert.equal(JSON.parse(run({ hook_event_name: 'Stop', permission_mode: 'auto', session_id: 's' }).lines[0]).permission_mode, undefined);
});

test('the message is cut at 200 characters, and only on a waiting line', () => {
  const long = 'x'.repeat(250);
  const e = JSON.parse(run({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: long, session_id: 's' }).lines[0]);
  assert.equal(e.message.length, 200);
  assert.equal(e.message, long.slice(0, 200));
  const stop = JSON.parse(run({ hook_event_name: 'Stop', message: long, session_id: 's' }).lines[0]);
  assert.equal(stop.message, undefined);
});

test('a Stop with scheduled wakes pending says so, so it is not written as a finish', () => {
  const e = JSON.parse(run({ hook_event_name: 'Stop', session_id: 's', session_crons: [{ id: 'a' }] }).lines[0]);
  assert.equal(e.session_crons, 1);
  assert.equal(e.event, 'turn-ended');
  assert.equal(JSON.parse(run({ hook_event_name: 'Stop', session_id: 's', session_crons: [] }).lines[0]).session_crons, undefined);
});

test('a Stop with background tasks says so, and every line carries an epoch ts', () => {
  const e = JSON.parse(run({ hook_event_name: 'Stop', session_id: 's', background_tasks: [{ id: 1 }, { id: 2 }] }).lines[0]);
  assert.equal(e.background_tasks, 2);
  assert.ok(Number.isInteger(e.ts) && e.ts > 1.7e9);
  assert.equal(JSON.parse(run({ hook_event_name: 'Stop', session_id: 's' }).lines[0]).background_tasks, undefined);
  for (const t of ['elicitation_url_dialog', 'agent_needs_input']) {
    assert.equal(JSON.parse(run({ hook_event_name: 'Notification', notification_type: t, session_id: 's' }).lines[0]).event, 'waiting-on-prompt');
  }
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
