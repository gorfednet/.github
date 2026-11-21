/**
 * Plan row 1.30g: the public-push guard as a real git pre-push hook. Each world is installed through install-git-hooks.sh (a throwaway HOME and
 * global git config, a stub `gh` that answers the private list), so the hook under test is
 * the one a session gets: git runs it, whatever the shell spelling of the push.
 *
 * "GitHub" is a local bare repository reached through an insteadOf rewrite of a fake
 * github.com URL. Planted values are built at run time, from invented addresses and names,
 * so this public file holds none of them.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugOf } from '../scripts/claude-hooks/public-push-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = join(ROOT, 'scripts', 'claude-hooks', 'install-git-hooks.sh')

const IP = ['10', '20', '30', '40'].join('.') // an invented private-range address
const SECRET = 'gorfednet/' + 'secret-repo' // an invented private repository
const PRIVATE = 'gorfednet/' + 'hidden-app'
const PUBLIC = 'gorfednet/' + 'open-app'

const cleanups = []
let seq = 0
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), `pp-${prefix}-`))
  cleanups.push(d)
  return d
}
process.on('exit', () => cleanups.forEach((d) => rmSync(d, { recursive: true, force: true })))

const envOf = (w) => ({ ...process.env, HOME: w.dir, GIT_CONFIG_GLOBAL: w.cfg, GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', PATH: `${w.bin}:${process.env.PATH}`, GITHUB_ACTIONS: '', NODE_BIN: process.execPath })

function git(cwd, w, ...args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: envOf(w) })
}
function ok(cwd, w, ...args) {
  const r = git(cwd, w, ...args)
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** A world: global git config, a stub gh, and the hook installed. `listOut` is what gh prints, or FAIL. */
function world({ install = true, listOut = `gorfednet/ops\n${SECRET}\n${PRIVATE}\n` } = {}) {
  const dir = tmp('world')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${listOut === 'FAIL' ? 'exit 1' : `printf '%s' '${listOut}'`}\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  const w = { dir, bin, cfg: join(dir, 'gitconfig'), hooks: join(dir, 'git-hooks') }
  writeFileSync(w.cfg, '')
  if (install) {
    const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), INSTALL_REV: 'HEAD', GIT_HOOKS_DIR: w.hooks, AUDIT_ROOT: join(dir, 'none') } })
    assert.equal(r.status, 0, `install: ${r.stderr}`)
    w.install = r
  }
  return w
}

/** Install again with AUDIT_ROOT at the world's directory, after a test has put a hook in a clone: only a hook some clone has is linked. */
function reinstall(w) {
  const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), INSTALL_REV: 'HEAD', GIT_HOOKS_DIR: w.hooks, AUDIT_ROOT: w.dir } })
  assert.equal(r.status, 0, `reinstall: ${r.stderr}`)
}

