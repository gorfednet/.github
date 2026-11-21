// Plan row 1.61: scripts/claude-hooks/context-cap.py, the PreToolUse hook that holds new tool work once a
// session's context passes 200,000 tokens. Each case spawns the real hook with the JSON Claude Code sends and
// a transcript on disk. Exit 2 is a refusal. Exit 0 lets the call run, with a warning on stdout at most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(here, '..', 'scripts', 'claude-hooks');
const HOOK = join(HOOKS, 'context-cap.py');
const CAP = 200_000;
const top = realpathSync(mkdtempSync(join(tmpdir(), 'contextcap-')));
// This suite's files live under the system temp directory, which the hook lets a handoff write into. The roots
// are pinned to one subdirectory so nothing else here is a "temp file". One test unpins them.
const TEMP = join(top, 'tmp');
const BASE_ENV = { PATH: process.env.PATH, HOME: join(top, 'home'), TMPDIR: TEMP, CONTEXT_CAP_TEMP_ROOTS: TEMP, CONTEXT_CAP_EXEMPT_FILE: join(top, 'no-exempt') };
// Read per call, never once for the file: a run that crosses midnight ET keeps the right date.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
let seq = 0;

const assistant = (tokens, extra = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-test', content: [], usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1003, output_tokens: 50_000 } }, ...extra });
function transcript(lines) {
  const dir = join(top, `t-${++seq}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), lines.join('\n') + '\n');
  return join(dir, 'session.jsonl');
}
const at = (tokens, before = 150_000) => transcript([assistant(before), assistant(tokens)]);

function spawnHook(input, env = {}) {
  const r = spawnSync('python3', ['-I', HOOK], { input, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', env: Object.fromEntries(Object.entries({ ...BASE_ENV, ...env }).filter(([, v]) => v !== undefined)) });
  assert.ok(!r.error, `the hook did not finish or could not start: ${r.error?.message}`);
  return r;
}
function call(tool_name, tool_input, { tokens = 250_000, transcriptPath, extra = {}, env } = {}) {
  return spawnHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'test-session', transcript_path: transcriptPath ?? at(tokens), cwd: '/w/repo', tool_name, tool_input, ...extra }), env);
}
const refused = (r, why, label = '') => {
  assert.equal(r.status, 2, `expected a refusal ${label}: status ${r.status} ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^context-cap \(plan row 1\.61\) refused this call: /);
  if (why) assert.match(r.stderr, why, label);
};
const passes = (r, label = '') => assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `expected to pass in silence ${label}`);
const EDIT = { file_path: '/w/repo/src/app.js', old_string: 'a', new_string: 'b' };

