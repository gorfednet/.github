#!/usr/bin/env node
/**
 * Push the hosted Actions spend lines (70% and 90% of the monthly cap) to ntfy, once each.
 *
 *   node scripts/actions-spend-alert.mjs [--in status.json] --spend spend.json
 *
 * Reads the published `actions` block from status.json (a state and an opaque memo, no figure) and the full reading
 * from spend.json (written by fleet-status.mjs --spend-out, kept on the runner), pushes at most one line for
 * the highest threshold newly crossed (70, 90 or 100% of the cap), and records it in `actions.memo` (an HMAC
 * under SPEND_MEMO_KEY, so no threshold is readable) in status.json, which the workflow then publishes: the status branch is the memo between runs. A push that fails records nothing, so the next
 * run (2 hours later) tries again. Needs NTFY_TOKEN, NTFY_URL and SPEND_MEMO_KEY; without them it warns and records
 * nothing. It prints only "alert sent" or "no alert": this log is public and the band is not. An unknown reading pushes nothing and leaves the memo alone.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'
import { applyAlert } from './lib/actionsSpend.mjs'

/** push(text, threshold) -> true when ntfy accepted it. */
export function ntfyPush({ url, token, fetchImpl = fetch }) {
  return async (text, threshold) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'gorfednet-fleet-status (+https://github.com/gorfednet/.github)',
          Title: 'Actions spend',
          Priority: threshold >= 90 ? 'high' : 'default',
          Tags: 'money_with_wings',
          Authorization: `Bearer ${token}`,
        },
        body: text,
        signal: AbortSignal.timeout(15_000),
      })
      return res.ok === true
    } catch {
      return false
    }
  }
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

if (isMain(import.meta.url)) {
  const path = arg('--in') ?? 'status.json'
  const status = JSON.parse(readFileSync(path, 'utf8'))
  let meter = null
  try { meter = JSON.parse(readFileSync(arg('--spend') ?? 'spend.json', 'utf8')) } catch { /* no reading: nothing to push */ }
  const url = process.env.NTFY_URL
  const token = process.env.NTFY_TOKEN
  const push = url && token ? ntfyPush({ url, token }) : async () => {
    console.error('::warning::NTFY_URL or NTFY_TOKEN missing, spend alert not posted')
    return false
  }
  const { status: next, action } = await applyAlert(status, meter, push, process.env.SPEND_MEMO_KEY)
  if (next !== status) {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(`${path}.tmp`, path)
  }
  if (action === 'push-failed') console.error('::warning::a spend alert was not delivered; it retries on the next run')
  console.log(`actions-spend-alert: ${action === 'pushed' ? 'alert sent' : 'no alert'}`)
}
