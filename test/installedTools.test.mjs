import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { collectLocal } from '../scripts/lib/hygiene.mjs'
import { installedTools } from '../scripts/lib/installed-tools.mjs'
import { checkInstalledDrift, newlyBehind } from '../scripts/lib/installedDrift.mjs'

const sh = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (p, body, mode) => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, mode ? { mode } : undefined)
}

/**
 * A .github clone with capacity/capacity.mjs at v1, v2, v3 and bin/tool, a gates-main worktree at v2's
 * commit (one behind), and a home with a link into it, a link into the working checkout and a capacity copy.
 */
function fixture() {
  const top = mkdtempSync(join(tmpdir(), 'installed-'))
  const origin = join(top, 'origin.git')
  sh(top, 'init', '-q', '--bare', '-b', 'main', origin)
  const root = join(top, 'clones')
  mkdirSync(root)
  const clone = join(root, 'gorfednet.github')
  sh(root, 'clone', '-q', origin, 'gorfednet.github')
  sh(clone, 'checkout', '-q', '-b', 'main')
  const commit = (v) => {
    put(join(clone, 'capacity', 'capacity.mjs'), `// ${v}\n`)
    put(join(clone, 'bin', 'tool'), `#!/bin/sh\necho ${v}\n`, 0o755)
    sh(clone, 'add', '-A')
    sh(clone, 'commit', '-q', '-m', v)
    sh(clone, 'push', '-q', 'origin', 'main')
  }
  commit('v1')
  commit('v2')
  const gates = join(clone, '.claude', 'worktrees', 'gates-main')
  sh(clone, 'worktree', 'add', '-q', '--detach', gates, 'origin/main')
  const home = join(top, 'home')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  symlinkSync(join(gates, 'bin', 'tool'), join(home, '.local', 'bin', 'tool'))
  put(join(home, '.desk', 'capacity-app', 'capacity.mjs'), '// v2\n')
  return { top, root, clone, gates, home, commit, agents: join(top, 'no-agents') }
}
const run = (f) => installedTools({ home: f.home, root: f.root, launchAgents: f.agents })

describe('installed tools behind main', () => {
  it('a link into a current tools worktree and a current copy are not flagged', () => {
    const f = fixture()
    const r = run(f)
    assert.deepEqual(r.behind, [])
    assert.equal(r.checked, 2)
    assert.deepEqual(r.unread, [])
  })

  it('a tools worktree and a copy left behind by a merge are flagged with their counts', () => {
    const f = fixture()
    f.commit('v3')
    const r = run(f)
    assert.deepEqual(
      r.behind.map((b) => [b.tool, b.source, b.behind]),
      [
        ['~/.local/bin/tool', 'gorfednet.github/.claude/worktrees/gates-main', 1],
        ['capacity check', '~/.desk/capacity-app/capacity.mjs', 1],
      ],
    )
  })

  it('an always-pr-remind hook copy left behind a committed fix is flagged', () => {
    const f = fixture()
    const src = join(f.clone, 'docs', 'claude-home', 'hooks', 'always-pr-remind.py')
    put(src, '# old\n')
    sh(f.clone, 'add', '-A')
    sh(f.clone, 'commit', '-q', '-m', 'hook v1')
    put(src, '# fixed\n')
    sh(f.clone, 'add', '-A')
    sh(f.clone, 'commit', '-q', '-m', 'hook v2')
    sh(f.clone, 'push', '-q', 'origin', 'main')
    put(join(f.home, '.claude', 'hooks', 'always-pr-remind.py'), '# old\n')
    const r = run(f)
    const hook = (x) => x.behind.filter((b) => b.tool === 'always-pr-remind hook')
    assert.deepEqual(hook(r).map((b) => b.behind), [1])
    put(join(f.home, '.claude', 'hooks', 'always-pr-remind.py'), '# fixed\n')
    assert.deepEqual(hook(run(f)), [])
  })

  it('a link into a working checkout is flagged even when that checkout is current', () => {
    const f = fixture()
    symlinkSync(join(f.clone, 'bin', 'tool'), join(f.home, '.local', 'bin', 'tool2'))
    const r = run(f)
    assert.equal(r.behind.length, 1)
    assert.equal(r.behind[0].tool, '~/.local/bin/tool2')
    assert.equal(r.behind[0].source, 'gorfednet.github')
    assert.match(r.behind[0].detail, /working checkout/)
  })

  it('a worktree with any other name is a working checkout, and a dangling link is flagged', () => {
    const f = fixture()
    const other = join(f.clone, '.claude', 'worktrees', 'feature')
    sh(f.clone, 'worktree', 'add', '-q', '--detach', other, 'origin/main')
    symlinkSync(join(other, 'bin', 'tool'), join(f.home, '.local', 'bin', 'tool3'))
    symlinkSync(join(f.root, 'gone', 'tool'), join(f.home, '.local', 'bin', 'tool4'))
    const r = run(f)
    assert.deepEqual(r.behind.map((b) => b.tool).sort(), ['~/.local/bin/tool3', '~/.local/bin/tool4'])
    assert.match(r.behind.find((b) => b.tool.endsWith('tool4')).detail, /missing/)
  })

  it('a copy that matches no committed version says so, with no count', () => {
    const f = fixture()
    put(join(f.home, '.desk', 'capacity-app', 'capacity.mjs'), '// edited by hand\n')
    const [b] = run(f).behind
    assert.equal(b.behind, null)
    assert.match(b.detail, /matches no committed version of gorfednet\.github\/capacity\/capacity\.mjs/)
  })

  it('a tools worktree on a branch or with edited tracked files is flagged though not behind', () => {
    const f = fixture()
    writeFileSync(join(f.gates, 'bin', 'tool'), '#!/bin/sh\necho edited\n')
    assert.match(run(f).behind[0].detail, /tracked files changed/)
    sh(f.gates, 'checkout', '-q', '--', 'bin/tool')
    sh(f.gates, 'checkout', '-q', '-b', 'local')
    assert.match(run(f).behind[0].detail, /on branch local/)
  })

  it('links outside the clone root are ignored (node, hc)', () => {
    const f = fixture()
    symlinkSync('/usr/bin/true', join(f.home, '.local', 'bin', 'true'))
    assert.equal(run(f).checked, 2)
  })

  it('collectLocal: measured after a fetch, not measured without one', () => {
    const f = fixture()
    f.commit('v3')
    const none = join(f.top, 'no-sessions')
    const measured = collectLocal(f.root, { home: f.home, launchAgents: f.agents, sessionsDir: none })
    assert.equal(measured.installedTools.length, 2)
    assert.equal(collectLocal(f.root, { fetch: false, home: f.home, launchAgents: f.agents, sessionsDir: none }).installedTools, null)
    const empty = join(f.top, 'empty-home')
    assert.equal(collectLocal(f.root, { home: empty, launchAgents: f.agents, sessionsDir: none }).installedTools, null, 'no tool found is not a clean Mac')
  })
})

