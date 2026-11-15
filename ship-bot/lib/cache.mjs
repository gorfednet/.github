/**
 * What the bot remembers between passes to save GitHub quota, in one file
 * (`<stateDir>/read-cache.json`), apart from state.json because it is safe to
 * lose and is written by dry runs too.
 *
 * - `etags`: the ETag and body of each GET, so the next pass can ask with
 *   `If-None-Match` and get a free 304 when nothing changed.
 * - `gates`: the output of a gate script for one exact set of inputs (head,
 *   the pull request's updated_at, the checks on the head). A pull request
 *   that waits pass after pass for a review would otherwise run all three
 *   scripts, about 9 REST calls, every 2 minutes. A remembered result is never
 *   what a merge rests on: the bot re-runs every script fresh before merging
 *   (bot.mjs, processPull).
 *
 * Losing or corrupting the file costs one pass of full-price requests, never a
 * wrong decision, so an unreadable file is treated as empty.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** An ETag entry unused for this long is dropped (a closed PR's checks, an old head). */
const ETAG_KEEP_MS = 6 * 60 * 60 * 1000
export const GATE_CACHE_MINUTES = 10

export class ReadCache {
  /**
   * @param {string|null} path null keeps everything in memory
   * @param {{now?: () => Date, gateMinutes?: number}} [opts]
   */
  constructor(path, { now = () => new Date(), gateMinutes = GATE_CACHE_MINUTES } = {}) {
    this.path = path
    this.now = now
    this.gateMs = gateMinutes * 60 * 1000
    this.data = { version: 1, etags: {}, gates: {} }
  }

  load() {
    if (!this.path || !existsSync(this.path)) return this
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
      if (raw?.version === 1 && isMap(raw.etags) && isMap(raw.gates)) this.data = raw
    } catch {
      // Unreadable: start empty. The cost is one pass of uncached requests.
    }
    return this
  }

  save() {
    if (!this.path) return
    const t = this.now().getTime()
    for (const [url, e] of Object.entries(this.data.etags)) {
      if (!(t - new Date(e.usedAt).getTime() < ETAG_KEEP_MS)) delete this.data.etags[url]
    }
    for (const [key, g] of Object.entries(this.data.gates)) {
      if (!(t - new Date(g.at).getTime() < this.gateMs)) delete this.data.gates[key]
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  // The ETag side, used by createGitHubClient.
  get(url) {
    return this.data.etags[url]
  }

  set(url, { etag, data }) {
    this.data.etags[url] = { etag, data, usedAt: this.now().toISOString() }
  }

  touch(url) {
    const e = this.data.etags[url]
    if (e) e.usedAt = this.now().toISOString()
  }

  // The gate side, used by gates.mjs.
  getGate(key) {
    const g = this.data.gates[key]
    if (!g || !(this.now().getTime() - new Date(g.at).getTime() < this.gateMs)) return undefined
    return structuredClone(g.result)
  }

  setGate(key, result) {
    this.data.gates[key] = { at: this.now().toISOString(), result: structuredClone(result) }
  }
}
