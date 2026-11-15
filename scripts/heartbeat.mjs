#!/usr/bin/env node
// node scripts/heartbeat.mjs <name> [--fail]     ping the dead-man URL in ~/.heartbeats/<name>.url
// node scripts/heartbeat.mjs --push "<text>"     push through ntfy.sh, off dapyllil
// node scripts/heartbeat.mjs --usage             70%/90% weekly-usage pushes from ~/.herdr-jobs/state.json
// Exits 0 even when unenrolled; prints what happened.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ping, pushOffbox } from '../ship-bot/lib/heartbeat.mjs'
import { checkUsage } from './lib/usageAlert.mjs'

const [a, b] = process.argv.slice(2)
let r
if (a === '--push') r = await pushOffbox(b ?? '')
else if (a === '--usage') {
  r = await checkUsage({
    statePath: join(homedir(), '.herdr-jobs', 'state.json'),
    memoPath: join(homedir(), '.desk', 'usage-alerts.json'),
    push: async (t) => (await pushOffbox(t)).sent === true,
  })
} else r = await ping(a, { ok: b !== '--fail' })
console.log(JSON.stringify(r))
