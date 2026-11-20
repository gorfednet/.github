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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  checkCounts,
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
function guard({
  before = { 'README.md': 'hello\n' },
  after = {},
  env = {},
  allow = true,
  message = 'pr',
  mergeMessage = null,
  mergeFiles = {},
  steps = [],
  head = 'pr',
} = {}) {
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
    // Further commits on the branch: { files, remove, message }. History is published whole.
    for (const step of steps) {
      put(step.files ?? {})
      for (const rel of step.remove ?? []) rmSync(join(dir, rel))
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '--allow-empty', '-m', step.message ?? 'step')
    }
    if (mergeMessage) {
      sh(dir, 'checkout', '-q', '-b', 'side', 'main')
      writeFileSync(join(dir, 'side.md'), 'clean\n')
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'side')
      sh(dir, 'checkout', '-q', 'pr')
      sh(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side')
      put(mergeFiles) // a hand edit inside the merge, the part a merge commit writes itself
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', mergeMessage)
    }
    const r = spawnSync('node', [GUARD, '--base', 'main', '--head', head, '--dir', dir], {
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

  it('lets a new design note under docs/plans through, and still reads what it says', () => {
    // main holds public design notes there; plan row 1.30 moves the plan of record, not these.
    assert.equal(guard({ after: { 'docs/plans/shared-ci.md': 'plain text\n' } }).status, 0)
    const r = guard({ after: { 'docs/plans/shared-ci.md': `${PLANT['private-ip']}\n` } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[private-ip\]/)
    assert.doesNotMatch(r.out, /\[new-file\]/)
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

  it('exempts a test fixture; docs/claude-home has no exemption left since its copy moved to ops (plan row 1.30)', () => {
    assert.equal(guard({ after: { 'test/fixtures/a.json': `${PLANT['private-ip']}\n` } }).status, 0)
    const r = guard({ after: { 'docs/claude-home/rules/a.md': `${PLANT['owner-quote']}\n` } })
    assert.equal(r.status, 1, 'an owner quote put back under docs/claude-home is refused like anywhere else')
    assert.match(r.out, /\[owner-quote\]/)
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

  it('does not let a held value excuse a longer or shorter one that contains it', () => {
    const org = 'gorfednet' + '/'
    const ip50 = ['10', '0', '0', '50'].join('.')
    const ip5 = ['10', '0', '0', '5'].join('.')
    const r = guard({
      before: { 'old.md': `${org}secret-repo-two and ${ip50}\n` },
      after: { 'old.md': `${org}secret-repo-two and ${ip50}\n${org}secret-repo\n${ip5}\n` },
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /old\.md:2: .*\[private-repo\]/)
    assert.match(r.out, /old\.md:3: .*\[private-ip\]/)
  })

  it('lets public files name a private repository the allowlist lists (ops), and no other', () => {
    const org = 'gorfednet' + '/'
    const r = guard({ after: { 'a.md': `${org}ops and ${org}secret-repo\n` }, env: { PRIVATE_REPOS: 'ops,secret-repo' } })
    assert.equal(r.status, 1, r.out)
    assert.equal((r.out.match(/\[private-repo\]/g) ?? []).length, 1, 'only secret-repo is a finding')
    assert.equal(guard({ after: { 'a.md': `${org}ops\n` }, env: { PRIVATE_REPOS: 'ops' } }).status, 0)
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

  it('reads a text file with an image name, and lets real image bytes through', () => {
    const real = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xd8, 0xfa, 0x10, 0x0a, 0x7f])
    assert.equal(guard({ after: { 'logo.png': real } }).status, 0, 'a real image has nothing to match')
    for (const name of ['notes.png', 'x.ico', 'f.woff2']) {
      const r = guard({ after: { [name]: `see ${PLANT['private-ip']}\n` } })
      assert.equal(r.status, 1, `${name}: ${r.out}`)
      assert.match(r.out, new RegExp(`${name.replace('.', '\\.')}:1: .*\\[private-ip\\]`))
    }
    const named = guard({ after: { [`img/${PLANT['internal-host']}.png`]: real } })
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
    assert.match(r.out, /path hash [0-9a-f]{8}:1: .*\[session-id\]/)
    assert.doesNotMatch(r.out, /local_[0-9a-f]|0123abcd|notes\//, 'a value in a file name must not reach the log')
    assert.doesNotMatch(r.out, /file=/, 'no annotation names the file')
  })

  it('fails on a private value in a commit message, and names the commit, not the text', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, message: `Fix it\n\n${PLANT['session-id']}` })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7,}: message line 3: .*\[session-id\]/)
    assert.doesNotMatch(r.out, /0123abcd/)
  })

  it('reads a commit message that holds control characters, and never prints it', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, message: `fix\u0001 and \u0002 see ${PLANT['session-id']}` })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7,}: message line 1: .*\[session-id\]/)
    assert.doesNotMatch(r.out, /0123abcd/)
  })

  it('reads the message of a merge commit the branch wrote', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, mergeMessage: `sync main, see ${PLANT['session-id']}` })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7,}: message line 1: .*\[session-id\]/)
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
    // Code, not quotes: owner destructured beside a number and a string, or owner as a key.
    `run({ ${'owne' + 'r'}, n: 2, title: "a b" })`,
    `{ ${'owne' + 'r'}: "the org" }`,
    `  ${'owne' + 'r'}: "the org",`,
    `x, ${'owne' + 'r'}: "a b"`,
    `readMeter({ ${'owne' + 'r'}, now = new Date(), cap, json })`,
    // A key first on its line, in an object literal: the value ends the line with a comma or a brace.
    `  ${'owne' + 'r'}: "the org" }`,
    `${'owne' + 'r'}: "the org",`,
    'needs v10.1.2 and 10.1.2',
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
    'owner quote with an ISO date': `(${'owne' + 'r'}, 2026-10-19: "do it")`,
    'owner quote with the month first': `(${'owne' + 'r'}, Nov 7, 2026: "do it")`,
    'owner quote with a time after the date': `(${'owne' + 'r'}, 16 Nov 2026, 07:23 ET: "do it")`,
    'owner quote, colon form after a dash': `- ${'owne' + 'r'}: "stop asking me"`,
    'owner quote with an ordinal date': `(${'owne' + 'r'}, 7th November 2026: "do it")`,
    'owner quote with a weekday first': `(${'owne' + 'r'}, Saturday 14 November 2026: "do it")`,
    'owner quote with on before the date': `(${'owne' + 'r'}, on 14 November 2026: "do it")`,
    'owner quote with a slashed date': `(${'owne' + 'r'}, 11/14/2026: "do it")`,
    'owner quote, colon form first on its line': `${'owne' + 'r'}: "stop asking me now"`,
    'owner quote, colon form first on an indented line': `  ${'owne' + 'r'}: "stop asking me now"`,
    'a v stuck to a four-part address': `see v${['10', '0', '0', '5'].join('.')} now`,
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

  it('exits 3, its own code, when the range holds no commits: a wrong base or head, or nothing outgoing', () => {
    const r = guard({ after: { 'ok.md': 'clean\n' }, head: 'main' })
    assert.equal(r.status, 3, r.out)
    assert.match(r.out, /nothing to read/)
  })

  it('reads the message of a commit that changes no files, and does not call it nothing to read', () => {
    const bad = guard({ after: {}, message: `empty, see ${PLANT['session-id']}` })
    assert.equal(bad.status, 1, bad.out)
    assert.match(bad.out, /commit [0-9a-f]{7,}: message line 1: .*\[session-id\]/)
    assert.equal(guard({ after: {}, message: 'empty and clean' }).status, 0)
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
    assert.match(wf, /git show "\$BASE_SHA:scripts\/privacy-guard\.mjs"/)
    assert.doesNotMatch(wf, /node scripts\/privacy-guard\.mjs/, 'the guard must run from the base, not the head')
  })
})

