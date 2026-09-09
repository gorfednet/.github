#!/usr/bin/env node
/**
 * Render FLEET.md from fleet.json.
 *
 * Generated rather than hand-written, because a table and a registry that can
 * disagree will. `--check` fails when the committed file is out of date, so
 * the readable copy cannot drift from the checked one.
 *
 * Usage: node scripts/write-fleet-md.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'FLEET.md'
const doc = JSON.parse(readFileSync('fleet.json', 'utf8'))

const rows = [...doc.projects]
  .sort((a, b) => b.tier - a.tier || a.slug.localeCompare(b.slug))
  .map((p) => {
    const name = `[${p.slug}](https://github.com/${p.slug})`
    const note = [p.note, p.evidenceReason && `_Exception:_ ${p.evidenceReason}`]
      .filter(Boolean)
      .join(' ')
    return `| ${name} | ${p.archetype} | ${p.tier} | ${p.owner} | ${p.verifiedAt} | ${note} |`
  })

const tally = {}
for (const p of doc.projects) tally[p.tier] = (tally[p.tier] ?? 0) + 1

const body = `<!-- Generated from fleet.json by scripts/write-fleet-md.mjs. Do not edit by hand. -->
# Fleet

Which projects run the shared verification baseline, and at what depth.

This table is generated from \`fleet.json\`, which \`scripts/check-fleet.mjs\`
holds against the repositories themselves — a project claiming a tier is asked
for the artefacts that tier requires. A registry nothing verifies becomes
fiction, and this one is about verification, so it would be a particularly
embarrassing place to skip the gate.

## Tiers

${Object.entries(doc.tiers)
  .map(([tier, description]) => `- **Tier ${tier}** — ${description}`)
  .join('\n')}

Currently ${Object.keys(tally)
  .sort()
  .map((t) => `${tally[t]} at tier ${t}`)
  .join(', ')}.

Adoption is opt-in per project. Every project already inherits one of the
reusable \`pr-check-*\` workflows, so the gate defaults to **off**: a non-empty
default would have turned the whole fleet red on the day it landed, and a
fleet-wide red is indistinguishable from a fleet-wide outage. What stops "not
yet" becoming permanent is the \`verifiedAt\` date — an entry ${doc.reverifyDays}
days stale fails the build until someone re-checks the tier or lowers it.

## Projects

| Project | Archetype | Tier | Owner | Verified | Notes |
|---|---|---|---|---|---|
${rows.join('\n')}

## Adopting

Use the \`verification-bootstrap\` skill, or follow
[\`templates/verification-kit/README.md\`](templates/verification-kit/README.md).
Pick the tier the project can actually run today, not the one it should run:
claiming a tier it does not meet is exactly what \`check-fleet.mjs\` fails on.
`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    /* treated as out of date below */
  }
  if (current !== body) {
    console.error(
      `\n✗ ${OUT} is out of date with fleet.json.\n\n` +
        '  A readable copy that can disagree with the checked one will.\n' +
        '  Regenerate:\n    node scripts/write-fleet-md.mjs\n',
    )
    process.exit(1)
  }
  console.log(`✓ ${OUT} matches fleet.json`)
  process.exit(0)
}

writeFileSync(OUT, body, 'utf8')
console.log(`✓ ${OUT}: ${doc.projects.length} project(s)`)
