// Plan row 1.61: scripts/claude-hooks/context-cap.py, the PreToolUse hook that holds new tool work once a
// session's context passes 200,000 tokens. Each case spawns the real hook with the JSON Claude Code sends,
// a transcript on disk, and reads the exit code and stderr. Exit 2 is a refusal; anything else lets the call run.
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
const HOOK_TIMEOUT_MS = 20_000;
const top = realpathSync(mkdtempSync(join(tmpdir(), 'contextcap-')));
let seq = 0;
const fresh = (name) => {
  const d = join(top, `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
// This suite's files live under the system temp directory, which the hook lets a handoff write into. The roots
// are pinned to one subdirectory so a repository made here is not a "temp file". One test below unpins them.
const TEMP = join(top, 'tmp');
const BASE_ENV = { PATH: process.env.PATH, HOME: join(top, 'home'), TMPDIR: TEMP, CONTEXT_CAP_TEMP_ROOTS: TEMP, CONTEXT_CAP_EXEMPT_FILE: join(top, 'no-exempt') };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date()); // YYYY-MM-DD

const assistant = (tokens, content = [{ type: 'text', text: 'ok' }], extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      model: 'claude-test',
      content,
      // split across the three fields the hook adds up
      usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1003, output_tokens: 50_000 },
    },
    ...extra,
  });
const user = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'go' } });
function transcript(lines) {
  const file = join(fresh('t'), 'session.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
const at = (tokens) => transcript([user, assistant(1200), user, assistant(tokens)]);

function spawnHook(input, { env = {}, hook = HOOK } = {}) {
  const r = spawnSync('python3', ['-I', hook], {
    input,
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: Object.fromEntries(Object.entries({ ...BASE_ENV, ...env }).filter(([, v]) => v !== undefined)),
  });
  assert.ok(!r.error, `the hook did not finish within ${HOOK_TIMEOUT_MS} ms or could not start: ${r.error?.message}`);
  return r;
}
function call(tool_name, tool_input, { tokens = CAP + 50_000, transcriptPath, cwd = '/w/repo', extra = {}, env, hook } = {}) {
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'test-session',
    transcript_path: transcriptPath ?? at(tokens),
    cwd,
    tool_name,
    tool_input,
    ...extra,
  };
  return spawnHook(JSON.stringify(payload), { env, hook });
}
const refused = (r, why, label = '') => {
  assert.equal(r.status, 2, `expected a refusal ${label}: status ${r.status} ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^context-cap \(plan row 1\.61\) refused this call: /);
  assert.match(r.stderr, /\/handoff|handoff is committed/);
  if (why) assert.match(r.stderr, why, label);
};
const passes = (r, label = '') => {
  assert.equal(r.status, 0, `expected to pass ${label}: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
};
const bash = (command, opts) => call('Bash', { command }, opts);

test('past the cap, new work is refused with the size, the cap and /handoff', () => {
  const r = call('Edit', { file_path: '/w/repo/src/app.js', old_string: 'a', new_string: 'b' }, { tokens: 250_000 });
  refused(r, /isn't a handoff file/);
  assert.match(r.stderr, /250,000 tokens/);
  assert.match(r.stderr, /200,000 cap/);
  assert.match(r.stderr, /Run \/handoff <topic> now/);
  refused(call('Write', { file_path: '/w/repo/README.md', content: 'x' }));
  refused(call('NotebookEdit', { notebook_path: '/w/repo/a.ipynb', new_source: 'x' }));
  for (const tool of ['Agent', 'Task', 'Workflow', 'WebFetch', 'WebSearch']) refused(call(tool, { prompt: 'x' }), /starts new work/, tool);
  refused(bash('npm test'), /`npm` isn't a command a handoff needs/);
  refused(call('Monitor', { command: 'gh run watch 1 --interval 60 --exit-status' }), /`gh run watch`/);
});

test('the boundary: 199,999 and 200,000 pass, 200,001 is refused', () => {
  const edit = (tokens) => call('Edit', { file_path: '/w/repo/src/app.js', old_string: 'a', new_string: 'b' }, { tokens });
  passes(edit(CAP - 1), '199,999');
  passes(edit(CAP), '200,000');
  refused(edit(CAP + 1), /200,001 tokens/);
  passes(bash('npm test', { tokens: CAP - 1 }));
  passes(call('Agent', { prompt: 'x' }, { tokens: CAP - 1 }));
});

test('context is input plus cache read plus cache creation, and output tokens never count', () => {
  const line = (usage) => JSON.stringify({ type: 'assistant', message: { model: 'm', content: [], usage } });
  const edit = (usage) => call('Edit', { file_path: '/w/repo/a.js' }, { transcriptPath: transcript([line(usage)]) });
  passes(edit({ input_tokens: 100_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_000, output_tokens: 900_000 }));
  refused(edit({ input_tokens: 100_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_001 }));
  refused(edit({ input_tokens: 200_001 }));
  refused(edit({ cache_read_input_tokens: 200_001 }));
  refused(edit({ cache_creation_input_tokens: 200_001 }));
});

test('the newest main-chain assistant message decides: a compacted session is under the cap again', () => {
  const edit = (lines) => call('Edit', { file_path: '/w/repo/a.js' }, { transcriptPath: transcript(lines) });
  passes(edit([assistant(300_000), user, assistant(40_000)]), 'compacted');
  refused(edit([assistant(40_000), user, assistant(300_000)]));
  // A subagent line, an error stub and trailing non-assistant lines are not the session's context.
  refused(edit([assistant(300_000), assistant(900, undefined, { isSidechain: true }), user, JSON.stringify({ type: 'attachment', usage: 1 })]));
  passes(edit([assistant(40_000), assistant(300_000, undefined, { isSidechain: true })]), 'sidechain over the cap');
  const synthetic = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [], usage: { input_tokens: 0, cache_read_input_tokens: 0 } } });
  refused(edit([assistant(300_000), synthetic]));
  // The line being written when the hook runs can be cut short.
  refused(edit([assistant(300_000), assistant(1000).slice(0, 80)]));
});

test('a transcript longer than the first read window is still read', () => {
  const pad = JSON.stringify({ type: 'attachment', data: 'x'.repeat(700_000) });
  refused(call('Edit', { file_path: '/w/repo/a.js' }, { transcriptPath: transcript([assistant(300_000), pad, pad, pad]) }));
  passes(call('Edit', { file_path: '/w/repo/a.js' }, { transcriptPath: transcript([assistant(300_000), assistant(1000), pad, pad, pad]) }));
});

test('past the cap, every call a handoff needs still runs', () => {
  for (const [tool, input] of [
    ['Read', { file_path: '/w/repo/src/app.js' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '**/*.md' }],
    ['Skill', { skill: 'handoff', args: 'context-cap' }],
    ['AskUserQuestion', { questions: [] }],
    ['TodoWrite', { todos: [] }],
    ['mcp__sessions__start_session', { brief: 'x' }],
    ['Write', { file_path: `/w/repo/docs/handoff/${today}-topic.md`, content: 'x' }],
    ['Edit', { file_path: `/w/ops/.claude/worktrees/h/control/handoff/${today}-topic.md` }],
    ['Edit', { file_path: '/w/repo/docs/backlog.json' }],
    ['Write', { file_path: join(TEMP, 'body.md'), content: 'x' }],
  ]) passes(call(tool, input), `${tool} ${JSON.stringify(input)}`);
  for (const command of [
    'git status',
    'git status --short && git log --oneline -5',
    'git -C /w/repo diff --stat origin/main...HEAD',
    'git add -A',
    `git add docs/handoff/${today}-topic.md docs/backlog.json`,
    'git commit -m "Handoff: context cap"',
    'git commit -m "$(cat <<\'EOF\'\nHandoff: context cap\n\nCo-Authored-By: X <x@example.com>\nEOF\n)"',
    'git push',
    'git push -u origin feat/x',
    'git add -A && git commit -m wip && git push',
    'git fetch origin',
    'git rev-parse origin/feat/x',
    'git branch --show-current',
    'git switch -c handoff/topic',
    'git checkout -b handoff/topic origin/main',
    'git -C /w/ops worktree add /w/ops/.claude/worktrees/h -b handoff/topic origin/main',
    'git restore --staged .env.local',
    'git remote -v',
    'git config user.name',
    'git stash list',
    'gh pr view --json number,body',
    'gh pr view 12 --json body -q .body > "$d/body.md"',
    'd=$(mktemp -d) && gh pr view --json body -q .body > "$d/body.md"',
    `gh pr edit 12 --body-file ${TEMP}/body.md`,
    'gh pr comment 12 --body "handoff written"',
    'gh pr create --draft --title "Handoff" --body-file "$d/body.md"',
    'gh pr list --state open --author @me',
    'gh pr checks 12',
    'gh api rate_limit',
    'TZ=America/Toronto date',
    'date +%F',
    'cat templates/handoff.md',
    'ls docs/handoff 2>/dev/null | tail -5',
    'mkdir -p docs/handoff',
    `cat > docs/handoff/${today}-topic.md <<'EOF'\n# Handoff\nnpm test && rm -rf /\nEOF`,
    `cp templates/handoff.md docs/handoff/${today}-topic.md`,
    'cd /w/repo && git status',
    'grep -rn "TODO" src | head -20',
    'sed -n 1,40p docs/backlog.json',
    'for f in docs/handoff/*.md; do echo "$f"; done',
    'if [[ -f docs/backlog.json && -d docs ]]; then echo yes; fi',
    'echo done >&2',
    'rm -rf "$d"',
  ]) passes(bash(command), command);
});