/** A clone whose origin is a fake GitHub URL backed by a bare repository holding main; `outgoing` is committed on `feature`. */
function repo(w, { outgoing = { 'a.md': 'clean\n' }, slug = PUBLIC, remoteUrl = `https://github.com/${slug}.git`, baseFiles = {} } = {}) {
  const bare = join(w.dir, `remote-${(seq += 1)}.git`)
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: envOf(w) })
  if (remoteUrl.startsWith('https://')) writeFileSync(w.cfg, `${readFileSync(w.cfg, 'utf8')}[url "${bare}"]\n\tinsteadOf = ${remoteUrl}\n`)
  const dir = join(w.dir, `work-${seq}`)
  mkdirSync(dir)
  ok(dir, w, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  for (const [rel, body] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  ok(dir, w, 'add', '-A')
  ok(dir, w, 'commit', '-q', '-m', 'base')
  ok(dir, w, 'remote', 'add', 'origin', remoteUrl.startsWith('https://') ? remoteUrl : bare)
  ok(dir, w, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main') // setting up the fake remote is not a push under test
  ok(dir, w, 'checkout', '-q', '-b', 'feature')
  commit(dir, w, outgoing)
  return { dir, w, bare }
}

function commit(dir, w, files, message = 'work') {
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) {
      rmSync(join(dir, rel))
      continue
    }
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  ok(dir, w, 'add', '-A')
  ok(dir, w, 'commit', '-q', '--allow-empty', '-m', message)
}

const push = (r, ...args) => git(r.dir, r.w, 'push', ...args)
const remoteHas = (r, ref) => git(r.bare, r.w, 'rev-parse', '--verify', '-q', ref).status === 0
const refused = (x) => x.status !== 0 && /public-push-guard refused/.test(x.stderr)

describe('pre-push: a public remote is read, and a private one is never refused', () => {
  it('refuses a planted private address, sends nothing, and never prints the value', () => {
    const r = repo(world(), { outgoing: { 'docs/note.md': `see ${IP}\n` } })
    const x = push(r, '-u', 'origin', 'feature')
    assert.ok(refused(x), x.stderr)
    assert.match(x.stderr, /private-ip/)
    assert.ok(!x.stderr.includes(IP), 'the value was repeated')
    assert.ok(!remoteHas(r, 'refs/heads/feature'), 'the branch was sent')
  })

  it('passes the same commit on a private remote', () => {
    const r = repo(world(), { slug: PRIVATE, outgoing: { 'docs/note.md': `see ${IP}\n` } })
    const x = push(r, '-u', 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    assert.ok(remoteHas(r, 'refs/heads/feature'))
  })

  it('passes a clean push to a public remote', () => {
    const r = repo(world())
    const x = push(r, '-u', 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    assert.ok(remoteHas(r, 'refs/heads/feature'))
  })

  it('does not take a private url for a different push URL: a public mirror added to a private clone is read', () => {
    const r = repo(world(), { slug: PRIVATE, outgoing: { 'x.md': `${IP}\n` } })
    const mirror = join(r.w.dir, 'mirror.git')
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', mirror], { env: envOf(r.w) })
    writeFileSync(r.w.cfg, `${readFileSync(r.w.cfg, 'utf8')}[url "${mirror}"]\n\tinsteadOf = https://github.com/${PUBLIC}-mirror.git\n`)
    ok(r.dir, r.w, 'remote', 'set-url', '--add', '--push', 'origin', `https://github.com/${PRIVATE}.git`)
    ok(r.dir, r.w, 'remote', 'set-url', '--add', '--push', 'origin', `https://github.com/${PUBLIC}-mirror.git`)
    ok(r.dir, r.w, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main:main') // seed the mirror
    const x = push(r, 'origin', 'feature')
    assert.ok(refused(x), x.stderr)
    assert.ok(!remoteHas({ bare: mirror, w: r.w }, 'refs/heads/feature'))
  })

  it('survives a stale list when gh is down: the list stands, nothing crashes, a private push passes', () => {
    const w = world()
    const r = repo(w, { slug: PRIVATE, outgoing: { 'x.md': `${IP}\n` } })
    writeFileSync(join(w.bin, 'gh'), '#!/bin/sh\nexit 1\n')
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    utimesSync(join(w.hooks, 'private-repos.txt'), old, old)
    assert.equal(push(r, 'origin', 'feature').status, 0)
    assert.equal(push(r, 'origin', 'feature').status, 0, 'and again, with the retry pushed an hour out')
  })

  it('counts a remote it has no entry for as public: it is read, not waved through like a local path', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
    const sha = ok(r.dir, r.w, 'rev-parse', 'HEAD').trim()
    const x = spawnSync('node', [join(r.w.hooks, 'public-push-guard.mjs'), 'origin', 'ssh://git@git.example.test/elsewhere.git'], { cwd: r.dir, input: `refs/heads/feature ${sha} refs/heads/feature ${'0'.repeat(40)}\n`, encoding: 'utf8', env: envOf(r.w) })
    assert.equal(x.status, 1, x.stderr)
    assert.match(x.stderr, /public-push-guard refused/)
  })

  it('refuses a private repository name from the list, a session id and a tailnet name', () => {
    for (const [text, rule] of [[`see ${SECRET}\n`, 'private-repo'], [`${'local' + '_'}0123abcd-4567-89ab-cdef-0123456789ab\n`, 'session-id'], [`host.tail1234.${'ts' + '.net'}\n`, 'tailnet-name']]) {
      const r = repo(world(), { outgoing: { 'x.md': text } })
      const x = push(r, 'origin', 'feature')
      assert.ok(refused(x), `${rule}: ${x.stderr}`)
      assert.match(x.stderr, new RegExp(rule))
    }
  })

  it('reads history: a value added in one commit and removed in the next', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
    commit(r.dir, r.w, { 'x.md': null })
    assert.ok(refused(push(r, 'origin', 'feature')))
  })

  it('reads a commit message', () => {
    const r = repo(world())
    commit(r.dir, r.w, {}, `note ${IP}`)
    assert.ok(refused(push(r, 'origin', 'feature')))
  })

  it('reads only what is outgoing: a pushed commit is not read again, and merging main adds nothing', () => {
    const r = repo(world())
    assert.equal(push(r, 'origin', 'feature').status, 0)
    ok(r.dir, r.w, 'checkout', '-q', 'main')
    commit(r.dir, r.w, { 'main.md': 'on main\n' }, 'main moves')
    ok(r.dir, r.w, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main')
    ok(r.dir, r.w, 'checkout', '-q', 'feature')
    ok(r.dir, r.w, 'merge', '-q', '--no-edit', 'main') // two published bases: feature's last push and main
    assert.equal(push(r, 'origin', 'feature').status, 0)
  })

  it('refuses a branch name that holds a value', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'branch', `fix-${IP}`)
    const x = push(r, 'origin', `fix-${IP}`)
    assert.ok(refused(x), x.stderr)
    assert.ok(!x.stderr.includes(IP))
  })

  it('lets a delete through: it carries no commits', () => {
    const r = repo(world())
    assert.equal(push(r, 'origin', 'feature').status, 0)
    assert.equal(push(r, 'origin', ':feature').status, 0)
    assert.ok(!remoteHas(r, 'refs/heads/feature'))
  })
})

describe('pre-push: tags and --mirror are read', () => {
  it('refuses an annotated tag whose message holds a value, though its commit is clean', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'tag', '-a', 'v1', '-m', `release on ${IP}`)
    const x = push(r, 'origin', 'v1')
    assert.ok(refused(x) && /tag v1/.test(x.stderr), x.stderr)
    assert.ok(!remoteHas(r, 'refs/tags/v1'))
  })

  it('reads a tag message when the push names the tag object by sha, or the tag points at another tag', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'tag', '-a', 'inner', '-m', `on ${IP}`)
    ok(r.dir, r.w, 'tag', '-a', 'outer', '-m', 'clean', 'inner')
    const sha = ok(r.dir, r.w, 'rev-parse', 'inner').trim()
    assert.ok(refused(push(r, 'origin', `${sha}:refs/tags/v1`)), 'by sha')
    assert.ok(refused(push(r, 'origin', 'outer')), 'a tag of a tag')
  })

  it('reads the names and tag messages of every ref, not only the first', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'tag', 'v0', 'main')
    ok(r.dir, r.w, 'tag', '-a', 'v9', '-m', `on ${IP}`)
    assert.ok(refused(push(r, 'origin', 'v0', 'v9')))
  })

  it('refuses a lightweight tag on an unpushed commit that holds a value', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
    ok(r.dir, r.w, 'tag', 'v2')
    assert.ok(refused(push(r, 'origin', 'v2')))
    assert.ok(refused(push(r, '--tags', 'origin')))
  })

  it('passes a tag on a commit the remote already holds', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
    ok(r.dir, r.w, 'tag', 'v3', 'main')
    assert.equal(push(r, 'origin', 'v3').status, 0)
  })

  it('reads every ref of a --mirror push, not just the current branch', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
    ok(r.dir, r.w, 'checkout', '-q', 'main')
    const x = push(r, '--mirror', 'origin')
    assert.ok(refused(x), x.stderr)
    assert.ok(!remoteHas(r, 'refs/heads/feature'))
  })

  it('reads every ref in one push, whichever order a bad one comes in', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } }) // feature is bad
    ok(r.dir, r.w, 'checkout', '-q', '-b', 'clean-one', 'main')
    commit(r.dir, r.w, { 'ok.md': 'fine\n' })
    assert.ok(refused(push(r, 'origin', 'clean-one', 'feature')), 'bad ref second')
    assert.ok(refused(push(r, 'origin', 'feature', 'clean-one')), 'bad ref first')
    assert.ok(!remoteHas(r, 'refs/heads/clean-one'), 'nothing of the push was sent')
    assert.ok(refused(push(r, '--all', 'origin')), '--all')
  })

  it('passes a clean --mirror push, and --all', () => {
    const r = repo(world())
    assert.equal(push(r, '--mirror', 'origin').status, 0, 'mirror')
    commit(r.dir, r.w, { 'b.md': 'more\n' })
    assert.equal(push(r, '--all', 'origin').status, 0, 'all')
  })
})

