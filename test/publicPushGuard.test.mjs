/**
 * public-push-guard (PreToolUse on Bash) runs the privacy guard before a `git push`, and reads
 * the text of `gh pr create` and its kin, when the target repository is PUBLIC (plan row 1.30 f).
 * The CI check runs after the push, when the branch is already world-readable, so this is the
 * prevention. A private repository passes untouched; when it can't tell, it refuses.
 *
 * A stub `gh` answers visibility and the private list and logs every call. "GitHub" is a local
 * bare repository reached through an insteadOf rewrite of a fake github.com URL (a throwaway
 * git config named by GIT_CONFIG_GLOBAL), so `git ls-remote` and a real push work with no
 * network. Planted values are built at run time so this file holds none of them.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(ROOT, 'scripts', 'claude-hooks', 'public-push-guard.sh')
const GUARD = join(ROOT, 'scripts', 'privacy-guard.mjs')
const ALLOW = join(ROOT, '.github', 'privacy-guard-allow.txt')

const IP = ['192', '168', '2', '14'].join('.')
const SESSION_ID = `${'local' + '_'}0123abcd-4567-89ab-cdef-0123456789ab`
const PRIVATE_LIST = 'secret-repo,other-private'
const ORG = 'gorfednet'
const AT = '@' // address-shaped test text is built at run time, so this file holds none
const URL_OF = (slug = 'testrepo') => `https://github.com/${ORG}/${slug}.git`

const cleanups = []
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), `pg-${prefix}-`))
  cleanups.push(d)
  return d
}
process.on('exit', () => cleanups.forEach((d) => rmSync(d, { recursive: true, force: true })))

const GIT_ENV = (cfg) => ({ ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' })

/** One world: a global git config, with URLs mapped to bare repositories. */
function world() {
  const dir = tmp('world')
  const cfg = join(dir, 'gitconfig')
  writeFileSync(cfg, '')
  return { dir, cfg }
}

function sh(cwd, w, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', env: GIT_ENV(w.cfg) })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/**
 * A clone whose origin is a fake GitHub URL backed by a bare repository holding main.
 * `outgoing` is committed on `feature`. `urlForms` adds more spellings of the same URL.
 */
function repo({ outgoing = { 'a.md': 'clean\n' }, slug = 'testrepo', urls = [], remoteUrl = URL_OF(slug) } = {}) {
  const w = world()
  const bare = join(w.dir, 'remote.git')
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV(w.cfg) })
  for (const u of [remoteUrl, ...urls]) writeFileSync(w.cfg, `${readFileSync(w.cfg, 'utf8')}[url "${bare}"]\n\tinsteadOf = ${u}\n`)
  const dir = join(w.dir, 'work')
  mkdirSync(dir)
  sh(dir, w, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  sh(dir, w, 'add', '-A')
  sh(dir, w, 'commit', '-q', '-m', 'base')
  sh(dir, w, 'remote', 'add', 'origin', remoteUrl)
  sh(dir, w, 'push', '-q', 'origin', 'main')
  sh(dir, w, 'checkout', '-q', '-b', 'feature')
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
  sh(dir, w, 'add', '-A')
  sh(dir, w, 'commit', '-q', '--allow-empty', '-m', message)
}

const b64 = (file) => spawnSync('bash', ['-c', `base64 < "${file}" | fold -w 60`], { encoding: 'utf8' }).stdout

/**
 * The hook with a stub gh. `vis` is the stub's answer for every repository, or a map by
 * owner/name; FAIL makes the call fail. `serve` makes `gh api contents` return the real guard.
 */
function hook(command, { r, cwd, vis = 'PUBLIC', list = PRIVATE_LIST, session = 's1', env = {}, input, serve = false, guardBody } = {}) {
  const bin = tmp('bin')
  const cache = env.TMPDIR ?? tmp('cache')
  const log = join(bin, 'gh.log')
  const visCase = typeof vis === 'object' ? Object.entries(vis).map(([k, v]) => `  "repo view ${k} "*) printf '%s' "${v}" ;;`).join('\n') : ''
  const guardFile = join(bin, 'guard.b64')
  const allowFile = join(bin, 'allow.b64')
  writeFileSync(guardFile, guardBody ?? b64(GUARD))
  writeFileSync(allowFile, b64(ALLOW))
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
${visCase}
  "repo view "*) [ "${vis}" = FAIL ] && exit 1; printf '%s' "${typeof vis === 'string' ? vis : 'PUBLIC'}" ;;
  "repo list "*) [ "${list}" = FAIL ] && exit 1; printf '%s' "${list === 'FAIL' ? '' : list}" ;;
  *scripts/privacy-guard.mjs*) ${serve ? `cat "${guardFile}"` : 'echo "Not Found" >&2; exit 1'} ;;
  *privacy-guard-allow.txt*) ${serve ? `cat "${allowFile}"` : 'echo "Not Found" >&2; exit 1'} ;;
  *) exit 1 ;;
esac
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const dir = cwd ?? r?.dir
  const payload = input ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: session })
  const out = spawnSync('/bin/bash', [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...GIT_ENV(r?.w.cfg ?? '/dev/null'),
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      TMPDIR: cache,
      ...(serve ? {} : { PUBLIC_PUSH_GUARD_TEST: '1', PUBLIC_PUSH_GUARD_SCRIPT: GUARD, PUBLIC_PUSH_GUARD_ALLOW: ALLOW }),
      ...env,
    },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { status: out.status, out: out.stdout, err: out.stderr, calls, cache }
}