describe('privacy guard: history is published whole, not just its net diff', () => {
  it('fails on a value one commit adds and the next removes', () => {
    const r = guard({
      after: { 'a.md': `top\n${PLANT['private-ip']}\n` },
      steps: [{ files: { 'a.md': 'top\n' }, message: 'remove it' }],
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7}: a\.md:2: .*\[private-ip\]/)
    assert.doesNotMatch(r.out, /10\.0\.0/, 'the log must not repeat the value')
  })

  it('fails on a whole file one commit adds and the next deletes', () => {
    const r = guard({
      after: { 'docs/notes/x.md': `${PLANT['session-id']}\n` },
      steps: [{ remove: ['docs/notes/x.md'], message: 'delete it' }],
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[session-id\]/)
  })

  it('fails on a forbidden new file that a later commit deletes', () => {
    const r = guard({
      after: { 'docs/handoff/x.md': 'plain\n' },
      steps: [{ remove: ['docs/handoff/x.md'], message: 'delete it' }],
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[new-file\]/)
  })

  it('passes a branch whose commits are each clean', () => {
    const r = guard({ after: { 'a.md': 'one\n' }, steps: [{ files: { 'b.md': 'two\n' } }, { files: { 'a.md': 'one\nmore\n' } }] })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /each of 3 commit diff\(s\) on its own/)
  })

  it('reads the lines a merge commit wrote by hand, and not the lines it brought from the other side', () => {
    const brought = guard({ after: { 'ok.md': 'clean\n' }, mergeMessage: 'sync main', mergeFiles: {} })
    assert.equal(brought.status, 0, brought.out)
    const evil = guard({ after: { 'ok.md': 'clean\n' }, mergeMessage: 'sync main', mergeFiles: { 'hand.md': `${PLANT['private-ip']}\n` } })
    assert.equal(evil.status, 1, evil.out)
  })

  it('does not read what the branch merged in from the base branch', () => {
    // main moves on with a bad line, and the branch merges it in: that line is public already.
    const dir = mkdtempSync(join(tmpdir(), 'privacy-guard-'))
    try {
      sh(dir, 'init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'a.md'), 'base\n')
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'base')
      sh(dir, 'checkout', '-q', '-b', 'pr')
      writeFileSync(join(dir, 'mine.md'), 'clean\n')
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'mine')
      sh(dir, 'checkout', '-q', 'main')
      writeFileSync(join(dir, 'theirs.md'), `${PLANT['private-ip']}\n`)
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'main moves on')
      sh(dir, 'checkout', '-q', 'pr')
      sh(dir, 'merge', '-q', '--no-ff', 'main', '-m', 'sync main')
      const r = spawnSync('node', [GUARD, '--base', 'main', '--head', 'pr', '--dir', dir], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, PRIVATE_REPOS: 'secret-repo' },
      })
      assert.equal(r.status, 0, r.stdout + r.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('privacy guard: a bare private repository name in a list-like file', () => {
  const list = 'secret-repo\t2026-11-14\tprivate\nother-one\t2026-11-14\tprivate\n'
  it('fails on a new TSV, CSV or text file listing bare names, the shape the first leak had', () => {
    for (const name of ['docs/plans/baseline.tsv', 'notes/repos.csv', 'notes/repos.txt']) {
      const r = guard({ after: { [name]: list } })
      assert.equal(r.status, 1, `${name}: ${r.out}`)
      assert.match(r.out, /\[private-repo\]/)
      assert.doesNotMatch(r.out, /secret-repo|other-one/)
    }
  })

  it('fails on a bare name added to a list-like file that already existed', () => {
    const r = guard({ before: { 'repos.txt': 'public-thing\n' }, after: { 'repos.txt': 'public-thing\nsecret-repo\n' } })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /repos\.txt:2: .*\[private-repo\]/)
  })

  it('leaves longer names alone, and a name the allowlist lists', () => {
    assert.equal(guard({ after: { 'a.md': 'the secret-repo is mentioned in prose\n' } }).status, 1, 'an unsaid name is read in prose too')
    assert.equal(guard({ after: { 'a.txt': 'secret-repo-two\nmy.secret-repo\nsecret-repos\n' } }).status, 0)
    assert.equal(guard({ after: { 'a.tsv': 'ops\t1\n' }, env: { PRIVATE_REPOS: 'ops' } }).status, 0)
  })

  it('does not go red on a bare name the file already held', () => {
    const r = guard({ before: { 'repos.txt': 'secret-repo\n' }, after: { 'repos.txt': 'secret-repo\nplain\n' } })
    assert.equal(r.status, 0, r.out)
  })
})

describe('privacy guard: it runs however it is reached', () => {
  it('runs, and finds the value, when started through a symlinked path', () => {
    // Without a real-path comparison the script takes itself for an import and exits 0, reading nothing.
    const tmp = mkdtempSync(join(tmpdir(), 'privacy-guard-link-'))
    try {
      const link = join(tmp, 'guard.mjs')
      symlinkSync(GUARD, link)
      const dir = join(tmp, 'repo')
      mkdirSync(dir)
      sh(dir, 'init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'a.md'), 'x\n')
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'base')
      sh(dir, 'checkout', '-q', '-b', 'pr')
      writeFileSync(join(dir, 'b.md'), `${PLANT['private-ip']}\n`)
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'work')
      const r = spawnSync('node', [link, '--base', 'main', '--head', 'pr', '--dir', dir], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, PRIVATE_REPOS: 'secret-repo' },
      })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /\[private-ip\]/, 'it read the change, not just exited')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('runs through a symlink under --preserve-symlinks-main too', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'privacy-guard-link-'))
    try {
      const link = join(tmp, 'guard.mjs')
      symlinkSync(GUARD, link)
      const dir = join(tmp, 'repo')
      mkdirSync(dir)
      sh(dir, 'init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'a.md'), 'x\n')
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'base')
      sh(dir, 'checkout', '-q', '-b', 'pr')
      writeFileSync(join(dir, 'b.md'), `${PLANT['private-ip']}\n`)
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'work')
      const r = spawnSync('node', ['--preserve-symlinks-main', link, '--base', 'main', '--head', 'pr', '--dir', dir], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, PRIVATE_REPOS: 'secret-repo' },
      })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /\[private-ip\]/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})


/**
 * A repository built by a callback: `base` is main, `pr` is the branch under test. The
 * callback gets { commit, put, sh, branch, checkout, merge }. `args` adds guard arguments
 * once the history exists; `node` adds node arguments.
 */
function scenario(build, { env = {}, args = () => [], node = [], allow = true } = {}) {
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
    if (allow) put({ '.github/privacy-guard-allow.txt': readFileSync(REAL_ALLOWLIST, 'utf8') })
    const api = {
      dir,
      sh: (...a) => sh(dir, ...a),
      put,
      commit(message = 'c', files = {}, remove = []) {
        put(files)
        for (const rel of remove) rmSync(join(dir, rel))
        sh(dir, 'add', '-A')
        sh(dir, 'commit', '-q', '--allow-empty', '-m', message)
        return sh(dir, 'rev-parse', 'HEAD').trim()
      },
      branch: (name, from) => sh(dir, 'checkout', '-q', '-b', name, ...(from ? [from] : [])),
      checkout: (name) => sh(dir, 'checkout', '-q', name),
      // A merge with a hand edit inside it: what the merge commit itself writes.
      merge(other, message, edit = {}, remove = []) {
        sh(dir, 'merge', '-q', '--no-ff', '--no-commit', ...(other.startsWith('--') ? [other] : [other]))
        put(edit)
        for (const rel of remove) rmSync(join(dir, rel))
        sh(dir, 'add', '-A')
        sh(dir, 'commit', '-q', '-m', message)
      },
    }
    build(api)
    const r = spawnSync('node', [...node, GUARD, '--base', 'main', '--head', 'pr', '--dir', dir, ...args(dir)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PRIVATE_REPOS: 'secret-repo,other-one', ...env },
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sha1 = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8)
// A side branch cut from main with one commit, to merge into pr.
const withSide = (a, files = { 'side.md': 'clean\n' }) => {
  a.commit('base', { 'README.md': 'hello\n' })
  a.branch('side')
  a.commit('side', files)
  a.checkout('main')
  a.branch('pr')
}

describe('privacy guard: a merge commit is read for paths and new files too', () => {
  it('fails on a file a merge adds by hand under a forbidden directory', () => {
    const r = scenario((a) => {
      withSide(a)
      a.merge('side', 'sync', { 'docs/handoff/hand.md': 'plain\n' })
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[new-file\]/)
  })

  it('fails on a file a merge adds by hand whose name holds a value, and hides the name', () => {
    const name = `notes/${PLANT['session-id'].slice(4)}.md`
    const r = scenario((a) => {
      withSide(a)
      a.merge('side', 'sync', { [name]: 'plain\n' })
      a.commit('remove it', {}, [name])
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7}: path hash [0-9a-f]{8}:1: .*\[session-id\]/)
    assert.doesNotMatch(r.out, /0123abcd/)
  })

  it('fails on a forbidden file a merge adds and a later commit deletes', () => {
    const r = scenario((a) => {
      withSide(a)
      a.merge('side', 'sync', { 'docs/handoff/hand.md': 'plain\n' })
      a.commit('remove it', {}, ['docs/handoff/hand.md'])
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7}: docs\/handoff\/hand\.md:1: .*\[new-file\]/)
  })

  it('fails on a line a merge wrote by hand and a later commit removed, naming the merge commit', () => {
    const r = scenario((a) => {
      withSide(a)
      a.merge('side', 'sync', { 'hand.md': `${PLANT['private-ip']}\n` })
      a.commit('remove it', {}, ['hand.md'])
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7}: hand\.md:1: .*\[private-ip\]/)
  })

  it('does not read a forbidden file or a valued name that came in from the other side', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('mine', { 'mine.md': 'clean\n' })
      a.checkout('main')
      a.commit('main moves on', { 'docs/handoff/theirs.md': 'plain\n', [`n/${PLANT['session-id'].slice(4)}.md`]: 'x\n' })
      a.checkout('pr')
      a.sh('merge', '-q', '--no-ff', 'main', '-m', 'sync main')
    })
    assert.equal(r.status, 0, r.out)
  })

  it('reads a root commit a merge brings in, against the empty tree', () => {
    const bad = (extra) =>
      scenario((a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        a.commit('mine', { 'mine.md': 'clean\n' })
        a.sh('checkout', '-q', '--orphan', 'other')
        a.sh('rm', '-rfq', '.')
        a.commit('unrelated root', { 'root.md': extra })
        a.checkout('pr')
        a.sh('merge', '-q', '--allow-unrelated-histories', '--no-ff', 'other', '-m', 'bring it in')
        a.commit('drop it again', {}, ['root.md'])
      })
    // The later commit removes the file, so only reading the root commit itself finds the value.
    const found = bad(`${PLANT['private-ip']}\n`)
    assert.equal(found.status, 1, found.out)
    assert.match(found.out, /commit [0-9a-f]{7}: root\.md:1: .*\[private-ip\]/)
    assert.equal(bad('clean\n').status, 0)
  })
})