describe('pre-push: everyday commands pass, whatever the shell spelling', () => {
  const sh = (r, script) => spawnSync('/bin/bash', ['-c', script], { cwd: r.dir, encoding: 'utf8', env: envOf(r.w) })
  const cases = {
    'a commit then a push': 'git -c user.name=t -c user.email=t@example.test commit -q --allow-empty -m x && git push -u origin feature',
    'a push piped to tail': 'git push -u origin feature 2>&1 | tail -3',
    'a push with a trailing comment': 'git push -u origin feature # ship it',
    'a push from another directory': 'cd / && git -C "$PWD_R" push -u origin feature',
    'a push with an environment prefix': 'FOO=1 git push -u origin feature',
    'a push in a command substitution': 'echo "$(git push -u origin feature 2>&1)"',
    'a push of HEAD': 'git push -u origin HEAD',
  }
  for (const [name, script] of Object.entries(cases)) {
    it(`passes ${name}`, () => {
      const r = repo(world())
      const x = sh(r, script.replace('$PWD_R', r.dir))
      assert.equal(x.status, 0, `${script}: ${x.stderr}`)
      assert.ok(remoteHas(r, 'refs/heads/feature'))
    })
  }

  it('refuses the same spellings when the push carries a planted value', () => {
    for (const script of ['git push -u origin feature 2>&1 | tail -3; test ${PIPESTATUS[0]} -eq 0', 'git push -u origin HEAD', 'FOO=1 git push origin feature']) {
      const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
      assert.notEqual(sh(r, script).status, 0, script)
      assert.ok(!remoteHas(r, 'refs/heads/feature'), script)
    }
  })

  it('works from a linked worktree', () => {
    const r = repo(world())
    const wt = join(r.w.dir, 'linked')
    ok(r.dir, r.w, 'worktree', 'add', '-q', '-b', 'wt', wt)
    assert.equal(git(wt, r.w, 'push', 'origin', 'wt').status, 0)
    assert.equal(git(r.dir, r.w, 'push', 'origin', 'feature').status, 0)
  })

  it('does not trust a tracking ref: a clone repointed at a public remote still has its commits read', () => {
    const r = repo(world(), { outgoing: { 'x.md': `${IP}\n` } })
    ok(r.dir, r.w, 'update-ref', 'refs/remotes/origin/feature', 'HEAD') // claims the remote holds a commit it does not
    assert.ok(refused(push(r, 'origin', 'feature')))
  })

  it('refuses when it cannot ask the remote what it holds', () => {
    const r = repo(world())
    const sha = ok(r.dir, r.w, 'rev-parse', 'HEAD').trim()
    const x = spawnSync('node', [join(r.w.hooks, 'public-push-guard.mjs'), 'origin', 'ssh://git@git.example.test/gone.git'], {
      cwd: r.dir,
      input: `refs/heads/feature ${sha} refs/heads/feature ${'0'.repeat(40)}\n`,
      encoding: 'utf8',
      env: envOf(r.w),
    })
    assert.equal(x.status, 1)
    assert.match(x.stderr, /ls-remote failed/)
  })
})

