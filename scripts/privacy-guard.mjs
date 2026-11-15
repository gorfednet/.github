#!/usr/bin/env node
/**
 * Privacy guard: fail a change that ADDS private detail to a public repository.
 *
 * This repository is public. Every branch is world-readable, force push and branch
 * delete are denied, and git history counts as disclosed. A value that lands here
 * cannot be taken back. The pull request check stops a value reaching `main`; running
 * this script on the outgoing range before a push stops it reaching the branch.
 * Plan row 1.30 (a).
 *
 * It reads only what the range adds, diffed against the merge base, so a change never
 * goes red on content that is already public (verification-floor rule 5):
 *   - the text of every added line, and the path of every added or renamed file
 *   - the message of every commit in merge-base..head, merge commits the branch wrote included
 * A finding is dropped when the same value is already in that file at the merge base.
 * Moving a line, or rewording a comment around an address that file already held,
 * discloses nothing new.
 *
 * What it fails on, by rule id:
 *   private-ip     RFC1918, the shared tailnet range (CGNAT) and IPv6 unique-local or link-local addresses
 *   session-id     a Claude session id, `local_` followed by a uuid
 *   tailnet-name   a tailnet name (the Tailscale domain suffix)
 *   internal-host  a host name main already names in `.deploy-env.example`, workflows
 *                  and scripts (the list below; those names are already public)
 *   private-repo   `gorfednet/<name>` for a private repository. The list comes from the
 *                  PRIVATE_REPOS Actions secret (comma-separated, so the log masks it), never
 *                  from a committed file or a plain variable.
 *                  Unset or empty fails closed (verification-floor rule 2).
 *   email          an address that is not a noreply, a bot identity already on main or an
 *                  allowlisted domain (not checked in commit messages)
 *   owner-quote    an owner marker with a date, a colon or comma, and then an opening quote
 *   new-file       a new file under docs/desk/, docs/handoff/ or briefs/
 *
 * Files git treats as binary are read as text (`--text`), so a `.gitattributes` line in
 * the change cannot switch the guard off. Only image and font files are skipped, by
 * extension. The parsed added-line count is checked against `git diff --numstat`, and a
 * mismatch is an error (rule 1: count what ran).
 *
 * The allowlist is read from the MERGE BASE, never from the change: an exemption takes
 * effect only after its own pull request has merged. Format in .github/privacy-guard-allow.txt.
 *
 * Usage:
 *   PRIVATE_REPOS=name-one,name-two node scripts/privacy-guard.mjs --base <ref> --head <ref>
 *     [--dir <repo>]      the git repository to read (default: current directory)
 *     [--allow <file>]    read the allowlist from this file instead of the merge base
 *
 * Exit: 0 clean, 1 findings, 2 the guard could not run (nothing was checked).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

// Host names main already names, so they are public already. Joined at run time so this
// file holds none of them whole and needs no exemption from its own rule.
export const INTERNAL_HOSTS = ['dapyl' + 'lil', 'gorfedna' + 's', 'gorfpa' + 'el', 'gowyl' + 'lop']

// New files under these are refused: runbooks, plans, handoffs and briefs live in the
// private ops repository (plan row 1.30).
export const FORBIDDEN_NEW_DIRS = ['docs/desk/', 'docs/handoff/', 'briefs/']

export const ALLOWLIST_PATH = '.github/privacy-guard-allow.txt'

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
  'gi',
)
const SESSION_ID = /local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const TAILNET = /\.ts\.net(?![A-Za-z0-9-])/gi
// Not next to a letter or digit; an underscore or hyphen is a boundary (DAPY_HOST, bc-x-host).
const INTERNAL = new RegExp(`(?<![A-Za-z0-9])(?:${INTERNAL_HOSTS.join('|')})(?![A-Za-z0-9])`, 'gi')
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// Two shapes. The word owner, a comma, a date (a digit within 60 characters), then a colon
// or comma and an opening quote. Or the word owner, a colon, and a quote that holds a
// space, so a GraphQL owner: "org" argument is not a quote.
const OWNER_QUOTE = /\bowner,\s+[^"“\n]{0,60}?\d[^"“\n]{0,40}?[:,]\s*["“]|\bowner:\s*["“][^"”\s]+\s/gi

// A filename that looks like an address (hero@2x.png, getty@tty1.service) is not one.
// Only names that are not real top-level domains: .md is Moldova's, so it is not here.
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'css', 'js', 'mjs', 'cjs',
  'json', 'yml', 'yaml', 'html', 'txt', 'map', 'woff', 'woff2', 'ttf', 'otf', 'service',
])

// Image and font files are not read as text. Everything else is, whatever git thinks.
const SKIP_CONTENT = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/i

// Bot and tool identities already on main, plus the address every git remote uses. The
// reserved example domains can never be private, so they live here, not in the allowlist.
const BASE_EMAILS = ['git@github.com', 'git@gitlab.com', 'ship-bot@gorfed.net', 'janitor@gorfed.net']
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.test', 'example.invalid']

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

// The org spelled out, or the Actions expression for it, then a slash or %2F, then a name.
export function privateRepoPattern(names) {
  if (names.length === 0) return /(?!)/g // every private name is allowlisted: nothing to match
  const alt = names.map(escapeRegex).join('|')
  return new RegExp(
    `(?:gorfednet|repository_owner\\s*\\}\\})(?:/|%2F)(?:${alt})(?:\\.git)?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
    'gi',
  )
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
 *   repo <name>                     a private repository whose name public files may use
 * A line that is neither is an error: a typo in an exemption must not read as no exemption.
 */