describe('privacy guard: a value in a file name never reaches the log', () => {
  const valued = `notes/${PLANT['session-id'].slice(4)}.md`
  it('prints a hash of the path in place of the path, for every finding in that file, and no file annotation', () => {
    const r = scenario(
      (a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        a.commit('work', { [valued]: `${PLANT['private-ip']}\n` })
      },
      { env: { GITHUB_ACTIONS: 'true' } },
    )
    assert.equal(r.status, 1, r.out)
    const hash = sha1(valued)
    assert.match(r.out, new RegExp(`path hash ${hash}:1: .*\\[session-id\\]`))
    assert.match(r.out, new RegExp(`path hash ${hash}:1: .*\\[private-ip\\]`), 'the content finding in the same file is masked too')
    assert.doesNotMatch(r.out, /local_[0-9a-f]|0123abcd|notes\/|file=/)
  })

  it('still names a path that holds no value', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('work', { 'docs/x.md': `${PLANT['private-ip']}\n` })
    })
    assert.match(r.out, /docs\/x\.md:1: .*\[private-ip\]/)
  })

  it('says in the unset error that the secret is one name per line', () => {
    const r = scenario((a) => a.commit('base', { 'a.md': 'x\n' }), { env: { PRIVATE_REPOS: '' } })
    assert.equal(r.status, 2)
    assert.match(r.out, /ONE PER LINE/)
  })

  it('reads a newline-separated secret as separate names', () => {
    assert.deepEqual(parsePrivateRepos('name-one\nname-two\r\nname-three'), ['name-one', 'name-two', 'name-three'])
    assert.deepEqual(parsePrivateRepos('name-one,name-two'), ['name-one', 'name-two'])
  })
})

describe('privacy guard: a commit message that cannot be rewritten can be exempted', () => {
  const allowWith = (sha) => (dir) => {
    const file = join(dir, '..', `allow-${sha.slice(0, 7)}.txt`)
    writeFileSync(file, `commit ${sha}\n`)
    return ['--allow', file]
  }
  const build = (a) => {
    a.commit('base', { 'README.md': 'hello\n' })
    a.branch('pr')
    a.commit(`see ${PLANT['session-id']}`, { 'a.md': 'clean\n' })
    a.commit('next', { 'b.md': 'clean\n' })
  }

  it('fails without the exemption', () => {
    assert.equal(scenario(build).status, 1)
  })

  it('passes when the allowlist names that commit by its full id', () => {
    let head
    const r = scenario(
      (a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        head = a.commit(`see ${PLANT['session-id']}`, { 'a.md': 'clean\n' })
        a.commit('next', { 'b.md': 'clean\n' })
      },
      { args: (dir) => allowWith(head)(dir) },
    )
    assert.equal(r.status, 0, r.out)
  })

  it('exempts that commit only: never a value still in the final tree, and not another commit\'s message', () => {
    let first
    const lines = scenario(
      (a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        first = a.commit(`see ${PLANT['session-id']}`, { 'a.md': `${PLANT['private-ip']}\n` })
      },
      { args: (dir) => allowWith(first)(dir) },
    )
    assert.equal(lines.status, 1, lines.out)
    assert.match(lines.out, /\[private-ip\]/)
    let other
    const second = scenario(
      (a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        other = a.commit('clean one', { 'a.md': 'clean\n' })
        a.commit(`see ${PLANT['session-id']}`, { 'b.md': 'clean\n' })
      },
      { args: (dir) => allowWith(other)(dir) },
    )
    assert.equal(second.status, 1, second.out)
    assert.match(second.out, /message line 1/)
  })

  it('is a parse error when the sha is short or not hex, never a silent no-op', () => {
    // A short prefix could be matched by a commit made to share it, so only the full id counts.
    assert.throws(() => parseAllowlist('commit abc12\n'), /allowlist line 1/)
    assert.throws(() => parseAllowlist('commit abcdef1\n'), /allowlist line 1/)
    assert.throws(() => parseAllowlist(`commit ${'a'.repeat(39)}\n`), /allowlist line 1/)
    assert.throws(() => parseAllowlist('commit zzzzzzzz\n'), /allowlist line 1/)
    assert.deepEqual(parseAllowlist(`commit ${'ABCDEF12'.repeat(5)}\n`).commits, ['abcdef12'.repeat(5)])
  })
})

describe('privacy guard: a false positive in a commit that is not the tip can be cleared without a rewrite', () => {
  const allowWith = (...shas) => (dir) => {
    const file = join(dir, '..', `allow-own-${shas[0].slice(0, 7)}.txt`)
    writeFileSync(file, shas.map((sha) => `commit ${sha}\n`).join(''))
    return ['--allow', file]
  }
  const ip = ['10', '0', '0', '5'].join('.')
  // c1 adds a value, c2 fixes it forward: only c1's own diff still holds it.
  const fixedForward = (keep) => (a) => {
    a.commit('base', { 'README.md': 'hello\n' })
    a.branch('pr')
    keep.c1 = a.commit('add', { 'a.md': `top\nserver ${ip}\n` })
    keep.c2 = a.commit('fix forward', { 'a.md': 'top\n' })
  }

  it('stays red after a fix forward, and names the full commit id and the way out', () => {
    const keep = {}
    const r = scenario(fixedForward(keep))
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7}: a\.md:2: .*\[private-ip\]/)
    assert.ok(r.out.includes(keep.c1), 'the advice gives the full id the allowlist line needs')
    assert.match(r.out, /adds `commit <full sha>` to the allowlist/)
  })

  it('passes once main\'s allowlist names that commit, and says it exempted one', () => {
    const keep = {}
    const r = scenario(fixedForward(keep), { args: (dir) => allowWith(keep.c1)(dir) })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /1 commit\(s\) had findings in their own diff or message that a `commit <sha>` allowlist line exempts/)
  })

  it('reads the line from main\'s tip, so an allowlist PR merged after the branch forked clears it with no merge of main', () => {
    const keep = {}
    const allowLine = (where) => (a) => {
      fixedForward(keep)(a)
      a.checkout(where)
      const base = readFileSync(join(a.dir, '.github', 'privacy-guard-allow.txt'), 'utf8')
      a.commit('allow it', { '.github/privacy-guard-allow.txt': `${base}commit ${keep.c1}\n` })
      a.checkout('pr')
    }
    const onMain = scenario(allowLine('main'))
    assert.equal(onMain.status, 0, onMain.out)
    assert.match(onMain.out, /1 commit\(s\) had findings/)
    // Near miss: the same line on a branch main has not merged counts for nothing.
    const onSide = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('side')
      a.checkout('main')
      a.branch('pr')
      keep.c1 = a.commit('add', { 'a.md': `top\nserver ${ip}\n` })
      a.commit('fix forward', { 'a.md': 'top\n' })
      a.checkout('side')
      const base = readFileSync(join(a.dir, '.github', 'privacy-guard-allow.txt'), 'utf8')
      a.commit('allow it', { '.github/privacy-guard-allow.txt': `${base}commit ${keep.c1}\n` })
      a.checkout('pr')
    })
    assert.equal(onSide.status, 1, onSide.out)
    assert.match(onSide.out, /then edit this pull request/)
  })

  it('never exempts the net diff: a value still in the final tree stays red', () => {
    const keep = {}
    const r = scenario(
      (a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        keep.c1 = a.commit('add', { 'a.md': `server ${ip}\n` })
      },
      { args: (dir) => allowWith(keep.c1)(dir) },
    )
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /a\.md:1: .*\[private-ip\]/)
  })

  it('exempts only the named commit: the same value added again by a later one stays red', () => {
    const keep = {}
    const r = scenario(
      (a) => {
        fixedForward(keep)(a)
        keep.c3 = a.commit('again', { 'a.md': `top\nserver ${ip}\n` })
        a.commit('fix again', { 'a.md': 'top\n' })
      },
      { args: (dir) => allowWith(keep.c1)(dir) },
    )
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, new RegExp(`commit ${keep.c3.slice(0, 7)}: a\\.md:2: .*\\[private-ip\\]`))
  })

  it('cannot be granted by the change itself: an allowlist line the branch adds does nothing', () => {
    const keep = {}
    const r = scenario((a) => {
      fixedForward(keep)(a)
      a.commit('exempt myself', { '.github/privacy-guard-allow.txt': `commit ${keep.c1}\n` })
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[private-ip\]/)
  })
})

