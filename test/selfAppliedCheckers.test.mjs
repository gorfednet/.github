/**
 * The org repository is a consumer of its own kit, and the list of checkers it
 * runs against itself was kept by hand.
 *
 * check-machine-paths shipped without being added to it. That mattered more than
 * a missing step usually would: the checker reads the git index, and it was
 * validated across the fleet while its own file was still untracked, so it never
 * saw itself. The commit that landed it made this repository fail its own check
 * on its own pattern definitions and a dozen deliberate test fixtures, and every
 * consumer that refreshed inherited the same failure. Two of them answered by
 * waiving /Users/gorf/ outright — the check switched off, still green.
 *
 * These tests fail when a checker is neither wired in here nor excluded with a
 * stated reason, so the decision has to be made when the checker is written.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { NOT_APPLICABLE, SELF_APPLIED } from '../scripts/lib/selfAppliedCheckers.mjs'

const BIN = 'templates/verification-kit/bin'
const workflow = readFileSync('.github/workflows/verification-kit.yml', 'utf8')
const checkers = readdirSync(BIN).filter((name) => name.endsWith('.mjs'))

/**
 * The exact arguments CI passes to check-machine-paths, taken from the workflow.
 * Throws rather than returning an empty list if the invocation cannot be found:
 * "no arguments" and "I could not read the step" would otherwise look identical,
 * and the empty case is the one that quietly passes.
 */
function waivedInWorkflow() {
  const line = workflow
    .split('\n')
    .find((l) => l.includes('check-machine-paths.mjs') && l.trimStart().startsWith('run:'))
  if (!line) throw new Error('no run: line invokes check-machine-paths.mjs in verification-kit.yml')
  const args = []
  for (const [, value] of line.matchAll(/--allow\s+'([^']+)'/g)) args.push('--allow', value)
  return args
}

describe('checkers this repository applies to itself', () => {
  it('classifies every checker the kit ships, so a new one forces the decision', () => {
    const classified = new Set([...SELF_APPLIED, ...Object.keys(NOT_APPLICABLE)])
    const unclassified = checkers.filter((name) => !classified.has(name))
    assert.deepEqual(
      unclassified,
      [],
      `${unclassified.join(', ')} is neither run against this repository nor excluded ` +
        'with a reason. Add it to SELF_APPLIED and wire it into ' +
        'verification-kit.yml, or to NOT_APPLICABLE with the sentence explaining ' +
        'what running it here would fail to prove.',
    )
  })

  it('names nothing that does not exist, so a rename cannot leave a phantom entry', () => {
    const known = new Set(checkers)
    const phantom = [...SELF_APPLIED, ...Object.keys(NOT_APPLICABLE)].filter(
      (name) => !known.has(name),
    )
    assert.deepEqual(phantom, [], `${phantom.join(', ')} is classified but no longer exists`)
  })

  it('gives every exclusion a reason long enough to be one', () => {
    // "n/a" is not a reason, and an empty string is how a list stops meaning
    // anything while still passing a length check.
    for (const [name, reason] of Object.entries(NOT_APPLICABLE)) {
      assert.ok(
        typeof reason === 'string' && reason.trim().length >= 40,
        `${name}: exclusion needs a stated reason, got ${JSON.stringify(reason)}`,
      )
    }
  })

  it('actually invokes each self-applied checker in the workflow', () => {
    /*
     * The half that matters. A registry saying a checker runs here, next to a
     * workflow that does not run it, is the same hand-maintained claim one level
     * removed — and it would read as authoritative.
     */
    const missing = SELF_APPLIED.filter((name) => !workflow.includes(`${BIN}/${name}`))
    assert.deepEqual(
      missing,
      [],
      `${missing.join(', ')} is listed as self-applied but ${BIN}/<name> does not ` +
        'appear in verification-kit.yml, so nothing runs it here.',
    )
  })

  it('passes the machine-path check on this repository, not merely wiring it', () => {
    /*
     * Running the checker rather than asserting a string appears in a workflow.
     * The wiring test above would have passed throughout the failure this file
     * exists because of.
     *
     * The waivers are read out of the workflow rather than restated here. A copy
     * would let the test and the step disagree, and the test is the one that would
     * be believed: it would keep passing with its own allowance while CI ran a
     * different one.
     */
    const result = spawnSync('node', [`${BIN}/check-machine-paths.mjs`, ...waivedInWorkflow()], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  })

  it('waives nothing broad enough to switch the check off', () => {
    /*
     * Five of ten repositories once answered a failure in this checker by waiving
     * /Users/gorf/ and ../ssatcy.com/node_modules — the two patterns it exists to
     * find. A waiver naming the check's own reason for existing reads as
     * authorised to the next person who hits the failure, so the shape is the
     * defect regardless of what it currently suppresses.
     */
    const tooBroad = ['/Users/', '/home/', '/Users/gorf', '/home/gorf', 'node_modules']
    for (const arg of waivedInWorkflow().filter((a) => a !== '--allow')) {
      assert.ok(
        !tooBroad.includes(arg.replace(/\/$/, '')),
        `the waiver "${arg}" is broad enough to hide the class this checker exists to catch. ` +
          'Name the specific file or directory instead.',
      )
    }
  })
})
