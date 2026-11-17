#!/usr/bin/env node
/**
 * Fails when the gate ref a fleet repository's workflows pin carries a kit more
 * than one minor behind this repository's canonical kit, or ahead of it, or
 * when the pin cannot be read. The vendored copy is not what the gate runs.
 *
 *   node scripts/fleet-kit-versions.mjs [--in status.json]
 *
 * Reads the status.json that fleet-status.mjs wrote. Runs in the daily
 * fleet-status workflow, not on pull requests (see scripts/lib/kit-version.mjs).
 */
import { readFileSync } from 'node:fs'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'
import { kitFailures } from './lib/kit-version.mjs'

/** One error line, with the fix that fits the pin's kind: a ref pin moves to main, a vendored copy is refreshed, an error row repeats its own cause. */
export function kitAdvice(r, canonical) {
  if (r.kind === 'vendored') return `${r.slug} runs its own kit copy: ${r.pin}, canonical kit is ${canonical} (${r.gap}). Run node verification-kit/bin/refresh-kit.mjs there.`
  if (r.kind === 'error') return `${r.slug} gate pin could not be established: ${r.pin} (${r.gap}). Fix that cause; nothing is assumed current.`
  return `${r.slug} gate pin is ${r.pin}, canonical kit is ${canonical} (${r.gap}). Move its workflows' gorfednet/.github refs to main.`
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--in')
  const status = JSON.parse(readFileSync(at !== -1 ? process.argv[at + 1] : 'status.json', 'utf8'))
  const manifest = process.env.KIT_CANONICAL_MANIFEST ?? new URL('../templates/verification-kit/MANIFEST.json', import.meta.url)
  const canonical = JSON.parse(readFileSync(manifest, 'utf8')).version
  const measured = status.repos.filter((r) => !r.unavailable && (typeof r.kitPin?.ref === 'string' || (r.kitPin?.vendored === true && typeof r.kitPin.version === 'string')))
  if (measured.length === 0) {
    // A run that measured nothing must not print the tick a clean fleet prints.
    console.error('::error::fleet-kit-versions: status.json carries no kitPin for any repository, so nothing was checked.')
    process.exit(1)
  }
  const fleetPath = process.env.KIT_FLEET_JSON ?? new URL('../fleet.json', import.meta.url)
  const projects = JSON.parse(readFileSync(fleetPath, 'utf8')).projects
  const bad = kitFailures(status.repos, canonical, projects)
  for (const r of bad) {
    console.error(`::error title=Kit out of date::${kitAdvice(r, canonical)}`)
  }
  if (bad.length > 0) process.exit(1)
  console.log(`fleet-kit-versions: ${measured.length} repositories pinned within one minor of ${canonical}`)
}
