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

import { FLOOR_ABOVE, tierTwoWiring } from '../scripts/tier-two-wiring.mjs'

const CHECK = resolve('scripts/check-fleet.mjs')
const RENDER = resolve('scripts/write-fleet-md.mjs')
const REGISTRY = JSON.parse(readFileSync('fleet.json', 'utf8'))
const FLOOR = REGISTRY.projects.find((p) => p.slug === 'gorfednet/.github').tierTwoFloor
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

  /**
   * The offline run is the only one a pull request can perform, and it reads
   * the registry back to itself. It therefore carries the deadline for the
   * online half, so that "we will wire the token up later" expires on a date
   * instead of quietly becoming the permanent arrangement.
   */
  describe('the deadline the offline run carries', () => {
    const withRoot = (changes) => {
      const doc = { ...structuredClone(REGISTRY), ...changes }
      for (const key of Object.keys(changes)) {
        if (changes[key] === undefined) delete doc[key]
      }
      const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
      temps.push(dir)
      const path = join(dir, 'fleet.json')
      writeFileSync(path, JSON.stringify(doc), 'utf8')
      return path
    }

    it('fails once the grace date has passed, naming both ways out', () => {
      const result = run(withRoot({ onlineGraceUntil: '2020-01-01', onlineVerifiedAt: null }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /no tier has been verified against a repository/)
      assert.match(result.stderr, /it has never run/)
      assert.match(result.stderr, /set onlineVerifiedAt to today, or move onlineGraceUntil/)
    })

    /**
     * The first version of this compared only the grace date and never looked
     * at onlineVerifiedAt, which made its own error message untrue: it named
     * recording a successful audit as the way out, and recording one changed
     * nothing. Every pull request would have been red from the grace date
     * onward however well the weekly audit was doing — and a check that stays
     * red whatever you do is one people route around.
     */
    it('a recent online run lifts the deadline, as the message promises', () => {
      const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
      const result = run(withRoot({ onlineGraceUntil: '2020-01-01', onlineVerifiedAt: recent }))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, new RegExp(`last ran ${recent}`))
    })

    // ...and an old one does not. The online half is held to reverifyDays like
    // every other claim in the file.
    it('an online run older than reverifyDays does not', () => {
      const result = run(withRoot({ onlineGraceUntil: '2020-01-01', onlineVerifiedAt: '2021-01-01' }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /the last one was 2021-01-01, \d+ days ago \(limit 120\)/)
    })

    it('rejects a malformed online date rather than reading it as never', () => {
      const result = run(withRoot({ onlineVerifiedAt: 'last week' }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /onlineVerifiedAt must be a YYYY-MM-DD date or null/)
    })

    it('refuses an undated deferral', () => {
      const result = run(withRoot({ onlineGraceUntil: undefined }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /an intention with no expiry/)
    })

    it('says when the online half last ran, and when this run stops passing', () => {
      const result = spawnSync('node', [CHECK, '--offline'], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Online verification (has never run|last ran \d{4}-\d{2}-\d{2})/)
      assert.match(result.stdout, /stops passing on \d{4}-\d{2}-\d{2}/)
    })
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

    /*
     * The expired exception. This repository is the one project the online
     * half can inspect without a token — `repoHasFile` reads the working tree
     * for its own slug — so the override branch is exercised for real rather
     * than against a stub of it.
     *
     * Everything else drops to tier 0 so the run makes no network call.
     */
    const onlyHere = (changes) => {
      const doc = structuredClone(REGISTRY)
      for (const project of doc.projects) {
        if (project.slug === 'gorfednet/.github') Object.assign(project, changes)
        else project.tier = 0
      }
      const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
      temps.push(dir)
      const path = join(dir, 'fleet.json')
      writeFileSync(path, JSON.stringify(doc), 'utf8')
      return path
    }

    it('flags an override whose canonical path has since appeared', () => {
      // Both sides present: docs/backlog.json is where the requirement points
      // and canaries.json is real too, so the redirect buys nothing.
      const result = run(
        onlyHere({
          tier: 1,
          evidencePaths: { 'docs/backlog.json': 'canaries.json' },
          evidenceReason: 'fixture',
        }),
        [],
      )
      assert.equal(result.status, 1, result.stdout)
      assert.match(result.stderr, /outlived its reason/)
    })

    it('leaves a still-needed override alone', () => {
      // The real one: the kit lives under templates/ here and is not vendored
      // into itself, so the canonical path is genuinely absent.
      const result = run(onlyHere({ tier: 1 }), [])
      assert.equal(result.status, 0, result.stderr)
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
   * Tier 2 used to be evidenced by the presence of
   * `verification-kit/bin/assert-tests-executed.mjs`, which every project that
   * vendored the kit has. Five projects held the tier that way while passing
   * `min-tests` to a shared gate that runs the assertion only when a report is
   * also passed, so the floor they configured never ran once.
   */
  describe('what tier 2 is evidenced by', () => {
    const caller = (body) => `jobs:\n  check:\n    uses: x/y@main\n    with:\n${body}`

    it('accepts a floor passed with the report it measures', () => {
      const wiring = tierTwoWiring(caller('      test-report: reports/test.json\n      min-tests: "73"\n'))
      assert.match(wiring.how, /min-tests 73 against reports\/test\.json/)
    })

    // The exact shape of the five. The number is there; nothing reads it.
    it('rejects a floor with no report to measure', () => {
      assert.equal(tierTwoWiring(caller('      min-tests: "110"\n')), null)
    })

    it('rejects an empty report, quoted or bare', () => {
      assert.equal(tierTwoWiring(caller('      test-report: ""\n      min-tests: "110"\n')), null)
      assert.equal(tierTwoWiring(caller('      test-report:\n      min-tests: "110"\n')), null)
    })

    // A suite that ran one test is the condition the assertion exists to catch.
    it('rejects a floor of exactly one', () => {
      const text = caller('      test-report: reports/test.json\n      min-tests: "1"\n')
      assert.equal(tierTwoWiring(text), null)
      assert.equal(FLOOR_ABOVE, 1)
    })

    /*
     * Both directions of pairing the wrong two lines, and both shapes are real.
     * `test-report: ""` is how a caller writes "skip this step", so taking the
     * first of each independently reads a protected repository as unprotected;
     * and pairing a report in one job with a floor in another certifies a
     * repository where no single step runs both.
     */
    it('is not fooled by an earlier empty report above a real pair', () => {
      const text = [
        'jobs:',
        '  quick:',
        '    uses: x/y@main',
        '    with:',
        '      test-report: ""',
        '  full:',
        '    uses: x/y@main',
        '    with:',
        '      test-report: reports/test.json',
        '      min-tests: "96"',
      ].join('\n')
      assert.match(tierTwoWiring(text).how, /min-tests 96 against reports\/test\.json/)
    })

    it('refuses a report in one job paired with a floor in another', () => {
      const text = [
        'jobs:',
        '  a:',
        '    uses: x/y@main',
        '    with:',
        '      test-report: reports/test.json',
        '  b:',
        '    uses: x/y@main',
        '    with:',
        '      min-tests: "96"',
      ].join('\n')
      assert.equal(tierTwoWiring(text), null)
    })

    it('refuses a pair split across two workflow files', () => {
      const withReport = 'jobs:\n  a:\n    with:\n      test-report: reports/test.json\n'
      const withFloor = 'jobs:\n  b:\n    with:\n      min-tests: "96"\n'
      assert.equal(tierTwoWiring([withReport, withFloor]), null)
    })

    it('accepts the binary called directly, and reports the weakest floor', () => {
      const text = [
        'run: node verification-kit/bin/assert-tests-executed.mjs --report a.json --min 280',
        'run: node verification-kit/bin/assert-tests-executed.mjs --report b.json --min 96',
      ].join('\n')
      assert.match(tierTwoWiring(text).how, /--min 96$/)
    })

    it('rejects the binary called with no floor, or with one', () => {
      assert.equal(tierTwoWiring('run: node verification-kit/bin/assert-tests-executed.mjs --report a.json'), null)
      assert.equal(
        tierTwoWiring('run: node verification-kit/bin/assert-tests-executed.mjs --report a.json --min 1'),
        null,
      )
    })

    /*
     * Vendoring the file is what used to count. It must now count for nothing
     * on its own, or the replacement changes only the error message.
     */
    it('rejects a workflow that merely mentions the kit', () => {
      assert.equal(tierTwoWiring('run: ls verification-kit/bin/assert-tests-executed.mjs\nrun: npm test'), null)
    })

    /*
     * This repository is the one the online half can read from the working
     * tree, so the branch runs for real here rather than against a stub.
     */
    const hereAtTierTwo = (changes) => {
      const doc = structuredClone(REGISTRY)
      for (const project of doc.projects) {
        if (project.slug !== 'gorfednet/.github') project.tier = 0
        else {
          Object.assign(project, { tier: 2 }, changes)
          for (const key of Object.keys(changes)) if (changes[key] === undefined) delete project[key]
        }
      }
      const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
      temps.push(dir)
      const path = join(dir, 'fleet.json')
      writeFileSync(path, JSON.stringify(doc), 'utf8')
      return path
    }

    it('names the inert-step trap rather than only the missing floor', () => {
      const result = run(hereAtTierTwo({ tierTwoFloor: undefined }), [])
      assert.equal(result.status, 1, result.stdout)
      assert.match(result.stderr, /configures a step that never runs/)
    })

    it('honours a declared floor the named workflow really contains', () => {
      assert.equal(run(hereAtTierTwo({}), []).status, 0)
    })

    it('rejects a declared floor whose pattern has left the workflow', () => {
      const result = run(hereAtTierTwo({ tierTwoFloor: { ...FLOOR, pattern: 'gone from this file' } }), [])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /no longer contains/)
    })

    it('rejects a declared floor pointing at a workflow that is not there', () => {
      const result = run(hereAtTierTwo({ tierTwoFloor: { ...FLOOR, workflow: '.github/workflows/nope.yml' } }), [])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /cannot be read/)
    })

    // An unexplained waiver is indistinguishable from a mistake.
    it('requires a reason of substance', () => {
      const result = run(hereAtTierTwo({ tierTwoFloor: { ...FLOOR, reason: 'because' } }), [])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /needs workflow, pattern and a reason of substance/)
    })
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
    // Derived, not typed. This count is every adopted project bar this one,
    // so it goes up on each rollout merge — written as a literal, the test
    // would turn red on the next adoption and say nothing about the token.
    const remote = REGISTRY.projects.filter((p) => p.tier > 0 && p.slug !== 'gorfednet/.github')
    const expected = remote.length === 1 ? '1 repository' : `${remote.length} repositories`

    const result = spawnSync('node', [CHECK], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: 'ghp_0000000000000000000000000000000000000000' },
    })
    assert.equal(result.status, 1)
    assert.ok(remote.length > 0, 'no adopted remote project left to make the lookup')
    assert.match(result.stderr, new RegExp(`cannot see ${expected}`))
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
