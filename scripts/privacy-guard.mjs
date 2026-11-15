#!/usr/bin/env node
/**
 * Privacy guard: fail a pull request that ADDS private detail to this public repository.
 *
 * This repository is public. Every branch is world-readable, force push and branch
 * delete are denied, and git history counts as disclosed. A value that lands here
 * cannot be taken back, so the only place left to stop one is the pull request that
 * would add it. Plan row 1.30 (a).
 *
 * It reads only the lines the pull request adds, diffed against the merge base, so it
 * never goes red on content that is already on `main` (verification-floor rule 5: a
 * pull request check fails only on something that pull request can change).
 *
 * What it fails on, by rule id:
 *   private-ip     RFC1918, the shared tailnet range (CGNAT) and IPv6 unique-local or link-local addresses
 *   session-id     a Claude session id, `local_` followed by a uuid
 *   tailnet-name   a tailnet name (the Tailscale domain suffix)
 *   internal-host  a host name main already names in `.deploy-env.example`, workflows
 *                  and scripts (the list below; those names are already public)
 *   private-repo   `gorfednet/<name>` for a private repository. The list comes from the
 *                  PRIVATE_REPOS variable (comma-separated), never from a committed file.
 *                  Unset or empty fails closed (verification-floor rule 2).
 *   email          an address that is not a noreply, a bot identity already on main or an
 *                  allowlisted domain
 *   owner-quote    an owner marker with a date, a colon and then an opening quote
 *   new-file       a new file under docs/desk/, docs/handoff/ or briefs/
 *
 * Exemptions live in .github/privacy-guard-allow.txt (format in that file).
 *
 * Usage:
 *   PRIVATE_REPOS=ops,other node scripts/privacy-guard.mjs --base <ref> --head <ref>
 *     [--dir <repo>]      the git repository to read (default: current directory)
 *     [--allow <file>]    the allowlist (default: <dir>/.github/privacy-guard-allow.txt)
 *
 * Exit: 0 clean, 1 findings, 2 the guard could not run (nothing was checked).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RULES = {
  'private-ip': 'private or tailnet IP address',
  'session-id': 'Claude session id (local_ followed by a uuid)',
  'tailnet-name': 'tailnet host name',
  'internal-host': 'internal host name',
  'private-repo': 'private repository name (from PRIVATE_REPOS)',
  email: 'email address that is not a noreply, bot or allowlisted address',
  'owner-quote': 'owner quote marker (owner, a date, a colon, then a quote)',
  'new-file': 'new file in a directory that belongs in the private ops repository',
}

// Host names main already names. Kept here, not in a variable: they are public already.
export const INTERNAL_HOSTS = ['dapyllil', 'gorfednas', 'gorfpael', 'gowyllop']

// New files under these are refused: runbooks, plans, handoffs and briefs live in the
// private ops repository (plan row 1.30).
export const FORBIDDEN_NEW_DIRS = ['docs/desk/', 'docs/handoff/', 'briefs/']

const O = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
const PRIVATE_IP = new RegExp(
  '(?<![\\d.])(?:' +
    `10(?:\\.${O}){3}` +
    `|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.${O}){2}` +
    `|192\\.168(?:\\.${O}){2}` +
    `|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.${O}){2}` +
    ')(?!\\d)' +
    // IPv6: unique-local fc00::/7 and link-local fe80::/10, as written in a host or prefix.
    '|(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*[0-9a-f]',
  'i',
)
const SESSION_ID = /local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const TAILNET = /\.ts\.net\b/i
const INTERNAL = new RegExp(`\\b(?:${INTERNAL_HOSTS.join('|')})\\b`, 'i')
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// The word owner, optionally a comma and up to 48 characters, a colon, then an opening quote.
const OWNER_QUOTE = /\bowner(?:,\s+[^"“\n]{1,48}?)?:\s*["“]/i

// A filename that looks like an address (hero@2x.png) is not one.
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'css', 'js', 'mjs', 'cjs',
  'json', 'md', 'yml', 'yaml', 'html', 'txt', 'map', 'woff', 'woff2', 'ttf', 'otf',
])

// Bot and tool identities already on main, plus the address every git remote uses.
const BASE_EMAILS = ['git@github.com', 'git@gitlab.com', 'ship-bot@gorfed.net', 'janitor@gorfed.net']

const REGEX_META = /[.*+?^${}()|[\]\\]/g
const escapeRegex = (s) => s.replace(REGEX_META, '\\$&')

/** PRIVATE_REPOS to a list of lowercase repository names. Throws on a bad entry. */
export function parsePrivateRepos(raw) {
  const names = []
  for (const part of String(raw ?? '').split(/[\s,]+/)) {
    if (!part) continue
    const name = part.replace(/^gorfednet\//i, '').toLowerCase()
    if (!/^[a-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error('PRIVATE_REPOS has an entry that is not a repository name; use comma-separated names such as ops,other')
    }
    names.push(name)
  }
  return [...new Set(names)]
}

export function privateRepoPattern(names) {
  const alt = names.map(escapeRegex).join('|')
  return new RegExp(`gorfednet/(?:${alt})(?:\\.git)?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i')
}

function globToRegex(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else out += escapeRegex(c)
  }
  return new RegExp(`^${out}$`)
}

/**
 * Allowlist lines (blank lines and `#` comments ignored):
 *   email <domain-or-address>       domain also covers its subdomains
 *   path <glob> <rule,rule | *>     the named rules are not applied to matching files
 * A line that is neither is an error: a typo in an exemption must not read as no exemption.
 */
export function parseAllowlist(text) {
  const emails = []
  const paths = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return
    const [kind, value, rules] = line.split(/\s+/)
    if (kind === 'email' && value && !rules) {
      emails.push(value.toLowerCase())
    } else if (kind === 'path' && value && rules) {
      const set = rules === '*' ? '*' : new Set(rules.split(','))
      if (set !== '*') {
        for (const r of set) {
          if (!(r in RULES)) throw new Error(`allowlist line ${i + 1}: unknown rule "${r}"`)
        }
      }
      paths.push({ re: globToRegex(value), rules: set })
    } else {
      throw new Error(`allowlist line ${i + 1}: expected "email <domain-or-address>" or "path <glob> <rules|*>"`)
    }
  })
  return { emails, paths }
}

function emailAllowed(address, allow) {
  const addr = address.toLowerCase()
  const at = addr.lastIndexOf('@')
  const local = addr.slice(0, at)
  const domain = addr.slice(at + 1)
  if (local === 'noreply' || local === 'no-reply') return true
  if (domain === 'noreply.github.com' || domain.endsWith('.noreply.github.com')) return true
  if (BASE_EMAILS.includes(addr)) return true
  return allow.emails.some((e) => (e.includes('@') ? e === addr : domain === e || domain.endsWith(`.${e}`)))
}

/** The rule ids a single added line breaks. */
export function scanLine(line, { privateRepo, allow }) {
  const hits = []
  if (PRIVATE_IP.test(line)) hits.push('private-ip')
  if (SESSION_ID.test(line)) hits.push('session-id')
  if (TAILNET.test(line)) hits.push('tailnet-name')
  if (INTERNAL.test(line)) hits.push('internal-host')
  if (privateRepo.test(line)) hits.push('private-repo')
  if (OWNER_QUOTE.test(line)) hits.push('owner-quote')
  for (const m of line.matchAll(EMAIL)) {
    const tld = m[0].slice(m[0].lastIndexOf('.') + 1).toLowerCase()
    if (FILE_EXTENSIONS.has(tld)) continue
    if (!emailAllowed(m[0], allow)) {
      hits.push('email')
      break
    }
  }
  return hits
}

const pathExempt = (path, rule, allow) =>
  allow.paths.some((p) => p.re.test(path) && (p.rules === '*' || p.rules.has(rule)))

function unquote(path) {
  const t = path.replace(/\t.*$/, '')
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
}

/**
 * Added lines from `git diff --unified=0`: [{ path, line, text }].
 * A state machine, not a prefix test: an added line that begins with "++" shows up as
 * "+++..." and must not be taken for a file header.
 */
export function parseAddedLines(diff) {
  const added = []
  let path = null
  let inHunk = false
  let next = 0
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      path = null
      inHunk = false
    } else if (!inHunk && row.startsWith('+++ ')) {
      const target = unquote(row.slice(4))
      path = target === '/dev/null' ? null : target.replace(/^b\//, '')
    } else if (row.startsWith('@@ ')) {
      const m = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (!m) throw new Error(`cannot read hunk header: ${row.slice(0, 60)}`)
      inHunk = true
      next = Number(m[1])
    } else if (inHunk && path !== null && row.startsWith('+')) {
      added.push({ path, line: next, text: row.slice(1) })
      next += 1
    }
  }
  return added
}

/** New files: [{ path }] with status A, or R from outside a forbidden directory. */
export function parseNewFiles(nameStatusZ) {
  const parts = nameStatusZ.split('\0')
  if (parts.at(-1) === '') parts.pop()
  const files = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    if (!status) throw new Error('cannot read the name-status output')
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: status[0], from: parts[i + 1], path: parts[i + 2] })
      i += 3
    } else {
      files.push({ status: status[0], path: parts[i + 1] })
      i += 2
    }
  }
  return files.filter((f) => {
    if (f.status === 'A' || f.status === 'C') return true
    // A rename inside a forbidden directory moves old content; one into it is new there.
    return f.status === 'R' && !FORBIDDEN_NEW_DIRS.some((d) => f.from.startsWith(d))
  })
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

