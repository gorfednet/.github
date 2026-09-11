/**
 * Rule numbers are cited from code, which makes the numbering an interface.
 * These cases were each watched failing before the checker was trusted.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-rule-citations.mjs', import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const sharedDoc = (count) =>
  Array.from({ length: count }, (_, i) => `**V${i + 1}. A rule.** Because it broke once.\n`).join(
    '\n',
  )

function project({ shared = sharedDoc(3), local = null, source = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-'))
  workspaces.push(dir)
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'docs/verification-rules.md'), shared, 'utf8')
  if (local !== null) writeFileSync(join(dir, 'docs/verification-rules.local.md'), local, 'utf8')
  writeFileSync(join(dir, 'src/app.js'), source, 'utf8')
  return dir
}

const run = (dir, args = []) =>
  spawnSync('node', [CHECKER, ...args], { cwd: dir, encoding: 'utf8' })

/**
 * Build a fixture citation without writing one.
 *
 * This file is scanned like any other source, so a literal project-prefixed
 * citation in a fixture string *is* a citation of a rule that does not exist
 * here — three of them failed this repository's own gate — and the
 * checker was right to fail on it. Splitting the identifier out of the source
 * text keeps the fixture readable and keeps the check strict — the alternative
 * was excluding test files from the scan, which is how a check quietly stops
 * covering the code most likely to cite a rule.
 */
const cite = (id, lead = 'rule') => `// ${lead} ${id}`

describe('check-rule-citations', () => {
  it('passes when every citation resolves', () => {
    const dir = project({ source: `${cite('V2')}, this fails closed\n` })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /3 shared/)
  })

  // The failure that prompted the original: nine branches merged, the list
  // reached 20 then 25, and two rules shared a number.
  it('fails on a gap in the shared sequence', () => {
    const dir = project({
      shared: '**V1. One.** Because.\n\n**V2. Two.** Because.\n\n**V4. Four.** Because.\n',
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /expected 1\.\.3 in order, read 1, 2, 4/)
  })

  it('fails on a duplicate number and names it', () => {
    const dir = project({
      shared: '**V1. One.** Because.\n\n**V2. Two.** Because.\n\n**V2. Also two.** Because.\n',
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Duplicated: 2/)
  })

  // A citation pointing at the wrong rule is worse than no citation, because
  // it reads as a verified cross-reference.
  it('fails on a citation past the end of the shared sequence', () => {
    const dir = project({ source: `${cite('V9', 'see rule')}\n` })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cites .*V9, but .* ends at V3/)
  })

  // Found by running the checker against bindercurve.com, where a backlog
  // entry describing Star Wars' "Comprehensive Rules v1.1" was read as citing
  // a citation of V1. A version number in prose is not a citation.
  it('does not read a lowercase version number as a citation', () => {
    const dir = project({ source: '// Comprehensive Rules v1.1 require one base\n' })
    assert.equal(run(dir).status, 0, run(dir).stderr)

    // And the same shape past the end of the sequence still must not fire.
    const far = project({ source: '// conforms to Rules v9.2 of the format\n' })
    assert.equal(run(far).status, 0, far.stderr)
  })

  it('still catches an uppercase citation that looks like a version', () => {
    const dir = project({ source: `${cite('V9', 'see rule')} for the reasoning\n` })
    assert.equal(run(dir).status, 1)
  })

  /*
   * A citation is written on one line. What `\s` additionally matched was a
   * sentence ending in "rules" followed by a line starting with a number — an
   * ordinary shape in a comment or a numbered list, and one that would be
   * reported as a dangling citation of whatever that number happened to be.
   */
  it('does not read a number on the next line as a citation', () => {
    // A template literal of prose, which is how this kit writes its own
    // messages: the line break is whitespace and nothing else, so `\s+` reads
    // "rules" and the "9" below it as one citation.
    const dir = project({
      source: 'export const help = `\n  This project has its own rules\n  9 of them, at present\n`\n',
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('still reads a citation separated by a tab', () => {
    const dir = project({ source: '// see rule\tV9\n' })
    assert.equal(run(dir).status, 1)
  })

  it('accepts the citation forms that appear in real comments', () => {
    const dir = project({
      source: [cite('V1', 'teardown rule'), cite('V2', 'class rule'), cite('V3', 'rules')].join('\n'),
    })
    assert.equal(run(dir).status, 0)
  })

  describe('with a local sequence', () => {
    const local = '**BC-1. Local one.** Because.\n\n**BC-2. Local two.** Because.\n'

    it('resolves both sequences at once', () => {
      const dir = project({ local, source: `${cite('V3')} and ${cite('BC-2')}\n` })
      const result = run(dir)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /2 local \(BC-\)/)
    })

    it('fails on a local citation past the end of the local sequence', () => {
      const dir = project({ local, source: `${cite('BC-7')}\n` })
      const result = run(dir)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /ends at BC-2/)
    })

    // The point of the prefix is that a project can never collide with the
    // shared numbering, so a foreign prefix is a mistake and not a rule.
    it('fails on a citation using another project prefix', () => {
      const dir = project({ local, source: `${cite('XY-1')}\n` })
      const result = run(dir)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /local prefix is BC/)
    })

    it('fails when the local document has no parseable rules', () => {
      const dir = project({ local: '# Local rules\n\nNothing yet.\n' })
      const result = run(dir)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /no local rules found/)
    })
  })

  // Fail closed, three ways. Each of these would otherwise print a tick over
  // having checked nothing.
  it('fails when the shared document is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-'))
    workspaces.push(dir)
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /is missing/)
  })

  it('fails when the shared document parses to no rules at all', () => {
    const dir = project({ shared: '# Verification rules\n\nComing soon.\n' })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no rules found/)
  })

  it('fails when the source globs match nothing', () => {
    const dir = project({})
    const result = run(dir, ['--source', 'no-such-directory'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pass vacuously/)
  })
})