test('past the cap, shell work that is not a handoff is refused', () => {
  for (const [command, why] of [
    ['npm run build', /`npm`/],
    ['node scripts/review-status.mjs --pr 3', /`node`/],
    ['python3 -c "open(\'a\',\'w\')"', /`python3`/],
    ['git status && npm test', /`npm`/],
    ['git merge origin/main', /`git merge`/],
    ['git rebase origin/main', /`git rebase`/],
    ['git checkout main', /`git checkout`/],
    ['git checkout -- src/app.js', /`git checkout`/],
    ['git switch main', /`git switch`/],
    ['git branch -D old', /`git branch`/],
    ['git stash', /`git stash`/],
    ['git restore src/app.js', /`git restore`/],
    ['git restore --staged --worktree src/app.js', /`git restore`/],
    ['git worktree remove x', /`git worktree`/],
    ['git config user.name x', /`git config`/],
    ['gh pr ready 12', /`gh pr ready`/],
    ['gh pr review 12 --approve', /`gh pr review`/],
    ['gh run rerun 5', /`gh run rerun`/],
    ['gh workflow run ci.yml', /`gh workflow run`/],
    ['gh api repos/o/r/issues -f title=x', /`gh api`/],
    ['gh api -X POST repos/o/r/dispatches', /`gh api`/],
    ['echo "x" > src/app.js', /redirects into `src\/app\.js`/],
    ['cat > src/new.js <<\'EOF\'\nconsole.log(1)\nEOF', /redirects into/],
    ['printf x >> README.md', /redirects into/],
    ['git diff > /w/repo/out.patch', /redirects into/],
    ['cp /w/other/a.js src/a.js', /`cp` touches/],
    ['tee src/a.js', /`tee` touches/],
    ['rm -rf src', /`rm` touches/],
    ['touch src/new.js', /`touch` touches/],
    ['sed -i "" s/a/b/ src/a.js', /sed -i/],
    ['sed -ni s/a/b/p src/a.js', /sed -i/],
    ['find . -name "*.tmp" -delete', /find/],
    ['bash scripts/build.sh', /runs a script/],
    ['bash -c "npm test"', /`npm`/],
    ['eval "npm test"', /`npm`/],
    ['env CI=1 npm test', /`npm`/],
    ['timeout 60 npm test', /`npm`/],
    ['echo $(npm test)', /`npm`/],
    ['ssh host "git status"', /`ssh`/],
    ['hc run --bg --name gate -- npm test', /`hc`/],
    ['sudo ls', /`sudo`/],
  ]) refused(bash(command), why, command);
});

