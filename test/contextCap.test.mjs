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
const BASE_ENV = { PATH: process.env.PATH, HOME: join(top, 'home'), TMPDIR: TEMP, CONTEXT_CAP_TEMP_ROOTS: TEMP, CONTEXT_CAP_EXEMPT_FILE: join(top, 'no-exempt'), CONTEXT_CAP_STATE_DIR: join(top, 'state') };
// Two repository roots (a `.git` entry is what makes one): the session's, and a second one a handoff can go to.
const REPO = join(top, 'w', 'repo');
const OPS = join(top, 'w', 'ops', '.claude', 'worktrees', 'h');
mkdirSync(join(REPO, '.git'), { recursive: true });
mkdirSync(OPS, { recursive: true });
writeFileSync(join(OPS, '.git'), 'gitdir: elsewhere\n'); // a worktree's .git is a file
// Read per call, never once for the file: a run that crosses midnight ET keeps the right date.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
let seq = 0;

const assistant = (tokens, extra = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-test', content: [], usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1003, output_tokens: 50_000 } }, ...extra });
// A transcript's file name is its session's id, so each one here gets its own unless a test names it.
function transcript(lines, name = `t-${++seq}.jsonl`) {
  const dir = join(top, 'transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join('\n') + '\n');
  return join(dir, name);
}
const at = (tokens, before = 150_000) => transcript([assistant(before), assistant(tokens)]);

function spawnHook(input, env = {}) {
  const r = spawnSync('python3', ['-I', HOOK], { input, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', env: Object.fromEntries(Object.entries({ ...BASE_ENV, ...env }).filter(([, v]) => v !== undefined)) });
  assert.ok(!r.error, `the hook did not finish or could not start: ${r.error?.message}`);
  return r;
}
function call(tool_name, tool_input, { tokens = 250_000, transcriptPath, extra = {}, env } = {}) {
  return spawnHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: `s-${++seq}`, transcript_path: transcriptPath ?? at(tokens), cwd: REPO, tool_name, tool_input, ...extra }), env);
}
const refused = (r, why, label = '') => {
  assert.equal(r.status, 2, `expected a refusal ${label}: status ${r.status} ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^context-cap \(plan row 1\.61\) refused this call: /);
  if (why) assert.match(r.stderr, why, label);
};
const passes = (r, label = '') => assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `expected to pass in silence ${label}`);
const EDIT = { file_path: join(REPO, 'src', 'app.js'), old_string: 'a', new_string: 'b' };

test('past the cap, new work is refused, and the message says handoff, successor, end the turn', () => {
  const r = call('Edit', EDIT);
  refused(r, /isn't a handoff file/);
  assert.match(r.stderr, /250,000 tokens, past the 200,000 cap/);
  assert.match(r.stderr, /write the handoff with \/handoff <topic>/);
  assert.match(r.stderr, /start the successor session from that handoff/);
  assert.match(r.stderr, /end the turn/);
  assert.match(r.stderr, /lasts for the rest of this session/);
  refused(call('Write', { file_path: join(REPO, 'README.md'), content: 'x' }));
  refused(call('NotebookEdit', { notebook_path: join(REPO, 'a.ipynb'), new_source: 'x' }));
  for (const tool of ['Agent', 'Task', 'Workflow', 'WebFetch', 'WebSearch']) refused(call(tool, { prompt: 'x' }), /starts new work/, tool);
});

test('the boundary: 199,999 and 200,000 pass, 200,001 is refused', () => {
  const edit = (tokens) => call('Edit', EDIT, { transcriptPath: at(tokens, 190_000) });
  assert.equal(edit(CAP - 1).status, 0, '199,999');
  assert.equal(edit(CAP).status, 0, '200,000');
  refused(edit(CAP + 1), /200,001 tokens/);
  assert.equal(call('Agent', { prompt: 'x' }, { transcriptPath: at(CAP - 1) }).status, 0);
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
    ['Read', { file_path: join(REPO, 'src', 'app.js') }],
    ['Grep', { pattern: 'x' }],
    ['Skill', { skill: 'handoff', args: 'context-cap' }],
    ['mcp__sessions__start_session', { brief: 'x' }],
    ['Write', { file_path: join(REPO, 'docs', 'handoff', `${day}-topic.md`), content: 'x' }],
    ['Write', { file_path: `docs/handoff/${day}-topic.md`, content: 'x' }],
    ['Edit', { file_path: join(OPS, 'control', 'handoff', `${day}-topic.md`) }],
    ['Edit', { file_path: join(REPO, 'docs', 'backlog.json') }],
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
    join(REPO, 'docs', 'handoff.md'),
    join(REPO, 'docs', 'handoff', 'run.sh'),
    join(REPO, 'docs', 'handoff', 'component.md'),
    join(REPO, 'docs', 'handoff', 'sub', `${day}-topic.md`),
    join(REPO, 'docs', 'handoff', '..', '..', 'src', `${day}-a.md`),
    join(REPO, 'backlog.json'),
    // The path from the repository root must start with the handoff directory. Ending with it is not enough.
    join(REPO, 'src', 'docs', 'handoff', `${day}-topic.md`),
    join(REPO, 'packages', 'api', 'docs', 'backlog.json'),
    join(OPS, 'x', 'control', 'handoff', `${day}-topic.md`),
    join(top, 'w', 'norepo', 'docs', 'handoff', `${day}-topic.md`), // no repository above it, and not under cwd
    // Desk's rotation files are Desk's alone.
    join(OPS, 'control', 'desk', `${day}.md`),
    join(OPS, 'control', 'briefs', 'next.md'),
    '/w/home/.claude/projects/-w-repo/memory/run.sh',
    '/w/home/.claude/settings.json',
  ]) refused(write(path), /isn't a handoff file/, path);
  const env = { CONTEXT_CAP_TEMP_ROOTS: undefined, TMPDIR: '/w/scratch/T/' };
  passes(write('/tmp/x/body.md', { env }));
  passes(write('/private/tmp/x/body.md', { env }));
  passes(write('/w/scratch/T/body.md', { env }));
  // Fixed paths here: on Linux this suite's own directory is under /tmp, which the unpinned roots allow.
  for (const path of ['/w/scratch/Tx/body.md', '/tmpx/a.js', '/tmp/../w/repo/a.js', '/w/repo/tmp/a.js']) refused(write(path, { env }), null, path);
  // A relative TMPDIR resolves against the hook's own working directory, which is this process's. It opens nothing.
  refused(write(join(process.cwd(), 'relative', 'body.md'), { env: { ...env, TMPDIR: 'relative' } }), null, 'a relative TMPDIR');
});

test('one warning per session, on the first tool call at or past 180,000, and nothing is refused there', () => {
  const warned = (r, pattern, label) => {
    assert.deepEqual([r.status, r.stderr], [0, ''], label);
    assert.ok(r.stdout, `expected a warning: ${label}`);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.match(out.additionalContext, pattern, label);
  };
  // One transcript per session, rewritten as it grows, as a real one is.
  const as = (session_id, tokens, tool = 'Edit', env, name = `${session_id}.jsonl`) => call(tool, EDIT, { transcriptPath: transcript([assistant(tokens)], name), extra: { session_id }, env });
  passes(as('warn-a', 179_999), 'under the line');
  warned(as('warn-a', 180_000), /^context-cap \(plan row 1\.61\): this session's context is 180,000 tokens\. At 200,000 new work is held/, 'first call at the line');
  passes(as('warn-a', 180_000, 'Read'), 'a second call in the same reply');
  passes(as('warn-a', 195_000, 'Bash'), 'a later reply');
  // Not only the reply that crosses: a session first seen well past the line is still warned, once.
  warned(as('warn-b', 199_000, 'Bash'), /\/handoff <topic> and start the successor session/, 'first seen at 199,000');
  passes(as('warn-b', 199_500));
  // A compacted session that climbs back gets its warning again.
  passes(as('warn-b', 60_000));
  warned(as('warn-b', 181_000), /181,000 tokens/, 'after compaction');
  // Past the cap there is a refusal or silence, never a warning.
  passes(as('warn-c', 250_000, 'Read'));
  // With nowhere to record it, the hook stays quiet and still holds: a warning on every call would be noise.
  passes(as('warn-d', 185_000, 'Edit', { CONTEXT_CAP_STATE_DIR: '/dev/null/nope' }));
  refused(as('warn-d', 250_000, 'Edit', { CONTEXT_CAP_STATE_DIR: '/dev/null/nope' }));
  passes(as('../escape', 185_000, 'Edit', undefined, 'no-id-in-this-name.txt'), 'an id that is not a file name records nothing and warns nothing');
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

test('Desk is exempt by its transcript id up to 300,000, is warned at 280,000, and only that session', () => {
  const file = join(top, 'context-cap-exempt');
  const DESK = '0f8e7c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'; // the form of a transcript's file name, made up
  writeFileSync(file, `retiring-desk\n\n  ${DESK}  \n`);
  const env = { CONTEXT_CAP_EXEMPT_FILE: file };
  const as = (session_id, tokens, { e = env, input = EDIT, transcriptPath } = {}) => call('Edit', input, { env: e, transcriptPath: transcriptPath ?? at(tokens), extra: { session_id } });
  passes(as(DESK, 250_000));
  passes(as('retiring-desk', 279_999));
  const deskWarning = as(DESK, 280_000);
  assert.equal(deskWarning.status, 0);
  assert.match(JSON.parse(deskWarning.stdout).hookSpecificOutput.additionalContext, /280,000 tokens\. At 300,000 new work is held.*\/desk-rotate/s);
  assert.equal(as(DESK, 300_000).status, 0, 'at 300,000');
  // The app's own id for a session is not the transcript's. The transcript's file name is what the hook can trust.
  passes(as('local_some-app-id', 250_000, { transcriptPath: transcript([assistant(250_000)], `${DESK}.jsonl`) }), 'matched by transcript file name');
  // Past 300,000 Desk is held, told to rotate, and can still write what a rotation writes.
  const r = as(DESK, 300_001);
  refused(r, /300,001 tokens, past the 300,000 cap/);
  assert.match(r.stderr, /\/desk-rotate/);
  assert.doesNotMatch(r.stderr, /\/handoff/);
  for (const path of [['control', 'desk', `${today()}.md`], ['control', 'desk', 'checklist.md'], ['control', 'briefs', 'next-brief.md'], ['control', 'handoff', `${today()}-x.md`]]) {
    passes(as(DESK, 320_000, { input: { file_path: join(OPS, ...path) } }), path.join('/'));
  }
  refused(as(DESK, 320_000, { input: { file_path: join(OPS, 'control', 'desk', 'run.sh') } }));
  refused(as(DESK, 320_000, { input: { file_path: join(OPS, 'x', 'control', 'desk', 'a.md') } }));
  refused(as(DESK, 320_000, { input: { file_path: join(OPS, 'control', 'ship-bot.json') } }));
  // A session Desk started has Desk's environment and its own id.
  refused(as('child-session', 250_000, { e: { ...env, DESK_SESSION_NAME: 'desk' } }), /\/handoff/);
  refused(as(DESK.slice(0, 8), 250_000), null, 'a prefix of an exempt id');
  refused(as('', 250_000), null, 'an empty id against a file with a blank line');
  refused(as(DESK, 250_000, { e: {} }), null, 'no exempt file');
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