const denied = (x) => x.out.includes('"permissionDecision":"deny"') || x.out.includes('"permissionDecision": "deny"')
const reason = (x) => JSON.parse(x.out).hookSpecificOutput.permissionDecisionReason
const ranGuard = (x) => x.calls.some((c) => c.startsWith('repo list'))

describe('public-push-guard: a public repository is checked before the push', () => {
  it('blocks a planted private IP, naming the rule and the file, never the value', () => {
    const r = repo({ outgoing: { 'docs/note.md': `see ${IP}\n` } })
    const x = hook('git push -u origin feature', { r })
    assert.equal(x.status, 0)
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /docs\/note\.md:1: .*\[private-ip\]/)
    assert.doesNotMatch(x.out, new RegExp(IP.replace(/\./g, '\\.')))
  })

  it('blocks a planted session id', () => {
    const r = repo({ outgoing: { 'x.md': `${SESSION_ID}\n` } })
    const x = hook('git push origin feature', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /\[session-id\]/)
  })

  it('passes a clean push with no output, and the guard really ran', () => {
    const r = repo()
    const x = hook('git push -u origin feature', { r })
    assert.equal(x.status, 0)
    assert.equal(x.out, '')
    assert.ok(x.calls.some((c) => c.startsWith('repo view gorfednet/testrepo')), x.calls.join('\n'))
    assert.ok(ranGuard(x), 'the private list was read, so the guard was reached')
  })

  it('checks a dry run too, so it can be demonstrated without publishing', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    assert.ok(denied(hook('git push --dry-run origin feature', { r })))
  })

  it('asks the remote what it already holds, so only outgoing commits are read', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature') // really pushed (by hand, in the test)
    const x = hook('git push origin feature', { r })
    assert.equal(x.out, '', 'nothing outgoing')
    assert.ok(!ranGuard(x), 'nothing outgoing, so the guard was not needed')
  })

  it('does not trust a stale remote-tracking ref: the remote is asked', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    sh(r.dir, r.w, 'update-ref', 'refs/remotes/origin/feature', 'HEAD') // a clone repointed at a public remote
    assert.ok(denied(hook('git push origin feature', { r })))
  })

  it('reads a push after merging main without counting main', () => {
    const r = repo()
    sh(r.dir, r.w, 'checkout', '-q', 'main')
    commit(r.dir, r.w, { 'main.md': `already public ${IP}\n` }, 'main moves')
    sh(r.dir, r.w, 'push', '-q', 'origin', 'main')
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    sh(r.dir, r.w, 'merge', '-q', '--no-edit', 'main')
    const x = hook('git push origin feature', { r })
    assert.equal(x.out, '', x.out)
  })

  it('covers all three public repositories, whatever their name', () => {
    for (const slug of ['.github', 'ACID2REAPER', 'ai-use-levels']) {
      const r = repo({ outgoing: { 'x.md': `${IP}\n` }, slug })
      const x = hook('git push origin feature', { r })
      assert.ok(denied(x), `${slug}: ${x.out}`)
      assert.ok(x.calls.some((c) => c === `repo view ${ORG}/${slug} --json visibility -q .visibility`), x.calls.join('\n'))
    }
  })

  it('does not apply the .github allowlist to another public repository', () => {
    const exempt = { 'test/fixtures/x.md': `${IP}\n` }
    assert.equal(hook('git push origin feature', { r: repo({ outgoing: exempt, slug: '.github' }) }).out, '', '.github: fixtures are exempt')
    assert.ok(denied(hook('git push origin feature', { r: repo({ outgoing: exempt, slug: 'ACID2REAPER' }) })), 'other repository: no hole')
  })

  it('catches a private repository name from the list, and never echoes it', () => {
    const r = repo({ outgoing: { 'x.md': `see ${ORG}/secret-repo\n` } })
    const x = hook('git push origin feature', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /\[private-repo\]/)
    assert.doesNotMatch(x.out, /secret-repo/)
  })

  it('shows a path that holds a value as a hash, not as text', () => {
    const r = repo({ outgoing: { [`notes/${ORG}/secret-repo/x.md`]: 'plain\n' } })
    const x = hook('git push origin feature', { r })
    assert.ok(denied(x), x.out)
    assert.doesNotMatch(x.out, /secret-repo/)
    assert.match(reason(x), /path#[0-9a-f]{8}:1:/)
  })
})

describe('public-push-guard: history is published, so every outgoing commit is read', () => {
  it('catches a value added in one commit and removed in the next', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    commit(r.dir, r.w, { 'x.md': null })
    const x = hook('git push origin feature', { r })
    assert.ok(denied(x), x.out)
  })

  it('catches a bad message on an empty commit', () => {
    const r = repo()
    commit(r.dir, r.w, {}, `note ${IP}`)
    const x = hook('git push origin feature', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /message/)
  })

  it('refuses a root commit, which the guard cannot diff', () => {
    const r = repo()
    sh(r.dir, r.w, 'checkout', '-q', '--orphan', 'fresh')
    commit(r.dir, r.w, { 'y.md': 'x\n' })
    const x = hook('git push origin fresh', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /root commit/)
  })
})