test('near misses: text that names refused work, and paths that only look like a handoff', () => {
  passes(bash('git commit -m "npm test is red; git merge main later"'));
  passes(bash('gh pr comment 12 --body "next: run npm test > out.txt"'));
  passes(bash('echo "git rebase origin/main"'));
  passes(bash('grep -n "npm run build" docs/handoff/x.md'));
  refused(call('Write', { file_path: '/w/repo/docs/handoff.md', content: 'x' }));
  refused(call('Write', { file_path: '/w/repo/docs/handoff/run.sh', content: 'x' }));
  refused(call('Write', { file_path: '/w/repo/src/docs/handoffs/a.md', content: 'x' }));
  refused(call('Write', { file_path: '/w/repo/docs/handoff/../../src/a.md', content: 'x' }));
  refused(call('Edit', { file_path: '/w/repo/backlog.json' }));
  refused(call('Edit', { file_path: '/w/repo/src/backlog.json' }));
  refused(call('Write', { file_path: '/tmpx/a.js', content: 'x' }));
  refused(call('Write', { file_path: '/tmp/../w/repo/a.js', content: 'x' }));
  refused(bash('echo x > docs/handoff/../../src/a.js'));
});

test('temp files: /tmp, /private/tmp and TMPDIR by default, and nothing that only starts like them', () => {
  const env = { CONTEXT_CAP_TEMP_ROOTS: undefined, TMPDIR: '/w/scratch/T/' };
  const write = (file_path) => call('Write', { file_path, content: 'x' }, { env });
  passes(write('/tmp/x/body.md'));
  passes(write('/private/tmp/claude-501/scratchpad/body.md'));
  passes(write('/w/scratch/T/body.md'));
  passes(bash('gh pr view 12 --json body -q .body > /tmp/x/body.md', { env }));
  refused(write('/w/scratch/body.md'));
  refused(write('/w/scratch/Tx/body.md'));
  refused(write('/tmpx/a.js'));
  refused(write('/tmp/../w/repo/a.js'));
  refused(write('/w/repo/tmp/a.js'));
  refused(call('Write', { file_path: '/w/scratch/body.md', content: 'x' }, { env: { ...env, TMPDIR: 'relative' } }), null, 'a relative TMPDIR');
});

