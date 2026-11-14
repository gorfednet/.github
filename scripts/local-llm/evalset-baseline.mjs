#!/usr/bin/env node
// Freezes the scores of the committed arm files into docs/eval-set/baseline.json (public: counts and hashes only).
// evalset-baseline.mjs --manifest m.json --arms dir --salt-file f --check-voice p --out baseline.json --note "..."
// <dir>/<name>.json for every arm; haiku.json, nomodel.json and nomodel-rule.json are the references (evalset.mjs checks their hashes here).
// Triage is listed only when an arm ran it. Every flag is required.
import fs from 'node:fs'
import path from 'node:path'
import { validateManifest, score, defaultVoice, sha256, TASKS } from './evalset.mjs'

const argv = process.argv.slice(2)
// A missing flag is an error, never argv[0] (indexOf is -1): that wrote "--manifest" into the note and the baseline into a file named "--manifest".
const val = (k) => {
  const v = argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined
  if (v === undefined || v.startsWith('--')) throw new Error(`evalset-baseline: ${k} <value> is required`)
  return v
}
const raw = fs.readFileSync(val('--manifest'))
const manifest = JSON.parse(raw)
const bad = validateManifest(manifest)
if (bad.length) throw new Error(bad.join('; '))
const salt = fs.readFileSync(val('--salt-file'), 'utf8').trim()
const voice = defaultVoice(val('--check-voice'))
const arms = []
for (const f of fs.readdirSync(val('--arms')).filter((x) => x.endsWith('.json')).sort()) {
  const bytes = fs.readFileSync(path.join(val('--arms'), f))
  const arm = JSON.parse(bytes)
  const scores = {}
  for (const t of TASKS) {
    const cs = manifest.cases.filter((c) => c.task === t)
    if (!cs.some((c) => arm[c.id] !== undefined)) continue
    const s = score(cs, arm, { voice, salt })
    scores[t] = { n: s.n, correct: s.correct, schema: s.schema, dangerous: s.dangerous, ...(t === 'copy' ? { drop: s.drop, start: s.start } : {}) }
  }
  // The no-model floor is every task's bar: a frozen floor that skips one would let the judge fall back to 0.
  const name = f.replace(/\.json$/, '')
  if (name === 'nomodel') for (const t of TASKS) if (manifest.cases.some((c) => c.task === t) && !manifest.cases.filter((c) => c.task === t).every((c) => arm[c.id] !== undefined)) throw new Error(`evalset-baseline: nomodel: no answers for ${t}`)
  arms.push({ name: f.replace(/\.json$/, ''), armSha256: sha256(bytes), scores })
}
const out = { frozen: new Date().toISOString().slice(0, 10), manifestSha256: sha256(raw), note: val('--note'), arms }
fs.writeFileSync(val('--out'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`${arms.length} arms frozen`)
