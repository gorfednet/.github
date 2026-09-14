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

  'site-url': `      site-url:
        description: >-
          Production base URL, no trailing slash. Required by the metadata and
          og:image checks, which have to know what "on this site" means before they
          can tell an absolute local URL from a third-party hotlink. Empty skips
          both, which is right only for a project that ships no HTML.
        required: false
        type: string
        default: ""`,

  'metadata-pages': `      metadata-pages:
        description: >-
          Space-separated HTML files to check, one per route the site actually
          serves — not just the homepage.

          ssatcy.com is why this is a list. It builds one shell for seven routes, so
          six of its pages emitted the homepage's canonical and could not rank,
          while every homepage-level check in the fleet passed. A representative
          page is not a sample of a per-page property; it is the page that works.
        required: false
        type: string
        default: ""`,

  'publish-root': `      publish-root:
        description: >-
          Directory the site's URL paths resolve against on disk, so an og:image URL
          can be turned back into bytes to open. Usually \`dist\` or \`public\`.
        required: false
        type: string
        default: ""`,

  'og-max-bytes': `      og-max-bytes:
        description: >-
          Ceiling for the social card image. denseware.com pointed og:image at a
          3840x4557 background weighing 2.1 MB; some scrapers give up first.
        required: false
        type: string
        default: "300000"`,

  'require-jsonld': `      require-jsonld:
        description: >-
          When "true", every checked page must carry a JSON-LD block. Off by
          default because a Tier 1 holding page has nothing to describe.
        required: false
        type: string
        default: "false"`,

  'error-page-root': `      error-page-root:
        description: >-
          Directory that should contain 404.html and 500.html. Empty skips the
          check. This is only the repository half — the server half is the live
          probe in production-healthcheck, because a 404.html nginx was never told
          to serve is exactly as useful as no file (V66).
        required: false
        type: string
        default: ""`,

  'error-page-markers': `      error-page-markers:
        description: >-
          Space-separated strings from this site's own design that must appear in
          each error page. Without one, "the file exists" is the whole assertion,
          and a placeholder added to turn a check green satisfies it.
        required: false
        type: string
        default: ""`,

  'allow-machine-paths': `      allow-machine-paths:
        description: >-
          Space-separated substrings waiving a deliberate absolute path from
          check-machine-paths (V73). The waiver belongs in the caller's config
          rather than as a marker inside the file it excuses, so that auditing
          what a repository is allowed to hardcode does not require a grep.
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
  'site-url': 'site-url',
  'metadata-pages': 'metadata-pages',
  'publish-root': 'publish-root',
  'og-max-bytes': 'og-max-bytes',
  'require-jsonld': 'require-jsonld',
  'error-page-root': 'error-page-root',
  'error-page-markers': 'error-page-markers',
  'allow-machine-paths': 'allow-machine-paths',
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
