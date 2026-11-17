import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { collectLocal } from '../scripts/lib/hygiene.mjs'
import { installedTools } from '../scripts/lib/installed-tools.mjs'
import { checkInstalledDrift, plan } from '../scripts/lib/installedDrift.mjs'

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
  // The ops clone holds the ~/.claude copy under control/claude-home/ (plan row 1.30).
  const opsOrigin = join(top, 'ops.git')
  sh(top, 'init', '-q', '--bare', '-b', 'main', opsOrigin)
  const ops = join(root, 'ops')
  sh(root, 'clone', '-q', opsOrigin, 'ops')
  sh(ops, 'checkout', '-q', '-b', 'main')
  put(join(ops, 'README.md'), 'ops\n')
  sh(ops, 'add', '-A')
  sh(ops, 'commit', '-q', '-m', 'ops')
  sh(ops, 'push', '-q', 'origin', 'main')
  return { top, root, clone, ops, gates, home, commit, agents: join(top, 'no-agents') }
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
  it('does not flag a Node under ~/.local/share/node (the user-owned installs, plan row 3.20k), but still flags other ~/.local/share paths', () => {
    const f = fixture()
    const ours = join(f.home, '.local', 'share', 'node', 'v24.22.3', 'bin', 'node')
    put(ours, '#!/bin/sh\n', 0o755)
    symlinkSync(join(f.home, '.local', 'share', 'node', 'v24.22.3'), join(f.home, '.local', 'share', 'node', '24'))
    agent(f, 'net.gorfed.ship-bot', join(f.home, '.local', 'share', 'node', '24', 'bin', 'node'))
    const other = join(f.home, '.local', 'share', 'nodeish', 'bin', 'node')
    put(other, '#!/bin/sh\n', 0o755)
    agent(f, 'net.gorfed.capacity', other)
    // The shell's own link resolves into the same folder, but an agent naming it is still on a shared Node.
    symlinkSync(join(f.home, '.local', 'share', 'node', 'v24.22.3', 'bin', 'node'), join(f.home, '.local', 'bin', 'node'))
    agent(f, 'net.gorfed.herdr-reconcile', join(f.home, '.local', 'bin', 'node'))
    const hit = run(f).behind.filter((b) => b.tool.startsWith('LaunchAgent'))
    assert.deepEqual(hit.map((h) => h.tool).sort(), ['LaunchAgent net.gorfed.capacity', 'LaunchAgent net.gorfed.herdr-reconcile'])
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

describe('a Node that is not the one check.sh passed on (plan row 1.22a)', () => {
  const setup = (version, recorded, rel = join('opt', 'bin', 'node')) => {
    const f = fixture()
    const node = join(f.home, rel)
    put(node, `#!/bin/sh\necho ${version}\n`, 0o755)
    mkdirSync(f.agents, { recursive: true })
    put(join(f.agents, 'net.gorfed.ship-bot.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>net.gorfed.ship-bot</string><key>ProgramArguments</key><array><string>${node}</string><string>${join(f.home, '.ship-bot', 'app', 'ship-bot.mjs')}</string></array></dict></plist>\n`)
    if (recorded !== null) put(join(f.home, '.ship-bot', 'app.node-version'), `${recorded}\n`)
    return f
  }
  const nodeRows = (f) => run(f).behind.filter((b) => b.tool.startsWith('Node version'))
  it('is quiet when the agent\'s Node reports the recorded version', () => {
    assert.deepEqual(nodeRows(setup('v22.23.1', 'v22.23.1')), [])
  })
  const stable = join('.local', 'share', 'node', '24', 'bin', 'node')
  it('is quiet after a patch or minor release in the recorded major, on the stable user-owned link only (plan row 3.20k)', () => {
    assert.deepEqual(nodeRows(setup('v24.22.4', 'v24.22.1', stable)), [])
    assert.deepEqual(nodeRows(setup('v24.23.0', 'v24.22.1', stable)), [])
    assert.equal(nodeRows(setup('v24.22.4', 'v24.22.1')).length, 1, 'any other program path keeps the exact comparison')
    assert.equal(nodeRows(setup('v24.22.0', 'v24.22.1', stable)).length, 1, 'a downgrade is drift')
  })
  it('still flags a different major, even one newer', () => {
    assert.equal(nodeRows(setup('v26.0.0', 'v24.22.1', stable)).length, 1)
  })
  it('flags a changed version, naming both', () => {
    const hit = nodeRows(setup('v24.1.0', 'v22.23.1'))
    assert.equal(hit.length, 1)
    assert.equal(hit[0].tool, 'Node version net.gorfed.ship-bot')
    assert.match(hit[0].detail, /runs Node v24\.1\.0, but check\.sh passed on v22\.23\.1: rerun the installer from origin\/main/)
  })
  it('flags an installed agent with no record, and ignores an agent that is not installed', () => {
    const hit = nodeRows(setup('v22.23.1', null))
    assert.equal(hit.length, 1)
    assert.match(hit[0].detail, /no check\.sh pass is recorded/)
    assert.deepEqual(nodeRows(fixture()), [])
  })
  it('reports an agent whose Node exists but will not report a version, instead of skipping it', () => {
    const f = setup('v22.23.1', 'v22.23.1')
    put(join(f.home, 'opt', 'bin', 'node'), '#!/bin/sh\nexit 1\n', 0o755)
    const hit = nodeRows(f)
    assert.equal(hit.length, 1)
    assert.equal(hit[0].tool, 'Node version net.gorfed.ship-bot')
    assert.match(hit[0].detail, /unread: .* --version failed or timed out/)
  })
  it('reports an unreadable Node even when no record exists (the state right after merge)', () => {
    const f = setup('v22.23.1', null)
    put(join(f.home, 'opt', 'bin', 'node'), '#!/bin/sh\nexit 1\n', 0o755)
    const hit = nodeRows(f)
    assert.equal(hit.length, 1)
    assert.match(hit[0].detail, /unread: .* --version failed or timed out/)
  })
})

describe('gate scripts and the ~/.claude mirror (plan row 1.18)', () => {
  const commitFile = (f, rel, body) => {
    const c = rel.startsWith('control/') ? f.ops : f.clone
    put(join(c, rel), body)
    sh(c, 'add', '-A')
    sh(c, 'commit', '-q', '-m', rel)
    sh(c, 'push', '-q', 'origin', 'main')
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
    commitFile(f, 'control/claude-home/rules/shipping.md', 'v1\n')
    commitFile(f, 'control/claude-home/rules/shipping.md', 'v2\n')
    commitFile(f, 'control/claude-home/skills/copy/SKILL.md', 'skill\n')
    commitFile(f, 'control/claude-home/README.md', 'docs only\n')
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'v1\n')
    put(join(f.home, '.claude', 'rules', 'only-here.md'), 'no mirror\n')
    const [b] = named(f, '~/.claude mirror')
    assert.equal(b.behind, 1)
    assert.match(b.detail, /1 files behind, 1 files not installed/, 'README.md is not in the include list')
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'edited by hand\n')
    const ahead = named(f, '~/.claude mirror').find((b) => b.ahead)
    assert.match(ahead.detail, /1 files ahead of main or unmirrored \(not behind\)/)
    assert.equal(ahead.behind, null)
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'v2\n')
    put(join(f.home, '.claude', 'skills', 'copy', 'SKILL.md'), 'skill\n')
    assert.deepEqual(named(f, '~/.claude mirror'), [])
  })

  it('the hooks are mirrored from this repository, and nothing else in scripts/claude-hooks/ is expected in ~/.claude/hooks', () => {
    const f = fixture()
    commitFile(f, 'scripts/claude-hooks/always-pr-remind.py', '# old\n')
    commitFile(f, 'scripts/claude-hooks/always-pr-remind.py', '# fixed\n')
    commitFile(f, 'scripts/claude-hooks/README.md', 'docs only\n')
    commitFile(f, 'scripts/claude-hooks/plugin-usage.py', '# a script, not a hook\n')
    put(join(f.home, '.claude', 'hooks', 'always-pr-remind.py'), '# old\n')
    const [b] = named(f, '~/.claude hooks')
    assert.equal(b.behind, 1)
    assert.match(b.detail, /mirror of gorfednet\.github\/scripts\/claude-hooks: 1 files behind/)
    assert.doesNotMatch(b.detail, /not installed/, 'README.md and plugin-usage.py are not in the include list')
    put(join(f.home, '.claude', 'hooks', 'always-pr-remind.py'), '# fixed\n')
    assert.deepEqual(named(f, '~/.claude hooks'), [])
  })
})

