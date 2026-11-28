// Plan row 1.62: scripts/claude-hooks/desk-message-guard.py, the PreToolUse hook that refuses a session message to
// Desk from a turn the owner didn't start. Each case spawns the real hook with the JSON Claude Code sends, a
// transcript on disk and a copy of the app's session records. Exit 2 is a refusal. Exit 0 lets the call run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(here, '..', 'scripts', 'claude-hooks');
const HOOK = join(HOOKS, 'desk-message-guard.py');
const top = realpathSync(mkdtempSync(join(tmpdir(), 'deskguard-')));
const STORE = join(top, 'store');
const BASE_ENV = { PATH: process.env.PATH, HOME: join(top, 'home'), DESK_MESSAGE_GUARD_SESSIONS_DIR: STORE, DESK_MESSAGE_GUARD_DESK_FILE: join(top, 'no-desk-file') };
const SEND = 'mcp__ccd_session_mgmt__send_message';
const DESK_TITLE = 'Active Remote Control [Desk (28 Nov)]';
let seq = 0;

// The app keeps one record a session: <store>/<a>/<b>/<app id>.json with the title and the id hooks get.
function record(appId, title, cliSessionId, dir = STORE) {
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'b', `${appId}.json`), JSON.stringify({ sessionId: appId, cliSessionId, title, isArchived: false }));
}
const DESK = 'local_desk-0001';
const DESK_CLI = 'cli-desk-0001';
const NEXT_DESK = 'local_desk-0002';
const WORKER = 'local_work-0001';
record(DESK, DESK_TITLE, DESK_CLI);
record(NEXT_DESK, 'Active Remote Control [Desk (29 Nov)]', 'cli-desk-0002');
record(WORKER, 'Row 1.62 guard build', 'cli-work-0001');
record('local_near-0001', 'Active Remote Control [Desktop sync]', 'cli-near-0001');

// One transcript line that starts a turn, as Claude Code writes it.
const prompt = (origin, extra = {}) => JSON.stringify({ type: 'user', isSidechain: false, uuid: `u-${++seq}`, promptSource: 'system', origin, message: { role: 'user', content: 'x' }, ...extra });
const human = (extra) => prompt({ kind: 'human' }, { promptSource: 'typed', turnOrigin: 'human', ...extra });
const notice = () => prompt({ kind: 'task-notification', producer: 'session-task' }, { turnOrigin: 'task_notification' });
const peer = () => prompt({ kind: 'peer', from: 'local_x', name: 'n', body: 'b' }, { isMeta: true, turnOrigin: 'peer' });
const scheduled = () => prompt({ kind: 'task-notification', subkind: 'scheduled-trigger', fireReason: 'scheduled' }, { turnOrigin: 'scheduled' });
const started = () => JSON.stringify({ type: 'user', isSidechain: false, uuid: `u-${++seq}`, promptSource: 'sdk', turnOrigin: 'host_synthetic', message: { role: 'user', content: 'brief' } });
const toolResult = () => JSON.stringify({ type: 'user', isSidechain: false, uuid: `u-${++seq}`, message: { role: 'user', content: [{ type: 'tool_result', content: '"origin":{"kind":"human"} "promptSource"' }] } });
const assistant = () => JSON.stringify({ type: 'assistant', isSidechain: false, uuid: `u-${++seq}`, message: { content: [] } });

function transcript(lines, name = `t-${++seq}`) {
  const dir = join(top, 'transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n');
  return join(dir, `${name}.jsonl`);
}
// The usual sender: a work session on a turn a background task's notice started.
const woken = () => transcript([human(), assistant(), notice(), assistant(), toolResult()]);
const ownerTurn = () => transcript([human(), assistant(), notice(), assistant(), human(), assistant(), toolResult()]);

function spawnHook(input, env = {}) {
  const r = spawnSync('python3', ['-I', HOOK], { input, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', env: Object.fromEntries(Object.entries({ ...BASE_ENV, ...env }).filter(([, v]) => v !== undefined)) });
  assert.ok(!r.error, `the hook did not finish or could not start: ${r.error?.message}`);
  return r;
}
function call(tool_name, tool_input, { transcriptPath, extra = {}, env } = {}) {
  return spawnHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: `s-${++seq}`, transcript_path: transcriptPath ?? woken(), cwd: top, tool_name, tool_input, ...extra }), env);
}
const refused = (r, why, label = '') => {
  assert.equal(r.status, 2, `expected a refusal ${label}: status ${r.status} ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^desk-message-guard \(plan row 1\.62\) refused this call: /);
  assert.match(r.stderr, /PR's `## Next`/, 'the refusal says where the result goes');
  if (why) assert.match(r.stderr, why, label);
};
const passes = (r, label = '') => assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `expected to pass in silence ${label}`);

