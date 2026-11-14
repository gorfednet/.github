#!/usr/bin/env node
// Render docs/models.md from docs/models.json. `--check` fails when it is stale.
import { readFileSync, writeFileSync } from 'node:fs'
const OUT = 'docs/models.md'
const doc = JSON.parse(readFileSync('docs/models.json', 'utf8'))
const rows = doc.rows.map((r) => `| ${r.task} | ${r.id} | ${r.sha} | ${r.adoptedAt} | ${r.evidence ?? ''} |`)
const body = `<!-- Generated from docs/models.json by scripts/local-llm/write-models-md.mjs. Do not edit by hand. -->
# Adopted local models

${doc.note}

Output from these models is a lead only. It never authorises a merge, label or rerun.

| Task | Model id | sha | Adopted | Evidence |
|------|----------|-----|---------|----------|
${rows.length ? rows.join('\n') : '| _none yet_ | | | | |'}
`
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== body) { console.error(`${OUT} is out of date: run node scripts/local-llm/write-models-md.mjs`); process.exit(1) }
} else writeFileSync(OUT, body)
