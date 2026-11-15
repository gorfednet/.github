#!/usr/bin/env node
// eval.mjs --manifest m.json --haiku h.json --nomodel n.json --arm name=f.json; manifest {items:[{id, verdict, cause:[lines]}]}, arm {id: {verdict, lines, ms}}
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VERDICTS } from './tasks/ci-triage.mjs'
const NEAR = 3
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : Infinity)
const valid = (o) => !!o && VERDICTS.includes(o.verdict) && Array.isArray(o.lines) && o.lines.length <= 10 && o.lines.every(Number.isInteger)
export function score(manifest, arm) {
  let verdict = 0, cause = 0, dangerous = 0, schema = 0
  const ms = []
  for (const it of manifest.items) {
    const o = arm[it.id]
    if (!valid(o)) continue
    schema++
    if (o.verdict === it.verdict) verdict++
    if (it.verdict === 'real' && o.verdict !== 'real') dangerous++
    if (it.cause?.length && o.lines.some((l) => it.cause.some((c) => Math.abs(l - c) <= NEAR))) cause++
    if (Number.isFinite(o.ms)) ms.push(o.ms)
  }
  return { n: manifest.items.length, verdict, cause, dangerous, schema, medianMs: median(ms) }
}
const constantVerdict = (manifest, arm) => new Set(manifest.items.map((it) => arm[it.id]?.verdict)).size === 1
const sameAnswers = (manifest, a, b) => manifest.items.every((it) => JSON.stringify([a[it.id]?.verdict, a[it.id]?.lines]) === JSON.stringify([b[it.id]?.verdict, b[it.id]?.lines]))
export function judge(manifest, arm, haiku, nomodel) {
  const reasons = []
  if (constantVerdict(manifest, arm)) reasons.push('rejected: constant-verdict arm')
  if (sameAnswers(manifest, arm, nomodel)) reasons.push('rejected: arm equals the no-model arm')
  if (reasons.length) return { pass: false, reasons, scores: null }
  const s = score(manifest, arm), h = score(manifest, haiku), z = score(manifest, nomodel)
  const floor = Math.ceil(0.8 * s.n)
  if (s.verdict < h.verdict - 1 || s.verdict < floor) reasons.push(`verdict ${s.verdict} below max(haiku-1=${h.verdict - 1}, ${floor})`)
  if (s.cause < h.cause) reasons.push(`cause ${s.cause} below haiku ${h.cause}`)
  if (s.dangerous > h.dangerous) reasons.push(`dangerous misses ${s.dangerous} above haiku ${h.dangerous}`)
  if (s.schema !== s.n) reasons.push(`schema valid ${s.schema}/${s.n}`)
  if (!(s.medianMs <= 60000)) reasons.push(`median latency ${s.medianMs} ms over 60000`)
  if (s.cause < z.cause + 2) reasons.push(`cause ${s.cause} below no-model ${z.cause} + 2`)
  return { pass: reasons.length === 0, reasons, scores: { arm: s, haiku: h, nomodel: z } }
}
function main(argv) {
  const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
  const [manifest, haiku, nomodel] = ['--manifest', '--haiku', '--nomodel'].map((k) => load(argv[argv.indexOf(k) + 1]))
  const arms = argv.flatMap((a, i) => (a === '--arm' ? [argv[i + 1].split('=')] : []))
  if (!arms.length) throw new Error('no --arm name=file given')
  let bad = 0
  for (const [name, file] of arms) {
    const r = judge(manifest, load(file), haiku, nomodel)
    console.log(`${name}: ${r.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(r.scores?.arm ?? {})} ${r.reasons.join('; ')}`)
    if (!r.pass) bad++
  }
  return bad ? 1 : 0
}
const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]) } catch { return false } }
if (isMain()) { try { process.exit(main(process.argv.slice(2))) } catch (e) { console.error(`eval: ${e.message}`); process.exit(2) } }
