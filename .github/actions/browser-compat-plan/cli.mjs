// Unconditional entry point: no "am I the main module" test, so a symlinked or encoded path
// can never make it load, run nothing and exit 0.
import { appendFileSync } from 'node:fs'
import { buildPlan } from './plan.mjs'

const matrix = buildPlan(process.env.WEBKIT_SHARDS)
const line = `matrix=${JSON.stringify(matrix)}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
else process.stdout.write(line)
console.log(`browser-compat plan: ${matrix.include.map((e) => e.label).join(', ')}`)
