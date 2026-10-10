/**
 * The bot's memory between runs (state.json) and the lock that keeps two runs
 * from overlapping.
 *
 * State is what makes the bot idempotent: which comments it already posted on
 * which head, whether it already asked Bugbot for a review, and which repos it
 * has stopped touching after a failure. Comments also carry a hidden marker, so
 * losing this file costs at most a repeated "waiting" note, never a second
 * `bugbot run` (that is guarded by reading the PR's own comments).
 */
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const EMPTY = () => ({ version: 1, prs: {}, repos: {} })

export class StateStore {
  /**
   * @param {string} path
   * @param {{persist?: boolean}} [opts] persist=false keeps every change in memory (dry run)
   */
  constructor(path, { persist = true } = {}) {
    this.path = path
    this.persist = persist
    this.data = EMPTY()
  }

  load() {
    if (!existsSync(this.path)) {
      this.data = EMPTY()
      return this
    }
    const raw = JSON.parse(readFileSync(this.path, 'utf8'))
    if (raw?.version !== 1 || typeof raw.prs !== 'object' || typeof raw.repos !== 'object') {
      // Unreadable memory is not an empty memory: an empty one would forget a
      // blocked repo and ask Bugbot again. Refuse to run instead.
      throw new Error(`${this.path} is not a ship-bot state file this version understands`)
    }
    this.data = raw
    return this
  }

  save() {
    if (!this.persist) return
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`)
    renameSync(tmp, this.path)
  }

  pr(slug, number) {
    const key = `${slug}#${number}`
    this.data.prs[key] ??= { heads: {} }
    return this.data.prs[key]
  }

  head(slug, number, sha, now) {
    const pr = this.pr(slug, number)
    pr.heads[sha] ??= { firstSeenAt: now, comments: {} }
    // Keep the record bounded: only the most recent heads matter.
    const shas = Object.keys(pr.heads)
    if (shas.length > 10) {
      shas
        .sort((a, b) => String(pr.heads[a].firstSeenAt).localeCompare(String(pr.heads[b].firstSeenAt)))
        .slice(0, shas.length - 10)
        .forEach((old) => delete pr.heads[old])
    }
    return pr.heads[sha]
  }

  forgetPr(slug, number) {
    delete this.data.prs[`${slug}#${number}`]
  }

  repo(slug) {
    this.data.repos[slug] ??= {}
    return this.data.repos[slug]
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // EPERM: it exists and belongs to someone else. Still alive.
    return cause.code === 'EPERM'
  }
}

/**
 * Take the run lock, or say who holds it.
 *
 * A lock left by a process that is gone is taken over, because the bot runs
 * every two minutes and a crash must not stop it for good. What a crash may
 * have interrupted is a deploy, and that is handled separately: state records
 * `deployInProgress` before a deploy starts, and a run that finds one left
 * behind blocks that repo instead of carrying on over it.
 *
 * @returns {{ok: true, release: () => void} | {ok: false, holder: string}}
 */
export function acquireLock(path, { pid = process.pid, now = () => new Date().toISOString(), isAlive = pidAlive } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, JSON.stringify({ pid, startedAt: now() }))
      closeSync(fd)
      return {
        ok: true,
        release: () => {
          try {
            const held = JSON.parse(readFileSync(path, 'utf8'))
            if (held.pid === pid) rmSync(path, { force: true })
          } catch {
            // Already gone, or unreadable; nothing of ours to remove.
          }
        },
      }
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      let held
      try {
        held = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        held = null
      }
      if (held && isAlive(held.pid)) {
        return { ok: false, holder: `pid ${held.pid} since ${held.startedAt}` }
      }
      if (!held) {
        // A lock being written right now reads as empty; do not steal it.
        return { ok: false, holder: 'a lock file that could not be read' }
      }
      rmSync(path, { force: true })
    }
  }
  return { ok: false, holder: 'a lock that reappeared while being replaced' }
}

export function lockPath(stateDir) {
  return join(stateDir, 'run.lock')
}