describe('LaunchAgents on another tool\'s Node', () => {
  const hasPlutil = spawnSync('plutil', ['-help']).error === undefined
  const agent = (f, name, program) => {
    mkdirSync(f.agents, { recursive: true })
    put(join(f.agents, `${name}.plist`), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${program}</string><string>${join(f.home, '.ship-bot', 'app', 'ship-bot.mjs')}</string></array></dict></plist>\n`)
  }
  it('flags a program that resolves into ~/.hermes through a symlink, not one in /usr/bin or app paths under ~/.ship-bot', () => {
    const f = fixture()
    const real = join(f.home, '.hermes', 'node', 'bin', 'node')
    put(real, '#!/bin/sh\n', 0o755)
    symlinkSync(real, join(f.home, '.local', 'bin', 'node'))
    agent(f, 'net.gorfed.ship-bot', join(f.home, '.local', 'bin', 'node'))
    agent(f, 'net.gorfed.fine', '/usr/bin/true')
    const hit = run(f).behind.filter((b) => b.tool.startsWith('LaunchAgent'))
    assert.equal(hit.length, 1)
    assert.equal(hit[0].tool, 'LaunchAgent net.gorfed.ship-bot')
    assert.match(hit[0].detail, /\.hermes\/node\/bin\/node, inside another tool's private folder/)
  })
  it('reports a LaunchAgent whose program no longer exists as behind, not unread', () => {
    const f = fixture()
    const real = join(f.home, '.hermes', 'node', 'bin', 'node')
    put(real, '#!/bin/sh\n', 0o755)
    symlinkSync(real, join(f.home, '.local', 'bin', 'node'))
    rmSync(real)
    agent(f, 'net.gorfed.ship-bot', join(f.home, '.local', 'bin', 'node'))
    const r = run(f)
    assert.ok(!r.unread.some((u) => u.startsWith('LaunchAgent')), 'a dangling program is a known fault, not "not read"')
    const hit = r.behind.filter((b) => b.tool === 'LaunchAgent net.gorfed.ship-bot')
    assert.equal(hit.length, 1)
    assert.match(hit[0].detail, /which does not exist/)
  })
})

describe('gate scripts and the ~/.claude mirror (plan row 1.18)', () => {
  const commitFile = (f, rel, body) => {
    put(join(f.clone, rel), body)
    sh(f.clone, 'add', '-A')
    sh(f.clone, 'commit', '-q', '-m', rel)
    sh(f.clone, 'push', '-q', 'origin', 'main')
  }
  const named = (f, tool) => run(f).behind.filter((b) => b.tool === tool)

  it('the installed gate scripts are compared with scripts/ on main, and SOURCE is ignored', () => {
    const f = fixture()
    commitFile(f, 'scripts/review-status.mjs', '// r1\n')
    commitFile(f, 'scripts/review-status.mjs', '// r2\n')
    const gs = join(f.home, '.ship-bot', 'app', 'gate-scripts')
    put(join(gs, 'SOURCE'), `${'a'.repeat(40)}\n`)
    put(join(gs, 'review-status.mjs'), '// r1\n')
    const [b] = named(f, 'ship-bot gate scripts')
    assert.equal(b.behind, 1)
    assert.match(b.detail, /1 files behind/)
    put(join(gs, 'review-status.mjs'), '// r2\n')
    assert.deepEqual(named(f, 'ship-bot gate scripts'), [])
  })

  it('a stale or hand-edited rule, a missing skill and an unmirrored file are told apart', () => {
    const f = fixture()
    commitFile(f, 'docs/claude-home/rules/shipping.md', 'v1\n')
    commitFile(f, 'docs/claude-home/rules/shipping.md', 'v2\n')
    commitFile(f, 'docs/claude-home/skills/copy/SKILL.md', 'skill\n')
    commitFile(f, 'docs/claude-home/README.md', 'docs only\n')
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'v1\n')
    put(join(f.home, '.claude', 'rules', 'only-here.md'), 'no mirror\n')
    const [b] = named(f, '~/.claude mirror')
    assert.equal(b.behind, 1)
    assert.match(b.detail, /1 files behind, 1 files not installed/, 'README.md is not in the include list')
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'edited by hand\n')
    assert.match(named(f, '~/.claude mirror')[0].detail, /1 files match no version on main/)
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'v2\n')
    put(join(f.home, '.claude', 'skills', 'copy', 'SKILL.md'), 'skill\n')
    assert.deepEqual(named(f, '~/.claude mirror'), [])
  })
})

describe('installed-drift notification (plan row 1.18)', () => {
  const memoOf = (f) => join(f.home, '.desk', 'installed-drift.json')
  const drift = (f, push, extra = {}) => checkInstalledDrift({ home: f.home, root: f.root, launchAgents: f.agents, push, fetchOrigin: () => true, ...extra })

  it('goes red once on a stale copy, stays quiet on later runs, then green and re-arms', async () => {
    const f = fixture()
    f.commit('v3') // the gates worktree and the capacity copy are now one behind
    const sent = []
    const push = async (t) => (sent.push(t), true)
    assert.equal((await drift(f, push)).action, 'pushed')
    assert.equal(sent.length, 1)
    assert.match(sent[0], /installed tools behind main: .*~\/\.local\/bin\/tool.*capacity check/)
    assert.equal((await drift(f, push)).action, 'none')
    f.commit('v4')
    assert.equal((await drift(f, push)).action, 'none', 'further behind is not news')
    assert.equal(sent.length, 1)
    sh(f.gates, 'checkout', '-q', '--detach', 'origin/main')
    put(join(f.home, '.desk', 'capacity-app', 'capacity.mjs'), '// v4\n')
    const green = await drift(f, push)
    assert.deepEqual([green.action, green.behind], ['none', 0])
    assert.deepEqual(JSON.parse(readFileSync(memoOf(f), 'utf8')).told, [])
    f.commit('v5')
    assert.equal((await drift(f, push)).action, 'pushed', 'a second lapse tells again')
    assert.equal(sent.length, 2)
  })

  it('a push nobody received is retried on the next run', async () => {
    const f = fixture()
    f.commit('v3')
    assert.equal((await drift(f, async () => false)).action, 'push-failed')
    assert.equal((await drift(f, async () => true)).action, 'pushed')
  })

  it('a failed fetch or an unreadable tool is unmeasured and never a green', async () => {
    const f = fixture()
    f.commit('v3')
    const push = async () => assert.fail('no push without a measurement')
    assert.equal((await drift(f, push, { fetchOrigin: () => false })).action, 'unmeasured')
    const bare = mkdtempSync(join(tmpdir(), 'no-clones-'))
    assert.equal((await drift(f, push, { root: bare })).action, 'unmeasured')
  })

  it('newlyBehind names each tool once however many files are behind', () => {
    const r = newlyBehind([{ tool: 'a' }, { tool: 'a' }, { tool: 'b' }], ['b', 'gone'])
    assert.deepEqual(r, { fresh: ['a'], still: ['b'], names: ['a', 'b'] })
  })
})