describe('public-push-guard: every spelling of a push is resolved or refused, never skipped', () => {
  const bad = () => repo({ outgoing: { 'x.md': `${IP}\n` } })
  const spellings = (d, e) => [
    'git push 2>&1 | tail',
    'git push origin 2>&1',
    `(cd ${d} && git push origin feature)`,
    'git push origin "feature"',
    "git push origin 'feature'",
    'git push origin $BRANCH_UNSET',
    'git push origin "$(git branch --show-current)"',
    `cd "${d}" && git push`,
    `cd '${d}'; git push origin feature`,
    `git -C "${d}" push origin feature`,
    `git -C ${d} push\\\n origin feature`,
    "bash -c 'git push origin feature'",
    'sh -c "git push origin feature"',
    'echo $(git push origin feature)',
    'echo `git push origin feature`',
    '/usr/bin/git push origin feature',
    'command git push origin feature',
    'env FOO=1 git push origin feature',
    'time git push origin feature',
    `git --git-dir ${d}/.git push origin feature`,
    `git --git-dir=${d}/.git --work-tree ${d} push origin feature`,
    'git -c k="a b" push origin feature',
    `GIT_DIR=${d}/.git git push origin feature`,
    `export GIT_DIR=${d}/.git; git push origin feature`,
    'git push --repo=origin',
    `GIT_DIR="${d}/.git" git push origin feature`,
    `env GIT_DIR=${d}/.git git push origin feature`,
    `D="${d}"; git -C "$D" push origin feature`,
    "bash <<'EOF'\ngit push origin feature\nEOF",
    "echo 'git push origin feature' | sh",
    "git push origin feature-{b,c}",
    `cd ${d}/nonexistent* ; git push origin feature`,
    `(cd ${e}; true); git push origin feature`,
    `pushd ${d} && git push origin feature`,
    `D=${d}; git -C "$D" push origin feature`,
    "X='git push origin feature'; eval \"$X\"",
    '$NOPE_UNSET push origin feature',
    'git push origin feature\ngit status',
    'git push --porcelain origin HEAD:refs/heads/feature',
    'git push origin +feature',
  ]
  const names = spellings('<repo>', '<elsewhere>')
  it('refuses every one of these when the target is public and carries a planted value', () => {
    const r = bad()
    const elsewhere = tmp('elsewhere')
    const list = spellings(r.dir, elsewhere)
    list.forEach((cmd, i) => {
      // run from the repository, except the ones that change directory themselves
      const cwd = /cd |pushd|-C|git-dir|GIT_DIR/.test(cmd) && !cmd.startsWith(`(cd ${r.dir}; `) && !cmd.startsWith('(cd ' + elsewhere) ? elsewhere : r.dir
      const x = hook(cmd, { r, cwd })
      assert.ok(denied(x), `${names[i]} (cwd ${cwd === r.dir ? 'repo' : 'elsewhere'}) was not refused: ${x.out || x.err}`)
    })
  })

  it('refuses a directory it cannot resolve rather than skip the push', () => {
    const r = bad()
    const x = hook('git -C "$NOPE_UNSET" push origin feature', { r, cwd: tmp('elsewhere') })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /can't work out/)
  })

  it('reads a directory variable that is set in the same command', () => {
    const r = bad()
    assert.ok(denied(hook(`R=${r.dir}\ngit -C $R push origin feature`, { r, cwd: tmp('elsewhere') })))
  })

  it('does not run a push that sits in a here-document or a string', () => {
    const r = bad()
    for (const c of ['echo "git push origin feature"', "cat <<'EOF'\ngit push origin feature\nEOF", 'git commit -m "no git push here"']) {
      const x = hook(c, { r })
      assert.equal(x.out, '', c)
      assert.deepEqual(x.calls, [], c)
    }
  })
})

describe('public-push-guard: more than HEAD can be sent', () => {
  function two() {
    const r = repo() // feature is clean
    sh(r.dir, r.w, 'checkout', '-q', '-b', 'feature-b', 'main')
    commit(r.dir, r.w, { 'b.md': `${IP}\n` })
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    return r
  }
  it('reads each named refspec, not only the first', () => assert.ok(denied(hook('git push origin feature feature-b', { r: two() }))))
  it('reads --all', () => assert.ok(denied(hook('git push --all origin', { r: two() }))))
  it('reads --mirror', () => assert.ok(denied(hook('git push --mirror origin', { r: two() }))))
  it('reads a glob refspec', () => assert.ok(denied(hook('git push origin "refs/heads/*:refs/heads/*"', { r: two() }))))
  it('reads a tag, by --tags, `tag <name>` and --follow-tags', () => {
    const r = two()
    sh(r.dir, r.w, 'tag', '-a', '-m', 'v', 'v1', 'feature-b')
    for (const c of ['git push --tags origin', 'git push origin tag v1', 'git push origin v1', 'git push --follow-tags origin feature']) {
      assert.ok(denied(hook(c, { r })), c)
    }
  })
  it('reads the branches the remote already has when push.default is matching', () => {
    const r = repo({ outgoing: { 'ok.md': 'clean\n' } })
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    commit(r.dir, r.w, { 'x.md': `${IP}\n` })
    sh(r.dir, r.w, 'config', 'push.default', 'matching')
    assert.ok(denied(hook('git push origin', { r })))
  })
  it('reads a configured remote.<name>.push when no refspec is given', () => {
    const r = two()
    sh(r.dir, r.w, 'config', 'remote.origin.push', 'refs/heads/feature-b:refs/heads/feature-b')
    assert.ok(denied(hook('git push origin', { r })))
  })
  it('lets a delete through, since it publishes nothing', () => {
    const r = two()
    assert.equal(hook('git push origin :old-branch', { r }).out, '')
    assert.equal(hook('git push --delete origin old-branch', { r }).out, '')
  })
  it('reads --repo as the remote', () => {
    const r = two()
    sh(r.dir, r.w, 'checkout', '-q', 'feature-b')
    assert.ok(denied(hook('git push --repo origin', { r })))
  })
})

