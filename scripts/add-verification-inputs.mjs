#!/usr/bin/env node
/**
 * One-off: add the verification-gate inputs and step to every reusable
 * pr-check workflow.
 *
 * Written as a script rather than five hand edits because five hand edits are
 * four opportunities to write it slightly differently, and a set of workflows
 * that are almost the same is how a fix reaches four of them.
 *
 * Kept in the repo so the next reusable workflow can be brought in line by
 * running it, rather than by copying from whichever sibling someone opens.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = '.github/workflows'

const INPUTS = `      verification-kit:
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
        default: ""
      verification-backlog:
        description: Path to the project's backlog. Empty skips that check.
        required: false
        type: string
        default: docs/backlog.json
      test-report:
        description: Playwright or Vitest JSON report to assert a floor against.
        required: false
        type: string
        default: ""
      min-tests:
        description: Executed-test floor. Set it to what the job runs today.
        required: false
        type: string
        default: "1"
`

const STEP = `      # Every check the fleet shares, in one step so a fix reaches all of
      # them. Runs last because it needs the test report, and \`!cancelled()\`
      # inside the action so an earlier failure cannot switch it off (V18).
      - name: Verification gate
        if: \${{ !cancelled() && inputs.verification-kit != '' }}
        uses: gorfednet/.github/.github/actions/verification-gate@main
        with:
          kit: \${{ inputs.verification-kit }}
          backlog: \${{ inputs.verification-backlog }}
          test-report: \${{ inputs.test-report }}
          min-tests: \${{ inputs.min-tests }}
`

const targets = readdirSync(WORKFLOWS).filter((f) => f.startsWith('pr-check-') && f.endsWith('.yml'))
if (targets.length === 0) {
  console.error('✗ no pr-check-*.yml workflows found; refusing to report success')
  process.exit(1)
}

let changed = 0
for (const file of targets) {
  const path = join(WORKFLOWS, file)
  let text = readFileSync(path, 'utf8')

  if (text.includes('verification-gate@main')) {
    console.log(`  = ${file} already wired`)
    continue
  }

  // Inputs go at the end of the existing `inputs:` block, which ends at the
  // first line that is not indented under it.
  const lines = text.split('\n')
  const inputsAt = lines.findIndex((l) => l === '    inputs:')
  if (inputsAt === -1) {
    console.error(`✗ ${file}: no "    inputs:" block; wire it by hand`)
    process.exit(1)
  }
  let end = inputsAt + 1
  while (end < lines.length && (lines[end].startsWith('      ') || lines[end].trim() === '')) end += 1
  lines.splice(end, 0, ...INPUTS.split('\n').slice(0, -1))
  text = lines.join('\n')

  // The step goes at the end of the file: it needs whatever the project's own
  // steps produced.
  text = `${text.replace(/\n+$/, '\n')}\n${STEP}`

  writeFileSync(path, text, 'utf8')
  console.log(`  + ${file}`)
  changed += 1
}

console.log(`\n✓ ${changed} of ${targets.length} workflow(s) wired`)