test('a message to Desk from a turn a background notice started is refused, by app id or by title', () => {
  refused(call(SEND, { session_id: DESK, message: 'CI is green' }), /background-task notice/, 'session_id');
  refused(call(SEND, { to: DESK, message: 'CI is green' }), null, 'to');
  refused(call('SendMessage', { to: DESK, summary: 's', message: 'm' }), null, 'SendMessage by id');
  refused(call('SendMessage', { to: DESK_TITLE, summary: 's', message: 'm' }), null, 'SendMessage by title');
  refused(call('SendMessage', { to: 'Active Remote Control [Desk', message: 'm' }), null, 'the bare prefix');
  refused(call('SendMessage', { to: `  ${DESK_TITLE} [ab12]`, message: 'm' }), null, 'a title with a ref after it');
  refused(call('send_message', { to: [DESK], message: 'm' }), null, 'a list of targets');
  refused(call(SEND, { session_id: NEXT_DESK, message: 'm' }), null, 'any session with the Desk title');
});

test('the refusal tells the session what to do instead and names no session', () => {
  const r = call(SEND, { session_id: DESK, message: 'done' });
  refused(r);
  assert.match(r.stderr, /- \[ \]/);
  assert.match(r.stderr, /end the turn/);
  assert.ok(!r.stderr.includes(DESK) && !r.stderr.includes(DESK_CLI), 'no session id in the message');
});

test('what started the turn decides: the newest prompt in the transcript wins', () => {
  refused(call(SEND, { session_id: DESK }, { transcriptPath: transcript([human(), assistant(), human(), peer(), assistant()]) }), /message from another session/, 'peer');
  refused(call(SEND, { session_id: DESK }, { transcriptPath: transcript([started(), assistant(), human(), assistant(), notice()]) }), /background-task notice/);
  refused(call(SEND, { session_id: DESK }, { transcriptPath: transcript([started(), assistant()]) }), /prompt that wasn't the owner's/, 'a brief another session sent');
  passes(call(SEND, { session_id: DESK }, { transcriptPath: transcript([started(), assistant(), notice(), human(), assistant()]) }), 'owner after a notice');
  // A subagent's human-looking line is not the session's turn.
  refused(call(SEND, { session_id: DESK }, { transcriptPath: transcript([human(), notice(), human({ isSidechain: true })]) }), /background-task notice/, 'sidechain');
  // Text inside a tool result that looks like a prompt's fields is not a prompt.
  refused(call(SEND, { session_id: DESK }, { transcriptPath: transcript([human(), notice(), toolResult()]) }), null, 'tool result');
});

test("the owner's own turn passes, typed at the Mac or sent from another device", () => {
  passes(call(SEND, { session_id: DESK, message: 'he asked' }, { transcriptPath: ownerTurn() }));
  passes(call('SendMessage', { to: DESK_TITLE, message: 'he asked' }, { transcriptPath: transcript([human(), assistant(), human({ promptSource: 'sdk' })]) }));
});