test('past the cap, new work is refused, and the message says handoff, successor, end the turn', () => {
  const r = call('Edit', EDIT);
  refused(r, /isn't a handoff file/);
  assert.match(r.stderr, /250,000 tokens, past the 200,000 cap/);
  assert.match(r.stderr, /write the handoff with \/handoff <topic>/);
  assert.match(r.stderr, /start the successor session from that handoff/);
  assert.match(r.stderr, /end the turn/);
  refused(call('Write', { file_path: '/w/repo/README.md', content: 'x' }));
  refused(call('NotebookEdit', { notebook_path: '/w/repo/a.ipynb', new_source: 'x' }));
  for (const tool of ['Agent', 'Task', 'Workflow', 'WebFetch', 'WebSearch']) refused(call(tool, { prompt: 'x' }), /starts new work/, tool);
});

test('the boundary: 199,999 and 200,000 pass, 200,001 is refused', () => {
  const edit = (tokens) => call('Edit', EDIT, { transcriptPath: at(tokens, 190_000) });
  passes(edit(CAP - 1), '199,999');
  passes(edit(CAP), '200,000');
  refused(edit(CAP + 1), /200,001 tokens/);
  passes(call('Agent', { prompt: 'x' }, { transcriptPath: at(CAP - 1, 190_000) }));
});

test('context is input plus cache read plus cache creation; the newest main-chain message decides', () => {
  const line = (usage, extra = {}) => JSON.stringify({ type: 'assistant', message: { model: 'm', content: [], usage }, ...extra });
  const edit = (lines) => call('Edit', EDIT, { transcriptPath: transcript(lines) });
  passes(edit([line({ input_tokens: 100_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 30_000, output_tokens: 900_000 })]), 'output never counts');
  refused(edit([line({ input_tokens: 100_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_001 })]));
  passes(edit([assistant(300_000), assistant(40_000)]), 'a compacted session is under the cap again');
  passes(edit([assistant(40_000), assistant(300_000, { isSidechain: true })]), 'a subagent line over the cap');
  refused(edit([assistant(300_000), assistant(900, { isSidechain: true }), JSON.stringify({ type: 'attachment', usage: 1 }), assistant(1000).slice(0, 80)]), null, 'later lines that are not the session');
  const pad = JSON.stringify({ type: 'attachment', data: 'x'.repeat(700_000) });
  refused(edit([assistant(300_000), pad, pad, pad]), null, 'past the first read window');
});

test('past the cap, a handoff still runs: reads, its own files, and every shell command', () => {
  const day = today();
  for (const [tool, input] of [
    ['Read', { file_path: '/w/repo/src/app.js' }],
    ['Grep', { pattern: 'x' }],
    ['Skill', { skill: 'handoff', args: 'context-cap' }],
    ['mcp__sessions__start_session', { brief: 'x' }],
    ['Write', { file_path: `/w/repo/docs/handoff/${day}-topic.md`, content: 'x' }],
    ['Edit', { file_path: `/w/ops/.claude/worktrees/h/control/handoff/${day}-topic.md` }],
    ['Edit', { file_path: '/w/repo/docs/backlog.json' }],
    ['Write', { file_path: '/w/home/.claude/projects/-w-repo/memory/note.md', content: 'x' }],
    ['Write', { file_path: join(TEMP, 'body.md'), content: 'x' }],
    ['Monitor', { command: 'gh run watch 1 --interval 60 --exit-status' }],
  ]) passes(call(tool, input), `${tool} ${JSON.stringify(input)}`);
  // Bash is not read in this version. Labels, cleanup, waits and gate scripts must never be refused.
  for (const command of [
    'git add -A && git commit -m wip && git push',
    'gh pr edit 12 --remove-label ready-to-merge',
    'gh pr edit 12 --add-label hold',
    'gh pr ready 12 --undo',
    'gh pr edit 12 --body-file /w/body.md',
    'hc wait gate',
    'hc kill build && hc rm build',
    'kill 4242',
    'git worktree remove .claude/worktrees/x',
    'node scripts/review-status.mjs --pr 12',
    'assert-checks-started --pr 12',
    'npm test > src/out.txt',
  ]) passes(call('Bash', { command }), command);
});

test('near misses: paths that only look like a handoff file or a temp file', () => {
  const day = today();
  const write = (file_path, opts) => call('Write', { file_path, content: 'x' }, opts);
  for (const path of [
    '/w/repo/docs/handoff.md',
    '/w/repo/docs/handoff/run.sh',
    '/w/repo/docs/handoff/component.md',
    `/w/repo/docs/handoff/sub/${day}-topic.md`,
    `/w/repo/docs/handoff/../../src/${day}-a.md`,
    '/w/repo/backlog.json',
    '/w/home/.claude/projects/-w-repo/memory/run.sh',
    '/w/home/.claude/settings.json',
  ]) refused(write(path), /isn't a handoff file/, path);
  const env = { CONTEXT_CAP_TEMP_ROOTS: undefined, TMPDIR: '/w/scratch/T/' };
  passes(write('/tmp/x/body.md', { env }));
  passes(write('/private/tmp/x/body.md', { env }));
  passes(write('/w/scratch/T/body.md', { env }));
  for (const path of ['/w/scratch/Tx/body.md', '/tmpx/a.js', '/tmp/../w/repo/a.js', '/w/repo/tmp/a.js']) refused(write(path, { env }), null, path);
  // A relative TMPDIR resolves against the hook's own working directory, which is this process's. It opens nothing.
  refused(write(join(process.cwd(), 'relative', 'body.md'), { env: { ...env, TMPDIR: 'relative' } }), null, 'a relative TMPDIR');
});

test('one warning as the session crosses 180,000, and nothing is refused there', () => {
  const warned = (r) => {
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.match(out.additionalContext, /^context-cap \(plan row 1\.61\): this session's context is 18\d,\d{3} tokens\. At 200,000 new work is held/);
    assert.match(out.additionalContext, /\/handoff <topic> and start the successor session/);
  };
  warned(call('Edit', EDIT, { transcriptPath: at(180_000, 179_999) }));
  warned(call('Bash', { command: 'npm test' }, { transcriptPath: at(185_000, 120_000) }));
  warned(call('Read', { file_path: '/w/a' }, { transcriptPath: transcript([assistant(120_000), assistant(181_000), assistant(181_000)]) }), 'one reply, several lines');
  passes(call('Edit', EDIT, { transcriptPath: at(179_999, 120_000) }), 'under the line');
  passes(call('Edit', EDIT, { transcriptPath: at(190_000, 185_000) }), 'already warned on an earlier reply');
  passes(call('Read', { file_path: '/w/a' }, { transcriptPath: at(250_000, 120_000) }), 'past the cap there is a refusal or silence');
});

test('fails open on every broken input, an unknown event and a subagent call', () => {
  for (const raw of ['', 'not json', '[1,2]', 'null']) passes(spawnHook(raw), JSON.stringify(raw));
  const broken = [
    join(top, 'missing.jsonl'),
    top, // a directory
    transcript(['']),
    transcript(['{{{', 'garbage', '\u0000\u0001']),
    transcript([JSON.stringify({ type: 'assistant', message: { content: [] } })]),
    transcript([JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: '900000', cache_read_input_tokens: null, cache_creation_input_tokens: true } } })]),
    transcript([JSON.stringify({ type: 'assistant', message: 'x', usage: 5 }), JSON.stringify(['assistant', '"usage"'])]),
  ];
  for (const transcriptPath of broken) passes(call('Edit', EDIT, { transcriptPath }), transcriptPath);
  for (const extra of [{ transcript_path: 5 }, { transcript_path: '' }, { tool_name: 5 }, { tool_input: 'x' }, { tool_input: {} }]) passes(call('Edit', EDIT, { extra }), JSON.stringify(extra));
  const unreadable = at(300_000);
  execFileSync('chmod', ['000', unreadable]);
  if (process.getuid?.() !== 0) passes(call('Edit', EDIT, { transcriptPath: unreadable }), 'unreadable transcript');
  for (const name of ['PostToolUse', 'Stop', 'SomethingNew', undefined, 5]) passes(call('Edit', EDIT, { extra: { hook_event_name: name } }), String(name));
  passes(call('Edit', EDIT, { extra: { agent_id: 'a1', agent_type: 'builder' } }), 'a subagent call');
});