describe('privacy guard: bare names, in more shapes and places', () => {
  // Most private repositories are named for public sites the repository already says, so a bare
  // name is watched only while the merge base has never said it. The test names are not in base.
  const shapes = {
    'a markdown table': ['docs/t.md', '| name | note |\n|---|---|\n| secret-repo | x |\n'],
    'a JSON array': ['data/r.json', '[\n  "secret-repo",\n  "plain"\n]\n'],
    'a YAML list': ['data/r.yml', 'repos:\n  - secret-repo\n  - plain\n'],
    'an extensionless list': ['data/repos', 'secret-repo\nplain\n'],
    'a .tab file': ['data/r.tab', 'secret-repo\tx\n'],
    'a name with .git in a text file': ['data/r.txt', 'secret-repo.git\n'],
    'a YAML value': ['data/c.yml', 'repo: secret-repo\n'],
    'an env line': ['data/c.env.example', 'REPO=secret-repo\n'],
    'a command line': ['docs/run.md', 'run `cd ../secret-repo` then `tool --repo secret-repo`\n'],
    'an HTML cell': ['docs/t.html', '<td>secret-repo</td>\n'],
    'a bold bullet': ['docs/b.md', '* **secret-repo**\n1. secret-repo\n- secret-repo (private)\n'],
    'a sentence': ['docs/p.md', 'the secret-repo is mentioned in prose\n'],
    'a wiki remote': ['docs/w.md', 'clone secret-repo.wiki.git for the notes\n'],
    'a wiki name': ['docs/w2.md', 'the secret-repo.wiki has the notes\n'],
    'a file name in prose': ['docs/f.md', 'see secret-repo.md for the notes\n'],
    'a name before an underscore': ['docs/u.md', 'the secret-repo_notes folder\n'],
    'a name after an underscore': ['data/u.env.example', 'OLD_secret-repo=1\n'],
  }
  for (const [what, [path, body]] of Object.entries(shapes)) {
    it(`fails on a bare name in ${what}`, () => {
      const r = scenario((a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        a.commit('work', { [path]: body })
      })
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, /\[private-repo\]/)
      assert.doesNotMatch(r.out, /secret-repo/)
    })
  }

  it('fails on the name as a directory and as a file name, and hides the path', () => {
    for (const path of ['docs/secret-repo/x.md', 'secret-repo.txt', 'docs/secret-repo.md']) {
      const r = scenario((a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        a.commit('work', { [path]: 'plain\n' })
      })
      assert.equal(r.status, 1, `${path}: ${r.out}`)
      assert.match(r.out, /path hash [0-9a-f]{8}:1: .*\[private-repo\]/)
      assert.doesNotMatch(r.out, /secret-repo/)
    }
  })

  it('fails on the name in a commit message', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('port the old secret-repo notes', { 'a.md': 'clean\n' })
    })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /commit [0-9a-f]{7}: message line 1: .*\[private-repo\]/)
  })

  it('still reads a bare list the way the 14 November leak was shaped: tabs, one name a line, under docs/plans', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('work', { 'data/baseline.tsv': 'secret-repo\t2026-11-14\tprivate\nother-one\t2026-11-14\tprivate\n' })
    })
    assert.equal(r.status, 1, r.out)
    assert.equal((r.out.match(/\[private-repo\]/g) ?? []).length, 2, 'one finding for each name')
  })

  it('leaves longer names and path parts that only contain the name alone', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('the secret-repoish thing', {
        'docs/a.md': 'secret-repos and secret-repo-two and x.secret-repo are different names\n',
        'docs/secret-repo-notes.md': 'plain\n',
        'data/r.txt': 'secret-repo-two\nmy.secret-repo\nsecret-repos\n',
      })
    })
    // The commit message holds the word-like "secret-repoish" only: not the name as a whole word.
    assert.equal(r.status, 0, r.out)
  })

  it('keeps watching a name the merge base only says inside a longer name or a host', () => {
    for (const says of ['secret-repo-two\n', 'secret-repo.example.com\n', 'the-secret-repo-notes\n']) {
      const r = scenario((a) => {
        a.commit('base', { 'README.md': says })
        a.branch('pr')
        a.commit('work', { 'data/r.tsv': 'secret-repo\tx\n' })
      })
      assert.equal(r.status, 1, `${says.trim()}: ${r.out}`)
    }
  })

  it('reads a name the merge base already says on a line that says it is private', () => {
    const says = { 'README.md': 'we also keep secret-repo around\n' }
    for (const body of ['secret-repo\t2026-11-14\tprivate\n', '- secret-repo (private)\n', 'secret-repo, visibility: internal\n']) {
      const r = scenario((a) => {
        a.commit('base', says)
        a.branch('pr')
        a.commit('work', { 'data/r.tsv': body })
      })
      assert.equal(r.status, 1, `${body.trim()}: ${r.out}`)
      assert.match(r.out, /\[private-repo\]/)
      assert.doesNotMatch(r.out, /secret-repo/)
    }
    const message = scenario((a) => {
      a.commit('base', says)
      a.branch('pr')
      a.commit('make secret-repo private', { 'a.md': 'clean\n' })
    })
    assert.equal(message.status, 1, message.out)
  })

  it('leaves a said name alone on a line that says private only as part of a word', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'we also keep secret-repo around\n' })
      a.branch('pr')
      a.commit('work', { 'docs/a.md': 'secret-repo is run privately\nsecret-repo uses a_private_key\n' })
    })
    assert.equal(r.status, 0, r.out)
  })

  it('leaves a name inside a host or before a second extension alone', () => {
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('work', { 'docs/a.md': 'secret-repo.example.com and secret-repo.md.example.com\n' })
    })
    assert.equal(r.status, 0, r.out)
  })

  it('stops watching a name the merge base already says, and still reads the org-prefixed form', () => {
    const org = 'gorfednet' + '/'
    const says = { 'README.md': 'we also keep secret-repo around\n' }
    const bare = scenario((a) => {
      a.commit('base', says)
      a.branch('pr')
      a.commit('work', { 'data/r.tsv': 'secret-repo\tx\n' })
    })
    assert.equal(bare.status, 0, bare.out)
    const prefixed = scenario((a) => {
      a.commit('base', says)
      a.branch('pr')
      a.commit('work', { 'a.md': `see ${org}secret-repo\n` })
    })
    assert.equal(prefixed.status, 1, prefixed.out)
  })
})

describe('privacy guard: a value the base held in general is not an excuse for a specific one', () => {
  it('reads a full tailnet host name when the base only names the suffix', () => {
    const suffix = '.' + ['ts', 'net'].join('.')
    const r = scenario((a) => {
      a.commit('base', { 'notes.md': `hosts end in ${suffix}\n` })
      a.branch('pr')
      a.commit('work', { 'notes.md': `hosts end in ${suffix}\nssh box.${['tail1234', 'ts', 'net'].join('.')}\n` })
    })
    assert.equal(r.status, 1, r.out)
  })

  it('reads a new owner quote in a file whose marker the base already held', () => {
    const quote = (n) => `(${'owne' + 'r'}, 3 Jan 2026: "${n}")`
    const r = scenario((a) => {
      a.commit('base', { 'notes.md': `${quote('first')}\n` })
      a.branch('pr')
      a.commit('work', { 'notes.md': `${quote('first')}\n${quote('second')}\n` })
    })
    assert.equal(r.status, 1, r.out)
    assert.equal(scenario((a) => {
      a.commit('base', { 'notes.md': `${quote('first')}\n` })
      a.branch('pr')
      a.commit('work', { 'notes.md': `intro\n${quote('first')}\n` })
    }).status, 0, 'the same quote, moved')
    assert.equal(scenario((a) => {
      a.commit('base', { 'notes.md': `${quote('first')} said so.\n` })
      a.branch('pr')
      a.commit('work', { 'notes.md': `${quote('first')} said so, twice.\n` })
    }).status, 0, 'text edited after a quote the base already held')
  })
})