describe('pre-push: it fails closed once the remote is public, and chains to the repository hook', () => {
  it('refuses when the private list is missing, empty or its guard script is gone', () => {
    for (const [what, wreck] of [['missing list', (w) => rmSync(join(w.hooks, 'private-repos.txt'))], ['empty list', (w) => writeFileSync(join(w.hooks, 'private-repos.txt'), '')], ['no guard', (w) => rmSync(join(w.hooks, 'privacy-guard.mjs'))]]) {
      const w = world()
      const r = repo(w)
      wreck(w)
      const x = push(r, 'origin', 'feature')
      assert.ok(x.status !== 0 && /public-push-guard/.test(x.stderr), `${what}: ${x.stderr}`)
      assert.ok(!remoteHas(r, 'refs/heads/feature'), what)
    }
  })

  it("runs a local repository's receive-side hooks, which a global hooksPath would otherwise hide", () => {
    const r = repo(world())
    const hook = join(r.bare, 'hooks', 'update')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    const x = push(r, 'origin', 'feature')
    assert.notEqual(x.status, 0, x.stderr)
    assert.ok(!remoteHas(r, 'refs/heads/feature'))
  })

  it('refuses a push that has no published commit to diff against', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'checkout', '-q', '--orphan', 'fresh')
    commit(r.dir, r.w, { 'y.md': 'x\n' })
    const x = push(r, 'origin', 'fresh')
    assert.ok(x.status !== 0 && /no published ancestor/.test(x.stderr), x.stderr)
  })

  it("runs the repository's own pre-push hook after the guard, with the same input, and honours its refusal", () => {
    const r = repo(world())
    const log = join(r.w.dir, 'own.log')
    const hook = join(r.dir, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, `#!/bin/sh\necho "$1" >> "${log}"\ncat >> "${log}"\nexit 0\n`)
    chmodSync(hook, 0o755)
    assert.equal(push(r, 'origin', 'feature').status, 0)
    assert.match(readFileSync(log, 'utf8'), /refs\/heads\/feature [0-9a-f]{40} refs\/heads\/feature /)
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    commit(r.dir, r.w, { 'c.md': 'more\n' })
    assert.notEqual(push(r, 'origin', 'feature').status, 0, 'the repository hook refused')
  })

  it("still runs the repository's other hooks, which a global hooksPath would otherwise hide", () => {
    const r = repo(world())
    const hook = join(r.dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    reinstall(r.w)
    assert.notEqual(git(r.dir, r.w, 'commit', '--allow-empty', '-m', 'x').status, 0)
  })
})

// Remote fixtures are built at runtime so the source holds no email-shaped text.
const at = (u) => u.replace(/#/g, '@')

describe('slugOf: only a GitHub host gives a slug', () => {
  it('reads the three real forms, with userinfo, a port, .git or a trailing slash', () => {
    assert.equal(slugOf(at('git#github.com:Owner/Repo.git')), 'owner/repo')
    assert.equal(slugOf('github.com:owner/repo'), 'owner/repo')
    assert.equal(slugOf(at('ssh://git#github.com/owner/repo.git')), 'owner/repo')
    assert.equal(slugOf(at('ssh://git#github.com:22/owner/repo')), 'owner/repo')
    assert.equal(slugOf(at('ssh://git#ssh.github.com:443/owner/repo.git')), 'owner/repo')
    assert.equal(slugOf('https://github.com/owner/repo'), 'owner/repo')
    assert.equal(slugOf('https://GitHub.com/owner/repo.git/'), 'owner/repo')
    assert.equal(slugOf(at('https://user:tok#github.com:443/owner/repo.git')), 'owner/repo')
  })

  it('gives null for another host, whichever way github.com appears in the URL', () => {
    for (const u of [
      'https://evilgithub.com/owner/repo',
      'https://gitlab.com/github.com/owner/repo.git',
      'https://github.com.evil.example/owner/repo',
      at('https://github.com#evil.example/owner/repo.git'),
      at('git#evilgithub.com:owner/repo.git'),
      at('git#gitlab.com:github.com/owner/repo.git'),
      at('ssh://git#gitlab.com/github.com:owner/repo.git'),
      'https://example.test/?u=github.com/owner/repo',
      // Plan row 1.30h: userinfo holds no fragment, query or backslash, so the host is the one before them.
      'https://evil.example#' + '@github.com/o/r',
      'https://evil.example?' + '@github.com/o/r',
      'https://evil.example\\' + '@github.com/o/r',
    ]) assert.equal(slugOf(u), null, u)
  })

  it('reads a push to a private name on another host, so the remote is scanned, not skipped', () => {
    for (const remoteUrl of [`https://evilgithub.com/${PRIVATE}.git`, `https://gitlab.com/github.com/${PRIVATE}.git`]) {
      const r = repo(world(), { remoteUrl, outgoing: { 'docs/note.md': `see ${IP}\n` } })
      // git would hand the hook the rewritten (local) URL here, so run the hook with the URL the push names.
      const sha = ok(r.dir, r.w, 'rev-parse', 'HEAD').trim()
      const x = spawnSync(process.execPath, [join(r.w.hooks, 'public-push-guard.mjs'), 'origin', remoteUrl], { cwd: r.dir, encoding: 'utf8', env: envOf(r.w), input: `refs/heads/feature ${sha} refs/heads/feature ${'0'.repeat(40)}\n` })
      assert.ok(refused(x), `${remoteUrl}: ${x.stderr}`)
      assert.match(x.stderr, /private-ip/, remoteUrl)
    }
  })
})

describe('install-git-hooks.sh', () => {
  it('refuses to replace a global core.hooksPath that points elsewhere, and writes nothing', () => {
    const w = world({ install: false })
    writeFileSync(w.cfg, '[core]\n\thooksPath = /somewhere/else\n')
    const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), INSTALL_REV: 'HEAD', GIT_HOOKS_DIR: w.hooks } })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /already/)
    assert.ok(!existsSync(w.hooks))
  })

  it('stops, without setting the path, when gh cannot list the private repositories', () => {
    const w = world({ install: false, listOut: 'FAIL' })
    const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), INSTALL_REV: 'HEAD', GIT_HOOKS_DIR: w.hooks } })
    assert.notEqual(r.status, 0)
    assert.equal(git(w.dir, w, 'config', '--global', '--get', 'core.hooksPath').status, 1)
  })

  it('reports a clone that sets its own core.hooksPath, since that skips the global hook', () => {
    const w = world({ install: false })
    const root = join(w.dir, 'clones')
    const clone = join(root, 'husky-app')
    mkdirSync(clone, { recursive: true })
    ok(clone, w, 'init', '-q')
    ok(clone, w, 'config', '--local', 'core.hooksPath', '.husky')
    const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), INSTALL_REV: 'HEAD', GIT_HOOKS_DIR: w.hooks, AUDIT_ROOT: root } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /husky-app\/\.git \.husky/)
  })
})