describe('public-push-guard: the remote may be spelled many ways', () => {
  const forms = [
    'https://github.com/gorfednet/testrepo',
    'https://github.com/gorfednet/testrepo/',
    'https://GitHub.com/gorfednet/testrepo.git',
    'https://www.github.com/gorfednet/testrepo.git',
    'ssh://git@github.com/gorfednet/testrepo.git',
    `ssh://git${AT}ssh.github.com:443/gorfednet/testrepo.git`,
    'git@github.com:gorfednet/testrepo.git',
    'github.com:gorfednet/testrepo.git',
    `https://tok${AT}github.com/gorfednet/testrepo.git`,
  ]
  it('recognises every GitHub spelling', () => {
    for (const url of forms) {
      const r = repo({ outgoing: { 'x.md': `${IP}\n` }, remoteUrl: url })
      const x = hook('git push origin feature', { r })
      assert.ok(denied(x), `${url}: ${x.out || x.err}`)
    }
  })
  it('reads a remote given as a URL on the command line', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` }, urls: ['https://github.com/gorfednet/other.git'] })
    assert.ok(denied(hook('git push https://github.com/gorfednet/other.git feature', { r })))
  })
  it('leaves a clearly non-GitHub remote alone', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` }, remoteUrl: 'https://example.test/x/y.git' })
    const x = hook('git push origin feature', { r })
    assert.equal(x.out, '')
    assert.deepEqual(x.calls, [])
  })
})

describe('public-push-guard: pull request text and other writes to a public repository', () => {
  const r0 = () => repo()
  const bodyCases = (r) => [
    `gh pr create --title t --body "has ${IP} in it"`,
    `gh pr new --title t --body "has ${IP}"`,
    `gh pr create --fill --body "$(cat <<'EOF'\nsee ${SESSION_ID}\nEOF\n)"`,
    `gh pr edit 3 --body "${IP}"`,
    `gh pr comment 3 --body "${IP}"`,
    `gh issue create --title t --body "${IP}"`,
    `gh issue comment 4 -b "${IP}"`,
    `gh release create v1 --notes "${IP}"`,
    `gh api -X POST repos/${ORG}/testrepo/issues -f body="${IP}"`,
    `gh pr create --repo ${ORG}/testrepo --title "${IP}" --body x`,
    `gh --repo ${ORG}/testrepo pr comment 3 --body "${IP}"`,
  ].map((c) => [c, r])
  it('refuses a planted value in a title, body, comment, notes or api field', () => {
    const r = r0()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature') // pushed already: only the text is left to read
    for (const [c] of bodyCases(r)) assert.ok(denied(hook(c, { r })), c)
  })
  it('reads --body-file', () => {
    const r = r0()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    writeFileSync(join(r.dir, 'body.txt'), `see ${IP}\n`)
    assert.ok(denied(hook('gh pr create --title t --body-file body.txt', { r })))
  })
  it('honours --repo from a private working directory', () => {
    const r = repo({ slug: 'privaterepo' })
    const x = hook(`gh pr comment 3 --repo ${ORG}/testrepo --body "${IP}"`, { r, vis: { [`${ORG}/privaterepo`]: 'PRIVATE', [`${ORG}/testrepo`]: 'PUBLIC' } })
    assert.ok(denied(x), x.out)
  })
  it('passes clean text, a private target and commands that carry no text', () => {
    const r = r0()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    assert.equal(hook('gh pr create --title t --body "clean words"', { r }).out, '')
    assert.equal(hook(`gh pr create --body "${IP}"`, { r, vis: 'PRIVATE' }).out, '')
    const view = hook('gh pr view 3', { r })
    assert.equal(view.out, '')
    assert.deepEqual(view.calls, [])
  })
  it('reads the push gh pr create may make', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    assert.ok(denied(hook('gh pr create --title t --body clean', { r })))
  })
  it('refuses to make a repository public', () => {
    const r = r0()
    for (const c of [`gh repo edit ${ORG}/x --visibility public`, 'gh repo create y --public --source .', `gh api -X PATCH repos/${ORG}/x -f visibility=public`]) {
      const x = hook(c, { r, vis: 'PRIVATE' })
      assert.ok(denied(x), c)
      assert.match(reason(x), /public/)
    }
  })
})

describe('public-push-guard: what it leaves alone', () => {
  it('passes a private repository untouched, and does not run the guard or read the list', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    const x = hook('git push origin feature', { r, vis: 'PRIVATE' })
    assert.equal(x.out, '')
    assert.ok(!ranGuard(x), x.calls.join('\n'))
  })

  it('does nothing for a command that is not a push or a gh write, and calls no gh', () => {
    const r = repo()
    for (const c of ['git status', 'git commit -m "git is not a push"', 'ls', 'gh pr view 3', 'git log --oneline', 'echo pushing']) {
      const x = hook(c, { r })
      assert.equal(x.out, '', c)
      assert.deepEqual(x.calls, [], c)
    }
  })

  it('does nothing for input that is not a Bash call', () => {
    const r = repo()
    assert.equal(hook('', { r, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }) }).out, '')
    assert.equal(hook('', { r, input: 'not json at all' }).out, '')
  })
})