describe('privacy guard: changes that no pull request could clear stay green', () => {
  it('does not go red on a rename that also adds a value the file already held', () => {
    const r = scenario((a) => {
      const body = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'
      a.commit('base', { 'old.md': `${body}${PLANT['private-ip']}\n` })
      a.branch('pr')
      a.sh('mv', 'old.md', 'new.md')
      a.commit('move and extend', { 'new.md': `${body}${PLANT['private-ip']}\nalso ${PLANT['private-ip']}\n` })
    })
    assert.equal(r.status, 0, r.out)
  })

  it('carries a rename across commits: renamed in one, a value the file held added in the next', () => {
    const r = scenario((a) => {
      const body = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'
      a.commit('base', { 'old.md': `${body}${PLANT['private-ip']}\n` })
      a.branch('pr')
      a.sh('mv', 'old.md', 'new.md')
      a.commit('move', {})
      a.commit('extend', { 'new.md': `${body}${PLANT['private-ip']}\nalso ${PLANT['private-ip']}\n` })
    })
    assert.equal(r.status, 0, r.out)
  })

  it('reads a file whose name holds a quote, a backslash or a tab, and never prints it', () => {
    for (const name of ['docs/a"b.md', 'docs/a\\b.md', 'docs/a\tb.md', 'docs/a"\u{1F600}.md']) {
      const clean = scenario((a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        a.commit('work', { [name]: 'plain\n' })
        a.commit('rename', {})
      })
      assert.equal(clean.status, 0, `${JSON.stringify(name)}: ${clean.out}`)
      const bad = scenario((a) => {
        a.commit('base', { 'README.md': 'hello\n' })
        a.branch('pr')
        a.commit('work', { [name]: `${PLANT['private-ip']}\n` })
      })
      assert.equal(bad.status, 1, `${JSON.stringify(name)}: ${bad.out}`)
      assert.match(bad.out, /\[private-ip\]/)
    }
  })

  it('finishes on one very long line with no spaces', () => {
    const started = Date.now()
    const r = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('work', { 'blob.txt': `${'ab0'.repeat(30000)}\n` })
    })
    assert.equal(r.status, 0, r.out)
    assert.ok(Date.now() - started < 20000, 'a long token must not make the email rule quadratic')
  })

  it('does not call a restored file new: deleted, then put back, under a forbidden directory', () => {
    const r = scenario((a) => {
      a.commit('base', { 'docs/handoff/old.md': 'plain\n' })
      a.branch('pr')
      a.commit('delete', {}, ['docs/handoff/old.md'])
      a.commit('restore', { 'docs/handoff/old.md': 'plain\n' })
    })
    assert.equal(r.status, 0, r.out)
    const fresh = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('add', { 'docs/handoff/new.md': 'plain\n' })
    })
    assert.equal(fresh.status, 1, fresh.out)
  })

  it('does not go red on a restored file whose name already held a value at the base', () => {
    const name = `notes/${PLANT['session-id'].slice(4)}.md`
    const r = scenario((a) => {
      a.commit('base', { [name]: 'plain\n' })
      a.branch('pr')
      a.commit('delete', {}, [name])
      a.commit('restore', { [name]: 'plain\n' })
    })
    assert.equal(r.status, 0, r.out)
  })

  it('lets the allowlist add a `repo <name>` line for a name the base already says, and refuses one for a name it never said', () => {
    const real = readFileSync(REAL_ALLOWLIST, 'utf8')
    const add = (readme) =>
      scenario((a) => {
        a.commit('base', { 'README.md': readme })
        a.branch('pr')
        a.commit('allow it', { '.github/privacy-guard-allow.txt': `${real}repo secret-repo\n` })
      })
    assert.equal(add('we keep secret-repo around\n').status, 0)
    const unsaid = add('hello\n')
    assert.equal(unsaid.status, 1, unsaid.out)
    assert.match(unsaid.out, /privacy-guard-allow\.txt:\d+: .*\[private-repo\]/)
  })
})

describe('privacy guard: a deleted or renamed file git calls binary can pass', () => {
  const nul = (extra = '') => Buffer.concat([Buffer.from('head\0\0\n'), Buffer.from(`${extra}line\n`)])
  const off = { '.gitattributes': '* -diff\n' }

  it('passes the deletion of a file that has a NUL byte and a -diff attribute', () => {
    const r = scenario((a) => {
      a.commit('base', { ...off, 'a.bin': nul() })
      a.branch('pr')
      a.commit('delete', {}, ['a.bin'])
    })
    assert.equal(r.status, 0, r.out)
  })

  it('passes a rename that changes nothing, and a -diff file that only loses lines', () => {
    const renamed = scenario((a) => {
      a.commit('base', { ...off, 'a.bin': nul() })
      a.branch('pr')
      a.sh('mv', 'a.bin', 'b.bin')
      a.commit('rename', {})
    })
    assert.equal(renamed.status, 0, renamed.out)
    const shorter = scenario((a) => {
      a.commit('base', { ...off, 'a.dat': 'one\ntwo\nthree\n' })
      a.branch('pr')
      a.commit('trim', { 'a.dat': 'one\n' })
    })
    assert.equal(shorter.status, 0, shorter.out)
  })

  it('still reads a -diff file that gains lines, a renamed one that gains a value, and one that only loses lines but holds a new value', () => {
    const grown = scenario((a) => {
      a.commit('base', { ...off, 'a.bin': nul() })
      a.branch('pr')
      a.commit('edit', { 'a.bin': nul(`${PLANT['private-ip']}\n`) })
    })
    assert.equal(grown.status, 1, grown.out)
    const moved = scenario((a) => {
      a.commit('base', { ...off, 'a.bin': nul() })
      a.branch('pr')
      a.sh('mv', 'a.bin', 'b.bin')
      a.commit('rename and extend', { 'b.bin': nul(`${PLANT['private-ip']}\n`) })
    })
    assert.equal(moved.status, 1, moved.out)
    // Lines only lost, but the commit also touches the attributes: the whole file is read.
    const swapped = scenario((a) => {
      a.commit('base', { ...off, 'a.dat': `one\ntwo\n${PLANT['private-ip']}\n` })
      a.branch('pr')
      a.commit('trim', { 'a.dat': `one\n${PLANT['private-ip']}\n` })
    })
    assert.equal(swapped.status, 0, 'a value the file already held is excused')
    const fresh = scenario((a) => {
      a.commit('base', { ...off, 'a.dat': 'one\ntwo\nthree\n' })
      a.branch('pr')
      a.commit('rewrite', { 'a.dat': 'one\n' })
      a.commit('then add', { 'a.dat': `one\n${PLANT['private-ip']}\n` })
    })
    assert.equal(fresh.status, 1, fresh.out)
  })
})

describe('privacy guard: checkCounts', () => {
  const bin = (path) => [{ path, added: null }]
  it('hands back a binary file with no readable lines to be read whole, unless it was deleted or only renamed', () => {
    assert.deepEqual(checkCounts(bin('a'), [], [{ status: 'M', path: 'a' }]), ['a'])
    assert.deepEqual(checkCounts(bin('a'), [], [{ status: 'A', path: 'a' }]), ['a'])
    assert.deepEqual(checkCounts(bin('a'), [], [{ status: 'R', similarity: 90, from: 'b', path: 'a' }]), ['a'])
    assert.deepEqual(checkCounts(bin('a'), [], [{ status: 'D', path: 'a' }]), [])
    assert.deepEqual(checkCounts(bin('a'), [], [{ status: 'R', similarity: 100, from: 'b', path: 'a' }]), [])
    assert.deepEqual(checkCounts(bin('a'), [{ path: 'a', line: 1, text: 'x' }], [{ status: 'M', path: 'a' }]), [])
  })
  it('still throws when the parsed count and git\'s count differ', () => {
    assert.throws(() => checkCounts([{ path: 'a', added: 2 }], [{ path: 'a', line: 1, text: 'x' }], []), /git counts 2/)
  })
})