test('a command the parser cannot read, or whose target only the shell knows, passes', () => {
  passes(bash('echo "unbalanced'));
  passes(bash('"$TOOL" build'));
  passes(bash('$(which npm) test > "$out"'));
  passes(bash('echo x > "$f"'));
  passes(bash(''));
  passes(call('Bash', {}));
  passes(call('Bash', { command: 7 }));
  passes(call('Edit', {}));
});

test('fails open on every broken input', () => {
  const edit = { file_path: '/w/repo/src/app.js' };
  const raw = (input) => spawnHook(input);
  passes(raw(''), 'empty stdin');
  passes(raw('not json'), 'not JSON');
  passes(raw('[1,2]'), 'not an object');
  passes(raw('null'));
  passes(call('Edit', edit, { transcriptPath: join(top, 'missing.jsonl') }), 'missing transcript');
  passes(call('Edit', edit, { transcriptPath: fresh('dir') }), 'transcript is a directory');
  passes(call('Edit', edit, { transcriptPath: transcript(['']) }), 'empty transcript');
  passes(call('Edit', edit, { transcriptPath: transcript(['{{{', 'garbage', '\u0000\u0001']) }), 'unparseable transcript');
  passes(call('Edit', edit, { transcriptPath: transcript([user, JSON.stringify({ type: 'assistant', message: { content: [] } })]) }), 'no usage');
  passes(call('Edit', edit, { transcriptPath: transcript([JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: '900000', cache_read_input_tokens: null, cache_creation_input_tokens: true } } })]) }), 'usage of the wrong types');
  passes(call('Edit', edit, { transcriptPath: transcript([JSON.stringify({ type: 'assistant', message: 'x', usage: 5 }), JSON.stringify(['assistant', '"usage"'])]) }), 'wrong shapes');
  for (const extra of [{ transcript_path: undefined }, { transcript_path: 5 }, { transcript_path: '' }, { tool_name: undefined }, { tool_name: 5 }, { tool_input: 'x' }]) {
    const payload = { hook_event_name: 'PreToolUse', transcript_path: at(300_000), cwd: '/w', tool_name: 'Edit', tool_input: edit, ...extra };
    const r = raw(JSON.stringify(payload));
    if ('tool_input' in extra) passes(r, 'tool_input of the wrong type');
    else passes(r, JSON.stringify(extra));
  }
  const unreadable = at(300_000);
  execFileSync('chmod', ['000', unreadable]);
  if (process.getuid?.() !== 0) passes(call('Edit', edit, { transcriptPath: unreadable }), 'unreadable transcript');
});

