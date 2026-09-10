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
import {
  GATE_ARGUMENTS,
  VERIFICATION_INPUT_NAMES,
  actionInputNames,
} from '../scripts/lib/verificationInputs.mjs'

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

      // Read from the same module the generator writes from. When these were
      // two lists, `source-dirs` was added here and not there, so the script
      // this test tells authors to run produced a workflow that failed this
      // test. V24: put the derivation where the second instance can reach it.
      it('exposes the inputs a project needs to configure it', () => {
        assert.ok(VERIFICATION_INPUT_NAMES.length >= 5, 'the input list is suspiciously short')
        for (const input of VERIFICATION_INPUT_NAMES) {
          assert.ok(text.includes(`      ${input}:`), `missing workflow input ${input}`)
        }
      })

      it('forwards every input to the gate, not just the ones it started with', () => {
        // An input a project can set and the gate never receives is worse
        // than no input: the configuration reads as applied.
        const step = text.slice(text.indexOf('- name: Verification gate'))
        for (const [input, key] of Object.entries(GATE_ARGUMENTS)) {
          assert.ok(
            step.includes(`${key}: \${{ inputs.${input} }}`),
            `the gate step drops ${input}; a project setting it would see no effect`,
          )
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
   * The failure this catches is quiet in the worst way: the action grows an
   * input with a sensible default, no reusable workflow passes it through, and
   * because the default is sensible nothing ever goes red. The option reads as
   * configurable in the action's own documentation while no project can set
   * it. `rule-sources` sat like that across twelve adopting projects.
   */
  it('every input it declares can be set by a caller', () => {
    const declared = actionInputNames(text)
    const reachable = new Set(Object.values(GATE_ARGUMENTS))
    const unreachable = declared.filter((name) => !reachable.has(name))
    assert.deepEqual(
      unreachable,
      [],
      `the action declares ${unreachable.join(', ')}, which no reusable workflow ` +
        'passes through, so no project can set it. Add it to VERIFICATION_INPUTS ' +
        'and GATE_ARGUMENTS in scripts/lib/verificationInputs.mjs.',
    )
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

  /**
   * The kit vendors its own test suite into every project, and until this step
   * existed no project ever ran it — assertions shipped as decoration, which
   * reads as coverage to anyone who sees the directory. It also answers what
   * the drift check cannot: whether the kit runs *here*, on this runner, in a
   * repository that may have no npm at all.
   */
  it("runs the kit's own tests, with a floor under the count", () => {
    assert.match(text, /The kit works in this repository/)
    assert.match(text, /--test-reporter=tap/)
    assert.match(text, /-lt 40/, 'a self-test step with no floor passes when the glob misses')
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
   * The publish-set checks assert what a deploy *sends*. Nothing asserted what
   * the server already holds, and rsync will not clear it: `--delete` protects
   * excluded files on the receiver, so adding a path to .deployignore stops the
   * re-upload and guarantees the copy already there stays forever. Measured on
   * a local pair of directories — `--delete` left the excluded file, only
   * `--delete-excluded` removed it. anal0g.org has been serving
   * nginx-routes.conf and LICENSE on exactly that mechanism.
   */
  describe('the forbidden-path probe', () => {
    const step = text.slice(text.indexOf('- name: Paths that must not be public'))

    it('treats anything under 400 as a leak', () => {
      assert.match(step, /-lt 400/)
      assert.match(step, /is public \(HTTP/)
    })

    it('does not follow redirects, so it reports on the path asked about', () => {
      const curl = /curl [^\n]*forbidden|curl -sS -o \/dev\/null -w '%\{http_code\}'[^\n]*/.exec(step)
      assert.ok(curl, 'expected a curl in the forbidden-path step')
      assert.doesNotMatch(curl[0], / -L\b/)
    })

    it('refuses to read an unreachable host as a withheld file', () => {
      assert.match(step, /000/)
      assert.match(step, /not the\n?\s*#?\s*same as being withheld|same as being withheld/)
    })

    /**
     * The first version wrote `curl ... -w '%{http_code}' || echo 000`. But
     * `-w` already prints 000 on failure, so the fallback appended a second
     * one, `$code` became "000\n000", the numeric comparison errored on a
     * non-number, the elif fell through, and an unreachable host was reported
     * as *withheld*. A false pass in the one branch written to prevent it.
     */
    it('never lets a non-numeric status reach the numeric comparison', () => {
      // Comments stripped first. The comment above the fix quotes the broken
      // expression in order to explain it, and matching that is how this
      // assertion failed against the corrected file — the same trap the
      // citation checker documents about its own prose.
      const code = step
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')

      assert.doesNotMatch(
        code,
        /\|\|\s*echo\s*000/,
        'curl -w already prints 000 on failure; appending another makes $code a non-number',
      )
      assert.match(
        step,
        /\[0-9\]\[0-9\]\[0-9\]\)/,
        'expected a three-digit case guard normalising anything else to 000',
      )
    })

    it('fails rather than ticks when the list parses to nothing', () => {
      assert.match(step, /probed" -eq 0/)
      assert.match(step, /parsed to nothing/)
    })

    it('is skippable only by leaving the input empty, never by an earlier failure', () => {
      assert.match(step, /if: \$\{\{ !cancelled\(\) && inputs\.forbid-paths != '' \}\}/)
    })
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

/**
 * A job with no `timeout-minutes` runs until GitHub kills it at six hours.
 *
 * Nobody notices, because the failure mode is a bill and a queue rather than a
 * red check — and in this repository a missing timeout is inherited by every
 * project that calls the workflow. `compat-success` was unbounded and six
 * repos were calling it.
 *
 * Found by the headroom check (V48) reporting "no timeout-minutes found",
 * which was meant as a diagnostic and turned out to be a finding.
 */
describe('every job is bounded', () => {
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8')

    it(`${file} declares a timeout on every job it runs itself`, () => {
      const unbounded = []

      // Only inside `jobs:`. Two-space keys also appear under `on:` and
      // `permissions:`, and counting `pull_request:` as an unbounded job
      // reports every workflow in the repository as broken — which is how
      // this assertion first behaved, and a check that fails on everything
      // gets deleted rather than read.
      let inJobs = false
      let job = null
      let body = []

      const check = () => {
        if (!job) return
        const joined = body.join('\n')
        // A job that delegates with `uses:` inherits the callee's timeout, and
        // GitHub rejects `timeout-minutes` alongside it.
        if (/^ {4}uses:/m.test(joined)) return
        if (!/^ {4}timeout-minutes:/m.test(joined)) unbounded.push(job)
      }

      for (const line of text.split('\n')) {
        if (/^[A-Za-z0-9_-]+:/.test(line)) {
          check()
          job = null
          inJobs = line.startsWith('jobs:')
          continue
        }
        if (!inJobs) continue

        const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
        if (header) {
          check()
          job = header[1]
          body = []
        } else if (job) {
          body.push(line)
        }
      }
      check()

      assert.deepEqual(unbounded, [], `unbounded job(s) in ${file}: ${unbounded.join(', ')}`)
    })
  }
})
