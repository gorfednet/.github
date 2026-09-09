#!/usr/bin/env node
/**
 * Bring every reusable `pr-check-*` workflow in line with the verification
 * gate: the inputs it needs, and the step that calls it.
 *
 * Written as a script rather than five hand edits because five hand edits are
 * four opportunities to write it slightly differently, and a set of workflows
 * that are almost the same is how a fix reaches four of them.
 *
 * It repairs as well as creates. The first version only skipped a workflow
 * that already had the gate step, so when `source-dirs` was added later, the
 * five wired workflows stayed one input short and running this changed
 * nothing — while the test it is recommended by demanded the input. A tool
 * that cannot fix a partial state is a tool people stop reaching for.
 *
 * The list itself lives in `lib/verificationInputs.mjs`, read by this script
 * and by `test/orgWorkflows.test.mjs`, per V24.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  VERIFICATION_INPUTS,
  GATE_ARGUMENTS,
  gateStep,
} from './lib/verificationInputs.mjs'

const WORKFLOWS = '.github/workflows'

const targets = readdirSync(WORKFLOWS).filter((f) => f.startsWith('pr-check-') && f.endsWith('.yml'))
if (targets.length === 0) {
  console.error('✗ no pr-check-*.yml workflows found; refusing to report success')
  process.exit(1)
}

/** Insert input blocks at the end of the `workflow_call.inputs:` section. */
function addInputs(text, file, missing) {
  const lines = text.split('\n')
  const inputsAt = lines.findIndex((l) => l === '    inputs:')
  if (inputsAt === -1) {
    console.error(`✗ ${file}: no "    inputs:" block; wire it by hand`)
    process.exit(1)
  }
  let end = inputsAt + 1
  while (end < lines.length && (lines[end].startsWith('      ') || lines[end].trim() === '')) end += 1

  const block = missing.map((name) => VERIFICATION_INPUTS[name]).join('\n')
  lines.splice(end, 0, ...block.split('\n'))
  return lines.join('\n')
}

/** Add any pass-through the gate step is missing, under its `with:`. */
function addPassthrough(text, missing) {
  const lines = text.split('\n')
  const stepAt = lines.findIndex((l) => l.includes('verification-gate@main'))
  if (stepAt === -1) return text

  let end = stepAt
  while (end < lines.length && !/^ {10}\S/.test(lines[end])) end += 1
  while (end < lines.length && /^ {10}\S/.test(lines[end])) end += 1

  const added = missing.map((name) => `          ${GATE_ARGUMENTS[name]}: \${{ inputs.${name} }}`)
  lines.splice(end, 0, ...added)
  return lines.join('\n')
}

let changed = 0
for (const file of targets) {
  const path = join(WORKFLOWS, file)
  let text = readFileSync(path, 'utf8')
  const before = text

  const missingInputs = Object.keys(VERIFICATION_INPUTS).filter(
    (name) => !text.includes(`      ${name}:`),
  )
  if (missingInputs.length > 0) text = addInputs(text, file, missingInputs)

  if (!text.includes('verification-gate@main')) {
    // The step goes at the end: it needs whatever the project's own steps
    // produced.
    text = `${text.replace(/\n+$/, '\n')}\n${gateStep()}`
  } else {
    const missingArgs = Object.keys(GATE_ARGUMENTS).filter(
      (name) => !text.includes(`inputs.${name} }}`),
    )
    if (missingArgs.length > 0) text = addPassthrough(text, missingArgs)
  }

  if (text === before) {
    console.log(`  = ${file} already complete`)
    continue
  }

  writeFileSync(path, text, 'utf8')
  console.log(`  + ${file}: ${missingInputs.join(', ') || 'gate step'}`)
  changed += 1
}

console.log(`\n✓ ${changed} of ${targets.length} workflow(s) changed`)