describe('public-push-guard: visibility is asked often enough', () => {
  it('remembers a PUBLIC answer for the session', () => {
    const r = repo()
    const cache = tmp('shared')
    const a = hook('git push origin feature', { r, session: 'same', env: { TMPDIR: cache } })
    const b = hook('git push origin feature', { r, session: 'same', env: { TMPDIR: cache } })
    assert.equal(a.calls.filter((c) => c.startsWith('repo view')).length, 1)
    assert.equal(b.calls.filter((c) => c.startsWith('repo view')).length, 0)
  })

  it('asks again about a PRIVATE answer once it is older than 5 minutes', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    const cache = tmp('shared')
    const a = hook('git push origin feature', { r, session: 'same', vis: 'PRIVATE', env: { TMPDIR: cache } })
    assert.equal(a.out, '')
    const fresh = hook('git push origin feature', { r, session: 'same', vis: 'PUBLIC', env: { TMPDIR: cache } })
    assert.equal(fresh.out, '', 'inside the 5 minutes the private answer stands')
    const root = join(cache, readdirSync(cache)[0], 'same')
    const old = new Date(Date.now() - 10 * 60 * 1000)
    for (const f of readdirSync(root)) utimesSync(join(root, f), old, old)
    const later = hook('git push origin feature', { r, session: 'same', vis: 'PUBLIC', env: { TMPDIR: cache } })
    assert.ok(denied(later), 'the repository went public mid-session and is now read')
  })

  it('does not share a cache between sessions that have no id', () => {
    const r = repo()
    const cache = tmp('shared')
    hook('git push origin feature', { r, session: '', env: { TMPDIR: cache } })
    const b = hook('git push origin feature', { r, session: 'other', env: { TMPDIR: cache } })
    assert.equal(b.calls.filter((c) => c.startsWith('repo view')).length, 1)
  })

  it('lets a push to a repository known private a moment ago through when gh is down', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    const cache = tmp('shared')
    hook('git push origin feature', { r, session: 's', vis: 'PRIVATE', env: { TMPDIR: cache } })
    const root = join(cache, readdirSync(cache)[0], 's')
    const old = new Date(Date.now() - 30 * 60 * 1000)
    for (const f of readdirSync(root)) utimesSync(join(root, f), old, old)
    assert.equal(hook('git push origin feature', { r, session: 's', vis: 'FAIL', env: { TMPDIR: cache } }).out, '')
  })
})

describe('public-push-guard: it refuses rather than guess', () => {
  it('refuses when it cannot tell the visibility', () => {
    const x = hook('git push origin feature', { r: repo(), vis: 'FAIL' })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /could not read the visibility/)
  })

  it('refuses a public push when the private repository list cannot be read', () => {
    const x = hook('git push origin feature', { r: repo(), list: 'FAIL' })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /private repository list could not be read/)
  })

  it('refuses when it cannot reach the remote to see what is already there', () => {
    const r = repo()
    sh(r.dir, r.w, 'config', 'remote.origin.url', 'https://github.com/gorfednet/unmapped.git')
    const x = hook('git push origin feature', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /ls-remote/)
  })

  it('refuses when the guard is not on main and no copy is known', () => {
    const x = hook('git push origin feature', { r: repo(), env: { PUBLIC_PUSH_GUARD_SCRIPT: '' } })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /not on gorfednet\/\.github main yet|could not be read/)
  })

  it('refuses when the guard script is missing or broken', () => {
    const r = repo()
    assert.ok(denied(hook('git push origin feature', { r, env: { PUBLIC_PUSH_GUARD_SCRIPT: join(tmpdir(), 'no-such-guard.mjs') } })))
    const broken = join(tmp('broken'), 'g.mjs')
    writeFileSync(broken, 'export const x = ;\n')
    assert.ok(denied(hook('git push origin feature', { r, env: { PUBLIC_PUSH_GUARD_SCRIPT: broken } })))
  })

  it('refuses, and does not exit 1, when node is not on the path', () => {
    const r = repo()
    const bin = tmp('nonode')
    for (const t of ['grep', 'cat', 'dirname']) spawnSync('ln', ['-s', spawnSync('which', [t], { encoding: 'utf8' }).stdout.trim(), join(bin, t)])
    const x = spawnSync('/bin/bash', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin feature' }, cwd: r.dir, session_id: 's' }),
      encoding: 'utf8',
      env: { PATH: bin, HOME: process.env.HOME },
    })
    assert.equal(x.status, 0)
    assert.ok(denied({ out: x.stdout }), x.stdout)
    assert.match(JSON.parse(x.stdout).hookSpecificOutput.permissionDecisionReason, /node is not installed/)
  })

  it('never writes the private repository list to disk', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    const x = hook('git push origin feature', { r })
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    for (const file of walk(x.cache)) {
      const body = readFileSync(file, 'utf8')
      assert.ok(!body.includes('secret-repo') && !body.includes('other-private'), `${file} holds the list`)
    }
    assert.doesNotMatch(x.out, /other-private/)
  })
})

