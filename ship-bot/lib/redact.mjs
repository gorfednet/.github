/**
 * Everything the bot prints, logs or posts goes through one redactor.
 *
 * Two layers. Known secrets — the GitHub token and every value in the env files
 * a deploy uses — are replaced wherever they appear, except a value equal to a
 * public name of a configured repo (its slug, owner, basename, directory or a
 * path segment): an env file that repeats the site's name must not mask that
 * name in every notification. Patterns catch the
 * secret-shaped strings nobody told it about: provider tokens, Authorization
 * headers, private keys, NAME=value lines whose name says secret, and LAN
 * addresses (several of these repositories are public, and a PR comment is
 * world-readable).
 */
import { readFileSync } from 'node:fs'

const MASK = '[REDACTED]'

/** Values this short are ports, usernames and booleans; masking them mangles every log line. */
export const MIN_SECRET_LENGTH = 6

const PATTERNS = [
  // GitHub tokens: classic, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Stripe and Slack, both in use or planned in this fleet.
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // LAN addresses: 10/8, 172.16/12, 192.168/16.
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
]

// "Authorization: Bearer xyz", "authorization: basic xyz"
const AUTH_HEADER = /(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s'"]+/gi
// FOO_TOKEN=xyz, password: xyz, "api_key": "xyz"
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"',]+)/gi

export class Redactor {
  /**
   * @param {Iterable<string|undefined|null>} secrets
   * @param {{ publicNames?: Iterable<string|undefined|null> }} [options] names that are never masked as known secrets
   */
  constructor(secrets = [], { publicNames = [] } = {}) {
    /** @type {Set<string>} */
    this.secrets = new Set()
    /** @type {Set<string>} lower-cased */
    this.publicNames = new Set()
    this.allow(publicNames)
    this.add(secrets)
  }

  /**
   * Names that must stay readable (repo slugs, their parts, path segments). A
   * value equal to one is never a known secret, now or later.
   *
   * @param {Iterable<string|undefined|null>} names
   */
  allow(names) {
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim()) continue
      this.publicNames.add(name.trim().toLowerCase())
    }
    for (const secret of this.secrets) if (this.publicNames.has(secret.toLowerCase())) this.secrets.delete(secret)
    return this
  }

  /** @param {Iterable<string|undefined|null>} values */
  add(values) {
    for (const value of values) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (trimmed.length < MIN_SECRET_LENGTH || this.publicNames.has(trimmed.toLowerCase())) continue
      this.secrets.add(trimmed)
    }
    return this
  }

  /** @param {unknown} text */
  apply(text) {
    let out = String(text ?? '')
    // Longest first, so a secret that contains another is masked whole.
    const known = [...this.secrets].sort((a, b) => b.length - a.length)
    for (const secret of known) out = out.split(secret).join(MASK)
    for (const re of PATTERNS) out = out.replace(re, MASK)
    out = out.replace(AUTH_HEADER, (_m, prefix, scheme) => `${prefix}${scheme ? `${scheme} ` : ''}${MASK}`)
    out = out.replace(SECRET_ASSIGNMENT, (_m, prefix) => `${prefix}${MASK}`)
    return out
  }
}

/**
 * The public names of the configured repos: each slug, its owner and basename,
 * its directory name, and every segment of its source and work paths (siblings
 * included). The redactor never takes one of these as a known secret.
 *
 * @param {Iterable<object>} repos normalized repo rows
 * @returns {string[]}
 */
export function publicNames(repos = []) {
  const names = new Set()
  const take = (value) => {
    if (typeof value !== 'string') return
    if (value) names.add(value)
    for (const part of value.split('/')) if (part) names.add(part)
  }
  for (const repo of repos ?? []) {
    for (const row of [repo, ...(repo.siblings ?? [])]) {
      for (const key of ['slug', 'name', 'dir', 'sourceDir', 'workDir', 'path']) take(row[key])
    }
  }
  return [...names]
}

/**
 * Values from a dotenv-style file: KEY=value, optional `export`, optional
 * quotes, # comments. Only the values are returned; they are what must never
 * be printed.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseEnvValues(text) {
  const values = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    if (value) values.push(value)
  }
  return values
}

/** @param {string} path */
export function envValuesFromFile(path, read = (p) => readFileSync(p, 'utf8')) {
  return parseEnvValues(read(path))
}

/** The last lines of a log, bounded in both lines and characters, for a PR comment. */
export function tail(text, { lines = 40, chars = 3500 } = {}) {
  const all = String(text ?? '').split('\n')
  let out = all.slice(-lines).join('\n')
  if (out.length > chars) out = `…${out.slice(-chars)}`
  return out
}
