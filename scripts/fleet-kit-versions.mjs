#!/usr/bin/env node
/**
 * Fails when a fleet repository's vendored kit is more than one minor behind
 * this repository's canonical kit, or ahead of it, or unreadable.
 *
 *   node scripts/fleet-kit-versions.mjs [--in status.json]
 *
 * Reads the status.json that fleet-status.mjs wrote. Runs in the daily
 * fleet-status workflow, not on pull requests (see scripts/lib/kit-version.mjs).
 */
import { readFileSync } from 'node:fs'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'
import { kitFailures } from './lib/kit-version.mjs'

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--in')
  const status = JSON.parse(readFileSync(at !== -1 ? process.argv[at + 1] : 'status.json', 'utf8'))
  const manifest = process.env.KIT_CANONICAL_MANIFEST ?? new URL('../templates/verification-kit/MANIFEST.json', import.meta.url)
  const canonical = JSON.parse(readFileSync(manifest, 'utf8')).version
  const measured = status.repos.filter((r) => !r.unavailable && r.kitVersion !== undefined)
  if (measured.length === 0) {
    // A run that measured nothing must not print the tick a clean fleet prints.
    console.error('::error::fleet-kit-versions: status.json carries no kitVersion for any repository, so nothing was checked.')
    process.exit(1)
  }
  const fleetPath = process.env.KIT_FLEET_JSON ?? new URL('../fleet.json', import.meta.url)
  const projects = JSON.parse(readFileSync(fleetPath, 'utf8')).projects
  const bad = kitFailures(status.repos, canonical, projects)
  for (const r of bad) {
    console.error(`::error title=Kit out of date::${r.slug} is on kit ${r.version || '(none or unreadable)'}, canonical is ${canonical} (${r.gap}). Run node verification-kit/bin/refresh-kit.mjs there.`)
  }
  if (bad.length > 0) process.exit(1)
  console.log(`fleet-kit-versions: ${measured.length} repositories within one minor of ${canonical}`)
}
