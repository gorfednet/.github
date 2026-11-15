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
function guard({ before = { 'README.md': 'hello\n' }, after = {}, env = {}, allow = true, message = 'pr' } = {}) {
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
    sh(dir, 'commit', '-q', '--allow-empty', '-m', message)
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
    // The added line "++ /dev/null" shows in the diff as "+++ /dev/null". A parser that
    // takes it for a header drops the planted line after it.
    const r = guard({ after: { 'x.txt': `++ /dev/null\n${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /x\.txt:2: .*\[private-ip\]/)
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

  it('limits the fixtures exemption to test/fixtures, so another fixtures folder is no way round', () => {
    const r = guard({ after: { 'docs/handoff/fixtures/x.md': 'plain\n', 'docs/x/fixtures/y.md': `${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /docs\/handoff\/fixtures\/x\.md:1: .*\[new-file\]/)
    assert.match(r.out, /docs\/x\/fixtures\/y\.md:1: .*\[private-ip\]/)
  })

  it('does not let a change widen its own exemptions: the allowlist is read from the merge base', () => {
    const widened = 'path docs/** *\n'
    const r = guard({ after: { '.github/privacy-guard-allow.txt': widened, 'docs/x.md': `${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /docs\/x\.md:1: .*\[private-ip\]/)
  })

  it('treats no allowlist at the merge base as no exemptions', () => {
    const r = guard({ allow: false, after: { 'test/fixtures/a.json': `${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
  })

  it('does not go red on a value the same file already held: a reworded line, or a moved one', () => {
    const before = { 'old.md': `see ${PLANT['internal-host']} and ${PLANT['private-ip']}\n` }
    const r = guard({ before, after: { 'old.md': `reworded: ${PLANT['internal-host']} and ${PLANT['private-ip']} again\nmore\n` } })
    assert.equal(r.status, 0, r.out)
  })

  it('does go red on a different value in a file that held another, and on the same value in another file', () => {
    const before = { 'old.md': `${PLANT['private-ip']}\n` }
    assert.equal(guard({ before, after: { 'old.md': `${PLANT['private-ip']}\n${PLANT['private-ip-192']}\n` } }).status, 1)
    assert.equal(guard({ before, after: { 'copy.md': `${PLANT['private-ip']}\n` } }).status, 1)
  })
})

describe('privacy guard: it cannot be switched off by the change it reads', () => {
  it('reads a file that .gitattributes marks as not diffable', () => {
    const r = guard({ after: { '.gitattributes': '* -diff\n', 'docs/x.md': `${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /docs\/x\.md:1: .*\[private-ip\]/)
  })

  it('reads a file with a NUL byte, and a UTF-16 file', () => {
    const nul = guard({ after: { 'a.bin': Buffer.concat([Buffer.from('head\0\0'), Buffer.from(`${PLANT['private-ip']}\n`)]) } })
    assert.equal(nul.status, 1, nul.out)
    const utf16 = guard({ after: { 'b.txt': Buffer.from(`\ufeff${PLANT['session-id']}\n`, 'utf16le') } })
    assert.equal(utf16.status, 1, utf16.out)
  })

  it('skips an image by extension but still reads its path', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`${PLANT['private-ip']}`)])
    assert.equal(guard({ after: { 'logo.png': png } }).status, 0)
    const named = guard({ after: { [`img/${PLANT['internal-host']}.png`]: png } })
    assert.equal(named.status, 1, named.out)
  })

  it('reads CRLF files', () => {
    const r = guard({ after: { 'win.txt': `a\r\n${PLANT['private-ip']}\r\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /win\.txt:2:/)
  })
})

describe('privacy guard: surfaces besides added lines', () => {
  it('fails on a private value in an added file name, and says the file', () => {
    const r = guard({ after: { [`notes/${PLANT['session-id'].slice(4)}.md`]: 'plain\n' } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /notes\/local_.*\.md:1: .*\[session-id\]/)
  })

  it('fails on a private value in a commit message, and names the commit, not the text', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, message: `Fix it\n\n${PLANT['session-id']}` })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7,}: message line 3: .*\[session-id\]/)
    assert.doesNotMatch(r.out, /0123abcd/)
  })

  it('allows a noreply trailer in a commit message', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, message: 'Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com>' })
    assert.equal(r.status, 0, r.out)
  })

  it('treats the directory case-insensitively', () => {
    assert.equal(guard({ after: { 'Docs/Handoff/x.md': 'plain\n' } }).status, 1)
  })
})

describe('privacy guard: reports what it read, and annotates in Actions', () => {
  it('says how many lines, files, paths and commits it read', () => {
    const r = guard({ after: { 'a.md': 'one\ntwo\n', 'b.md': 'three\n' } })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /read 3 added line\(s\) in 2 file\(s\), 2 path\(s\) and 1 commit message\(s\)/)
  })

  it('writes ::error annotations with file and line under GITHUB_ACTIONS, and warns on a change to the guard', () => {
    const r = guard({
      after: { 'docs/note.md': `first\n${PLANT['private-ip']}\n`, 'scripts/privacy-guard.mjs': '// edit\n' },
      env: { GITHUB_ACTIONS: 'true' },
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /::error file=docs\/note\.md,line=2,title=privacy-guard::/)
    assert.match(r.out, /::warning title=privacy-guard::/)
  })
})

describe('privacy guard: near misses that must stay clean', () => {
  const clean = [
    '172.32.0.1',
    '172.15.255.1',
    '100.63.0.1',
    '100.128.0.1',
    '192.169.1.1',
    '11.0.0.1',
    '8.8.8.8',
    'version 10.0.0 and 10.1.2',
    'owner: "gorfednet"',
    'gorfednet/.github and gorfednet/secret-repo-two',
    'getty@tty1.service and hero@2x.png',
    'plain host names like hostname.example.com',
  ]
  for (const line of clean) {
    it(`passes: ${line}`, () => {
      const r = guard({ after: { 'ok.md': `${line}\n` } })
      assert.equal(r.status, 0, r.out)
    })
  }
})

describe('privacy guard: more shapes that must fail', () => {
  const bad = {
    'IPv6 unique-local': `addr ${['fd7a', '115c', 'a1e0', '', '1'].join(':')} here`,
    'IPv6 link-local': `addr ${['fe80', '', '1'].join(':')} here`,
    'host after an underscore': `${'DAPYL' + 'LIL'}_HOST=x and runner_${'dapyl' + 'lil'}`,
    'owner quote with a comma before the quote': `(${'owne' + 'r'}, 7 November 2026, "automate as much as you can")`,
    'owner quote, colon form with a sentence': `(${'owne' + 'r'}: "stop asking me in all sessions")`,
    'org given as an Actions expression': '${{ github.repository_owner }}/' + 'secret-repo',
    'org slash encoded': `${'gorfednet' + '%2F'}secret-repo`,
    'an address at a real top-level domain that looks like a file extension': `${'someone' + '@'}mail.md`,
  }
  for (const [name, line] of Object.entries(bad)) {
    it(`fails: ${name}`, () => {
      const r = guard({ after: { 'x.md': `${line}\n` } })
      assert.equal(r.status, 1, r.out)
    })
  }
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
