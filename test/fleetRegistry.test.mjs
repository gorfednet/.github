/**
 * The fleet registry is a hand-maintained list, and a hand-maintained list
 * that nothing verifies keeps reading as authoritative long after it stopped
 * being true. This one is about verification, which would make it a
 * particularly embarrassing place to skip the gate.
 *
 * The offline cases below cover schema, dates and overrides. The online half —
 * asking a repository for the artefacts a claimed tier requires — is exercised
 * by running the real check against this repository in CI, since stubbing `gh`
 * would test a different program.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

const CHECK = resolve('scripts/check-fleet.mjs')
const RENDER = resolve('scripts/write-fleet-md.mjs')
const REGISTRY = JSON.parse(readFileSync('fleet.json', 'utf8'))
const temps = []

after(() => {
  for (const path of temps) rmSync(path, { force: true, recursive: true })
})

/** The real registry with one project altered, so fixtures stay realistic. */
function withProject(index, changes) {
  const doc = structuredClone(REGISTRY)
  Object.assign(doc.projects[index], changes)
  for (const key of Object.keys(changes)) {
    if (changes[key] === undefined) delete doc.projects[index][key]
  }
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
  temps.push(dir)
  const path = join(dir, 'fleet.json')
  writeFileSync(path, JSON.stringify(doc), 'utf8')
  return path
}

const run = (file, args = ['--offline']) =>
  spawnSync('node', [CHECK, '--file', file, ...args], { encoding: 'utf8' })

describe('fleet registry', () => {
  it('the committed registry is valid', () => {
    const result = spawnSync('node', [CHECK, '--offline'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  it('says out loud that --offline verified no tier against a repository', () => {
    const result = spawnSync('node', [CHECK, '--offline'], { encoding: 'utf8' })
    assert.match(result.stdout, /did NOT verify any claimed tier/)
  })

  it('covers every project in the workspace', () => {
    // A registry missing a project is the failure it exists to prevent, and
    // the count is the only thing that notices a quiet omission.
    assert.ok(
      REGISTRY.projects.length >= 14,
      `registry lists ${REGISTRY.projects.length} projects; the fleet has at least 14`,
    )
  })

  it('rejects an unknown archetype', () => {
    const result = run(withProject(0, { archetype: 'something-new' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unknown archetype/)
  })

  it('rejects a tier outside 0-3 and an unowned project', () => {
    assert.match(run(withProject(0, { tier: 7 })).stderr, /tier must be 0-3/)
    assert.match(run(withProject(0, { owner: '' })).stderr, /Unowned work is nobody's work/)
  })

  it('rejects the same project listed twice', () => {
    const doc = structuredClone(REGISTRY)
    doc.projects.push(structuredClone(doc.projects[0]))
    const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
    temps.push(dir)
    const path = join(dir, 'fleet.json')
    writeFileSync(path, JSON.stringify(doc), 'utf8')
    assert.match(run(path).stderr, /listed twice/)
  })

  // Deferral is fine; undated deferral becomes permanent by accident.
  it('fails once an entry has gone stale, and names the remedy', () => {
    const result = run(withProject(0, { verifiedAt: '2020-01-01' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /days ago \(limit 120\)/)
    assert.match(result.stderr, /Re-check the tier and move the date, or lower the tier/)
  })

  it('rejects a malformed verification date rather than ignoring it', () => {
    assert.match(run(withProject(0, { verifiedAt: 'recently' })).stderr, /YYYY-MM-DD/)
  })

  describe('evidence path overrides', () => {
    // An override moves a path; it must not waive the requirement, and an
    // unexplained exception is indistinguishable from a mistake.
    it('requires a reason', () => {
      const result = run(withProject(0, { evidenceReason: undefined }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /gives no evidenceReason/)
    })

    it('rejects an override of something that is not a tier requirement', () => {
      const doc = structuredClone(REGISTRY.projects[0].evidencePaths)
      const result = run(withProject(0, { evidencePaths: { ...doc, 'docs/nope.md': 'x' } }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /not a tier requirement/)
    })
  })

  // Every per-project assertion is inside a loop over the list, so a truncated
  // or empty file would satisfy all of them by having none to make.
  it('refuses to run on a suspiciously short registry', () => {
    const doc = structuredClone(REGISTRY)
    doc.projects = doc.projects.slice(0, 3)
    const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
    temps.push(dir)
    const path = join(dir, 'fleet.json')
    writeFileSync(path, JSON.stringify(doc), 'utf8')
    const result = run(path)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Every check below would pass over the gap/)
  })

  it('fails closed when the registry cannot be read', () => {
    const result = run('/no/such/fleet.json')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot read/)
  })

  /**
   * A lookup that failed for a reason other than 404 is not evidence of
   * absence. Collapsing it either way is wrong in a different direction:
   * "absent" cries wolf during an outage, and crying wolf is how a check gets
   * switched off along with its real detections; "present" certifies a tier
   * nobody checked.
   */
  it('reports an unreadable lookup as unknown rather than deciding', () => {
    const source = readFileSync(CHECK, 'utf8')
    assert.match(source, /if \(\/404\|Not Found\/i\.test\(message\)\) return 'absent'/)
    assert.match(source, /return 'unknown'/)
    assert.match(source, /not evidence of absence/)
  })

  /**
   * V39, and the reason it exists. GitHub answers 404 for a private repository
   * the caller cannot see and 404 for a path that is not there, so the first
   * online run of this check reported four present files as missing and
   * accused BinderCurve of having adopted nothing. Credentials that cannot
   * open the repository must produce one credentials problem, not one
   * confident falsehood per lookup.
   */
  it('blames the token, not the project, when it cannot see a repository', () => {
    const result = spawnSync('node', [CHECK], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: 'ghp_0000000000000000000000000000000000000000' },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot see 1 repository/)
    assert.match(result.stderr, /means "cannot see", not "not there"/)
    assert.doesNotMatch(
      result.stderr,
      /claims tier \d+ but has no/,
      'an unreadable repository must never reach the absent branch',
    )
    // One message, not one per required artefact.
    assert.match(result.stderr, /^\n✗ fleet registry: 1 problem\(s\)/)
  })

  /**
   * The org repo asks GitHub about its own default branch for every other
   * project, but must read the working tree for itself: otherwise the change
   * that adds a file and the entry claiming it can never be green at the same
   * time, and the only ways out are merging red or weakening the check.
   */
  it('resolves its own repository from the working tree, not the API', () => {
    const source = readFileSync(CHECK, 'utf8')
    assert.match(source, /if \(slug === HERE\) return existsSync\(path\)/)
  })
})

describe('FLEET.md', () => {
  it('matches the registry it is generated from', () => {
    const result = spawnSync('node', [RENDER, '--check'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  it('says it is generated, so nobody edits it by hand', () => {
    assert.match(readFileSync('FLEET.md', 'utf8'), /^<!-- Generated from fleet\.json/)
  })
})