export function parseAllowlist(text) {
  const emails = []
  const paths = []
  const repos = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return
    const [kind, value, rules] = line.split(/\s+/)
    if (kind === 'email' && value && !rules) {
      emails.push(value.toLowerCase())
    } else if (kind === 'repo' && value && !rules && /^[A-Za-z0-9._-]+$/.test(value)) {
      repos.push(value.toLowerCase())
    } else if (kind === 'path' && value && rules) {
      const set = rules === '*' ? '*' : new Set(rules.split(','))
      if (set !== '*') {
        for (const r of set) {
          if (!(r in RULES)) throw new Error(`allowlist line ${i + 1}: unknown rule "${r}"`)
        }
      }
      paths.push({ re: globToRegex(value), rules: set })
    } else {
      throw new Error(`allowlist line ${i + 1}: expected "email <domain-or-address>", "repo <name>" or "path <glob> <rules|*>"`)
    }
  })
  return { emails, paths, repos }
}

function emailAllowed(address, allow) {
  const addr = address.toLowerCase()
  const at = addr.lastIndexOf('@')
  const local = addr.slice(0, at)
  const domain = addr.slice(at + 1)
  if (local === 'noreply' || local === 'no-reply') return true
  if (domain === 'noreply.github.com' || domain.endsWith('.noreply.github.com')) return true
  if (BASE_EMAILS.includes(addr)) return true
  const covers = (e) => (e.includes('@') ? e === addr : domain === e || domain.endsWith(`.${e}`))
  return RESERVED_DOMAINS.some(covers) || allow.emails.some(covers)
}

const all = (re, text) => [...text.matchAll(re)].map((m) => m[0])

/**
 * What a piece of text breaks: [{ rule, value }]. `rules` limits which rules run (a path
 * or a commit message is not checked for emails).
 */
export function scanText(raw, { privateRepo, allow }, rules = Object.keys(RULES)) {
  const text = raw.replace(/\0/g, '') // a UTF-16 file read as bytes has a NUL between letters
  const on = (r) => rules.includes(r)
  const hits = []
  const add = (rule, values) => values.forEach((value) => hits.push({ rule, value }))
  if (on('private-ip')) add('private-ip', all(PRIVATE_IP, text))
  if (on('session-id')) add('session-id', all(SESSION_ID, text))
  if (on('tailnet-name')) add('tailnet-name', all(TAILNET, text))
  if (on('internal-host')) add('internal-host', all(INTERNAL, text))
  if (on('private-repo')) add('private-repo', all(privateRepo, text))
  if (on('owner-quote')) add('owner-quote', all(OWNER_QUOTE, text))
  if (on('email')) {
    add(
      'email',
      all(EMAIL, text).filter((m) => {
        const tld = m.slice(m.lastIndexOf('.') + 1).toLowerCase()
        return !FILE_EXTENSIONS.has(tld) && !emailAllowed(m, allow)
      }),
    )
  }
  return hits
}

/** The rule ids a single added line breaks (kept for callers that only count). */
export const scanLine = (line, ctx) => [...new Set(scanText(line, ctx).map((h) => h.rule))]

export const pathExempt = (path, rule, allow) =>
  allow.paths.some((p) => p.re.test(path) && (p.rules === '*' || p.rules.has(rule)))

const inForbiddenDir = (path) => {
  const lower = path.toLowerCase()
  return FORBIDDEN_NEW_DIRS.some((d) => lower.startsWith(d))
}

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
      added.push({ path, line: next, text: row.replace(/\r$/, '').slice(1) })
      next += 1
    }
  }
  return added
}

