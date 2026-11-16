#!/usr/bin/env node
/**
 * Push the hosted Actions spend lines (70% and 90% of the monthly cap) to ntfy, once each.
 *
 *   node scripts/actions-spend-alert.mjs [--in status.json]
 *
 * Reads `actions` from status.json (written by fleet-status.mjs), pushes at most one line for the highest
 * threshold newly crossed, and records it in `actions.fired` in the same file, which the workflow then
 * publishes: the status branch is the memo between runs. A push that fails records nothing, so the next
 * run (2 hours later) tries again. Needs NTFY_TOKEN and NTFY_URL; without them it warns and records
 * nothing. An unknown reading pushes nothing and leaves the memo alone.
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
  const url = process.env.NTFY_URL
  const token = process.env.NTFY_TOKEN
  const push = url && token ? ntfyPush({ url, token }) : async () => {
    console.error('::warning::NTFY_URL or NTFY_TOKEN missing, spend alert not posted')
    return false
  }
  const { status: next, action, due } = await applyAlert(status, push)
  if (next !== status) {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(`${path}.tmp`, path)
  }
  if (action === 'push-failed') console.error(`::warning::spend alert for ${due}% was not delivered; it retries on the next run`)
  console.log(`actions-spend-alert: ${action}${due ? ` (${due}%)` : ''}`)
}