test('Desk is exempt by session id up to 300,000, and only that session', () => {
  const file = join(top, 'context-cap-exempt');
  writeFileSync(file, 'retiring-desk\n\n  desk-session  \n');
  const env = { CONTEXT_CAP_EXEMPT_FILE: file };
  const as = (session_id, tokens, e = env) => call('Edit', EDIT, { env: e, transcriptPath: at(tokens, 190_000), extra: { session_id } });
  passes(as('desk-session', 250_000));
  passes(as('retiring-desk', 300_000), 'at 300,000');
  refused(as('desk-session', 300_001), /300,001 tokens, past the 300,000 cap/);
  // A session Desk started has Desk's environment and its own id.
  refused(as('child-session', 250_000, { ...env, DESK_SESSION_NAME: 'desk' }));
  refused(as('desk', 250_000), null, 'a prefix of an exempt id');
  refused(as('', 250_000), null, 'an empty id against a file with a blank line');
  refused(as('desk-session', 250_000, {}), null, 'no exempt file');
});

test('the settings fragment runs this hook on every tool and lets a missing file through', () => {
  const [entry] = JSON.parse(readFileSync(join(HOOKS, 'context-cap.settings.json'), 'utf8')).hooks.PreToolUse;
  assert.equal(entry.matcher, '*', 'every tool, so Edit, Write and Agent are seen');
  const [hook] = entry.hooks;
  // No `|| true`: exit 2 is the refusal. python3 also exits 2 on a missing script, so the command checks for the file.
  assert.ok(!/\|\|\s*true/.test(hook.command));
  const home = join(top, 'home-settings');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: EDIT, transcript_path: at(300_000) });
  const sh = () => spawnSync('sh', ['-c', hook.command], { input, encoding: 'utf8', env: { ...BASE_ENV, HOME: home } });
  assert.equal(sh().status, 0, 'missing hook file');
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  copyFileSync(HOOK, join(home, '.claude', 'hooks', 'context-cap.py'));
  assert.equal(sh().status, 2, 'installed, the same command refuses');
});