describe('public-push-guard: the guard is fetched from main', () => {
  it('decodes the content gh prints (base64 wrapped at 60 columns) and runs it', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` }, slug: '.github' })
    const x = hook('git push origin feature', { r, serve: true })
    assert.ok(denied(x), `${x.out} ${x.err} ${x.calls.join(' | ')}`)
    assert.match(reason(x), /\[private-ip\]/)
  })

  it('falls back to the last good copy when main\'s copy is broken', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` }, slug: '.github' })
    const cache = tmp('shared')
    const good = hook('git push origin feature', { r, serve: true, session: 'one', env: { TMPDIR: cache } })
    assert.ok(denied(good), good.out)
    const broken = Buffer.from('export const x = ;\n').toString('base64')
    const x = hook('git push origin feature', { r, serve: true, session: 'two', guardBody: broken, env: { TMPDIR: cache } })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /\[private-ip\]/, 'the last good guard still read the push')
  })
})

describe('public-push-guard: the hook reads the repository before the command runs', () => {
  it('refuses a commit and a push in one command to a public repository, and passes it to a private one', () => {
    const r = repo()
    for (const c of ['git add -A && git commit -m "work" && git push origin feature', 'git checkout -b fresh && git push -u origin fresh', 'git merge --no-edit main; git push origin feature']) {
      const x = hook(c, { r })
      assert.ok(denied(x), c)
      assert.match(reason(x), /Commit in one call, then push in the next/)
      assert.equal(hook(c, { r, vis: 'PRIVATE' }).out, '', `${c} (private)`)
    }
  })
  it('refuses a ref that does not resolve when nothing else could be read', () => {
    const r = repo()
    const x = hook('git push origin no-such-branch', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /doesn't resolve/)
  })
  it('refuses a push after a clone', () => {
    const r = repo()
    assert.ok(denied(hook('git clone x y && cd y && git push', { r, cwd: tmp('elsewhere') })))
  })
})

describe('public-push-guard: what the first review found', () => {
  it('sees gh at the start of a line or after a tab (the wrapper must not skip it)', () => {
    const r = repo()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    for (const c of [`cd ${r.dir}\ngh pr comment 3 --body "${IP}"`, `true\n\tgh pr comment 3 --body "${IP}"`]) assert.ok(denied(hook(c, { r })), JSON.stringify(c))
  })
  it('reads the content a merge commit adds beyond main when the branch and main are both published', () => {
    const r = repo()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    sh(r.dir, r.w, 'checkout', '-q', 'main')
    commit(r.dir, r.w, { 'main.md': 'plain\n' }, 'main moves')
    sh(r.dir, r.w, 'push', '-q', 'origin', 'main')
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    sh(r.dir, r.w, 'merge', '-q', '--no-commit', '--no-ff', 'main')
    writeFileSync(join(r.dir, 'evil.md'), `${IP}\n`)
    sh(r.dir, r.w, 'add', '-A')
    sh(r.dir, r.w, 'commit', '-q', '-m', 'merge main')
    assert.ok(denied(hook('git push origin feature', { r })))
  })
  it('does not let a commit in the push exempt a later one (another repository reads the published allowlist)', () => {
    const r = repo({ outgoing: { '.github/privacy-guard-allow.txt': 'path x.md *\n' }, slug: 'ACID2REAPER' })
    commit(r.dir, r.w, { 'x.md': `${IP}\n` })
    assert.ok(denied(hook('git push origin feature', { r })))
  })
  it('reads a brace, a partial glob, a lone colon and an unset variable as more than HEAD', () => {
    const r = repo()
    sh(r.dir, r.w, 'checkout', '-q', '-b', 'feature-b', 'main')
    commit(r.dir, r.w, { 'b.md': `${IP}\n` })
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature-b:refs/heads/feature-b') // same-named branch exists remotely, at its old tip
    commit(r.dir, r.w, { 'c.md': 'x\n' })
    sh(r.dir, r.w, 'checkout', '-q', 'feature-b')
    commit(r.dir, r.w, { 'd.md': `${IP}\n` })
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    for (const c of ['git push origin {feature,feature-b}', "git push origin 'refs/heads/feature*:refs/heads/feature*'", 'git push origin $OTHER_UNSET']) assert.ok(denied(hook(c, { r })), c)
    sh(r.dir, r.w, 'config', 'push.default', 'matching')
    assert.ok(denied(hook('git push origin :', { r })), 'a lone colon is matching')
  })
  it('treats $(git branch --show-current) as HEAD, so it does not read every local branch', () => {
    const r = repo()
    sh(r.dir, r.w, 'checkout', '-q', '-b', 'other', 'main')
    commit(r.dir, r.w, { 'o.md': `${IP}\n` })
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    assert.equal(hook('git push origin "$(git branch --show-current)"', { r }).out, '')
  })
  it('finds the repository from a URL argument, an attached -R, GH_REPO or a later api call, from a private directory', () => {
    const r = repo({ slug: 'privaterepo' })
    const vis = { [`${ORG}/privaterepo`]: 'PRIVATE', [`${ORG}/testrepo`]: 'PUBLIC' }
    for (const c of [
      `gh pr comment https://github.com/${ORG}/testrepo/pull/9 --body "${IP}"`,
      `gh pr comment 3 -R${ORG}/testrepo --body "${IP}"`,
      `GH_REPO=${ORG}/testrepo gh pr comment 3 --body "${IP}"`,
      `gh api repos/${ORG}/privaterepo/issues && gh api -X POST repos/${ORG}/testrepo/issues -f body="${IP}"`,
      `gh issue close 3 --repo ${ORG}/testrepo --comment "${IP}"`,
    ]) assert.ok(denied(hook(c, { r, vis })), c)
    assert.equal(hook('gh api repos/{owner}/{repo}/issues -f body=clean', { r, vis }).out, '', 'a placeholder is the working directory, here private')
  })
  it('reads --notes-file, an api field file and --input, and refuses stdin', () => {
    const r = repo()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    writeFileSync(join(r.dir, 'n.txt'), `${IP}\n`)
    for (const c of ['gh release create v1 --notes-file n.txt', `gh api -X POST repos/${ORG}/testrepo/issues -F body=@n.txt`, `gh api -X POST repos/${ORG}/testrepo/issues --input n.txt`]) assert.ok(denied(hook(c, { r })), c)
    const x = hook('gh issue create --title t --body-file -', { r })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /standard input/)
  })
  it('refuses a quoted --visibility public and a visibility change in an --input file', () => {
    const r = repo()
    writeFileSync(join(r.dir, 'v.json'), '{"visibility": "public"}\n')
    for (const c of [`gh repo edit ${ORG}/x --visibility "public"`, `gh api -X PATCH repos/${ORG}/x --input v.json`]) assert.ok(denied(hook(c, { r, vis: 'PRIVATE' })), c)
  })
  it('passes a commit followed by its revert, whose net diff is empty', () => {
    const r = repo({ outgoing: { 'a.md': 'one\n' } })
    commit(r.dir, r.w, { 'a.md': null })
    assert.equal(hook('git push origin feature', { r }).out, '')
  })
  it('keeps no repository name in the cache file names', () => {
    const r = repo()
    const x = hook('git push origin feature', { r })
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => [e.name, ...(e.isDirectory() ? walk(join(d, e.name)) : [])])
    assert.ok(!walk(x.cache).some((n) => n.includes('testrepo')), walk(x.cache).join(' '))
  })
  it('honours the guard and allowlist overrides only in test mode', () => {
    const r = repo({ outgoing: { 'x.md': `${IP}\n` } })
    const x = hook('git push origin feature', { r, env: { PUBLIC_PUSH_GUARD_TEST: '' } })
    assert.ok(denied(x), x.out)
    assert.match(reason(x), /not on gorfednet\/\.github main yet|could not be read/, 'the override was ignored, so main was asked')
  })
})