test('an unknown event, or no event name, never refuses', () => {
  const edit = { file_path: '/w/repo/src/app.js' };
  for (const name of ['PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SomethingNew', undefined, 5]) {
    passes(call('Edit', edit, { extra: { hook_event_name: name } }), String(name));
  }
});

test('a subagent call passes: its context is not this transcript', () => {
  passes(call('Edit', { file_path: '/w/repo/src/app.js' }, { extra: { agent_id: 'a1', agent_type: 'builder' } }));
  passes(bash('npm test', { extra: { agent_id: 'a1' } }));
});

test('Desk is exempt by session id, and only that session', () => {
  const file = join(fresh('desk'), 'context-cap-exempt');
  writeFileSync(file, 'retiring-desk\n  desk-session  \n');
  const env = { CONTEXT_CAP_EXEMPT_FILE: file };
  const edit = { file_path: '/w/repo/src/app.js' };
  passes(call('Edit', edit, { env, extra: { session_id: 'desk-session' } }));
  passes(call('Edit', edit, { env, extra: { session_id: 'retiring-desk' } }));
  passes(bash('npm test', { env, extra: { session_id: 'desk-session' } }));
  // A session Desk started has Desk's environment and its own id.
  refused(call('Edit', edit, { env: { ...env, DESK_SESSION_NAME: 'desk', CONTEXT_CAP_DESK: '1' }, extra: { session_id: 'child-session' } }));
  refused(call('Edit', edit, { env, extra: { session_id: 'desk' } }), null, 'a prefix of an exempt id');
  refused(call('Edit', edit, { env, extra: { session_id: '' } }), null, 'an empty id against a file with a blank line');
  refused(call('Edit', edit, { env, extra: { session_id: undefined } }));
  // With no file at all (the default in every other test), nobody is exempt.
  refused(call('Edit', edit, { extra: { session_id: 'desk-session' } }));
});

// ---- once the handoff is committed --------------------------------------------

function repoWithHandoff({ commit = true, date = today, dir = 'docs' } = {}) {
  const repo = fresh('repo');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'work');
  const handoff = join(repo, dir, 'handoff', `${date}-topic.md`);
  mkdirSync(dirname(handoff), { recursive: true });
  writeFileSync(handoff, '# Handoff\n');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  if (commit) {
    git('add', '-A');
    git('commit', '-q', '-m', 'handoff');
  }
  const wrote = (tool = 'Write', path = handoff) => assistant(250_000, [{ type: 'tool_use', id: 't1', name: tool, input: { file_path: path, content: '# Handoff\n' } }]);
  return { repo, handoff, git, wrote };
}

