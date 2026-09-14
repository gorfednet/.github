/**
 * Every case here is a real line from this fleet, and each was watched failing.
 *
 * Two of them are the reason the check is subtler than a grep for /Users/. The
 * BusinessWire link appears in gorfed.net's press table and 4thcltr.com's press
 * list; a naive pattern reads `/news/home/20180227005360/` as an absolute home
 * directory and flags shipped content that is entirely correct. And the comments
 * that explain this defect quote the paths that caused it, so a check that could
 * not tell code from prose would forbid its own documentation.
 *
 * Both are the same lesson as the share-mount guard: what counts is not whether
 * the string is present but whether anything executes it.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-machine-paths.mjs', import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

/** A real git repository, because the check reads the index rather than the tree. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'machinepaths-'))
  workspaces.push(dir)
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  git('add', '-A')
  return dir
}

const run = (dir, extra = []) =>
  spawnSync('node', [CHECKER, '--root', dir, ...extra], { encoding: 'utf8' })

describe('check-machine-paths', () => {
  it('passes a repository whose scripts derive their own location', () => {
    const dir = repo({
      'scripts/build.mjs': "const root = path.resolve(__dirname, '..')\n",
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /derive their locations/)
  })

  it('fails on an absolute home directory in code', () => {
    // blackpixelrecords.com/scripts/generate-favicons.mjs, verbatim.
    const dir = repo({
      'scripts/generate-favicons.mjs':
        "    const fallback = '/Users/gorf/Documents/Apps/www/ssatcy.com/node_modules/sharp'\n",
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /generate-favicons\.mjs:1/)
    assert.match(result.stderr, /home directory/)
  })

  it('fails on a dependency resolved from a sibling checkout', () => {
    // anal0g.org's relative form. CI named it; nothing in the repo would have.
    const dir = repo({
      'scripts/card.mjs': "const sibling = path.resolve(root, '../ssatcy.com/node_modules/sharp')\n",
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /another repository for a dependency/)
  })

  it('fails on a Linux home directory that is not the CI runner', () => {
    const dir = repo({ 'conf/app.conf': 'AuthUserFile /home/gorfed/domains/x/.htpasswd\n' })
    assert.equal(run(dir).status, 1)
  })

  it('allows /home/runner, which is GitHub\u2019s own working directory', () => {
    const dir = repo({
      '.github/workflows/ci.yml': '      run: ls /home/runner/work/repo/repo\n',
    })
    assert.equal(run(dir).status, 0, run(dir).stderr)
  })

  it('does not flag a URL containing a path segment called home', () => {
    /*
     * The false positive that this check produced on its first run across the
     * fleet, in two repositories at once. Correct, shipped content.
     */
    const dir = repo({
      'press.html':
        '<a href="https://www.businesswire.com/news/home/20180227005360/en/Circulation">x</a>\n',
      'src/content/shared.ts':
        "  href: 'https://www.businesswire.com/news/home/20180227005360/en/Circulation',\n",
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('lets a comment quote the path it is explaining', () => {
    const dir = repo({
      'scripts/card.mjs': [
        '// There was a fallback here that resolved',
        "// '/Users/gorf/Documents/Apps/www/ssatcy.com/node_modules/sharp' — one",
        '// machine\u2019s home directory, committed.',
        '#  /Users/gorf/elsewhere',
        ' * /home/gorfed/domains/x',
        '<!-- /Users/gorf/x -->',
        "const root = path.resolve(__dirname, '..')",
      ].join('\n'),
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('lets documentation quote the paths it documents', () => {
    /*
     * Not a convenience. V73 in docs/verification-rules.md quotes all three
     * offending paths, and a check that forbade that would forbid the record of
     * why it exists. Every line of a .md is prose and none of it executes.
     */
    const dir = repo({
      'docs/verification-rules.md':
        "**V73.** anal0g resolved `path.resolve(root, '../ssatcy.com/node_modules/sharp')`,\n" +
        'and blackpixelrecords had /Users/gorf/Documents/Apps/www/ssatcy.com/node_modules/sharp.\n',
      'scripts/build.mjs': 'export const x = 1\n',
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    // And the exemption is by file type, not a free pass: the count proves the
    // .md was skipped rather than scanned and found clean.
    assert.match(result.stdout, /1 tracked text file/)
  })

  it('does not scan the vendored kit, whose fixtures are made of what it looks for', () => {
    /*
     * The case this check shipped without, and the omission was invisible for a
     * specific reason: it reads the git index, and I validated it across the
     * fleet while its own file was still untracked. `git ls-files` cannot see
     * what is not staged, so it never saw itself until the commit landed — after
     * which it failed on its own pattern definitions and on every one of these
     * fixtures, in this repository and in each consumer that refreshed.
     *
     * Two pull requests answered that by waiving /Users/gorf/ outright, which
     * turns the check off and leaves it green. A check that cannot be satisfied
     * honestly gets satisfied dishonestly, so the subject is what had to change.
     */
    const dir = repo({
      'verification-kit/bin/check-machine-paths.mjs': "  re: /\\/Users\\/[^/\\s]+\\//,\n",
      'verification-kit/test/machinePaths.test.mjs':
        "      'scripts/x.mjs': \"const p = '/Users/gorf/Documents/Apps/www/other/node_modules/sharp'\",\n",
      'src/app.mjs': 'export const x = 1\n',
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 tracked text file/)
  })

  it('excludes the kit and nothing that merely resembles it', () => {
    // Otherwise the exclusion is a hole rather than a boundary: a directory named
    // for the kit is not the kit, and the drift check is what makes the real one
    // safe to skip.
    const dir = repo({
      'my-verification-kit-notes/setup.mjs': "const p = '/Users/gorf/x'\n",
      'verification-kit-extras/setup.mjs': "const p = '/Users/gorf/x'\n",
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /2 machine-specific path/)
  })

  it('still flags a path after code on the same line as a trailing comment', () => {
    // The conservative direction: prose is an allowance for whole lines only.
    const dir = repo({
      'scripts/card.mjs': "const p = '/Users/gorf/x' // explained below\n",
    })
    assert.equal(run(dir).status, 1)
  })

  it('waives a deliberate path only when the caller says so', () => {
    const dir = repo({ 'stats/.htaccess': 'AuthUserFile /home/gorfed/domains/x/.htpasswd\n' })
    assert.equal(run(dir).status, 1)
    const waived = run(dir, ['--allow', 'AuthUserFile /home/gorfed/'])
    assert.equal(waived.status, 0, waived.stderr)
    assert.match(waived.stdout, /1 waiver/)
  })

  it('does not read binary files as text', () => {
    const dir = repo({ 'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x2f, 0x55]) })
    assert.equal(run(dir).status, 0, run(dir).stderr)
  })

  it('scans the index, not the working tree, so build output cannot dilute it', () => {
    const dir = repo({ 'scripts/build.mjs': 'export const x = 1\n' })
    writeFileSync(join(dir, 'untracked.mjs'), "const p = '/Users/gorf/x'\n")
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 tracked text file/)
  })

  it('exits 2 rather than 0 when it cannot list files at all', () => {
    // V69: a filter that cannot run emits exactly what a clean scan emits.
    const dir = mkdtempSync(join(tmpdir(), 'machinepaths-nogit-'))
    workspaces.push(dir)
    const result = run(dir)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /failure to scan, not a clean scan/)
  })

  it('exits 2 on a repository with nothing tracked, rather than claiming success', () => {
    const dir = repo({})
    const result = run(dir)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /proved nothing/)
  })
})