/** Name-status output (-z) as [{ status, path, from? }]; from is set for a rename or copy. */
export function parseNameStatus(nameStatusZ) {
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
  return files
}

/** New files: status A or C, or R from outside a forbidden directory. */
export function parseNewFiles(nameStatusZ) {
  return parseNameStatus(nameStatusZ).filter((f) => {
    if (f.status === 'A' || f.status === 'C') return true
    // A rename inside a forbidden directory moves old content; one into it is new there.
    return f.status === 'R' && !inForbiddenDir(f.from)
  })
}

/**
 * `git diff --numstat -z` as [{ path, added }]; added is null where git calls the file
 * binary, which it still does for a `-diff` attribute even with --text.
 */
export function parseNumstat(numstatZ) {
  const parts = numstatZ.split('\0')
  if (parts.at(-1) === '') parts.pop()
  const rows = []
  for (let i = 0; i < parts.length; ) {
    const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s)
    if (!m) throw new Error('cannot read the numstat output')
    const added = m[1] === '-' ? null : Number(m[1])
    if (m[3] === '') {
      rows.push({ path: parts[i + 2], added }) // a rename: old and new path follow
      i += 3
    } else {
      rows.push({ path: m[3], added })
      i += 1
    }
  }
  return rows
}

/**
 * Check the parsed added lines against git's own count, file by file (rule 1: count what
 * ran). A file git calls binary must still have produced lines, or it was not read.
 */
