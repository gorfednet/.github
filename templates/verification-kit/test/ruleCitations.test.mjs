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

  /*
   * Found the same way as the version-number case above, by running the checker
   * against bindercurve.com — which turned out to vendor it and never run it.
   * A rulebook section number is not a citation, and a local prefix that is
   * purely numeric is not a prefix.
   */
  /*
   * The section number has to fall *outside* the sequence or this cannot fail.
   * Written first with the real string — `comprehensive rules 1-2-1-1-1` — it
   * passed with the guard removed, because dropping the lookahead makes the
   * matcher capture the leading `1`, and rule 1 exists. Green for the wrong
   * reason, caught by the canary rather than by review.
   */
  it('does not read a rulebook section number as a citation', () => {
    const dir = project({ source: '// conforms to comprehensive rules 9-2-1 of the format\n' })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)

    // The two-part form is the one that read as a prefixed citation.
    const short = project({ source: '// see the tournament rules 9-2 for timing\n' })
    assert.equal(run(short).status, 0, run(short).stderr)

    // And the real string from bindercurve, which is the reason any of this exists.
    const real = project({ source: '// (Digimon Card Game comprehensive rules 1-2-1-1-1 / glossary)\n' })
    assert.equal(run(real).status, 0, run(real).stderr)
  })

  /*
   * Found in towit.io's two vendored copies of AngularJS, in a library comment
   * about pluralization. Every sequence starts at 1, so a number beginning with
   * 0 is prose by definition — and this repository's check is not wired there,
   * so it was a false failure waiting for whoever wired it first, exactly as the
   * rulebook-section case was in bindercurve.
   */
  it('does not read a zero as a citation, because there is no rule zero', () => {
    const dir = project({
      source: '// we added three explicit number rules 0, 1 and 2\n',
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('still reads a two-digit citation, which the narrowing must not break', () => {
    const dir = project({ shared: sharedDoc(12), source: `${cite('V12')}\n` })
    assert.equal(run(dir).status, 0, run(dir).stderr)

    const past = project({ shared: sharedDoc(12), source: `${cite('V40')}\n` })
    assert.equal(run(past).status, 1)
  })

  // Narrowing the prefix must not stop it matching a real one. Built with
  // cite() for the reason that helper exists.
  it('still catches a prefixed citation, which has a letter in it', () => {
    const dir = project({ source: `${cite('ZQ-1')}\n` })
    const result = run(dir)
    assert.equal(result.status, 1)
  })

  /*
   * 4thcltr.com's prefix is `4C`, so a prefix may contain a letter without
   * beginning with one. Requiring a leading letter skipped its citations
   * entirely, which is the worse of the two errors: a false positive sends
   * somebody to look, and a silently skipped citation reports that everything
   * resolves. Bugbot caught it on the release.
   */
  it('resolves a prefix that starts with a digit, as one real project does', () => {
    const local = '**4C-1. Local one.** Because.\n\n**4C-2. Local two.** Because.\n'
    const resolves = project({ local, source: `${cite('4C-2')}\n` })
    assert.equal(run(resolves).status, 0, run(resolves).stderr)

    // And still catches one past the end, which is the whole point of matching it.
    const dangling = project({ local, source: `${cite('4C-9')}\n` })
    const result = run(dangling)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ends at 4C-2/)
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