describe('installed-drift notification (plan row 1.18)', () => {
  const memoOf = (f) => join(f.home, '.desk', 'installed-drift.json')
  const drift = (f, push, extra = {}) => checkInstalledDrift({ home: f.home, root: f.root, launchAgents: f.agents, push, fetchOrigin: () => true, ...extra })

  it('goes red once, only after two runs in a row, stays quiet, then green and re-arms', async () => {
    const f = fixture()
    f.commit('v3') // the gates worktree and the capacity copy are now one behind
    const sent = []
    const push = async (t) => (sent.push(t), true)
    assert.equal((await drift(f, push)).action, 'pending', 'one sighting could be the gap before ship-bot advances gates-main')
    assert.equal(sent.length, 0)
    assert.equal((await drift(f, push)).action, 'pushed')
    assert.equal(sent.length, 1)
    assert.match(sent[0], /installed tools behind main: .*~\/\.local\/bin\/tool.*capacity check/)
    assert.equal((await drift(f, push)).action, 'pending', 'told already; still behind')
    f.commit('v4')
    await drift(f, push); await drift(f, push)
    assert.equal(sent.length, 1, 'further behind is not news')
    sh(f.gates, 'checkout', '-q', '--detach', 'origin/main')
    put(join(f.home, '.desk', 'capacity-app', 'capacity.mjs'), '// v4\n')
    const green = await drift(f, push)
    assert.deepEqual([green.action, green.behind], ['none', 0])
    assert.deepEqual(JSON.parse(readFileSync(memoOf(f), 'utf8')).told, [])
    f.commit('v5')
    await drift(f, push)
    assert.equal((await drift(f, push)).action, 'pushed', 'a second lapse tells again')
    assert.equal(sent.length, 2)
  })

  it('another file going stale under an aggregate tool is news; a one-run blip is not', async () => {
    const f = fixture()
    const sent = []
    const push = async (t) => (sent.push(t), true)
    const rule = (n, body) => { put(join(f.ops, 'control/claude-home/rules', n), body); sh(f.ops, 'add', '-A'); sh(f.ops, 'commit', '-q', '-m', n); sh(f.ops, 'push', '-q', 'origin', 'main') }
    rule('a.md', 'a1\n'); rule('b.md', 'b1\n')
    put(join(f.home, '.claude', 'rules', 'a.md'), 'a1\n'); put(join(f.home, '.claude', 'rules', 'b.md'), 'b1\n')
    assert.equal((await drift(f, push)).action, 'none')
    rule('a.md', 'a2\n')
    await drift(f, push); await drift(f, push)
    assert.equal(sent.length, 1)
    rule('b.md', 'b2\n') // same tool, another file (2 files behind)
    await drift(f, push)
    assert.equal((await drift(f, push)).action, 'pushed')
    assert.equal(sent.length, 2)
    put(join(f.home, '.claude', 'rules', 'b.md'), 'b2\n') // one comes right: fewer files, nothing new
    await drift(f, push); await drift(f, push)
    assert.equal(sent.length, 2, 'a falling count is not news')
  })

  it('a push nobody received is retried on the next run', async () => {
    const f = fixture()
    f.commit('v3')
    await drift(f, async () => false)
    assert.equal((await drift(f, async () => false)).action, 'push-failed')
    assert.equal((await drift(f, async () => true)).action, 'pushed')
  })

  it('a check that cannot measure is never green: silent twice, one push on the third run, none after', async () => {
    const f = fixture()
    f.commit('v3')
    const sent = []
    const push = async (t) => (sent.push(t), true)
    const broken = { fetchOrigin: () => false }
    for (let i = 0; i < 2; i++) assert.equal((await drift(f, push, broken)).action, 'unmeasured')
    assert.equal(sent.length, 0)
    assert.equal((await drift(f, push, broken)).action, 'unmeasured')
    assert.equal(sent.length, 1)
    assert.match(sent[0], /could not measure for 3 runs \(a fetch failed\); capacity.log has the reason/)
    assert.ok(!sent[0].includes(f.root) && !sent[0].includes(f.home), 'no path leaves the Mac')
    await drift(f, push, broken)
    assert.equal(sent.length, 1)
    const bare = mkdtempSync(join(tmpdir(), 'no-clones-'))
    const nothing = await drift(f, push, { root: bare })
    assert.deepEqual([nothing.action, nothing.unread.length > 0], ['none', true], 'no clones: nothing found, and said to be unread rather than green')
    await drift(f, push); assert.equal(JSON.parse(readFileSync(memoOf(f), 'utf8')).unmeasuredRuns, undefined, 'a measurement resets the streak')
  })

  it('a clone the tools come from but the list does not name is fetched too, and unmeasured when that fetch fails', async () => {
    const f = fixture()
    const third = join(f.root, 'third')
    sh(f.root, 'clone', '-q', join(f.top, 'origin.git'), 'third')
    symlinkSync(join(third, 'bin', 'tool'), join(f.home, '.local', 'bin', 'tool5')) // a working checkout outside DRIFT_REPOS
    const seen = []
    await drift(f, async () => true, { fetchOrigin: (d) => (seen.push(d), true) })
    assert.ok(seen.some((d) => d.endsWith('/third')), `third clone fetched: ${seen.join(' ')}`)
    const r = await drift(f, async () => true, { fetchOrigin: (d) => !d.endsWith('/third') })
    assert.deepEqual([r.action, r.reason.startsWith('fetch of')], ['unmeasured', true])
  })

  it('plan keys a finding by tool and file, or tool and detail without files', () => {
    const r = plan([{ tool: 'a', detail: 'x' }, { tool: 'a', detail: '2 files', items: ['f1', 'f2'] }, { tool: 'b', detail: 'z' }], { told: ['b|z', 'gone|q', 'a|f2'], seen: { 'a|x': 1 } })
    assert.deepEqual(r.fresh, ['a|x'])
    assert.deepEqual(r.told, ['b|z', 'a|f2'])
    assert.deepEqual(r.tools, ['a', 'b'])
  })
})