const ALLOW = (name) => ({ '.github/privacy-guard-allow.txt': `repo ${name}\n` })
const SECRET_NAME = SECRET.split('/')[1]

describe("pre-push: the target repository's allowlist, as the CI guard reads it", () => {
  it('lets a branch name hold a private name the base allowlist clears, and refuses it without the line', () => {
    const named = (extra) => {
      const r = repo(world(), extra)
      ok(r.dir, r.w, 'branch', `notes/${SECRET}`)
      return push(r, 'origin', `notes/${SECRET}`)
    }
    assert.equal(named({ baseFiles: ALLOW(SECRET_NAME) }).status, 0)
    assert.ok(refused(named({ baseFiles: ALLOW('some-other') })), 'a line for another name clears nothing')
  })

  it('reads the allowlist from the published base, so the pushed change cannot clear itself', () => {
    const r = repo(world(), { outgoing: { '.github/privacy-guard-allow.txt': `repo ${SECRET_NAME}\n` } })
    ok(r.dir, r.w, 'branch', `notes/${SECRET}`)
    assert.ok(refused(push(r, 'origin', `notes/${SECRET}`)))
  })
})

describe("pre-push: the allowlist is the remote default branch's tip, as it is now", () => {
  const ALLOW_FILE = '.github/privacy-guard-allow.txt'
  /** Another clone puts a file on the remote's main, so this clone's tracking refs are behind. */
  const advanceMain = (r, files) => {
    const other = join(r.w.dir, `other-${(seq += 1)}`)
    ok(r.w.dir, r.w, '-c', 'core.hooksPath=/dev/null', 'clone', '-q', r.bare, other)
    commit(other, r.w, files, 'allowlist')
    ok(other, r.w, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'HEAD:main')
  }

  for (const [kind, line, planted] of [
    ['repo', `repo ${SECRET_NAME}`, `see ${SECRET}\n`],
    ['path', 'path docs/** private-ip', `see ${IP}\n`],
  ]) {
    // A `repo` line names a private repository, so the guard refuses the push that adds it: only a path line can ride a first push.
    if (kind === 'path') {
      it(`a ${kind} line pushed to a branch exempts nothing in the next push: only the default branch counts`, () => {
        const r = repo(world(), { outgoing: { [ALLOW_FILE]: `${line}\n` } })
        const first = push(r, '-u', 'origin', 'feature')
        assert.equal(first.status, 0, first.stderr)
        const sent = ok(r.dir, r.w, 'rev-parse', 'feature').trim()
        commit(r.dir, r.w, { 'docs/n.md': planted })
        const x = push(r, 'origin', 'feature')
        assert.ok(refused(x), x.stderr)
        assert.equal(ok(r.bare, r.w, 'rev-parse', 'feature').trim(), sent, 'the second push was not sent')
      })
    }

    it(`a ${kind} line main gained after this branch was cut still applies`, () => {
      const r = repo(world(), { outgoing: { 'docs/n.md': planted } })
      advanceMain(r, { [ALLOW_FILE]: `${line}\n` })
      const x = push(r, '-u', 'origin', 'feature')
      assert.equal(x.status, 0, x.stderr)
      assert.ok(remoteHas(r, 'refs/heads/feature'))
    })
  }
})