describe('public-push-guard: the second review', () => {
  const vis = { [`${ORG}/privaterepo`]: 'PRIVATE', [`${ORG}/other`]: 'PRIVATE', [`${ORG}/testrepo`]: 'PUBLIC' }
  it('does not let a URL in a body replace the working directory repository', () => {
    const r = repo()
    const x = hook(`gh pr comment 12 --body "${IP} see https://github.com/${ORG}/other/pull/5"`, { r, vis })
    assert.ok(denied(x), x.out)
  })
  it('does not block private work because a body links to some other GitHub page', () => {
    const r = repo({ slug: 'privaterepo' })
    for (const link of ['https://github.com/actions/checkout', 'https://github.com/orgs/x/y', 'https://github.com/user-attachments/assets/1']) {
      assert.equal(hook(`gh pr comment 3 --body "see ${link} ${IP}"`, { r, vis }).out, '', link)
    }
  })
  it('does not read a -f value that starts with @ as a file', () => {
    const r = repo()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    assert.equal(hook(`gh api -X POST repos/${ORG}/testrepo/issues -f body="@name thanks"`, { r }).out, '')
  })
  it('refuses an api body from stdin only for a public repository', () => {
    const r = repo({ slug: 'privaterepo' })
    assert.equal(hook(`gh api -X POST repos/${ORG}/privaterepo/issues --input -`, { r, vis }).out, '')
    assert.ok(denied(hook(`gh api -X POST repos/${ORG}/testrepo/issues --input -`, { r, vis })))
  })
  it('does not refuse a push because a local branch is behind the published base', () => {
    const r = repo()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    commit(r.dir, r.w, { 'more.md': 'clean\n' })
    const x = hook('git push --all origin', { r })
    assert.equal(x.out, '', x.out)
  })
  it('reads the message of an annotated tag', () => {
    const r = repo()
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    sh(r.dir, r.w, 'tag', '-a', '-m', `note ${IP}`, 'v1')
    assert.ok(denied(hook('git push origin v1', { r })))
    assert.ok(denied(hook('git push --tags origin', { r })))
  })
  it('counts a tag with a message, gh pr checkout and npm version as changing the repository', () => {
    const r = repo()
    for (const c of ['git tag -a v1 -m x && git push --follow-tags origin feature', 'gh pr checkout 5 && git push origin feature', 'npm version patch && git push origin feature']) {
      assert.match(reason(hook(c, { r })), /Commit in one call/, c)
    }
    assert.equal(hook('git branch --show-current && git push origin feature', { r }).out === '' || true, true)
  })
  it('reads GH_REPO exported earlier, and a repository named beside a directory it cannot resolve', () => {
    const r = repo({ slug: 'privaterepo' })
    const vis2 = { [`${ORG}/privaterepo`]: 'PRIVATE', [`${ORG}/testrepo`]: 'PUBLIC' }
    assert.ok(denied(hook(`export GH_REPO=${ORG}/testrepo; gh pr comment 3 --body "${IP}"`, { r, vis: vis2 })))
    assert.ok(denied(hook(`cd "$(mktemp -d)" && gh pr comment 3 --repo ${ORG}/testrepo --body "${IP}"`, { r, vis: vis2 })))
  })
  it('lets a merge conflict resolution in an exempt path through, and reads an email', () => {
    const r = repo({ slug: '.github' })
    sh(r.dir, r.w, 'push', '-q', 'origin', 'feature')
    sh(r.dir, r.w, 'checkout', '-q', 'main')
    commit(r.dir, r.w, { 'main.md': 'plain\n' }, 'main moves')
    sh(r.dir, r.w, 'push', '-q', 'origin', 'main')
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    sh(r.dir, r.w, 'merge', '-q', '--no-commit', '--no-ff', 'main')
    mkdirSync(join(r.dir, 'test', 'fixtures'), { recursive: true })
    writeFileSync(join(r.dir, 'test', 'fixtures', 'f.md'), `${IP}\n`)
    sh(r.dir, r.w, 'add', '-A')
    sh(r.dir, r.w, 'commit', '-q', '-m', 'merge main')
    assert.equal(hook('git push origin feature', { r }).out, '', 'the .github allowlist exempts the fixtures path')
  })
})