function parseArgs(argv) {
  const out = { dir: '.', base: null, head: null, allow: null }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!['--base', '--head', '--dir', '--allow'].includes(key) || value === undefined) {
      throw new Error(`unknown or incomplete argument: ${key}`)
    }
    out[key.slice(2)] = value
  }
  if (!out.base || !out.head) throw new Error('--base and --head are required')
  return out
}

const escapeProperty = (s) =>
  String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C')

export function run(argv, env = process.env, out = console) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    out.error(`privacy-guard: ${error.message}`)
    return 2
  }

  // Fail closed first: without the list the private-repo rule cannot run, and a guard
  // that quietly skips a rule reads as a pass.
  let names
  try {
    names = parsePrivateRepos(env.PRIVATE_REPOS)
  } catch (error) {
    out.error(`privacy-guard: ${error.message}`)
    return 2
  }
  if (names.length === 0) {
    out.error(
      'privacy-guard: PRIVATE_REPOS is unset or empty, so the private-repo rule cannot run and nothing was checked. ' +
        'A repository admin sets it as an Actions variable (Settings, Secrets and variables, Actions, Variables): ' +
        'a comma-separated list of private repository names, for example name-one,name-two.',
    )
    return 2
  }

  const dir = resolve(args.dir)
  const allowFile = args.allow ? resolve(args.allow) : join(dir, '.github', 'privacy-guard-allow.txt')
  let allow
  try {
    allow = parseAllowlist(existsSync(allowFile) ? readFileSync(allowFile, 'utf8') : '')
  } catch (error) {
    out.error(`privacy-guard: ${error.message}`)
    return 2
  }

  let diff
  let nameStatus
  try {
    const range = `${args.base}...${args.head}`
    diff = git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', '-M', range, '--'])
    nameStatus = git(dir, ['diff', '--no-color', '--no-ext-diff', '--name-status', '-z', '-M', range, '--'])
  } catch (error) {
    out.error(`privacy-guard: could not diff ${args.base}...${args.head}, so nothing was checked: ${String(error.message).split('\n')[0]}`)
    return 2
  }
  // An empty diff is not "clean", it is "nothing to read": a wrong base or head gives the
  // same output. A pull request always changes something.
  if (nameStatus.replace(/\0/g, '') === '') {
    out.error(`privacy-guard: ${args.base}...${args.head} changes no files, so nothing was checked. Check the base and head.`)
    return 2
  }

  const privateRepo = privateRepoPattern(names)
  const findings = []
  for (const f of parseNewFiles(nameStatus)) {
    if (FORBIDDEN_NEW_DIRS.some((d) => f.path.startsWith(d)) && !pathExempt(f.path, 'new-file', allow)) {
      findings.push({ path: f.path, line: 1, rule: 'new-file' })
    }
  }
  for (const { path, line, text } of parseAddedLines(diff)) {
    for (const rule of scanLine(text, { privateRepo, allow })) {
      if (!pathExempt(path, rule, allow)) findings.push({ path, line, rule })
    }
  }

  const actions = env.GITHUB_ACTIONS === 'true'
  const shown = findings.slice(0, 200)
  for (const f of shown) {
    const message = `${RULES[f.rule]} [${f.rule}]`
    if (actions) out.log(`::error file=${escapeProperty(f.path)},line=${f.line},title=privacy-guard::${message}`)
    else out.log(`${f.path}:${f.line}: ${message}`)
  }
  if (findings.length > shown.length) out.log(`... and ${findings.length - shown.length} more`)

  // The allowlist widens what a pull request may add, so say when one touches it.
  if (/(^|\0)\.github\/privacy-guard-allow\.txt(\0|$)/.test(nameStatus) && actions) {
    out.log('::warning title=privacy-guard::This pull request changes the privacy guard allowlist; read the exemptions it adds.')
  }

  if (findings.length > 0) {
    out.log(
      `privacy-guard: ${findings.length} finding(s) on lines this pull request adds. This repository is public; ` +
        'remove the value, or describe it without naming it. Runbooks, plans and handoffs belong in the private ops repository. ' +
        'The finding names the rule, never the value, so the log does not repeat it.',
    )
    return 1
  }
  out.log(`privacy-guard: OK, no private detail on the lines added by ${args.base}...${args.head}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)))
}