describe('privacy guard: false positives it must not raise', () => {
  const scan = (files) =>
    scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('work', files)
    })
  const ip = ['10', '0', '0', '5'].join('.')

  it('does not take a version for an address, and still takes an address after any letter or a punctuation mark', () => {
    // Every private IPv4 address has four parts, so a three-part version never matches.
    const v = ['10', '1', '2'].join('.')
    assert.equal(scan({ 'a.md': `needs v${v} and V${v} and go v${v}\n` }).status, 0)
    for (const text of [`v${ip}`, `V${ip}`, `user@${ip}`, `host=${ip}`, `(${ip})`, `ssh ${ip}`, `curl -x${ip}`, `nas-${ip}`, `IP${ip}`, `ev${ip}`, `x-${ip}`, `1-${ip}`]) {
      assert.equal(scan({ 'a.md': `${text}\n` }).status, 1, text)
    }
    assert.equal(scan({ 'a.md': `"nameserver\\n${ip}"\n` }).status, 1, 'after an escape written as text')
  })

  it('does not read numbers in minified SVG path data, and still reads an address in the same file or anywhere else', () => {
    const n = ['10', '1', '2', '3'].join('.')
    const path = `<path d="M${n.slice(0, 4)}.2.3 4.5l${n} 2.4.5.6z"/><polygon points="${n} 4.5,${n} 6 7 8 9"/>`
    assert.equal(scan({ 'logo.svg': `${path}\n` }).status, 0)
    assert.equal(scan({ 'logo.svg': `${path}\n<desc>server ${ip}</desc>\n` }).status, 1)
    assert.equal(scan({ 'logo.svg': `<path d="${ip}"/>\n` }).status, 1, 'an address alone in an attribute is not path data')
    // Outside an svg file, or a path tag, the same shapes are not drawing data.
    for (const text of [`d="M ${ip}"`, `host -d='M${ip}'`, `data-d="m${ip}"`, `points="${ip} ${ip} 1 2 3 4"`, `d = "${ip} ${ip} 1 2 3 4"`]) {
      assert.equal(scan({ 'notes.md': `${text}\n` }).status, 1, text)
    }
  })

  it('does not take an npm tag for an email address, and still takes a real address with a numeric label', () => {
    assert.equal(scan({ 'a.md': `install pkg@${['1', '0', '0'].join('.')}-beta.next or pkg@${['2', '1', '0'].join('.')}\n` }).status, 0)
    assert.equal(scan({ 'a.md': `mail ${'someone' + '@'}163.com\n` }).status, 1)
  })
})