export function checkCounts(numstat, added) {
  const parsed = new Map()
  for (const { path } of added) parsed.set(path, (parsed.get(path) ?? 0) + 1)
  for (const { path, added: n } of numstat) {
    const got = parsed.get(path) ?? 0
    if (n === null) {
      if (got === 0 && !SKIP_CONTENT.test(path)) throw new Error(`a file git calls binary produced no readable lines: ${path}`)
    } else if (got !== n) {
      throw new Error(`read ${got} added line(s) of ${path} but git counts ${n}`)
    }
  }
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
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

const PATH_RULES = ['private-ip', 'session-id', 'tailnet-name', 'internal-host', 'private-repo']
const COMMIT_RULES = [...PATH_RULES, 'owner-quote']

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
        'A repository admin sets it as an Actions secret (Settings, Secrets and variables, Actions, Secrets), holding a comma-separated list of private repository names such as name-one,name-two. ' +
        'A pull request from a fork gets no secrets, so it fails here too.',
    )
    return 2
  }

  const dir = resolve(args.dir)
  const range = `${args.base}...${args.head}`
  let mergeBase
  let diff
  let numstat
  let nameStatus
  let messages
  let allowText
  try {
    mergeBase = git(dir, ['merge-base', args.base, args.head]).trim()
    const common = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '-M']
    diff = git(dir, ['diff', ...common, '--unified=0', range, '--'])
    numstat = git(dir, ['diff', ...common, '--numstat', '-z', range, '--'])
    nameStatus = git(dir, ['diff', ...common, '--name-status', '-z', range, '--'])
    messages = git(dir, ['log', '-z', '--format=%h%n%B', `${mergeBase}..${args.head}`, '--'])
    if (args.allow) allowText = readFileSync(resolve(args.allow), 'utf8')
    else {
      try {
        allowText = git(dir, ['show', `${mergeBase}:${ALLOWLIST_PATH}`])
      } catch {
        allowText = '' // no allowlist at the merge base: no exemptions
      }
    }
  } catch (error) {
    out.error(`privacy-guard: could not read ${range}, so nothing was checked: ${String(error.message).split('\n')[0]}`)
    return 2
  }

  let allow
  try {
    allow = parseAllowlist(allowText)
  } catch (error) {
    out.error(`privacy-guard: ${error.message}`)
    return 2
  }

  // An empty diff is not "clean", it is "nothing to read": a wrong base or head gives the
  // same output. A pull request always changes something.
  if (nameStatus.replace(/\0/g, '') === '') {
    out.error(`privacy-guard: ${range} changes no files, so nothing was checked. Check the base and head.`)
    return 2
  }

  const ctx = { privateRepo: privateRepoPattern(names.filter((n) => !allow.repos.includes(n))), allow }
  const files = parseNameStatus(nameStatus)
  const oldPath = new Map(files.map((f) => [f.path, f.from ?? f.path]))
  let added
  try {
    added = parseAddedLines(diff)
    checkCounts(parseNumstat(numstat), added)
  } catch (error) {
    out.error(`privacy-guard: cannot trust the diff, so nothing was checked: ${error.message}`)
    return 2
  }

  const findings = []

  // New files under the directories that belong in the private ops repository.
  for (const f of parseNewFiles(nameStatus)) {
    if (inForbiddenDir(f.path) && !pathExempt(f.path, 'new-file', allow)) {
      findings.push({ path: f.path, line: 1, rule: 'new-file' })
    }
  }

  // Added and renamed paths are public too.
  for (const f of files) {
    if (!['A', 'R', 'C'].includes(f.status)) continue
    for (const hit of scanText(f.path, ctx, PATH_RULES)) {
      if (!pathExempt(f.path, hit.rule, allow)) findings.push({ path: f.path, line: 1, rule: hit.rule })
    }
  }

  // Added lines, minus any value the same file already held at the merge base.
  // The values the same rule finds in the file at the merge base, compared whole: a file
  // that holds one value does not excuse a longer or shorter one that contains it.
  const baseCache = new Map()
  const heldAtBase = (path, rule, value) => {
    const key = oldPath.get(path) ?? path
    if (!baseCache.has(key)) {
      let held = new Set()
      try {
        const text = git(dir, ['show', `${mergeBase}:${key}`])
        held = new Set(scanText(text, ctx).map((h) => `${h.rule}\0${h.value.toLowerCase()}`))
      } catch {
        // a new file held nothing
      }
      baseCache.set(key, held)
    }
    return baseCache.get(key).has(`${rule}\0${value.toLowerCase()}`)
  }
  let linesRead = 0
  let filesRead = new Set()
  for (const { path, line, text } of added) {
    if (SKIP_CONTENT.test(path)) continue
    linesRead += 1
    filesRead.add(path)
    for (const hit of scanText(text, ctx)) {
      if (pathExempt(path, hit.rule, allow)) continue
      if (heldAtBase(path, hit.rule, hit.value)) continue
      findings.push({ path, line, rule: hit.rule })
    }
  }

  // Commit messages are public too. The finding is "commit <sha>", never the text.
  let commits = 0
  // -z separates commits with NUL, which a commit message cannot hold; a control character
  // a message can hold (\x01, \x02) would otherwise split an entry and hide text.
  for (const entry of messages.split('\0').filter((e) => e.trim() !== '')) {
    const nl = entry.indexOf('\n')
    const sha = entry.slice(0, nl).trim()
    const body = entry.slice(nl + 1)
    commits += 1
    body.split('\n').forEach((text, i) => {
      for (const hit of scanText(text, ctx, COMMIT_RULES)) {
        findings.push({ path: `commit ${sha}`, line: i + 1, rule: hit.rule, commit: true })
      }
    })
  }

  const actions = env.GITHUB_ACTIONS === 'true'
  const shown = findings.slice(0, 200)
  for (const f of shown) {
    const message = `${RULES[f.rule]} [${f.rule}]`
    if (f.commit) out.log(`${f.path}: message line ${f.line}: ${message}`)
    else if (actions) out.log(`::error file=${escapeProperty(f.path)},line=${f.line},title=privacy-guard::${message}`)
    else out.log(`${f.path}:${f.line}: ${message}`)
  }
  if (findings.length > shown.length) out.log(`... and ${findings.length - shown.length} more`)

  // The allowlist, this script and the workflow decide what the guard lets through, so
  // say when a change touches them. They are control-plane files and need a human read.
  const touched = files.filter((f) =>
    [ALLOWLIST_PATH, 'scripts/privacy-guard.mjs', '.github/workflows/privacy-guard.yml'].includes(f.path),
  )
  if (actions && touched.length > 0) {
    out.log('::warning title=privacy-guard::This change edits the guard, its workflow or its allowlist. Read every line it adds.')
  }

  if (findings.length > 0) {
    out.log(
      `privacy-guard: ${findings.length} finding(s) on what ${range} adds. This repository is public; ` +
        'remove the value, or describe it without naming it. Runbooks, plans and handoffs belong in the private ops repository. ' +
        'The finding names the rule and the place, never the value, so the log does not repeat it.',
    )
    return 1
  }
  out.log(
    `privacy-guard: OK, read ${linesRead} added line(s) in ${filesRead.size} file(s), ${files.length} path(s) and ${commits} commit message(s) in ${range}`,
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let status
  try {
    status = run(process.argv.slice(2))
  } catch (error) {
    // Any throw is a tool problem, not a finding, and must not read as a pass.
    console.error(`privacy-guard: crashed, so nothing was checked: ${error.message}`)
    status = 2
  }
  process.exit(status)
}
