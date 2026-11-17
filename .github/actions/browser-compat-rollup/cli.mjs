// Unconditional entry point (see the plan action's cli.mjs).
import { rollup } from './rollup.mjs'

let matrix
try {
  matrix = JSON.parse(process.env.MATRIX ?? '')
} catch {
  console.log('::error::browser-compat roll-up: the plan matrix is missing or not JSON')
  process.exit(1)
}
const r = rollup({ matrix, dir: process.env.REPORT_DIR ?? '.', min: process.env.MIN_TESTS })
for (const l of r.lines) console.log(l)
for (const e of r.errors) console.log(`::error::${e}`)
process.exit(r.ok ? 0 : 1)