describe('review fixes: code-only ship-bot copy, ahead is not behind, fail closed (plan row 1.18)', () => {
  const commitFile = (f, rel, body) => {
    const c = rel.startsWith('control/') ? f.ops : f.clone
    put(join(c, rel), body)
    sh(c, 'add', '-A')
    sh(c, 'commit', '-q', '-m', rel)
    sh(c, 'push', '-q', 'origin', 'main')
    sh(f.gates, 'checkout', '-q', '--detach', 'origin/main')
  }
  const drift = (f, push, extra = {}) => checkInstalledDrift({ home: f.home, root: f.root, launchAgents: f.agents, push, fetchOrigin: () => true, ...extra })

  it('a README or example-config merge does not make the ship-bot copy stale, a code merge does', () => {
    const f = fixture()
    const app = join(f.home, '.ship-bot', 'app')
    commitFile(f, 'ship-bot/README.md', 'r1\n')
    commitFile(f, 'ship-bot/config.example.json', '{}\n')
    commitFile(f, 'ship-bot/ship-bot.mjs', '// s1\n')
    put(join(app, 'README.md'), 'old readme\n')
    put(join(app, 'config.example.json'), '{"old":1}\n')
    put(join(app, 'ship-bot.mjs'), '// s1\n')
    assert.deepEqual(run(f).behind.filter((b) => b.tool === 'ship-bot'), [])
    commitFile(f, 'ship-bot/ship-bot.mjs', '// s2\n')
    assert.equal(run(f).behind.filter((b) => b.tool === 'ship-bot')[0].behind, 1)
  })

  it('a copy ahead of main is shown as ahead, never notified, and does not hide a real stale tool', async () => {
    const f = fixture()
    commitFile(f, 'control/claude-home/rules/shipping.md', 's1\n')
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 's1 plus an edit not yet in a pull request\n')
    const [b] = run(f).behind
    assert.deepEqual([b.ahead, b.behind], [true, null])
    const sent = []
    const push = async (t) => (sent.push(t), true)
    await drift(f, push); await drift(f, push)
    assert.equal(sent.length, 0, 'ahead is not behind')
    f.commit('v3')
    await drift(f, push)
    assert.equal((await drift(f, push)).action, 'pushed')
    assert.ok(!sent[0].includes('~/.claude mirror'))
  })

  it('an empty listing compares nothing and is unread, not a clean mirror', () => {
    const f = fixture()
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'x\n') // ~/.claude exists but ops main holds no control/claude-home
    const r = run(f)
    assert.ok(r.unread.includes('~/.claude'))
    assert.deepEqual(r.behind.filter((b) => b.tool === '~/.claude mirror'), [])
  })

  it('one unreadable item does not discard the findings, and the unread streak is told once without a path', async () => {
    const f = fixture()
    f.commit('v3') // stale link and copy
    put(join(f.home, '.claude', 'rules', 'shipping.md'), 'x\n') // ~/.claude exists, ops main has no control/claude-home: unread
    const sent = []
    const push = async (t) => (sent.push(t), true)
    const r1 = await drift(f, push)
    assert.deepEqual([r1.action, r1.behind, r1.unread.length], ['pending', 2, 1])
    const r2 = await drift(f, push)
    assert.equal(r2.action, 'pushed')
    await drift(f, push)
    assert.equal(sent.length, 2)
    assert.match(sent[0], /^installed tools behind main: /)
    assert.match(sent[1], /could not measure for 3 runs \(1 items unread\)/)
    for (const t of sent) assert.ok(!t.includes(f.home) && !t.includes(f.root) && !t.includes('/Users/'), t)
  })

  it('an installed file that cannot be read is unread, not ahead and not a made-up count, in the mirror and in a copied directory', () => {
    const f = fixture()
    // history with a deletion: the path was committed, deleted and committed again, so a null blob would match the deletion commit
    commitFile(f, 'control/claude-home/rules/shipping.md', 's1\n')
    sh(f.ops, 'rm', '-q', 'control/claude-home/rules/shipping.md')
    sh(f.ops, 'commit', '-q', '-m', 'delete')
    commitFile(f, 'control/claude-home/rules/shipping.md', 's2\n')
    commitFile(f, 'scripts/review-status.mjs', 'r1\n')
    sh(f.clone, 'rm', '-q', 'scripts/review-status.mjs')
    sh(f.clone, 'commit', '-q', '-m', 'delete')
    commitFile(f, 'scripts/review-status.mjs', 'r2\n')
    const rule = join(f.home, '.claude', 'rules', 'shipping.md')
    const gate = join(f.home, '.ship-bot', 'app', 'gate-scripts', 'review-status.mjs')
    put(rule, 's2\n')
    put(gate, 'r2\n')
    assert.deepEqual(run(f).behind.filter((b) => b.tool === '~/.claude mirror' || b.tool === 'ship-bot gate scripts'), [], 'readable and current: nothing')
    chmodSync(rule, 0o000)
    chmodSync(gate, 0o000)
    try {
      const r = run(f)
      assert.deepEqual(r.behind.filter((b) => b.tool === '~/.claude mirror' || b.tool === 'ship-bot gate scripts'), [], 'no ahead item and no count')
      assert.ok(r.unread.includes('~/.claude/rules/shipping.md'), r.unread.join(' '))
      assert.ok(r.unread.includes('~/.ship-bot/app/gate-scripts/review-status.mjs'), r.unread.join(' '))
    } finally {
      chmodSync(rule, 0o644)
      chmodSync(gate, 0o644)
    }
  })
})