describe('privacy guard: it cannot be pointed at nothing, or at an option', () => {
  const clean = (a) => {
    a.commit('base', { 'README.md': 'hello\n' })
    a.branch('pr')
    a.commit('work', { 'a.md': 'clean\n' })
  }
  it('exits 2, not 3 or 0, for a revision that is an option or does not exist', () => {
    for (const args of [['--head', '--max-count=0'], ['--base', '--all'], ['--base', 'nope'], ['--head', '--not']]) {
      const r = scenario(clean, { args: () => args })
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.out}`)
      assert.match(r.out, /nothing was checked/)
    }
  })

  it('exits 3 when the head holds nothing the base lacks, and reads a commit with an empty net diff', () => {
    const nothing = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
    })
    assert.equal(nothing.status, 3, nothing.out)
    const empty = scenario((a) => {
      a.commit('base', { 'README.md': 'hello\n' })
      a.branch('pr')
      a.commit('add', { 'a.md': 'clean\n' })
      a.commit('remove', {}, ['a.md'])
    })
    assert.equal(empty.status, 0, empty.out)
    assert.match(empty.out, /OK, read/)
  })
})

describe('privacy guard: the workflow and ship-bot expect the check', () => {
  it('has no path that runs the pull request\'s own copy of the guard', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'privacy-guard.yml'), 'utf8')
    assert.doesNotMatch(wf, /cp scripts\/privacy-guard\.mjs/)
    assert.match(wf, /::error title=privacy-guard::The base has no scripts\/privacy-guard\.mjs/)
    assert.match(wf, /exit 2/)
    assert.match(wf, /one name per line/i)
  })

  it('lists the guard job among ship-bot\'s expected checks for this repository', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'privacy-guard.yml'), 'utf8')
    const job = wf.match(/^jobs:\n {2}([a-z-]+):/m)[1]
    const config = JSON.parse(readFileSync(join(ROOT, 'ship-bot', 'config.example.json'), 'utf8'))
    const entry = config.repos.find((r) => r.slug === 'gorfednet/.github')
    assert.ok(entry.expectedChecks.includes(job), `${job} must be expected, so a head whose workflow never starts is blocked`)
  })
})

describe('privacy guard: a `product <Name>` line clears a public product name, whole and exact only', () => {
  const real = readFileSync(REAL_ALLOWLIST, 'utf8')
  // The private name is secret-repo; the product is spelled Secret-Repo. A product line says the
  // name at the base, so it is the "said" path that matters: a line that says private is read.
  const run = (body, { path = 'docs/p.md', allow = `${real}product Secret-Repo\n` } = {}) =>
    guard({ before: { '.github/privacy-guard-allow.txt': allow }, after: { [path]: body }, allow: false })
  const fails = (body, opts) => {
    const r = run(body, opts)
    assert.equal(r.status, 1, `expected a refusal for ${JSON.stringify(body)}: ${r.out}`)
    assert.match(r.out, /\[private-repo\]/)
  }
  const passes = (body, opts) => {
    const r = run(body, opts)
    assert.equal(r.status, 0, `expected a pass for ${JSON.stringify(body)}: ${r.out}`)
  }

  it('lets the product name through on a line that says private, and refuses without the line', () => {
    passes('Join the private beta of Secret-Repo today.\n')
    passes('Secret-Repo has a private mode for friends.\n')
    passes('Secret-Repo is a game. Private lobbies are coming.\n')
    passes("Secret-Repo's private beta opens Friday.\n")
    passes("Don't share the Secret-Repo private beta link.\n")
    passes('- [ ] Secret-Repo: fix private lobby join\n')
    passes('- [x] Secret-Repo: fix private lobby join\n')
    passes('[Secret-Repo](https://example.org/x) private beta\n')
    passes('Secret-Repo Private Beta opens Friday\n')
    passes('SECRET-REPO PRIVATE BETA'.replace('SECRET-REPO', 'Secret-Repo') + '\n')
    passes('Secret-Repo private-beta signup\n')
    passes('Secret-Repo has private betas and private modes\n')
    passes('Secret-Repo now has private lobbies\n')
    passes('Secret-Repo 2.0.0 has a private beta.\n')
    passes('Secret-Repo ships to phones and tablets with a private beta, see the GitHub docs\n')
    fails('Join the private beta of Secret-Repo today.\n', { allow: real })
  })

  it('refuses a near-miss spelling or another case', () => {
    fails('Join the private beta of secret-repo today.\n')
    fails('Join the private beta of SECRET-REPO today.\n')
    fails('Join the private beta of Secret-repo today.\n')
    fails('Join the private beta of Secret-Repo.git today.\n')
    fails('Join the private beta of Secret-Repo.wiki today.\n')
  })

  it('refuses the name used in another sense', () => {
    fails(`the private ${'gorfednet' + '/'}Secret-Repo for it\n`)
    fails('Secret-Repo is private\n')
    fails('Secret-Repo (private)\n')
    fails('private Secret-Repo\n')
    fails('Secret-Repo\t2026-11-14\tprivate\n')
    fails('| Secret-Repo | private |\n')
    fails('the private repo Secret-Repo\n')
    fails('Secret-Repo, visibility: internal\n')
    fails('private cd ../Secret-Repo\n')
    fails('a private Secret-Repo_notes file\n')
    fails('a private note for @Secret-Repo\n')
    fails('private Secret-Repo.md\n')
    fails('a private beta in ~/Secret-Repo\n')
    fails('a private beta in Secret-Repo/docs\n')
    fails('a private beta for Secret-Repo\\x\n')
    fails('Secret-Repo repo: private beta\n')
    fails('the repo Secret-Repo has a private beta\n')
    fails('a private beta in the repo of the Secret-Repo game\n')
    fails('repo for the Secret-Repo has a private beta\n')
    fails('Secret-Repo has a repo private beta\n')
    fails('the Secret-Repo monorepo has a private beta\n')
    fails('a private beta of the Secret-Repo codebase\n')
    fails('the Secret-Repo org has a private beta\n')
    fails('x = Secret-Repo private beta\n')
    fails('[Secret-Repo, private beta]\n')
    fails('{Secret-Repo} private beta\n')
    fails('"Secret-Repo" private beta\n')
    fails('Secret-Repo 2.0.0 is in private beta.\n')
    fails('Secret-Repo v1.2 is a private beta.\n')
    fails('Secret-Repo is still private for now.\n')
    fails('Secret-Repo is kept private until launch.\n')
    fails('Secret-Repo went private not yet public.\n')
    fails('Secret-Repo is currently private.\n')
    fails('Secret-Repo is a private game.\n')
    fails('Secret-Repo is in private testing.\n')
    fails('Secret-Repo stays a private test.\n')
    fails('Secret-Repo is a private server.\n')
    fails('Secret-Repo is in private beta.\n')
    fails('private until launch, then Secret-Repo ships\n')
    fails('{"name":"Secret-Repo","private":true}\n')
    fails('Secret-Repo,2026-11-14,private\n')
    fails('Secret-Repo   2026-11-14   private\n')
    fails('Secret-Repo, Other-Game: private\n')
    fails('Secret-Repo is a game, private: yes\n')
    fails('the Secret-Repo "private" flag\n')
  })

  it('refuses a private name that was never listed as a product, beside one that was', () => {
    fails('a private beta of Secret-Repo and other-one\n'.replace('other-one', 'other-one'))
    const r = run('the private other-one is out, like Secret-Repo\n')
    assert.equal(r.status, 1, r.out)
  })

  it('parses the line, and rejects a malformed one', () => {
    assert.deepEqual(parseAllowlist('product Secret-Repo\n').products, ['Secret-Repo'])
    assert.throws(() => parseAllowlist('product\n'), /allowlist line 1/)
    assert.throws(() => parseAllowlist('product A B\n'), /allowlist line 1/)
    assert.throws(() => parseAllowlist('product a/b\n'), /allowlist line 1/)
    assert.throws(() => parseAllowlist('product secret-repo\n'), /capital letter/)
  })

  it('does not let its own allowlist line make the name count as said at the base', () => {
    // The only mention at the base is the product line, so the name is unsaid and read on every line.
    const lowercase = ['secret-repo is fun', 'secret-repo.git', 'cd ../secret-repo', 'SECRET-REPO']
    for (const body of lowercase) fails(`${body}\n`)
    passes('Secret-Repo is fun\n')
  })
})

describe('privacy guard: a `site <domain>` line clears a public site in host form only', () => {
  // The private repository is named for its public site, example-music.com.
  const NAME = 'example-music.com'
  const real = readFileSync(REAL_ALLOWLIST, 'utf8')
  const ORG = 'gorfednet' + '/'
  const run = (body, { path = 'README.md', allow = `${real}site ${NAME}\n`, env } = {}) =>
    guard({ before: { '.github/privacy-guard-allow.txt': allow }, after: { [path]: body }, allow: false, env: { PRIVATE_REPOS: NAME, ...env } })
  const fails = (body, opts) => {
    const r = run(body, opts)
    assert.equal(r.status, 1, `expected a refusal for ${JSON.stringify(body)}: ${r.out}`)
    assert.match(r.out, /\[private-repo\]/)
  }
  const passes = (body, opts) => {
    const r = run(body, opts)
    assert.equal(r.status, 0, `expected a pass for ${JSON.stringify(body)}: ${r.out}`)
  }

  it('lets the public site through as a URL or a bare host, and refuses it without the line', () => {
    passes(`Music: [listen](https://${NAME}/albums)\n`)
    passes(`Music at https://${NAME}\n`)
    passes(`Visit ${NAME} for the music.\n`)
    passes(`<a href="http://${NAME}/">Music</a>\n`)
    const r = run(`Music: https://${NAME}/\n`, { allow: real })
    assert.equal(r.status, 1, r.out)
  })

  it('still refuses the repository: org-prefixed, a GitHub link, a path part, a suffix, a handle', () => {
    fails(`see ${ORG}${NAME}\n`)
    fails(`https://github.com/${ORG}${NAME}\n`)
    fails(`git clone git@github.com:${ORG}${NAME}.git\n`)
    fails(`cd ../${NAME}\n`)
    fails(`${NAME}.git\n`)
    fails(`@${NAME}\n`)
    fails(`${NAME}_notes\n`)
    fails(`https://example.org/${NAME}\n`)
  })

  it('refuses a line that pairs the site with a repository word or private, and the file name', () => {
    fails(`The ${NAME} repo is private.\n`)
    fails(`${NAME} is a private project\n`)
    fails(`The code for ${NAME} lives in the codebase.\n`)
    fails(`https://${NAME} (internal)\n`)
    fails('x\n', { path: `${NAME}/index.md` })
  })

  it('reads a name in any other file or message even when a site line is on main', () => {
    fails(`notes for example-music.com.git\n`)
    const other = guard({
      before: { '.github/privacy-guard-allow.txt': `${real}site ${NAME}\n` },
      after: { 'a.md': 'see ' + ORG + 'other-one\n' },
      allow: false,
      env: { PRIVATE_REPOS: `${NAME},other-one` },
    })
    assert.equal(other.status, 1, other.out)
    const msg = run('ok\n', { env: {} })
    assert.equal(msg.status, 0, msg.out)
    const m = guard({ before: { '.github/privacy-guard-allow.txt': `${real}site ${NAME}\n` }, after: { 'a.md': 'ok\n' }, allow: false, message: `see ${ORG}${NAME}`, env: { PRIVATE_REPOS: NAME } })
    assert.equal(m.status, 1, m.out)
  })

  it('lets a repository add its first site line: the line is not read for its own domain', () => {
    const add = (line, files = {}) =>
      guard({ before: { 'README.md': 'hello\n' }, after: { '.github/privacy-guard-allow.txt': line, ...files }, allow: false, env: { PRIVATE_REPOS: NAME } })
    const r = add(`site ${NAME}\n`)
    assert.equal(r.status, 0, r.out)
    // The line clears nothing else: the same push naming the repository, or the README link, is read.
    assert.equal(add(`site ${NAME}\n`, { 'README.md': `https://${NAME}/\n` }).status, 1, 'the README link needs the line on main first')
    assert.equal(add(`site ${NAME}\n`, { 'a.md': `see ${ORG}${NAME}\n` }).status, 1)
    assert.equal(add(`site ${NAME}\n`, { 'b.md': `${NAME}.git\n` }).status, 1)
    // Not a way to publish a name: a comment on the line, a repo line, a name with no dot, another file.
    assert.equal(add(`site ${NAME} # the private repo\n`).status, 1)
    assert.equal(add(`repo ${NAME}\n`).status, 1)
    assert.equal(guard({ allow: false, after: { '.github/privacy-guard-allow.txt': 'site secret-repo\n' }, env: { PRIVATE_REPOS: 'secret-repo' } }).status, 1)
    assert.equal(add(`site ${NAME}\n`, { 'docs/privacy-guard-allow.txt': `site ${NAME}\n` }).status, 1)
  })

  it('parses site lines and refuses a value that is not a domain', () => {
    assert.deepEqual(parseAllowlist(`site Example-Music.com\n`).sites, ['example-music.com'])
    for (const bad of ['site\n', 'site secret-repo\n', 'site a.com extra\n', 'site https://a.com\n', 'site a/b.com\n']) {
      assert.throws(() => parseAllowlist(bad), /allowlist line 1/, bad)
    }
  })
})

describe('privacy guard: a `site` line stays narrow once the site is on the base (Fable read fixes)', () => {
  const NAME = 'example-music.com'
  const ORG = 'gorfednet' + '/'
  const real = readFileSync(REAL_ALLOWLIST, 'utf8')
  const allow = `${real}site ${NAME}\n`
  // The base already carries the README link, so the name is "said" there.
  const run = (body, { before = {}, path = 'docs/n.md', allow: allowText = allow } = {}) =>
    guard({
      before: { '.github/privacy-guard-allow.txt': allowText, 'README.md': `Music: https://${NAME}/\n`, ...before },
      after: { [path]: body },
      allow: false,
      env: { PRIVATE_REPOS: NAME },
    })
  const fails = (body, opts) => assert.equal(run(body, opts).status, 1, `expected a refusal for ${JSON.stringify(body)}`)
  const passes = (body, opts) => {
    const r = run(body, opts)
    assert.equal(r.status, 0, `expected a pass for ${JSON.stringify(body)}: ${r.out}`)
  }

  it('still refuses repository-shaped mentions when the base already says the name', () => {
    for (const body of [
      `cd ../${NAME}`,
      `${NAME}.git`,
      `@${NAME}`,
      `${NAME}_notes`,
      `https://example.org/${NAME}`,
      `The code for ${NAME} lives in the codebase.`,
      `cd ${NAME} && pnpm gate`,
      `open ${NAME}/src/index.ts`,
      `${NAME}#12 fixes the header`,
      `${NAME} PR 12 is waiting on CI`,
      `gh pr list -R ${NAME}`,
      `gorfednet / ${NAME}`,
      `${NAME} is confidential`,
      `REPO_NAME=${NAME}`,
      `GH_REPO=${NAME}`,
      `GITHUB_REPOSITORY=${NAME}`,
    ]) fails(`${body}\n`)
    assert.equal(run(`- ${NAME}\n`, { before: {} }).status, 0, 'a bare list item with nothing private around passes')
    fails('x\n', { path: `${NAME}/index.md` })
  })

  it('reads identifiers apart: camelCase, digits and underscores carry the words too (Fable read fixes)', () => {
    for (const body of [
      `{"name":"${NAME}","isPrivate":true}`,
      `privateRepos: ['${NAME}']`,
      `repoName: "${NAME}"`,
      `REPO1=${NAME}`,
      `REPO_NAME=${NAME}`,
      `GH_REPO=${NAME}`,
      `GITHUB_REPOSITORY=${NAME}`,
      `${NAME}#12 fixes the header`,
    ]) fails(`${body}\n`)
    // Near misses: plain words that merely contain the letters.
    passes(`Reports and privateers: https://${NAME}/\n`)
    passes(`DOMAIN=${NAME}\n`)
    passes(`privateKey docs: https://${NAME}/\n`)
  })

  it('reads the line without the domain: its own labels are not words about a repository (.org, pr-)', () => {
    for (const site of ['example-music.org', 'pr-music.com', 'repo-music.com', 'private-notes.com']) {
      // The URL form and the bare form: the bare one has no URL to cut, so the domain's own labels are cut by name.
      const body = `Music: https://${site}/albums\nAlso at ${site} now\n`
      const r = guard({
        before: { '.github/privacy-guard-allow.txt': `${real}site ${site}\n`, 'README.md': 'hello\n' },
        after: { 'docs/n.md': body },
        allow: false,
        env: { PRIVATE_REPOS: site },
      })
      assert.equal(r.status, 0, `${site}: ${r.out}`)
    }
    // The route still works end to end for a .org site, and the line adding it clears itself.
    const first = guard({ before: { 'README.md': 'hi\n' }, after: { '.github/privacy-guard-allow.txt': 'site example-music.org\n' }, allow: false, env: { PRIVATE_REPOS: 'example-music.org' } })
    assert.equal(first.status, 0, first.out)
  })

  it('does not refuse a site link because the line says GitHub, source, org, remote or git', () => {
    passes(`I'm on GitHub, and my music lives at https://${NAME}/\n`)
    passes(`Open source credits: https://${NAME}/credits\n`)
    passes(`Find my git history and the remote shows: https://${NAME}/\n`)
    passes(`My org plays at https://${NAME}/ &#39;\n`)
    passes(`Colour #0af at https://${NAME}/\n`)
    // The repository forms are still refused by their own rules.
    fails(`https://github.com/${ORG}${NAME}\n`)
    fails(`on GitHub: ${ORG}${NAME}\n`)
  })

  it('reads identifiers whatever their case or separators (second Fable read)', () => {
    for (const body of [
      `reponame=${NAME}`,
      `REPONAME=${NAME}`,
      `GHRepo: ${NAME}`,
      `PRNumber: ${NAME}`,
      `ISPRIVATE=${NAME}`,
      `isprivate: ${NAME}`,
      `PRIVATE_REPOS=${NAME}`,
      `private_repos: ['${NAME}']`,
      `{"name":"${NAME}","is_private":true}`,
    ]) fails(`${body}\n`)
  })

  it('keeps main\'s whole-word rule for a said name: identifiers that hold private are other things', () => {
    const said = (line) => guard({ before: { 'README.md': 'see other-one in the docs\n' }, after: { 'a.txt': `${line}\n` }, env: { PRIVATE_REPOS: 'other-one' } })
    for (const line of ['other-one is private', 'private: other-one', 'the private other-one']) assert.equal(said(line).status, 1, line)
    for (const line of ['PRIVATE_REPOS other-one', 'privateList other-one', 'private_subnet other-one', 'isPrivate other-one', 'other-one privateKey', 'PrivateRoute for other-one', 'other-one uses a_private_key']) {
      const r = said(line)
      assert.equal(r.status, 0, `${line}: ${r.out}`)
    }
  })

  it('reads a bare // as a host only inside an attribute or bracket, never after a comment (third Fable read)', () => {
    fails(`x = 1 //${NAME}\n`)
    fails(`foo // //${NAME}\n`)
    fails(`see //${NAME}\n`)
    passes(`<a href="//${NAME}/">music</a>\n`)
    passes(`[music](//${NAME}/)\n`)
  })

  it('reads whole words for repo: repost, repopulate and preposterous are other things', () => {
    passes(`Reposted and repopulate, preposterous: https://${NAME}/\n`)
    passes(`reposted=https://${NAME}/\n`)
    fails(`repos=${NAME}\n`)
    fails(`reponame=${NAME}\n`)
  })

  it('lets prose words secret, gate and private sit beside the link, and reads them in identifiers', () => {
    passes(`Secret show, private events: https://${NAME}/events\n`)
    passes(`Open the gate at 7: https://${NAME}/\n`)
    fails(`secret_key=${NAME}\n`)
    fails(`SecretKey: ${NAME}\n`)
    fails(`gate_key=${NAME}\n`)
    fails(`The show is private: https://${NAME}/\n`)
    fails(`Is it still private? https://${NAME}/\n`)
    fails(`${NAME} is a private project\n`)
    fails(`visibility: https://${NAME}/\n`)
  })

  it('lets an address on the site, an italic name and site: through, and still refuses handles', () => {
    const mail = { allow: `${allow}email ${NAME}\n` } // the address itself is the email rule's, not the name's
    passes(`Bookings: booking@${NAME}\n`, mail)
    passes(`Mail mailto:booking@${NAME}\n`, mail)
    passes(`Find _${NAME}_ online\n`)
    passes(`site:${NAME}\n`)
    fails(`git@${NAME}:me/repo.git\n`)
    fails(`@${NAME}\n`)
    fails(`${NAME}_notes\n`)
    fails(`~${NAME}\n`)
  })

  it('does not refuse the site link for words in its own URL or in prose (second Fable read)', () => {
    passes(`Shop: https://${NAME}/checkout\n`)
    passes(`Shop: https://${NAME}/shop/cd/x\n`)
    passes(`News: https://${NAME}/pr/launch\n`)
    passes(`Events: https://${NAME}/private-events\n`)
    passes(`Styles https://${NAME}/ app.3cd9f1.css\n`)
    passes(`The 2CD set is out: https://${NAME}/\n`)
    passes(`CD release, PR contact: https://${NAME}/\n`)
    passes(`CI badge passing. https://${NAME}/\n`)
    passes(`https://${NAME}/ and https://pr-music.com/\n`)
  })

  it('lets the usual public mentions through', () => {
    passes(`<a href="https://${NAME}/">${NAME}</a>\n`)
    passes(`DOMAIN=${NAME}\n`)
    passes(`2026-11-01,${NAME},200\n`)
  })

  it('does not let the first push of a site line excuse a later line in the same file', () => {
    const r = guard({
      before: { 'README.md': 'hello\n' },
      after: { '.github/privacy-guard-allow.txt': `site ${NAME}\n` },
      allow: false,
      steps: [{ files: { '.github/privacy-guard-allow.txt': `site ${NAME}\n# ${NAME}: the label site\nrepo ${NAME}\n` } }],
      env: { PRIVATE_REPOS: NAME },
    })
    assert.equal(r.status, 1, r.out)
  })

  it('a site line already in the pushed base holds nothing for a later line (second push, allowlist read from main)', () => {
    // The hook reads the allowlist from the remote's default branch (no site line) while the
    // merge base is the first push, which holds the cleared line.
    const dir = mkdtempSync(join(tmpdir(), 'privacy-guard-held-'))
    try {
      sh(dir, 'init', '-q', '-b', 'main')
      mkdirSync(join(dir, '.github'), { recursive: true })
      writeFileSync(join(dir, '.github', 'privacy-guard-allow.txt'), `site ${NAME}\n`)
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'base')
      sh(dir, 'checkout', '-q', '-b', 'pr')
      writeFileSync(join(dir, '.github', 'privacy-guard-allow.txt'), `site ${NAME}\nrepo ${NAME}\n`)
      sh(dir, 'add', '-A')
      sh(dir, 'commit', '-q', '-m', 'second')
      const empty = join(dir, 'empty-allow.txt')
      writeFileSync(empty, '')
      const r = spawnSync('node', [GUARD, '--base', 'main', '--head', 'pr', '--dir', dir, '--allow', empty], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, PRIVATE_REPOS: NAME },
      })
      assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes only a web domain: a file name, a package or a bare word is no site line', () => {
    for (const v of ['secret-engine.js', 'notes.md', 'org.github', 'secret-repo']) {
      const r = guard({ before: { 'README.md': 'hi\n' }, after: { '.github/privacy-guard-allow.txt': `site ${v}\n` }, allow: false, env: { PRIVATE_REPOS: v } })
      assert.equal(r.status, 1, `${v}: ${r.out}`)
      assert.throws(() => parseAllowlist(`site ${v}\n`), /allowlist line 1/)
    }
  })
})