describe('pre-push: a `site` line makes the name count as said', () => {
  const SITE = 'example-music.com'
  const world2 = () => world({ listOut: `gorfednet/ops\ngorfednet/${SITE}\n` })
  const base = { '.github/privacy-guard-allow.txt': `site ${SITE}\n` }
  it('lets a README link to the site through the installed hook, and refuses it without the line', () => {
    const body = { 'README.md': `Music: https://${SITE}/\n` }
    const r = repo(world2(), { baseFiles: base, outgoing: body })
    const x = push(r, '-u', 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    assert.ok(refused(push(repo(world2(), { outgoing: body }), '-u', 'origin', 'feature')), 'without the site line the name is watched')
  })
  it('lets the first push carry the site line and the README link together, and refuses the link in a push without the line', () => {
    const body = { '.github/privacy-guard-allow.txt': `site ${SITE}\n`, 'README.md': `Music: [listen](https://${SITE}/)\n` }
    const x = push(repo(world2(), { outgoing: body }), '-u', 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    for (const bad of [`see gorfednet/${SITE}\n`, `Private project: https://${SITE}/\n`, `The repo ${SITE} holds it\n`]) {
      const r = repo(world2(), { outgoing: { ...body, 'README.md': bad } })
      assert.ok(refused(push(r, '-u', 'origin', 'feature')), bad)
    }
  })
  it('still refuses the repository form and a line that says private', () => {
    for (const body of [`see gorfednet/${SITE}\n`, `Private project: https://${SITE}/\n`]) {
      const r = repo(world2(), { baseFiles: base, outgoing: { 'docs/n.md': body } })
      assert.ok(refused(push(r, '-u', 'origin', 'feature')), body)
    }
  })

  // The installed hook is a copy of the committed tree, so this reads the working-tree module
  // itself: loadGuard decides what a branch or tag name is read for, and the clause under test is in it.
  it('loadGuard counts a site-listed name as said: a branch named for it is not read', async () => {
    const w = world({ install: false })
    const dir = join(w.dir, 'loadguard')
    mkdirSync(dir)
    ok(dir, w, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), 'hello\n') // the base never says the name
    ok(dir, w, 'add', '-A')
    ok(dir, w, 'commit', '-q', '-m', 'base')
    const head = ok(dir, w, 'rev-parse', 'HEAD').trim()
    const was = [process.cwd(), process.env.PUBLIC_PUSH_GUARD_SCRIPT]
    process.env.PUBLIC_PUSH_GUARD_SCRIPT = join(ROOT, 'scripts', 'privacy-guard.mjs')
    try {
      const mod = await import(`../scripts/claude-hooks/public-push-guard.mjs?loadguard=${(seq += 1)}`)
      process.chdir(dir)
      const read = async (allowText) => {
        const { mod: g, ctx } = await mod.loadGuard(new Set([`gorfednet/${SITE}`]), allowText, head)
        return ['path', 'word'].some((m) => g.scanText(`refs/heads/notes/${SITE}`, ctx, ['private-repo'], m).length > 0)
      }
      assert.equal(await read(`site ${SITE}\n`), false, 'listed as a site: said')
      assert.equal(await read(''), true, 'not listed and never said: read')
    } finally {
      process.chdir(was[0])
      if (was[1] === undefined) delete process.env.PUBLIC_PUSH_GUARD_SCRIPT
      else process.env.PUBLIC_PUSH_GUARD_SCRIPT = was[1]
    }
  })
})

describe('pre-push: the public sites in the installed fleet.json count as said in every repository', () => {
  const SITE = 'example-site.org'
  const world3 = (fleet = { projects: [{ slug: `gorfednet/${SITE}` }, { slug: 'gorfednet/plain-tool' }] }) => {
    const w = world({ listOut: `gorfednet/ops\ngorfednet/${SITE}\ngorfednet/plain-tool\n` })
    // null: no installed copy at all (an older install). The installer put the real one there, so take it away.
    if (fleet === null) rmSync(join(w.hooks, 'fleet.json'))
    else writeFileSync(join(w.hooks, 'fleet.json'), typeof fleet === 'string' ? fleet : JSON.stringify(fleet))
    return w
  }
  const body = (text) => ({ 'README.md': text })
  it('installs fleet.json beside the guard', () => {
    assert.ok(existsSync(join(world().hooks, 'fleet.json')))
  })
  it('lets a README link to a fleet site with no site line in the repository, and refuses it once the fleet lacks it', () => {
    const x = push(repo(world3(), { outgoing: body(`Visit https://${SITE}/\n`) }), '-u', 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    // The deliberate break: an installed fleet without the site, or none at all, and the same push is refused.
    assert.ok(refused(push(repo(world3({ projects: [{ slug: 'gorfednet/other-site.org' }] }), { outgoing: body(`Visit https://${SITE}/\n`) }), '-u', 'origin', 'feature')))
    assert.ok(refused(push(repo(world3(null), { outgoing: body(`Visit https://${SITE}/\n`) }), '-u', 'origin', 'feature')))
  })
  it('still refuses the repository form, a line that says private, and a near-miss name', () => {
    for (const text of [`see gorfednet/${SITE}\n`, `Private project: https://${SITE}/\n`]) {
      assert.ok(refused(push(repo(world3(), { outgoing: body(text) }), '-u', 'origin', 'feature')), text)
    }
    // A private repository whose name only resembles a fleet site, and a fleet tool with no domain, stay watched.
    const near = () => {
      const w = world({ listOut: 'gorfednet/ops\ngorfednet/example-sites.org\ngorfednet/plain-tool\n' })
      writeFileSync(join(w.hooks, 'fleet.json'), JSON.stringify({ projects: [{ slug: `gorfednet/${SITE}` }, { slug: 'gorfednet/plain-tool' }] }))
      return w
    }
    for (const text of ['Visit example-sites.org now\n', 'Visit plain-tool now\n']) {
      assert.ok(refused(push(repo(near(), { outgoing: body(text) }), '-u', 'origin', 'feature')), text)
    }
  })
  it('with no installed fleet.json, never reads the pushed repository\'s own fleet.json', () => {
    // An older install. The pushed base holds a fleet.json of another shape: it must not be read (it would stop the push).
    const odd = { 'fleet.json': '{"x":1}\n' }
    const x = push(repo(world3(null), { baseFiles: odd, outgoing: body('clean\n') }), '-u', 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
  })
  it('refuses the push when the installed fleet.json is broken', () => {
    assert.ok(refused(push(repo(world3('not json'), { outgoing: body('clean\n') }), '-u', 'origin', 'feature')))
  })
})

describe('pre-push: bare private names in ref names and tag messages', () => {
  const BARE = SECRET.split('/')[1]
  const OPEN = PUBLIC.split('/')[1]

  it('refuses an annotated tag whose message names a private repository bare', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'tag', '-a', 'v1', '-m', `notes on ${BARE} work`)
    const x = push(r, 'origin', 'v1')
    assert.ok(refused(x) && /tag v1/.test(x.stderr), x.stderr)
    assert.ok(!remoteHas(r, 'refs/tags/v1'))
  })

  it('refuses a branch whose name holds a private repository name as a path part', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'checkout', '-q', '-b', `notes/${BARE}`)
    const x = push(r, 'origin', `notes/${BARE}`)
    assert.ok(refused(x) && /branch or tag name/.test(x.stderr), x.stderr)
    assert.ok(!remoteHas(r, `refs/heads/notes/${BARE}`))
  })

  it('passes a public repository name, and a private name the remote default branch already says', () => {
    const r = repo(world(), { baseFiles: { 'docs/a.md': `${BARE} is a site\n` } })
    ok(r.dir, r.w, 'tag', '-a', 'v1', '-m', `${OPEN} and ${BARE} work`)
    ok(r.dir, r.w, 'checkout', '-q', '-b', `notes/${BARE}`)
    ok(r.dir, r.w, 'checkout', '-q', '-b', `notes/${OPEN}`)
    assert.equal(push(r, 'origin', 'v1').status, 0, 'tag')
    assert.equal(push(r, 'origin', `notes/${OPEN}`).status, 0, 'public branch name')
    assert.equal(push(r, 'origin', `notes/${BARE}`).status, 0, 'a said name in a branch name')
  })

  // Plan row 1.30h: the near misses on each side of the line.
  it('refuses a private name joined by an underscore, which path parts alone do not split on, and one with an extension words alone miss', () => {
    const r = repo(world())
    for (const branch of [`notes/${BARE}_v2`, `OLD_${BARE}`, `notes/${BARE}.bak`]) {
      ok(r.dir, r.w, 'branch', branch)
      const x = push(r, 'origin', branch)
      assert.ok(refused(x) && /branch or tag name/.test(x.stderr), `${branch}: ${x.stderr}`)
      assert.ok(!remoteHas(r, `refs/heads/${branch}`), branch)
    }
  })

  it('passes a hyphen-joined private name: a longer name is another name, as in the CI guard', () => {
    const r = repo(world())
    for (const branch of [`notes/${BARE}-v2`, `fix-${BARE}`]) {
      ok(r.dir, r.w, 'branch', branch)
      const x = push(r, 'origin', branch)
      assert.equal(x.status, 0, `${branch}: ${x.stderr}`)
    }
  })

  it('refuses a branch named after a private repository plus a slash, on a remote that has never named it, and passes it once the default branch says it', () => {
    const fresh = repo(world())
    ok(fresh.dir, fresh.w, 'branch', `${BARE}/fix`)
    const x = push(fresh, 'origin', `${BARE}/fix`)
    assert.ok(refused(x) && /branch or tag name/.test(x.stderr), x.stderr)
    const said = repo(world(), { baseFiles: { 'docs/a.md': `${BARE} is a site\n` } })
    ok(said.dir, said.w, 'branch', `${BARE}/fix`)
    assert.equal(push(said, 'origin', `${BARE}/fix`).status, 0)
  })

  it('refuses a said name in a tag message on a line that says private, and passes it on a line that does not', () => {
    const r = repo(world(), { baseFiles: { 'docs/a.md': `${BARE} is a site\n` } })
    ok(r.dir, r.w, 'tag', '-a', 'v1', '-m', `${BARE} work`)
    ok(r.dir, r.w, 'tag', '-a', 'v2', '-m', `${BARE} is private now`)
    assert.equal(push(r, 'origin', 'v1').status, 0, 'said, no private')
    const x = push(r, 'origin', 'v2')
    assert.ok(refused(x) && /message of tag v2/.test(x.stderr), x.stderr)
  })

  it("reads the tag object's own name, which a push under another ref name still publishes", () => {
    const r = repo(world())
    for (const name of [`notes/${BARE}`, `${BARE}_rc`]) {
      ok(r.dir, r.w, 'tag', '-a', name, '-m', 'clean')
      const x = push(r, 'origin', `refs/tags/${name}:refs/tags/v7`)
      assert.ok(refused(x) && /name inside tag v7/.test(x.stderr), `${name}: ${x.stderr}`)
      assert.ok(!remoteHas(r, 'refs/tags/v7'), name)
    }
    ok(r.dir, r.w, 'tag', '-a', `${BARE}_inner`, '-m', 'clean')
    ok(r.dir, r.w, 'tag', '-a', 'outer', '-m', 'clean', `${BARE}_inner`)
    const inner = push(r, 'origin', 'refs/tags/outer:refs/tags/v9')
    assert.ok(refused(inner) && /name inside tag v9/.test(inner.stderr), `a named tag under a clean one: ${inner.stderr}`)
    ok(r.dir, r.w, 'tag', '-a', `${BARE}-rc`, '-m', 'clean')
    assert.equal(push(r, 'origin', `refs/tags/${BARE}-rc:refs/tags/v8`).status, 0, 'a hyphen-joined name in the header passes')
  })
})

