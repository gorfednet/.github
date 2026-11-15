/**
 * scripts/privacy-guard.mjs reads the lines a pull request adds and fails on private
 * detail (plan row 1.30 a). Each rule is planted once and must fail; a clean change
 * must pass; old content must never matter; an unset PRIVATE_REPOS must fail closed.
 *
 * The planted values are assembled at run time, so this file carries none of them and
 * the guard can scan it like any other file.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  parseAddedLines,
  parseAllowlist,
  parseNewFiles,
  parsePrivateRepos,
} from '../scripts/privacy-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'scripts', 'privacy-guard.mjs')
const REAL_ALLOWLIST = join(ROOT, '.github', 'privacy-guard-allow.txt')

const PLANT = {
  'private-ip': `server at ${['10', '0', '0', '5'].join('.')} answers`,
  'private-ip-172': `gateway ${['172', '20', '1', '9'].join('.')}`,
  'private-ip-192': `lan ${['192', '168', '2', '14'].join('.')}`,
  'private-ip-tailnet': `peer ${['100', '101', '2', '3'].join('.')}`,
  'session-id': `see ${'local' + '_'}${'0123abcd-4567-89ab-cdef-0123456789ab'}`,
  'tailnet-name': `ssh box.${['tail1234', 'ts', 'net'].join('.')}`,
  'internal-host': `deploys to ${'dapyl' + 'lil'} nightly`,
  'private-repo': `see ${'gorfednet' + '/'}secret-repo for it`,
  email: `contact ${'someone' + '@'}${'gmail' + '.com'}`,
  'owner-quote': `(${'owne' + 'r'}, 3 Jan 2026: "do it now")`,
}

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-C', cwd, ...args], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/**
 * A real repository: `base` holds `before`, branch `pr` adds `after` on top. Returns the
 * guard's exit status and output. `allow` copies the real allowlist in, so the shipped
 * exemptions are what is under test.
 */
