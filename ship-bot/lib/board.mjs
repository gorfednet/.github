/**
 * The board (plan row 1.55): one row per open pull request a pass looked at,
 * written to `<stateDir>/board.json` so a reader (Desk) reads one local file
 * instead of asking GitHub again for what the bot already fetched.
 *
 * It adds no GitHub call. Rows come from three reads the pass already makes
 * (`tap`: the open-pull list, a full pull request, its file list), from each
 * gate result (`gated`) and from the pass's own log lines (`heard`), which is
 * where each reason comes from, word for word. A value the pass did not read
 * is null, never a guess: `checks`, `review`, `mergeable` and `controlPlane`
 * are null on a pull request the bot ignored before reading them.
 *
 * Nothing here decides anything, and no recorder throws: a board that cannot
 * be built or written must not change a pass.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { HOLD_LABEL } from './config.mjs'
import { controlPlaneFiles, firstNextItem } from './drafts.mjs'

export const BOARD_FILE = 'board.json'
export const BOARD_VERSION = 1
export const BOARD_MAX_LINES = 40

/** A log line about one pull request: `owner/name#12 (abc1234, draft): text`, with the observe prefix or without. */
const PR_LINE = /^(?:OBSERVE \(repo not live\) )?(\S+)#(\d+)(?: \([^)]*\))?: /
const REPO_LINE = /^(?:OBSERVE \(repo not live\) )?(\S+\/[^\s:#]+): /
const quiet = (fn) => (...args) => {
  try {
    return fn(...args)
  } catch {
    return undefined
  }
}
/**
 * The older of two times. A pass whose state is not kept (observing, or a not-live repo) first sees every head
 * "now", so the bot's own first sight only counts when it is older than GitHub's last update.
 */
const earlier = (a, b) => [a, b].filter((t) => t && Number.isFinite(new Date(t).getTime())).sort((x, y) => new Date(x) - new Date(y))[0] ?? null
const labelsOf = (pr) => (pr.labels ?? []).map((l) => l.name)

export class Board {
  constructor() {
    this.rows = new Map()
    this.listed = new Set()
    this.repoLines = new Map()
    this.heard = quiet(this.#heard.bind(this))
    this.gated = quiet(this.#gated.bind(this))
    this.record = quiet(this.#record.bind(this))
    /** A row the bot will not move by itself, whatever level its log lines had this pass. */
    this.decide = quiet((slug, number) => {
      this.rows.get(`${slug}#${number}`).loud = true
    })
  }

  /** The same client, with the three reads the board is built from also recorded. Results pass through untouched. */
  tap(github) {
    const board = this
    return new Proxy(github, {
      get(target, prop) {
        if (!['listOpenPulls', 'getPull', 'listPullFiles', 'mergePull'].includes(prop)) return target[prop]
        return async (...args) => {
          const out = await target[prop](...args)
          board.record(prop, args, out)
          return out
        }
      },
    })
  }

  #record(call, [slug, number], out) {
    if (call === 'listOpenPulls') {
      this.listed.add(slug)
      for (const p of out) {
        this.rows.set(`${slug}#${p.number}`, { repository: slug, number: p.number, title: p.title ?? '', head: p.head?.sha ?? null, headNow: p.head?.sha ?? null, draft: Boolean(p.draft), labels: labelsOf(p), checks: null, review: null, mergeable: null, next: firstNextItem(p.body) ?? '', controlPlane: null, since: p.updated_at ?? null, reasons: [] })
      }
      return
    }
    const row = this.rows.get(`${slug}#${number}`)
    if (!row) return
    if (call === 'listPullFiles') row.controlPlane = controlPlaneFiles(out, slug).length > 0
    if (call === 'mergePull' && out?.merged) row.merged = true
    if (call !== 'getPull') return
    // Every later read says where the head is now. Once the gates ran, `head` stays the commit they ran on.
    row.headNow = out.head?.sha ?? null
    if (row.gates) return
    Object.assign(row, { head: row.headNow, title: out.title ?? row.title, draft: Boolean(out.draft), labels: labelsOf(out), next: firstNextItem(out.body) ?? '', mergeable: out.mergeable ?? null })
  }

  #gated(slug, pr, result, headState) {
    const row = this.rows.get(`${slug}#${pr.number}`)
    if (!row) return
    Object.assign(row, { head: pr.head.sha, checks: result.checks ?? null, review: result.review ?? null, since: earlier(headState?.firstSeenAt, row.since) })
    row.gates = result.ready ? 'ready' : result.blocks.some((b) => b.kind === 'fail') ? 'needs-decision' : 'waiting'
  }

  #heard(level, line) {
    const repo = REPO_LINE.exec(line)
    if (repo) this.repoLines.set(repo[1], line.slice(repo[0].length))
    const m = PR_LINE.exec(line)
    const row = m && this.rows.get(`${m[1]}#${m[2]}`)
    if (!row) return
    if (level === 'warn' || level === 'error') row.loud = true
    if (row.reasons.length < 6) row.reasons.push(line.slice(m[0].length).slice(0, 500))
  }

  /**
   * `state`: merged (this pass), held (the hold label), ready (every gate
   * passed; the reason says what it is waiting on, if anything), waiting (on
   * CI, the reviewer or GitHub), not-reached (the pass ended before it), and
   * needs-decision for everything else the bot is not going to move by itself.
   */
  #state(row) {
    if (row.merged) return 'merged'
    if (row.reasons.length === 0) return 'not-reached'
    if (row.labels.includes(HOLD_LABEL)) return 'held'
    if (row.loud) return 'needs-decision'
    if (row.gates) return row.gates
    return row.reasons.some((r) => /not computed yet/.test(r)) ? 'waiting' : 'needs-decision'
  }

  /** What the pass saw. `repos` are the slugs it was meant to cover: one never listed is skipped, with its last log line as why. */
  snapshot(repos, redact = (s) => s) {
    const rows = [...this.rows.values()].map(({ reasons, gates, loud, merged, headNow, ...row }) => ({
      ...row,
      title: redact(row.title),
      next: redact(row.next),
      ...(headNow !== row.head ? { headMovedTo: headNow } : {}),
      state: this.#state({ ...row, reasons, gates, loud, merged }),
      reason: reasons.join('\n') || 'not looked at this pass',
    }))
    const skipped = repos.filter((slug) => !this.listed.has(slug)).map((slug) => ({ repository: slug, why: this.repoLines.get(slug) ?? 'not reached this pass' }))
    return { version: BOARD_VERSION, skipped, rows }
  }
}

/** Atomic and private: a temporary file beside it, mode 600, renamed into place. Throws; the caller logs one line. */
export function writeBoard(path, board) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(board, null, 1)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (cause) {
    rmSync(tmp, { force: true })
    throw cause
  }
}