test("a session's first prompt is its brief, so it is not the owner's turn even when typed", () => {
  const r = call(SEND, { session_id: DESK, message: 'started' }, { transcriptPath: transcript([human(), assistant(), toolResult()]) });
  refused(r, /first prompt/);
  assert.match(r.stderr, /after the session's first prompt/);
});

test('a scheduled task that messages Desk passes: the timer and the owner reminders are whole sessions of that kind', () => {
  passes(call(SEND, { session_id: DESK, message: '10:00 pass' }, { transcriptPath: transcript([scheduled(), assistant(), toolResult()]) }));
});

test('other targets pass: a work session, a subagent, the parent, an unknown id, an email', () => {
  passes(call(SEND, { session_id: WORKER, message: 'm' }), 'another session by id');
  passes(call('SendMessage', { to: 'Row 1.62 guard build', message: 'm' }), 'another session by title');
  passes(call('SendMessage', { to: 'a24bdbfccd94c4d47', summary: 's', message: 'm' }), 'a subagent');
  passes(call('SendMessage', { to: 'main', message: 'm' }), 'the parent');
  passes(call(SEND, { session_id: 'local_none-0009', message: 'm' }), 'an id with no record');
  passes(call('mcp__mail__send_message', { to: 'someone@example.com', subject: DESK_TITLE, body: DESK_TITLE }), 'a mail tool');
  passes(call(SEND, { session_id: WORKER, message: `${DESK_TITLE} said so`, summary: DESK_TITLE }), "Desk's title in the text only");
});

test('a near-miss title is not Desk', () => {
  for (const to of ['Active Remote Control [Desktop sync]', 'Active Remote Control [Desk-top]', 'Active Remote Control [Design', 'Notes: Active Remote Control [Desk', 'active remote control [desk', 'Active Remote Control', 'Remote Control [Desk (28 Nov)]', 'Active Remote Control [Desk2]']) {
    passes(call('SendMessage', { to, message: 'm' }), to);
  }
  passes(call(SEND, { session_id: 'local_near-0001', message: 'm' }), 'a record with a near-miss title');
});

test("Desk's own sends pass: to itself, to its successor, and when its id is in Desk's file", () => {
  const deskTranscript = () => transcript([human(), notice()], DESK_CLI);
  passes(call(SEND, { session_id: NEXT_DESK, message: 'handover' }, { transcriptPath: deskTranscript() }), 'outgoing Desk to the successor');
  passes(call('SendMessage', { to: 'Active Remote Control [Desk (29 Nov)]', message: 'handover' }, { transcriptPath: deskTranscript() }), 'by title');
  passes(call(SEND, { session_id: DESK, message: 'note' }, { transcriptPath: woken(), extra: { session_id: DESK_CLI } }), 'known by session_id alone');
  const file = join(top, 'desk-ids');
  writeFileSync(file, 'cli-listed-0001\n');
  passes(call(SEND, { session_id: DESK }, { transcriptPath: transcript([human(), notice()], 'cli-listed-0001'), env: { DESK_MESSAGE_GUARD_DESK_FILE: file } }), 'listed in the file');
  // The file also names Desk as a target, when a sender uses that id.
  refused(call(SEND, { session_id: 'cli-listed-0001' }, { env: { DESK_MESSAGE_GUARD_DESK_FILE: file } }), null, 'target by listed id');
  // A work session whose record merely mentions Desk's title is not Desk.
  refused(call(SEND, { session_id: DESK }, { transcriptPath: transcript([human(), notice()], 'cli-work-0001') }), null, 'a worker is not Desk');
});

test("a subagent's send to Desk is held like its session's", () => {
  refused(call('SendMessage', { to: DESK_TITLE, message: 'm' }, { extra: { agent_id: 'a1' } }));
});

test('it fails open on anything it cannot read', () => {
  passes(spawnHook(''), 'empty input');
  passes(spawnHook('{not json'), 'bad JSON');
  passes(spawnHook('[1,2]'), 'not an object');
  passes(spawnHook(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: SEND, tool_input: { session_id: DESK }, transcript_path: woken() })), 'another event');
  passes(call(SEND, 'local_desk-0001'), 'tool_input is not an object');
  passes(call(SEND, { session_id: 7, to: null }), 'no string target');
  passes(call(SEND, { session_id: DESK }, { transcriptPath: join(top, 'missing.jsonl') }), 'no transcript');
  passes(call(SEND, { session_id: DESK }, { extra: { transcript_path: 12 } }), 'transcript path is not a string');
  passes(call(SEND, { session_id: DESK }, { transcriptPath: transcript([assistant(), toolResult(), '{broken']) }), 'no prompt in the transcript');
  passes(call(SEND, { session_id: DESK }, { transcriptPath: transcript([prompt({ kind: 'human' }).slice(0, -9)]) }), 'a cut-off line');
  passes(call(SEND, { session_id: DESK }, { env: { DESK_MESSAGE_GUARD_SESSIONS_DIR: join(top, 'no-store') } }), 'no session records');
  const bad = join(top, 'bad-store');
  mkdirSync(join(bad, 'a', 'b'), { recursive: true });
  writeFileSync(join(bad, 'a', 'b', `${DESK}.json`), '{"title": "Active Remote Control [Desk');
  passes(call(SEND, { session_id: DESK }, { env: { DESK_MESSAGE_GUARD_SESSIONS_DIR: bad } }), 'a corrupt record');
  passes(call(SEND, { session_id: 'local_../../x' }), 'an id that is not an id');
});

test('a title needs no records: with none on disk a send by title is still refused', () => {
  refused(call('SendMessage', { to: DESK_TITLE, message: 'm' }, { env: { DESK_MESSAGE_GUARD_SESSIONS_DIR: join(top, 'no-store') } }));
});

test('tools that are not session messages are never read', () => {
  passes(call('Bash', { command: `echo "${DESK_TITLE}" ${DESK}` }));
  passes(call('mcp__ccd_session_mgmt__list_sessions', { to: DESK_TITLE }));
  passes(call('Agent', { to: DESK_TITLE, prompt: 'p' }));
});

test('the settings fragment runs the hook on the message tools only, and lets calls through when the file is missing', () => {
  const settings = JSON.parse(readFileSync(join(HOOKS, 'desk-message-guard.settings.json'), 'utf8'));
  const [entry] = settings.hooks.PreToolUse;
  const matcher = new RegExp(`^(?:${entry.matcher})$`);
  for (const name of ['SendMessage', 'send_message', SEND]) assert.ok(matcher.test(name), name);
  for (const name of ['Bash', 'Edit', 'mcp__ccd_session_mgmt__list_sessions', 'SendMessages']) assert.ok(!matcher.test(name), name);
  const [hook] = entry.hooks;
  assert.equal(hook.command, '[ -r ~/.claude/hooks/desk-message-guard.py ] || exit 0; python3 -I ~/.claude/hooks/desk-message-guard.py');
  assert.ok(hook.timeout >= 5);
});
