/**
 * The inputs every reusable `pr-check-*` workflow must expose to reach the
 * verification gate, in one place.
 *
 * There were two copies of this list. `add-verification-inputs.mjs` wrote the
 * workflows, `test/orgWorkflows.test.mjs` asserted they were complete, and
 * neither read the other. `source-dirs` was added to the second and not the
 * first, so the script the test recommends produced a workflow that failed the
 * test. Nobody would have noticed until the next archetype needed a workflow.
 *
 * That is V24 — put the derivation where the second instance can reach it,
 * because there is always a second instance — and V23, compute rather than
 * enumerate. Adding an input here now reaches the generator, the assertion and
 * the pass-through block at once.
 */

/**
 * Name → the YAML block declaring it, indented for a `workflow_call.inputs`
 * section. Order is the order they are written.
 */
export const VERIFICATION_INPUTS = {
  'verification-kit': `      verification-kit:
        description: >-
          Path to the vendored verification kit. Empty disables the gate.
          The default is empty on purpose: all fourteen projects already
          inherit these workflows, so a non-empty default would have turned
          every one of them red on the day the gate landed, and a fleet-wide
          red is indistinguishable from a fleet-wide outage. Adoption is
          opt-in and per project; FLEET.md is what stops "not yet" becoming
          permanent.
        required: false
        type: string
        default: ""`,

  'verification-backlog': `      verification-backlog:
        description: Path to the project's backlog. Empty skips that check.
        required: false
        type: string
        default: docs/backlog.json`,

  'test-report': `      test-report:
        description: Playwright or Vitest JSON report to assert a floor against.
        required: false
        type: string
        default: ""`,

  'min-tests': `      min-tests:
        description: Executed-test floor. Set it to what the job runs today.
        required: false
        type: string
        default: "1"`,

  'rule-sources': `      rule-sources:
        description: >-
          Space-separated roots to scan for rule citations. Defaults to the
          whole tree, which is right until a project vendors third-party code:
          towit.io ships a bundled AngularJS whose wrapped lines read as a
          citation of a rule numbered zero, which no editing of a third-party
          library can fix.

          The gate action has always had this input. No caller exposed it, so
          no project could set it — an input nothing can reach is the same as
          no input at all (rule V54).
        required: false
        type: string
        default: "."`,

  'source-dirs': `      source-dirs:
        description: >-
          Space-separated directories that look generated but hold hand-written
          code here. \`build/\` is output nearly everywhere and is where
          gorfed.net keeps its Python build scripts, so the kit's list cannot
          simply drop it. Each one is printed on every run.
        required: false
        type: string
        default: ""`,
}

/** The input names, for assertions that only care about presence. */
export const VERIFICATION_INPUT_NAMES = Object.keys(VERIFICATION_INPUTS)

/**
 * Maps each input to the `with:` key the composite action expects. They differ
 * because the action's own names are shorter — `kit`, not `verification-kit`.
 */
export const GATE_ARGUMENTS = {
  'verification-kit': 'kit',
  'verification-backlog': 'backlog',
  'test-report': 'test-report',
  'min-tests': 'min-tests',
  'rule-sources': 'rule-sources',
  'source-dirs': 'source-dirs',
}

/**
 * Every input the composite action declares, read from the action itself.
 *
 * This list used to be implicit in the one above, and that is how
 * `rule-sources` came to exist on the action while no reusable workflow
 * exposed it: the action grew an input, the pass-through map did not, and
 * because the action defaults it to `.` nothing ever failed. Twelve projects
 * inherited an option none of them could set, and towit.io could not scope its
 * citation scan away from a vendored AngularJS bundle without an org change.
 *
 * Derived rather than enumerated (V23), so the next input added to the action
 * fails this repository's own tests until a caller can reach it.
 */
export function actionInputNames(actionYaml) {
  const inputsSection = /^inputs:\n([\s\S]*?)^(?:runs|outputs|branding):/m.exec(actionYaml)
  if (inputsSection === null) {
    throw new Error(
      'could not find an `inputs:` section in the verification-gate action. ' +
        'Returning an empty list here would make every assertion over it pass.',
    )
  }
  const names = [...inputsSection[1].matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(
    (match) => match[1],
  )
  if (names.length === 0) {
    throw new Error(
      'read no input names from the verification-gate action. The YAML shape ' +
        'changed, so this is a parse failure rather than an action with no inputs.',
    )
  }
  return names
}

/** The full `inputs:` fragment, in declaration order. */
export function inputsBlock() {
  return `${Object.values(VERIFICATION_INPUTS).join('\n')}\n`
}

/** The gate step, including every pass-through, derived from the same list. */
export function gateStep() {
  const passthrough = Object.entries(GATE_ARGUMENTS)
    .map(([input, key]) => `          ${key}: \${{ inputs.${input} }}`)
    .join('\n')

  return `      # Every check the fleet shares, in one step so a fix reaches all of
      # them. Runs last because it needs the test report, and \`!cancelled()\`
      # inside the action so an earlier failure cannot switch it off (V18).
      - name: Verification gate
        if: \${{ !cancelled() && inputs.verification-kit != '' }}
        uses: gorfednet/.github/.github/actions/verification-gate@main
        with:
${passthrough}
`
}
