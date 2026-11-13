#!/usr/bin/env node
// node scripts/heartbeat.mjs <name> [--fail]     ping the dead-man URL in ~/.heartbeats/<name>.url
// node scripts/heartbeat.mjs --push "<text>"     push through ntfy.sh, off dapyllil
// Exits 0 even when unenrolled; prints what happened.
import { ping, pushOffbox } from '../ship-bot/lib/heartbeat.mjs'

const [a, b] = process.argv.slice(2)
const r = a === '--push' ? await pushOffbox(b ?? '') : await ping(a, { ok: b !== '--fail' })
console.log(JSON.stringify(r))