test('once this session\'s handoff is committed, reads end and only publishing it runs', () => {
  const f = repoWithHandoff();
  const opts = { transcriptPath: transcript([user, f.wrote(), user, assistant(260_000)]), cwd: f.repo };
  const r = call('Read', { file_path: join(f.repo, 'README.md') }, opts);
  refused(r, /Read reads, and the handoff is already committed/);
  assert.ok(r.stderr.includes(`its handoff is committed: ${f.handoff}`), r.stderr);
  assert.match(r.stderr, /end the turn/);
  assert.match(r.stderr, /260,000 tokens/);
  refused(call('Grep', { pattern: 'x' }, opts), /Grep reads/);
  refused(call('Glob', { pattern: '*' }, opts), /Glob reads/);
  refused(call('Agent', { prompt: 'x' }, opts), /starts new work/);
  refused(call('Edit', { file_path: join(f.repo, 'README.md') }, opts), /isn't a handoff file/);
  for (const [command, why] of [
    ['cat README.md', /`cat` touches/],
    ['ls', /`ls` reads, and the handoff is already committed/],
    ['grep -rn x src', /`grep` reads/],
    ['git show HEAD', /`git show` reads, and the handoff is already committed/],
    ['git fetch origin', /`git fetch`/],
    ['git switch -c more-work', /`git switch`/],
    ['git branch more-work', /`git branch`/],
    ['gh pr checks 12', /`gh pr checks`/],
    ['gh api rate_limit', /`gh api rate_limit`/],
    ['gh issue list', /`gh issue list`/],
    ['npm test', /`npm` isn't a command a handoff needs/],
  ]) refused(bash(command, opts), why, command);
  for (const command of [
    'git push',
    'git push -u origin work',
    'git status --short',
    'git log --oneline -3',
    'git rev-parse origin/work',
    'git branch --show-current',
    'git add docs/backlog.json && git commit -m "Backlog stamps" && git push',
    'gh pr view --json number,body',
    'd=$(mktemp -d) && gh pr view --json body -q .body > "$d/body.md"',
    `gh pr edit 12 --body-file ${TEMP}/body.md`,
    'gh pr comment 12 --body "handoff is in docs/handoff"',
    `gh pr create --draft --title Handoff --body-file ${TEMP}/body.md`,
    'TZ=America/Toronto date',
    `cat docs/handoff/${today}-topic.md`,
  ]) passes(bash(command, opts), command);
  passes(call('Skill', { skill: 'handoff' }, opts));
  passes(call('Read', { file_path: f.handoff }, opts), 'reading the handoff itself');
  passes(call('Read', { file_path: join(f.repo, 'docs', 'backlog.json') }, opts));
  passes(call('Edit', { file_path: f.handoff }, opts), 'correcting the handoff');
  passes(call('Edit', { file_path: join(f.repo, 'docs', 'backlog.json') }, opts));
  passes(call('Write', { file_path: `${TEMP}/body.md`, content: 'x' }, opts));
});

test('a handoff under control/handoff in another repository counts the same', () => {
  const f = repoWithHandoff({ dir: 'control' });
  const opts = { transcriptPath: transcript([f.wrote('Edit'), assistant(260_000)]), cwd: '/w/repo' };
  refused(call('Read', { file_path: '/w/repo/README.md' }, opts), /handoff is already committed/);
});

test('near misses: a handoff that is not committed, not today\'s or not this session\'s leaves reads open', () => {
  const read = (opts) => call('Read', { file_path: '/w/repo/README.md' }, opts);
  const stillHeld = (opts) => refused(call('Edit', { file_path: '/w/repo/src/a.js' }, opts), /Run \/handoff <topic> now/);

  const uncommitted = repoWithHandoff({ commit: false });
  let opts = { transcriptPath: transcript([uncommitted.wrote(), assistant(260_000)]), cwd: uncommitted.repo };
  passes(read(opts), 'written, not committed');
  stillHeld(opts);

  const edited = repoWithHandoff();
  writeFileSync(edited.handoff, '# Handoff\nmore\n');
  opts = { transcriptPath: transcript([edited.wrote(), assistant(260_000)]), cwd: edited.repo };
  passes(read(opts), 'committed, then edited again');

  const old = repoWithHandoff({ date: '2026-01-05' });
  opts = { transcriptPath: transcript([old.wrote(), assistant(260_000)]), cwd: old.repo };
  passes(read(opts), 'an older handoff');

  // Another session's handoff, committed in this repository today: this transcript never wrote it.
  const other = repoWithHandoff();
  opts = { transcriptPath: transcript([user, assistant(260_000)]), cwd: other.repo };
  passes(read(opts), "another session's handoff");
  stillHeld(opts);

  // Reading the handoff, or a subagent writing one, is not this session writing it.
  const readOnly = repoWithHandoff();
  opts = { transcriptPath: transcript([readOnly.wrote('Read'), assistant(250_000, [{ type: 'text', text: readOnly.handoff }]), assistant(260_000)]), cwd: readOnly.repo };
  passes(read(opts), 'only read');
  const side = repoWithHandoff();
  opts = { transcriptPath: transcript([JSON.stringify({ ...JSON.parse(side.wrote()), isSidechain: true }), assistant(260_000)]), cwd: side.repo };
  passes(read(opts), 'written by a subagent');

  const gone = repoWithHandoff();
  opts = { transcriptPath: transcript([gone.wrote('Write', join(gone.repo, 'docs', 'handoff', `${today}-missing.md`)), assistant(260_000)]), cwd: gone.repo };
  passes(read(opts), 'the file no longer exists');

  const outside = fresh('norepo');
  mkdirSync(join(outside, 'docs', 'handoff'), { recursive: true });
  const loose = join(outside, 'docs', 'handoff', `${today}-topic.md`);
  writeFileSync(loose, 'x');
  opts = { transcriptPath: transcript([assistant(250_000, [{ type: 'tool_use', name: 'Write', input: { file_path: loose } }]), assistant(260_000)]), cwd: outside };
  passes(read(opts), 'not in a git repository');
});

test('without argv-guard.py beside it the hook cannot read shell commands, so they pass, and the rest still holds', () => {
  const dir = fresh('alone');
  const alone = join(dir, 'context-cap.py');
  copyFileSync(HOOK, alone);
  passes(bash('npm test', { hook: alone }));
  refused(call('Edit', { file_path: '/w/repo/src/a.js' }, { hook: alone }));
  refused(call('Agent', { prompt: 'x' }, { hook: alone }));
});

test('the settings fragment runs this hook on every tool and lets a missing file through', () => {
  const settings = JSON.parse(readFileSync(join(HOOKS, 'context-cap.settings.json'), 'utf8'));
  const entries = settings.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  assert.ok(entries[0].matcher === undefined || entries[0].matcher === '*', 'every tool, so Edit, Write and Agent are seen');
  const [hook] = entries[0].hooks;
  assert.equal(hook.type, 'command');
  assert.ok(hook.timeout >= 5 && hook.timeout <= 10);
  // No `|| true`: exit 2 is the refusal. So the command itself must exit 0 when the hook file isn't installed yet
  // (python3 exits 2 on a missing script, which would refuse every call in every session).
  assert.ok(!/\|\|\s*true/.test(hook.command));
  const home = fresh('home');
  const sh = (h) => spawnSync('sh', ['-c', hook.command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/a.js' }, transcript_path: at(300_000) }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, TMPDIR: join(top, 'tmp') } });
  let r = sh(home);
  assert.equal(r.status, 0, `missing hook file: ${r.stderr}`);
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  copyFileSync(HOOK, join(home, '.claude', 'hooks', 'context-cap.py'));
  copyFileSync(join(HOOKS, 'argv-guard.py'), join(home, '.claude', 'hooks', 'argv-guard.py'));
  r = sh(home);
  assert.equal(r.status, 2, 'installed, the same command refuses');
  assert.match(r.stderr, /^context-cap \(plan row 1\.61\) refused this call/);
});