function guard({ before = { 'README.md': 'hello\n' }, after = {}, env = {}, allow = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-guard-'))
  try {
    sh(dir, 'init', '-q', '-b', 'main')
    const put = (files) => {
      for (const [rel, body] of Object.entries(files)) {
        const path = join(dir, rel)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, body)
      }
    }
    if (allow) {
      mkdirSync(join(dir, '.github'), { recursive: true })
      copyFileSync(REAL_ALLOWLIST, join(dir, '.github', 'privacy-guard-allow.txt'))
    }
    put(before)
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-q', '-m', 'base')
    sh(dir, 'checkout', '-q', '-b', 'pr')
    put(after)
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-q', '--allow-empty', '-m', 'pr')
    const r = spawnSync('node', [GUARD, '--base', 'main', '--head', 'pr', '--dir', dir], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PRIVATE_REPOS: 'secret-repo,other-one', ...env },
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('privacy guard: each rule fails once when its value is added', () => {
  const expected = {
    'private-ip': 'private-ip',
    'private-ip-172': 'private-ip',
    'private-ip-192': 'private-ip',
    'private-ip-tailnet': 'private-ip',
    'session-id': 'session-id',
    'tailnet-name': 'tailnet-name',
    'internal-host': 'internal-host',
    'private-repo': 'private-repo',
    email: 'email',
    'owner-quote': 'owner-quote',
  }
  for (const [name, rule] of Object.entries(expected)) {
    it(`fails on ${name}, naming the rule and the line but not the value`, () => {
      const r = guard({ after: { 'docs/note.md': `first\n${PLANT[name]}\n` } })
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, new RegExp(`docs/note\\.md:2: .*\\[${rule}\\]`))
      assert.doesNotMatch(r.out, /secret-repo|someone|0123abcd|dapyl/, 'the log must not repeat the value')
    })
  }

  it('fails on a new file under docs/desk, docs/handoff and briefs, whatever it says', () => {
    for (const dir of ['docs/desk', 'docs/handoff', 'briefs']) {
      const r = guard({ after: { [`${dir}/x.md`]: 'plain text\n' } })
      assert.equal(r.status, 1, `${dir}: ${r.out}`)
      assert.match(r.out, /\[new-file\]/)
    }
  })
})

describe('privacy guard: what it must let through', () => {
  it('passes a clean change', () => {
    const r = guard({ after: { 'docs/note.md': 'Shared CI for the sites.\nmailto:a@example.com\n' } })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /OK/)
  })

  it('never reads old content: a value already on the base branch is not a finding', () => {
    const r = guard({
      before: { 'old.md': `${PLANT['private-ip']}\n${PLANT['session-id']}\n`, 'README.md': 'hello\n' },
      after: { 'new.md': 'clean\n' },
    })
    assert.equal(r.status, 0, r.out)
  })

  it('reads only added lines: removing a bad line passes, and so does editing a clean one next to it', () => {
    const before = { 'old.md': `top\n${PLANT['private-ip']}\nbottom\n` }
    assert.equal(guard({ before, after: { 'old.md': 'top\nbottom\n' } }).status, 0)
    assert.equal(guard({ before, after: { 'old.md': `top changed\n${PLANT['private-ip']}\nbottom\n` } }).status, 0)
  })

  it('does catch a bad value added to a file that already had one', () => {
    const before = { 'old.md': `${PLANT['private-ip']}\n` }
    const r = guard({ before, after: { 'old.md': `${PLANT['private-ip']}\n${PLANT['session-id']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /old\.md:2: .*\[session-id\]/)
  })

  it('reads an added line that starts with ++ as content, not as a file header', () => {
    const r = guard({ after: { 'x.txt': `++${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
  })

  it('allows noreply addresses, the bot addresses already on main and example domains', () => {
    const lines = [
      `${'12345+bot' + '@'}users.noreply.github.com`,
      `${'noreply' + '@'}anthropic.com`,
      `${'ship-bot' + '@'}gorfed.net`,
      `${'git' + '@'}github.com:org/repo.git`,
      `${'t' + '@'}example.test`,
      'srcset hero@2x.png and actions/checkout@v4 and react@18.3.1',
    ]
    const r = guard({ after: { 'ok.md': `${lines.join('\n')}\n` } })
    assert.equal(r.status, 0, r.out)
  })

  it('does not flag a longer repository name that merely starts with a private one', () => {
    const r = guard({ after: { 'ok.md': `${'gorfednet' + '/'}secret-repo-two and ${'gorfednet' + '/'}.github\n` } })
    assert.equal(r.status, 0, r.out)
  })

  it('flags a private repository name case-insensitively and inside a URL', () => {
    const r = guard({ after: { 'x.md': `https://github.com/${'GorfedNet' + '/'}Secret-Repo/pull/3\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[private-repo\]/)
  })

  it('exempts a test fixture, and the owner-quote rule inside docs/claude-home only', () => {
    assert.equal(guard({ after: { 'test/fixtures/a.json': `${PLANT['private-ip']}\n` } }).status, 0)
    assert.equal(guard({ after: { 'docs/claude-home/rules/a.md': `${PLANT['owner-quote']}\n` } }).status, 0)
    const r = guard({ after: { 'docs/claude-home/rules/a.md': `${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, 'the claude-home exemption covers quotes, not addresses')
  })

  it('applies an exemption from the shipped allowlist only to its own rule', () => {
    const r = guard({ after: { 'scripts/privacy-guard.mjs': `${PLANT['internal-host']}\n${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[private-ip\]/)
    assert.doesNotMatch(r.out, /\[internal-host\]/)
  })
})

describe('privacy guard: it fails closed rather than pass having read nothing', () => {
  it('fails with a message when PRIVATE_REPOS is unset', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, env: { PRIVATE_REPOS: undefined } })
    assert.equal(r.status, 2, r.out)
    assert.match(r.out, /PRIVATE_REPOS is unset or empty/)
  })

  it('fails when PRIVATE_REPOS holds only separators', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, env: { PRIVATE_REPOS: ' , ,' } })
    assert.equal(r.status, 2, r.out)
  })

  it('fails on a PRIVATE_REPOS entry that is not a repository name', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, env: { PRIVATE_REPOS: 'fine,not a/name?' } })
    assert.equal(r.status, 2, r.out)
  })

  it('fails when the diff is empty, which a wrong base or head also produces', () => {
    const r = guard({ after: {} })
    assert.equal(r.status, 2, r.out)
    assert.match(r.out, /changes no files/)
  })

  it('fails when the base ref does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-guard-'))
    try {
      sh(dir, 'init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'a'), 'x\n')
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'a')
      const r = spawnSync('node', [GUARD, '--base', 'nope', '--head', 'main', '--dir', dir], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, PRIVATE_REPOS: 'secret-repo' },
      })
      assert.equal(r.status, 2, r.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails on an allowlist line it cannot read', () => {
    assert.throws(() => parseAllowlist('emial example.com\n'), /allowlist line 1/)
    assert.throws(() => parseAllowlist('path a/** not-a-rule\n'), /unknown rule/)
  })
})

describe('privacy guard: parsers', () => {
  it('parses PRIVATE_REPOS with or without the org prefix, and dedupes', () => {
    assert.deepEqual(parsePrivateRepos('a, GorfedNet/B\nc,a'), ['a', 'b', 'c'])
    assert.deepEqual(parsePrivateRepos(undefined), [])
  })

  it('reads hunk line numbers and skips deletions, binary files and /dev/null targets', () => {
    const diff = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -3,2 +3,3 @@',
      '-old',
      '+new one',
      '+new two',
      'diff --git a/gone.md b/gone.md',
      '--- a/gone.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/i.png b/i.png',
      'Binary files a/i.png and b/i.png differ',
    ].join('\n')
    assert.deepEqual(parseAddedLines(diff), [
      { path: 'a.md', line: 3, text: 'new one' },
      { path: 'a.md', line: 4, text: 'new two' },
    ])
  })

  it('counts a rename into a forbidden directory as new, and a rename inside it as old', () => {
    const z = (...p) => `${p.join('\0')}\0`
    assert.deepEqual(
      parseNewFiles(z('R100', 'a.md', 'docs/desk/a.md')).map((f) => f.path),
      ['docs/desk/a.md'],
    )
    assert.deepEqual(parseNewFiles(z('R100', 'docs/desk/a.md', 'docs/desk/b.md')), [])
    assert.deepEqual(parseNewFiles(z('M', 'a.md')), [])
  })
})

describe('privacy guard: the workflow', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'privacy-guard.yml'), 'utf8')

  it('runs on pull requests only, reads PRIVATE_REPOS from the secret, never a variable, and keeps if: !cancelled() on the assertion', () => {
    assert.match(wf, /^on:\n {2}pull_request:/m)
    assert.doesNotMatch(wf, /^ {2}push:/m)
    assert.match(wf, /PRIVATE_REPOS: \$\{\{ secrets\.PRIVATE_REPOS \}\}/)
    assert.doesNotMatch(wf, /vars\.PRIVATE_REPOS/)
    assert.match(wf, /if: \$\{\{ !cancelled\(\) \}\}\n\s+env:|if: \$\{\{ !cancelled\(\) \}\}\n\s+run:/)
  })

  it('diffs against the merge base with full history', () => {
    assert.match(wf, /fetch-depth: 0/)
    assert.match(wf, /--base "\$BASE_SHA" --head "\$HEAD_SHA"/)
  })
})
