/**
 * Guards on this repository's own workflows.
 *
 * Every project in the fleet inherits its CI from one of the reusable
 * `pr-check-*` workflows here, which makes them the highest-leverage files in
 * the org — and the easiest place for a gap to go unnoticed, because nobody
 * reads a workflow they did not write. A sixth workflow added next month
 * without the verification gate would give whichever project adopts it a green
 * check over nothing checked.
 *
 * Derived from the directory rather than from a list, per rule V23: a
 * hand-maintained list of what to check is the thing that goes stale.
 */
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const WORKFLOWS = '.github/workflows'
const ACTIONS = '.github/actions'

const reusableChecks = readdirSync(WORKFLOWS).filter(
  (file) => file.startsWith('pr-check-') && file.endsWith('.yml'),
)

describe('reusable pr-check workflows', () => {
  it('there are some, so nothing below passes over an empty list', () => {
    assert.ok(
      reusableChecks.length >= 5,
      `found ${reusableChecks.length} pr-check workflows, expected at least 5`,
    )
  })

  for (const file of reusableChecks) {
    describe(file, () => {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8')

      // The whole point of the org layer: a project upgrades its `uses:` line
      // and inherits the gate. A workflow that skipped this hands the project
      // a green check over nothing checked.
      it('runs the verification gate', () => {
        assert.match(
          text,
          /uses: gorfednet\/\.github\/\.github\/actions\/verification-gate@/,
          'Add the gate, or run scripts/add-verification-inputs.mjs',
        )
      })

      /**
       * All fourteen projects already inherit one of these workflows, so a
       * non-empty default would have turned the whole fleet red on the day
       * the gate landed — and a fleet-wide red is indistinguishable from a
       * fleet-wide outage, which is how a gate gets switched off rather than
       * adopted. Adoption is opt-in and per project.
       *
       * The opposite failure — "not yet" becoming permanent — is FLEET.md's
       * job, not this default's.
       */
      it('defaults the gate to off, so adoption is a decision', () => {
        const block = text.slice(text.indexOf('      verification-kit:'))
        const lines = block.split('\n').slice(0, 14)
        assert.ok(
          lines.some((l) => l.trim() === 'default: ""'),
          'verification-kit must default to empty; see FLEET.md for who has adopted',
        )
      })

      it('exposes the inputs a project needs to configure it', () => {
        for (const input of ['verification-kit:', 'verification-backlog:', 'test-report:', 'min-tests:']) {
          assert.ok(text.includes(`      ${input}`), `missing workflow input ${input}`)
        }
      })

      // Rule V18. GitHub defaults a step to success(), so an unrelated earlier
      // failure — an artifact upload 403, say — silently switches the gate off
      // at exactly the moment it matters.
      it('does not let an earlier failure switch the gate off', () => {
        const step = text.slice(text.indexOf('- name: Verification gate'))
        assert.match(step.split('\n').slice(0, 3).join('\n'), /if: \$\{\{ !cancelled\(\)/)
      })
    })
  }
})

describe('verification-gate composite action', () => {
  const text = readFileSync(join(ACTIONS, 'verification-gate/action.yml'), 'utf8')

  it('is a composite action, so it can be dropped into any job', () => {
    assert.match(text, /using: composite/)
  })

  /**
   * Every step, not most of them. The failure this prevents is subtle: the
   * steps that most need `if:` are the assertions, and the assertions are the
   * ones placed last, which is precisely where an earlier failure reaches
   * them. Counting rather than sampling is the difference between a guard and
   * a spot check.
   */
  it('gives every step an if: that survives an earlier failure', () => {
    const steps = text.split('\n').filter((line) => /^    - name: /.test(line))
    assert.ok(steps.length >= 5, `parsed ${steps.length} steps, expected at least 5`)

    // Only real `if:` keys. The prose above the steps names the same
    // expression, and counting it would let one unguarded step hide behind a
    // comment that says they are all guarded — a claim about verification
    // read as verification, which is rule V20.
    const guarded = text
      .split('\n')
      .filter((line) => /^\s*if: \$\{\{ !cancelled\(\)/.test(line))
    assert.equal(
      guarded.length,
      steps.length,
      `${steps.length} steps but ${guarded.length} carry "if: \${{ !cancelled()". ` +
        'A verification step ordered behind something that can fail for an unrelated ' +
        'reason is not a gate.',
    )
  })

  it('runs each kit check by name, so a renamed script fails loudly', () => {
    for (const script of [
      'check-kit-drift.mjs',
      'check-rule-citations.mjs',
      'check-tracked-artifacts.mjs',
      'check-backlog.mjs',
      'assert-tests-executed.mjs',
    ]) {
      assert.ok(text.includes(script), `the gate never runs ${script}`)
    }
  })

  // A missing kit is the condition the gate exists to surface in a project
  // that has not adopted it, so it must not read as "nothing to check".
  it('fails when the kit is absent rather than skipping', () => {
    assert.match(text, /No verification kit at/)
    assert.match(text, /exit 1/)
  })
})

/**
 * Nine sites are watched by this one file, and a monitor is the last thing
 * that should be taken on trust: when it fails silently nobody finds out until
 * a person happens to load the site. Three of its shapes were exactly that.
 */
describe('production-healthcheck workflow', () => {
  const text = readFileSync(join(WORKFLOWS, 'production-healthcheck.yml'), 'utf8')

  /**
   * The worst of the three. The step read `if [[ ! -f e2e/smoke.spec.ts ]];
   * then echo "skipping"; exit 0; fi`, so renaming or moving a spec ended live
   * monitoring for that project and printed a tick while doing it. Five
   * projects had run-playwright at its default of true.
   */
  it('fails when asked for a live smoke it cannot find', () => {
    const step = text.slice(text.indexOf('- name: Playwright live smoke'))
    assert.match(step, /does not exist/)
    assert.match(step, /exit 1/)
    assert.doesNotMatch(
      step.slice(0, step.indexOf('npx playwright')),
      /exit 0/,
      'a missing spec must fail; opting out is run-playwright: false',
    )
  })

  it('counts what the live smoke executed, since a filtered suite exits 0', () => {
    assert.match(text, /Assert the live smoke actually ran/)
    assert.match(text, /executed no specs|assert-tests-executed\.mjs/)
  })

  /**
   * A status code says a server answered. A parking page, a CDN error page and
   * a blank 200 all answer.
   */
  it('looks at the body, not only the status code', () => {
    const step = text.slice(text.indexOf('- name: HTTP health checks'))
    // The comparison itself, not the error message next to it: a message can
    // sit under a condition that no longer runs, and read as a check.
    assert.match(
      step,
      /if \[ "\$bytes" -lt "\$min_bytes" \]/,
      'the size floor must be an executed comparison',
    )
    assert.match(step, /grep -qF/, 'expect-text must actually be matched against the body')
    assert.match(step, /An empty 200 is the shape of a broken deploy/)
  })

  it('rejects a redirect that leaves the origin', () => {
    assert.match(text, /off \$host/)
    assert.match(text, /final_host/)
  })

  // curl -L plus a for-loop over an empty string is a job that passes having
  // fetched nothing at all.
  it('fails rather than passing when it checked zero paths', () => {
    assert.match(text, /Zero paths checked. This job proved nothing/)
  })

  it('says out loud when it never inspected any content', () => {
    assert.match(text, /::warning::No expect-text given/)
  })
})

describe('bugbot-verdict workflow', () => {
  const text = readFileSync(join(WORKFLOWS, 'bugbot-verdict.yml'), 'utf8')

  it('is reusable', () => {
    assert.match(text, /workflow_call:/)
  })

  /**
   * The reason this workflow exists. A Bugbot NEUTRAL prints in the checks
   * panel in the same bucket as a clean pass and means "reviewed, and found
   * things" — so a verdict job that treats anything other than an explicit
   * clean result as acceptable reproduces the bug it was written to fix.
   */
  it('treats a timeout as a failure, not as a pass', () => {
    assert.match(text, /No Bugbot verdict on PR/)
    const afterTimeout = text.slice(text.indexOf('No Bugbot verdict on PR'))
    assert.match(afterTimeout.split('\n').slice(0, 4).join('\n'), /exit 1/)
  })

  it('stops immediately on findings rather than waiting them out', () => {
    assert.match(text, /found something/)
  })

  it('passes only on the clean exit code from the kit', () => {
    assert.match(text, /bugbot-review-status\.mjs/)
    assert.match(text, /if \[ "\$status" -eq 0 \]/)
  })
})