describe('pre-push: a tag chain is read to its end', () => {
  it('refuses a chain of more than 20 tags rather than leave the rest unread, and passes one of 20', () => {
    const r = repo(world())
    ok(r.dir, r.w, 'tag', '-a', 't1', '-m', 'clean')
    for (let i = 2; i <= 21; i += 1) ok(r.dir, r.w, 'tag', '-a', `t${i}`, '-m', 'clean', `t${i - 1}`)
    assert.equal(push(r, 'origin', 'refs/tags/t20:refs/tags/t20').status, 0, '20 deep')
    const x = push(r, 'origin', 'refs/tags/t21:refs/tags/t21')
    assert.ok(refused(x) && /more than 20 tags/.test(x.stderr), x.stderr)
  })
})

describe('pre-push: a push that publishes nothing, or goes to a repository made since the list was cut', () => {
  it('lets a local path remote through, planted value and all', () => {
    const r = repo(world(), { remoteUrl: 'local', outgoing: { 'x.md': `${IP}\n` } })
    const x = push(r, 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    assert.ok(remoteHas(r, 'refs/heads/feature'))
  })

  it('passes a push to a local path when the private list is missing', () => {
    const w = world()
    const r = repo(w, { remoteUrl: 'local', outgoing: { 'x.md': `${IP}\n` } })
    rmSync(join(w.hooks, 'private-repos.txt'))
    const x = push(r, 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
    assert.ok(remoteHas(r, 'refs/heads/feature'))
  })

  it('does not read a slug out of a local path that ends in github.com/<owner>/<name>.git', () => {
    const w = world()
    const r = repo(w, { remoteUrl: 'local', outgoing: { 'x.md': `${IP}\n` } })
    const lookalike = join(w.dir, 'github.com', 'gorfednet', 'lookalike.git')
    mkdirSync(dirname(lookalike), { recursive: true })
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', lookalike], { env: envOf(w) })
    ok(r.dir, w, 'remote', 'set-url', 'origin', lookalike)
    ok(r.dir, w, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main')
    const x = push(r, 'origin', 'feature')
    assert.equal(x.status, 0, x.stderr)
  })

  /** A clone whose remote is an empty bare repository behind a fake GitHub URL for `slug`. */
  const firstPush = (w, slug) => {
    const bare = join(w.dir, `empty-${(seq += 1)}.git`)
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: envOf(w) })
    writeFileSync(w.cfg, `${readFileSync(w.cfg, 'utf8')}[url "${bare}"]\n\tinsteadOf = https://github.com/${slug}.git\n`)
    const dir = join(w.dir, `first-${seq}`)
    mkdirSync(dir)
    ok(dir, w, 'init', '-q', '-b', 'main')
    commit(dir, w, { 'x.md': `${IP}\n` })
    ok(dir, w, 'remote', 'add', 'origin', `https://github.com/${slug}.git`)
    return { dir, w, bare }
  }
  const listing = (w, ...slugs) => writeFileSync(join(w.bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' ${slugs.map((s) => `'${s}'`).join(' ')}\n`, { mode: 0o755 })

  it('asks gh once before calling an unlisted repository public: a repository made after the list was cut passes its first push', () => {
    const w = world()
    const fresh = 'gorfednet/' + 'just-made'
    const r = firstPush(w, fresh)
    listing(w, 'gorfednet/ops', SECRET, PRIVATE, fresh) // the repository exists now; the list on disk predates it
    const x = push(r, 'origin', 'main')
    assert.equal(x.status, 0, x.stderr)
    assert.ok(remoteHas(r, 'refs/heads/main'))
  })

  it('still refuses a first push to a repository gh does not list as private', () => {
    const w = world()
    const r = firstPush(w, 'gorfednet/' + 'not-private')
    const x = push(r, 'origin', 'main')
    assert.ok(refused(x), x.stderr)
    assert.ok(!remoteHas(r, 'refs/heads/main'))
  })
})

describe('install-git-hooks.sh: a failed install leaves the hooks that were there', () => {
  it('keeps the old files when the second install cannot read its revision', () => {
    const w = world()
    const read = () => ['hook', 'public-push-guard.mjs', 'privacy-guard.mjs', 'node-path'].map((f) => readFileSync(join(w.hooks, f), 'utf8'))
    const before = read()
    assert.ok(before.every((t) => t.length > 0))
    const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), INSTALL_REV: 'no-such-rev', GIT_HOOKS_DIR: w.hooks } })
    assert.notEqual(r.status, 0)
    assert.deepEqual(read(), before)
  })

  it('links every client and receive-side hook name but five, so a repository outside AUDIT_ROOT keeps its own hooks of any name', () => {
    const w = world()
    const linked = () => readdirSync(w.hooks).filter((f) => lstatSync(join(w.hooks, f)).isSymbolicLink())
    for (const h of ['pre-commit', 'commit-msg', 'post-checkout', 'post-merge', 'post-commit', 'pre-rebase', 'prepare-commit-msg', 'pre-push', 'pre-receive', 'update', 'post-receive', 'post-update', 'sendemail-validate', 'p4-pre-submit']) assert.ok(linked().includes(h), `${h} is not linked`)
    for (const h of ['push-to-checkout', 'proc-receive', 'fsmonitor-watchman']) assert.ok(!linked().includes(h), `${h} must not be linked`)
    // The two names that fire on nearly every git command wait for a clone under AUDIT_ROOT that has one.
    for (const h of ['reference-transaction', 'post-index-change']) assert.ok(!linked().includes(h), `${h} is linked with no clone that needs it`)
    // No clone is under AUDIT_ROOT, and its hooks were added after the install: they still run.
    const r = repo(w)
    const hook = join(r.dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    assert.notEqual(git(r.dir, r.w, 'commit', '--allow-empty', '-m', 'x').status, 0)
    const post = join(r.dir, '.git', 'hooks', 'post-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    writeFileSync(post, `#!/bin/sh\n: > "${join(w.dir, 'post-commit-ran')}"\n`)
    chmodSync(post, 0o755)
    ok(r.dir, r.w, 'commit', '--allow-empty', '-m', 'y')
    assert.ok(existsSync(join(w.dir, 'post-commit-ran')))
    // A clone under AUDIT_ROOT with a reference-transaction hook links that one name, and the link goes when nothing needs it.
    const rt = join(r.dir, '.git', 'hooks', 'reference-transaction')
    writeFileSync(rt, '#!/bin/sh\nexit 0\n')
    chmodSync(rt, 0o755)
    reinstall(w)
    assert.ok(linked().includes('reference-transaction') && !linked().includes('post-index-change'))
    rmSync(rt)
    reinstall(w)
    assert.ok(!linked().includes('reference-transaction'), 'a link the last install made and nothing needs is removed')
  })

  it('does not link push-to-checkout, which would override the default working-tree update', () => {
    const w = world()
    assert.ok(!existsSync(join(w.hooks, 'push-to-checkout')))
    assert.ok(existsSync(join(w.hooks, 'pre-push')))
  })

  it('runs the Node the installer resolved, not the first node on PATH', () => {
    const w = world({ install: false })
    const log = join(w.dir, 'node.log')
    const node = join(w.dir, 'picked-node')
    writeFileSync(node, `#!/bin/sh\necho run >> '${log}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
    const r = spawnSync('bash', [INSTALL, ROOT], { encoding: 'utf8', env: { ...envOf(w), NODE_BIN: node, INSTALL_REV: 'HEAD', GIT_HOOKS_DIR: w.hooks, AUDIT_ROOT: join(w.dir, 'none') } })
    assert.equal(r.status, 0, r.stderr)
    const installed = readFileSync(log, 'utf8').split('\n').length
    const p = repo(w)
    assert.equal(push(p, 'origin', 'feature').status, 0)
    assert.ok(readFileSync(log, 'utf8').split('\n').length > installed, 'the hook did not use the resolved node')
  })
})