export const readBoard = (path) => JSON.parse(readFileSync(path, 'utf8'))

const age = (fromIso, now) => {
  const minutes = Math.round((now - new Date(fromIso)) / 60000)
  if (!Number.isFinite(minutes)) return '?'
  return minutes < 120 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

/** `--board`: the rows that need a decision, longest-standing first, in at most `max` lines. */
export function formatBoard(board, now = new Date(), max = BOARD_MAX_LINES) {
  const rows = Array.isArray(board?.rows) ? board.rows : []
  const count = (state) => rows.filter((r) => r.state === state).length
  const lines = [`board ${board.at} (${age(board.at, now)} old), ship-bot ${board.installedSha ? String(board.installedSha).slice(0, 7) : 'from a checkout'}, ${board.mode}: ${rows.length} open, ${count('needs-decision')} need a decision, ${count('waiting')} waiting, ${count('ready')} ready, ${count('held')} held, ${count('not-reached')} not reached`]
  const skipped = (board.skipped ?? []).map((s) => `skipped ${s.repository}: ${s.why}`.slice(0, 200))
  const decide = rows.filter((r) => r.state === 'needs-decision').sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')))
  const skipLines = skipped.slice(0, 5)
  if (skipped.length > 5) skipLines[4] = `skipped ${skipped.length - 4} more repositories`
  const room = max - lines.length - skipLines.length
  const shown = decide.length > room ? decide.slice(0, room - 1) : decide
  for (const r of shown) {
    const flags = [r.draft ? 'draft' : null, r.controlPlane ? 'control-plane' : null, r.headMovedTo ? `head moved to ${String(r.headMovedTo).slice(0, 7)}` : null].filter(Boolean)
    lines.push(`${r.repository}#${r.number} (${String(r.head).slice(0, 7)}) ${age(r.since, now)} checks:${r.checks ?? '-'} review:${r.review ?? '-'}${flags.length ? ` [${flags.join(', ')}]` : ''} ${String(r.reason).split('\n')[0]}`.slice(0, 240))
  }
  if (shown.length < decide.length) lines.push(`and ${decide.length - shown.length} more that need a decision`)
  return [...lines, ...skipLines]
}