describe('the public-push guard install (plan row 1.30i): missing is drift, once main ships it', () => {
  const ship = (f, v) => {
    put(join(f.clone, 'scripts', 'claude-hooks', 'public-push-guard.mjs'), `// guard ${v}\n`)
    put(join(f.clone, 'scripts', 'privacy-guard.mjs'), `// privacy ${v}\n`)
    put(join(f.clone, 'scripts', 'claude-hooks', 'git-hooks', 'hook'), `#!/bin/sh\n# ${v}\n`)
    sh(f.clone, 'add', '-A')
    sh(f.clone, 'commit', '-q', '-m', `guard ${v}`)
    sh(f.clone, 'push', '-q', 'origin', 'main')
  }
  const dir = (f) => join(f.home, '.claude', 'git-hooks')
  const install = (f, v, { hooksPath = dir(f) } = {}) => {
    put(join(dir(f), 'public-push-guard.mjs'), `// guard ${v}\n`)
    put(join(dir(f), 'privacy-guard.mjs'), `// privacy ${v}\n`)
    put(join(dir(f), 'hook'), `#!/bin/sh\n# ${v}\n`, 0o755)
    rmSync(join(dir(f), 'pre-push'), { force: true })
    symlinkSync('hook', join(dir(f), 'pre-push'))
    writeFileSync(join(f.home, '.gitconfig'), `[core]\n\thooksPath = ${hooksPath}\n`)
  }
  const guard = (f) => run(f).behind.filter((b) => b.tool === 'public-push guard')

  it('expects nothing before main ships the guard', () => {
    const f = fixture()
    assert.deepEqual(guard(f), [])
    assert.equal(run(f).checked, 2)
  })

  it('a Mac with no install is flagged, naming every missing part', () => {
    const f = fixture()
    ship(f, 'g1')
    const [b, ...rest] = guard(f)
    assert.deepEqual(rest, [])
    assert.equal(b.behind, null)
    assert.ok(!b.ahead)
    assert.deepEqual(b.items, ['core.hooksPath', 'pre-push', 'public-push-guard.mjs', 'privacy-guard.mjs', 'hook'])
    assert.match(b.detail, /^not installed: /)
  })

  it('a current install is quiet, in either spelling of the path', () => {
    const f = fixture()
    ship(f, 'g1')
    install(f, 'g1')
    assert.deepEqual(guard(f), [])
    install(f, 'g1', { hooksPath: '~/.claude/git-hooks' })
    assert.deepEqual(guard(f), [])
  })

  it('a core.hooksPath that points elsewhere, or a pre-push that is not the dispatcher, is missing', () => {
    const f = fixture()
    ship(f, 'g1')
    install(f, 'g1', { hooksPath: join(f.home, 'other-hooks') })
    rmSync(join(dir(f), 'pre-push'))
    writeFileSync(join(dir(f), 'pre-push'), '#!/bin/sh\n')
    assert.deepEqual(guard(f).map((b) => b.items), [['core.hooksPath', 'pre-push']])
  })

  it('a copy left behind by a merge has its count, and a hand-edited one is ahead, never both in one entry', () => {
    const f = fixture()
    ship(f, 'g1')
    install(f, 'g1')
    ship(f, 'g2')
    const [b] = guard(f)
    assert.equal(b.behind, 1)
    assert.deepEqual(b.items, ['public-push-guard.mjs', 'privacy-guard.mjs', 'hook'])
    put(join(dir(f), 'hook'), '#!/bin/sh\n# edited\n', 0o755)
    const entries = guard(f)
    assert.deepEqual(entries.map((e) => [e.items, e.ahead ?? false]), [[['public-push-guard.mjs', 'privacy-guard.mjs'], false], [['hook'], true]])
  })
})
