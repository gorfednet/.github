// Builds the browser-compat matrix. With webkit-shards "1" the entries are exactly the three
// the workflow always ran: label = browser, so the job is still `compat (chromium)`. With
// N > 1 only webkit splits, into `webkit 1 of N` ... `webkit N of N`, each a Playwright
// --shard and its own report. Anything it does not understand throws: a bad value must stop
// the run, never fall back to one shard.
export const BROWSERS = ['chromium', 'firefox', 'webkit']
export const MAX_SHARDS = 8

export function parseShards(raw) {
  const s = String(raw ?? '').trim()
  if (!/^[1-9][0-9]*$/.test(s)) throw new Error(`webkit-shards must be a whole number from 1 to ${MAX_SHARDS}, got "${raw}"`)
  const n = Number(s)
  if (n > MAX_SHARDS) throw new Error(`webkit-shards must be at most ${MAX_SHARDS}, got ${n}`)
  return n
}

export function buildPlan(webkitShards) {
  const n = parseShards(webkitShards)
  const include = []
  for (const browser of BROWSERS) {
    if (browser === 'webkit' && n > 1) {
      for (let i = 1; i <= n; i++) {
        include.push({
          browser,
          label: `${browser} ${i} of ${n}`,
          shard_arg: `--shard=${i}/${n}`,
          report: `compat-${browser}-${i}.json`,
          shards: String(n),
        })
      }
    } else {
      include.push({ browser, label: browser, shard_arg: '', report: `compat-${browser}.json`, shards: '' })
    }
  }
  return { include }
}