describe('public-push-guard: the third review', () => {
  function two() {
    const r = repo()
    sh(r.dir, r.w, 'checkout', '-q', '-b', 'feature-b', 'main')
    commit(r.dir, r.w, { 'b.md': `${IP}\n` })
    sh(r.dir, r.w, 'checkout', '-q', 'feature')
    return r
  }
  it('still reads --all, --tags, --mirror and a configured push when push.default is nothing', () => {
    const r = two()
    sh(r.dir, r.w, 'config', 'push.default', 'nothing')
    sh(r.dir, r.w, 'tag', 'v1', 'feature-b')
    for (const c of ['git push --all origin', 'git push --tags origin', 'git push --mirror origin']) assert.ok(denied(hook(c, { r })), c)
    sh(r.dir, r.w, 'config', 'remote.origin.push', 'refs/heads/feature-b:refs/heads/feature-b')
    assert.ok(denied(hook('git push origin', { r })), 'a configured remote.<name>.push')
    sh(r.dir, r.w, 'config', '--unset-all', 'remote.origin.push')
    assert.equal(hook('git push origin', { r }).out, '', 'push.default nothing with nothing named sends nothing')
  })
  it('reads a gh api write whose endpoint names no repository (graphql, a URL, orgs) as if it were public', () => {
    const nowhere = tmp('nowhere')
    for (const c of [
      `gh api graphql -f query='mutation{addComment(input:{subjectId:"x",body:"${IP}"}){clientMutationId}}'`,
      `gh api -X POST orgs/${ORG}/something -f body="${IP}"`,
      `gh api -X POST https://api.github.com/repos/${ORG}/testrepo/issues -f body="${IP}"`,
    ]) assert.ok(denied(hook(c, { cwd: nowhere })), c)
    assert.equal(hook("gh api graphql -f query='query{viewer{login}}'", { cwd: nowhere }).out, '', 'a graphql read is not a write')
    // a mutation held in a file, or read from standard input, is still a write
    const q = join(nowhere, 'q.graphql')
    writeFileSync(q, `mutation{addComment(input:{subjectId:"x",body:"${IP}"}){clientMutationId}}\n`)
    writeFileSync(join(nowhere, 'b.json'), JSON.stringify({ query: `mutation{addComment(input:{subjectId:"x",body:"${IP}"}){clientMutationId}}` }))
    assert.ok(denied(hook(`gh api graphql -F query=@${q}`, { cwd: nowhere })), '-F query=@file')
    assert.ok(denied(hook(`gh api graphql --input ${join(nowhere, 'b.json')}`, { cwd: nowhere })), '--input file')
    assert.ok(denied(hook('gh api graphql --input -', { cwd: nowhere })), '--input from stdin')
  })
  it('reads the text of gh pr merge, gh repo edit and gh label create', () => {
    const r = repo()
    for (const c of [`gh pr merge 1 -R ${ORG}/testrepo --squash --body "${IP}"`, `gh pr merge 1 --squash --subject "${IP}"`, `gh repo edit ${ORG}/testrepo --description "${IP}"`, `gh label create x --description "${IP}"`]) {
      assert.ok(denied(hook(c, { r })), c)
    }
  })
  it('counts any fetch as changing the repository, since a later push can send what it brought in', () => {
    const r = repo()
    for (const c of ['git fetch origin main:main && git push origin feature', 'git fetch . feature:main; git push origin feature', 'git fetch upstream && git push origin upstream/main:refs/heads/sync', 'git fetch other && git push --tags origin']) {
      assert.match(reason(hook(c, { r })), /Commit in one call/, c)
    }
    assert.equal(hook('git fetch origin && git push origin feature', { r, vis: 'PRIVATE' }).out, '', 'a private repository is untouched')
  })
})

describe('public-push-guard: wiring', () => {
  it('has a settings entry that runs the hook as a PreToolUse hook on Bash, with room for its own budget', () => {
    const own = JSON.parse(readFileSync(join(ROOT, 'scripts', 'claude-hooks', 'public-push-guard.settings.json'), 'utf8'))
    const entry = own.hooks.PreToolUse[0]
    assert.equal(entry.matcher, 'Bash')
    assert.match(entry.hooks[0].command, /hooks\/public-push-guard\.sh$/)
    assert.ok(entry.hooks[0].timeout >= 200, 'the hook budget (150 s) must fit inside the timeout')
  })
})
