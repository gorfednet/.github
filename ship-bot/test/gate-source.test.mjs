import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, rmSync } from 'node:fs'
import { unresolvedGateImports } from '../lib/gate-imports.mjs'
import { describe, it } from 'node:test'
import { INSTALLED_PATHS, resolveGateScripts } from '../lib/gate-source.mjs'
import { main } from '../ship-bot.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { FakeGitHub, TOKEN, makeRunner, repoEntry } from './fakes.mjs'

const SHA = 'a'.repeat(40)
const config = { scripts: { assertChecksStarted: '/clone/scripts/gates/assert-checks-started.mjs', reviewStatus: '/clone/scripts/review-status.mjs', checkClosingKeywords: '/clone/scripts/gates/check-closing-keywords.mjs' } }

/** A fake git over one clone at /clone: `head` and `main` are its refs, `dirty` its porcelain output. */
const fakeGit = ({ head = SHA, main = SHA, dirty = '', top = '/clone' } = {}) => (args) => {
  const cmd = args.slice(2).join(' ')
  if (cmd === 'rev-parse --show-toplevel') {
    if (!top) throw new Error('fatal: not a git repository')
    return top
  }
  if (cmd === 'rev-parse HEAD') return head
  if (cmd === 'rev-parse --verify refs/remotes/origin/main') return main
  if (cmd.startsWith('status --porcelain')) return dirty
  throw new Error(`unexpected git ${cmd}`)
}
const noCopy = { appDir: '/app', exists: () => false }

describe('plan row 1.12: where the gate scripts run from', () => {
  it('runs the installed copy whatever the config names, and never asks git', () => {
    const r = resolveGateScripts(config, { appDir: '/app', exists: () => true, readFile: () => `${SHA}\n`, git: () => assert.fail('no git with an installed copy') })
    assert.deepEqual(r.scripts, Object.fromEntries(Object.entries(INSTALLED_PATHS).map(([k, p]) => [k, `/app/gate-scripts/${p}`])))
    assert.equal(r.source, 'installed copy of aaaaaaa')
  })

  it('refuses an incomplete installed copy rather than falling back to the clone', () => {
    const r = resolveGateScripts(config, { appDir: '/app', exists: (p) => !p.endsWith('review-status.mjs'), readFile: () => SHA, git: fakeGit() })
    assert.equal(r.scripts, undefined)
    assert.match(r.problems.join('\n'), /incomplete .*reviewStatus: no file at \/app\/gate-scripts\/review-status\.mjs/)
    const bad = resolveGateScripts(config, { appDir: '/app', exists: () => true, readFile: () => 'main', git: fakeGit() })
    assert.match(bad.problems.join('\n'), /does not hold a commit sha/)
  })

  it('with no installed copy, runs the clone only when HEAD is origin/main and clean', () => {
    const r = resolveGateScripts(config, { ...noCopy, git: fakeGit() })
    assert.deepEqual(r.scripts, config.scripts)
    assert.equal(r.source, 'clone at origin/main')
  })

  it('fails closed on a clone switched to another branch', () => {
    const r = resolveGateScripts(config, { ...noCopy, git: fakeGit({ head: 'b'.repeat(40) }) })
    assert.equal(r.scripts, undefined)
    assert.match(r.problems.join('\n'), /HEAD bbbbbbb is not origin\/main aaaaaaa/)
  })

  it('fails closed on uncommitted changes, on a script outside git, and on unreadable refs', () => {
    assert.match(resolveGateScripts(config, { ...noCopy, git: fakeGit({ dirty: ' M scripts/review-status.mjs' }) }).problems.join('\n'), /uncommitted changes/)
    assert.match(resolveGateScripts(config, { ...noCopy, git: fakeGit({ top: '' }) }).problems.join('\n'), /is not in a git clone/)
    const noMain = (args) => {
      if (args.includes('--verify')) throw new Error('fatal: Needed a single revision')
      return fakeGit()(args)
    }
    assert.match(resolveGateScripts(config, { ...noCopy, git: noMain }).problems.join('\n'), /cannot read its git state/)
  })

  it('against a real clone: a branch switch is refused, origin/main is accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-bot-gates-'))
    // No global or system git config: a signing hook or template must not decide this test.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'scripts/gates'), { recursive: true })
    for (const f of ['scripts/gates/assert-checks-started.mjs', 'scripts/review-status.mjs', 'scripts/gates/check-closing-keywords.mjs']) writeFileSync(join(dir, f), '// gate\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const cfg = { scripts: { assertChecksStarted: join(dir, 'scripts/gates/assert-checks-started.mjs'), reviewStatus: join(dir, 'scripts/review-status.mjs'), checkClosingKeywords: join(dir, 'scripts/gates/check-closing-keywords.mjs') } }
    const realGit = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
    assert.ok(resolveGateScripts(cfg, { appDir: dir, git: realGit }).scripts)
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'scripts/review-status.mjs'), 'process.exit(0)\n')
    assert.match(resolveGateScripts(cfg, { appDir: dir, git: realGit }).problems.join('\n'), /uncommitted changes/)
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'always clean')
    assert.match(resolveGateScripts(cfg, { appDir: dir, git: realGit }).problems.join('\n'), /is not origin\/main/)
  })

  it('a refused pass reads no token, calls no GitHub and runs no gate, and exits 1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ship-bot-gs-'))
    const cfg = normalizeConfig({ live: true, stateDir: join(home, 'state'), sourceRoot: join(home, 'src'), scripts: { assertChecksStarted: 'a', reviewStatus: 'b', checkClosingKeywords: 'c' }, repos: [repoEntry({ envFiles: [] })] }, { home })
    const out = []
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'auth' ? { stdout: `${TOKEN}\n` } : undefined) })
    let github = 0
    const code = await main(['--live', '--once'], {
      loadConfig: () => cfg,
      gateScripts: () => ({ problems: ['/clone (scripts reviewStatus): HEAD bbbbbbb is not origin/main aaaaaaa'] }),
      makeGithub: () => (github += 1, new FakeGitHub()),
      runner,
      clock: { now: () => new Date('2026-10-09T12:00:00Z') },
      out: (l) => out.push(l),
      sleep: async () => {},
      baseEnv: {},
    })
    assert.equal(code, 1)
    assert.equal(github, 0)
    assert.equal(runner.calls.length, 0)
    assert.ok(out.some((l) => /error gate scripts refused: \/clone .*is not origin\/main/.test(l)), out.join('\n'))
    assert.ok(out.some((l) => /pass refused: nothing is checked, readied or merged/.test(l)))
  })

  it('the gate scripts install.sh copies resolve every import inside the copy; a missing lib file is caught', () => {
    const scripts = join(dirname(fileURLToPath(import.meta.url)), '../../scripts')
    const dir = mkdtempSync(join(tmpdir(), 'ship-bot-imports-'))
    mkdirSync(join(dir, 'gates'))
    cpSync(join(scripts, 'review-status.mjs'), join(dir, 'review-status.mjs'))
    for (const f of ['assert-checks-started.mjs', 'check-closing-keywords.mjs']) cpSync(join(scripts, 'gates', f), join(dir, 'gates', f))
    cpSync(join(scripts, 'lib'), join(dir, 'lib'), { recursive: true })
    assert.deepEqual(unresolvedGateImports(dir), [])
    rmSync(join(dir, 'lib/reviewVerdict.mjs'))
    assert.match(unresolvedGateImports(dir).join('\n'), /missing: .*lib\/reviewVerdict\.mjs/)
  })
})
