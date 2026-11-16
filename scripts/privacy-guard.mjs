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
 * It reads only what the range adds, so a change never goes red on content that is
 * already public (verification-floor rule 5). Twice: the net diff against the merge base
 * (what a merge would land) and each commit's own diff (what a push publishes, so a value
 * one commit adds and the next removes still counts). A merge commit contributes only what
 * it wrote itself: the lines, added paths and new files in its diff against EVERY parent.
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
 *   private-repo   `gorfednet/<name>` for a private repository, always. And a bare name, but
 *                  only a name the merge base has never said (as a whole word, in any text
 *                  file): most private repositories are named for a public site and are said
 *                  everywhere, so watching them would be red for good. A bare name is read as
 *                  a whole word on any added line, as a path part (a directory, or the name
 *                  with one extension) and in a commit message. The list comes from the
 *                  PRIVATE_REPOS Actions secret, one name per line (comma-separated is read
 *                  too): Actions masks each line of a multi-line secret on its own, a
 *                  comma-separated one only whole. Never from a committed file or a plain variable.
 *                  Unset or empty fails closed (verification-floor rule 2).
 *   email          an address that is not a noreply, a bot identity already on main or an
 *                  allowlisted domain (not checked in commit messages)
 *   owner-quote    an owner marker with a date, a colon or comma, and then an opening quote
 *   new-file       a new file under docs/desk/, docs/handoff/ or briefs/
 *
 * Files git treats as binary are read as text (`--text`), so a `.gitattributes` line in
 * the change cannot switch the guard off. No file is skipped by name or type: a text file
 * called logo.png is read like any other, and real image bytes hold nothing the rules match.
 * The parsed added-line count is checked against `git diff --numstat`, and a
 * mismatch is an error (rule 1: count what ran). A file git still calls binary (a `-diff`
 * attribute) that gave no lines is read whole, unless it was deleted or only renamed.
 *
 * A finding names the rule and the place, never the value. A file whose own name holds a
 * value is shown as `path hash <8 hex>` (the path's sha1) and gets no annotation.
 * An address is not read in minified SVG path data (a `d` or `points` attribute that is
 * only drawing data), nor after a v that starts a word (a version); a domain of numbers (an npm tag)
 * is a version tag, not an email.
 *
 * The allowlist is read from the MERGE BASE, never from the change: an exemption takes
 * effect only after its own pull request has merged. Format in .github/privacy-guard-allow.txt.
 *
 * Usage:
 *   PRIVATE_REPOS=name-one,name-two node scripts/privacy-guard.mjs --base <ref> --head <ref>
 *     [--dir <repo>]      the git repository to read (default: current directory)
 *     [--allow <file>]    read the allowlist from this file instead of the merge base
 * Both revisions are resolved first (`rev-parse --verify --end-of-options`), so a value that
 * starts with "--" is a name that fails, never an option. The commits read are the head's
 * that the base does not hold (`head --not base`); the net diff is against the merge base.
 *
 * Exit: 0 clean, 1 findings, 2 the guard could not run (nothing was checked), 3 the head
 * holds no commit the base lacks, so there was nothing to read. A caller that has its own
 * proof that nothing is outgoing may treat 3 as a pass; the guard never does.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
export const FORBIDDEN_NEW_DIRS = ['docs/desk/', 'docs/handoff/', 'docs/plans/', 'briefs/']

/** Exit status for "no commits in the range": nothing was read, and that is not a pass. */
export const EXIT_NOTHING_TO_READ = 3

// Files that list things, where a private repository is named without the org prefix.
// A bare name is read in two ways: as a whole word anywhere on a line ('word', for files
// that are lists). Elsewhere it is read the same way: only names the repository has never
// said are watched, and every mention of one is a disclosure.
const LIST_LIKE = /\.(?:tsv|csv|tab|txt|list|lst)$/i
export const isListLike = (path) => LIST_LIKE.test(path)
export const bareScope = () => 'word'

export const ALLOWLIST_PATH = '.github/privacy-guard-allow.txt'

const O = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
// Not after a digit or dot (a longer number), and not a version: a v or V that starts a word
// right before it. Any other letter before it is no excuse (a flag, a host, an escape).
const PRIVATE_IP = new RegExp(
  '(?<![\\d.])(?<!(?<![A-Za-z0-9])[vV])(?:' +
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
// The whole host name when there is one (so a base that names the suffix does not excuse a host), else the suffix.
const TAILNET = /(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\.)+ts\.net(?![A-Za-z0-9-])|\.ts\.net(?![A-Za-z0-9-])/gi
// Not next to a letter or digit; an underscore or hyphen is a boundary (DAPY_HOST, bc-x-host).
const INTERNAL = new RegExp(`(?<![A-Za-z0-9])(?:${INTERNAL_HOSTS.join('|')})(?![A-Za-z0-9])`, 'gi')
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// Two shapes. The word owner, a comma, a date (a digit within 60 characters), then a colon
// or comma and an opening quote. Or the word owner, a colon, and a quote that holds a
// space, so a GraphQL owner: "org" argument is not a quote.
const OWNER_QUOTE = /\bowner,\s+[^"“\n]{0,60}?\d[^"“\n]{0,40}?[:,]\s*["“][^\n]{0,200}|\bowner:\s*["“][^"”\s]+\s[^\n]{0,200}/gi

// A filename that looks like an address (hero@2x.png, getty@tty1.service) is not one.
// Only names that are not real top-level domains: .md is Moldova's, so it is not here.
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'css', 'js', 'mjs', 'cjs',
  'json', 'yml', 'yaml', 'html', 'txt', 'map', 'woff', 'woff2', 'ttf', 'otf', 'service',
])

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
 *   commit <sha>                    a commit (7 to 40 hex) whose MESSAGE findings are exempt: a
 *                                   pushed message cannot be rewritten, so this is the way out
 * A line that is neither is an error: a typo in an exemption must not read as no exemption.
 */
export function parseAllowlist(text) {
  const emails = []
  const paths = []
  const repos = []
  const commits = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return
    const [kind, value, rules] = line.split(/\s+/)
    if (kind === 'email' && value && !rules) {
      emails.push(value.toLowerCase())
    } else if (kind === 'repo' && value && !rules && /^[A-Za-z0-9._-]+$/.test(value)) {
      repos.push(value.toLowerCase())
    } else if (kind === 'commit' && value && !rules && /^[0-9a-f]{7,40}$/i.test(value)) {
      commits.push(value.toLowerCase())
    } else if (kind === 'path' && value && rules) {
      const set = rules === '*' ? '*' : new Set(rules.split(','))
      if (set !== '*') {
        for (const r of set) {
          if (!(r in RULES)) throw new Error(`allowlist line ${i + 1}: unknown rule "${r}"`)
        }
      }
      paths.push({ re: globToRegex(value), rules: set })
    } else {
      throw new Error(`allowlist line ${i + 1}: expected "email <domain-or-address>", "repo <name>", "commit <sha>" or "path <glob> <rules|*>"`)
    }
  })
  return { emails, paths, repos, commits }
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

/**
 * A bare private repository name, in two shapes (case-insensitive, `.git` allowed):
 *   word  a whole word anywhere on the line: not part of a longer name, path or word
 *   path  a whole path part, or a part that is the name plus one extension (`name/`, `name.md`)
 * Only names the merge base has never said are watched, so the loose shape costs nothing.
 */
export function bareNamePatterns(names) {
  if (names.length === 0) return { word: /(?!)/g, path: /(?!)/g }
  const alt = names.map(escapeRegex).join('|')
  return {
    word: new RegExp(`(?<![A-Za-z0-9_.-])(?:${alt})(?:\\.git)?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'gi'),
    path: new RegExp(`(?<=^|/)(?:${alt})(?:\\.git|\\.[A-Za-z0-9]{1,8})?(?=/|$)`, 'gi'),
  }
}
export const bareNamePattern = (names) => bareNamePatterns(names).word

const all = (re, text) => [...text.matchAll(re)].map((m) => m[0])

// Minified SVG: the numbers in path data and point lists are not addresses. Dropped only in
// an .svg file or on a line with a path or polygon tag, and only a value that reads as
// drawing data: a path starts with a move command, a point list is many numbers. An address
// in another attribute, in another kind of file, or alone in a value, still counts.
const SVG_DATA =
  /(?<![\w-])(?:d\s*=\s*(["'])[Mm][MmLlHhVvCcSsQqTtAaZz0-9\s,.eE+-]*\1|points\s*=\s*(["'])(?:-?[\d.]+[\s,]+){5,}-?[\d.]+\2)/g
const stripSvgData = (text) => text.replace(SVG_DATA, ' ')
export const svgContext = (path, text) => /\.svg$/i.test(path) || /<(?:path|polygon|polyline)\b/i.test(text)

// A domain whose first two labels are numbers is a version tag (a package name, an at sign,
// then a dotted version). A real domain with a numeric first label (163.com) is still an address.
const versionLikeDomain = (address) => /^\d+\.\d/.test(address.slice(address.lastIndexOf('@') + 1))

/**
 * What a piece of text breaks: [{ rule, value }]. `rules` limits which rules run (a path
 * or a commit message is not checked for emails). `bare` is how a bare private repository
 * name is read in this text: 'word', 'path', or null for not at all. `svg` drops drawing data.
 */
export function scanText(raw, { privateRepo, bareNames, allow }, rules = Object.keys(RULES), bare = null, svg = false) {
  const text = raw.replace(/\0/g, '') // a UTF-16 file read as bytes has a NUL between letters
  const on = (r) => rules.includes(r)
  const hits = []
  const add = (rule, values) => values.forEach((value) => hits.push({ rule, value }))
  if (on('private-ip')) add('private-ip', all(PRIVATE_IP, svg ? stripSvgData(text) : text))
  if (on('session-id')) add('session-id', all(SESSION_ID, text))
  if (on('tailnet-name')) add('tailnet-name', all(TAILNET, text))
  if (on('internal-host')) add('internal-host', all(INTERNAL, text))
  if (on('private-repo')) add('private-repo', all(privateRepo, text))
  if (on('private-repo') && bare && bareNames) {
    // A bare match inside an org-prefixed one is the same mention, not a second finding.
    const spans = [...text.matchAll(privateRepo)].map((m) => [m.index, m.index + m[0].length])
    for (const m of text.matchAll(bareNames[bare])) {
      if (!spans.some(([from, to]) => m.index >= from && m.index < to)) add('private-repo', [m[0]])
    }
  }
  if (on('owner-quote')) add('owner-quote', all(OWNER_QUOTE, text))
  if (on('email')) {
    add(
      'email',
      all(EMAIL, text).filter((m) => {
        const tld = m.slice(m.lastIndexOf('.') + 1).toLowerCase()
        return !FILE_EXTENSIONS.has(tld) && !versionLikeDomain(m) && !emailAllowed(m, allow)
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

const C_ESCAPES = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }

// A path git quotes (a quote, backslash, tab or control character in it) is C-style: decode it,
// or the path in a diff header never matches the path in name-status and the count check fails.
function unquote(raw) {
  const t = raw.replace(/\t.*$/, '')
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return t
  const inner = t.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      bytes.push(...Buffer.from(inner[i]))
      continue
    }
    i += 1
    if (/[0-7]/.test(inner[i])) {
      let octal = inner[i]
      while (octal.length < 3 && /[0-7]/.test(inner[i + 1] ?? '')) octal += inner[(i += 1)]
      bytes.push(parseInt(octal, 8))
    } else bytes.push(C_ESCAPES[inner[i]] ?? inner.charCodeAt(i))
  }
  return Buffer.from(bytes).toString('utf8')
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

/**
 * Name-status output (-z) as [{ status, path, from?, similarity? }]; status is the first
 * letter, from is set for a rename or copy, similarity is git's percentage for those (R100
 * is a pure rename).
 */
export function parseNameStatus(nameStatusZ) {
  const parts = nameStatusZ.split('\0')
  if (parts.at(-1) === '') parts.pop()
  const files = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    if (!status) throw new Error('cannot read the name-status output')
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: status[0], from: parts[i + 1], path: parts[i + 2], similarity: Number(status.slice(1)) })
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
 * ran). Returns the paths git calls binary that gave no readable lines (it does so for a
 * `-diff` attribute even with --text, for a file that only loses lines or is only
 * renamed): the caller reads those whole. A deleted file and a pure rename (R100) have
 * nothing to read and are not returned.
 */
export function checkCounts(numstat, added, files = []) {
  const parsed = new Map()
  for (const { path } of added) parsed.set(path, (parsed.get(path) ?? 0) + 1)
  const status = new Map(files.map((f) => [f.path, f]))
  const unread = []
  for (const { path, added: n } of numstat) {
    const got = parsed.get(path) ?? 0
    if (n === null) {
      const f = status.get(path)
      const nothingToRead = f && (f.status === 'D' || (f.status === 'R' && f.similarity === 100))
      if (got === 0 && !nothingToRead) unread.push(path)
    } else if (got !== n) {
      throw new Error(`read ${got} added line(s) of path hash ${shortHash(path)} but git counts ${n}`)
    }
  }
  return unread
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // The command line and git's message name the paths and revisions it was given, and a path
    // can hold a value: say which subcommand failed and nothing else.
    const e = new Error(`git ${args[0]} failed${error.status ? ` (exit ${error.status})` : ''}`)
    e.status = error.status
    throw e
  }
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
const ADDED = ['A', 'R', 'C']

// The well-known empty tree: a root commit that a merge brings in diffs against it.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '-M']

/** One diff between two revisions, read three ways and checked against git's own count. */
function readDiff(dir, from, to) {
  const pair = [from, to, '--']
  const diff = git(dir, ['diff', ...DIFF_FLAGS, '--unified=0', ...pair])
  const numstat = git(dir, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...pair])
  const nameStatus = git(dir, ['diff', ...DIFF_FLAGS, '--name-status', '-z', ...pair])
  const added = parseAddedLines(diff)
  const files = parseNameStatus(nameStatus)
  // A file git will not diff line by line is read whole: every line counts as added, and
  // a value the file already held at the merge base is excused later like any other.
  for (const path of checkCounts(parseNumstat(numstat), added, files)) {
    git(dir, ['show', `${to}:${path}`]).split('\n').forEach((text, i, all) => {
      if (i < all.length - 1 || text !== '') added.push({ path, line: i + 1, text: text.replace(/\r$/, '') })
    })
  }
  return { files, newFiles: parseNewFiles(nameStatus), added }
}

/**
 * What a merge commit wrote itself: what its diff against EVERY parent holds. Lines, added
 * or renamed paths and new files that came in from the other side are public already, so
 * they are in the diff against one parent and not the other. Each parent diff is counted.
 */
function readMerge(dir, parents, sha) {
  const diffs = parents.map((p) => readDiff(dir, p, sha))
  const inEvery = (pick, key) => {
    let keep = null
    for (const d of diffs) {
      const m = new Map(pick(d).map((x) => [key(x), x]))
      keep = keep === null ? m : new Map([...keep].filter(([k]) => m.has(k)))
    }
    return [...(keep ?? new Map()).values()]
  }
  const noFrom = ({ from, similarity, ...rest }) => rest // renames differ per parent: no chain through a merge
  return {
    files: inEvery((d) => d.files.filter((f) => ADDED.includes(f.status)), (f) => f.path).map(noFrom),
    newFiles: inEvery((d) => d.newFiles, (f) => f.path).map(noFrom),
    added: inEvery((d) => d.added, (r) => `${r.path}\0${r.text}`),
  }
}

function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

/**
 * Findings for one diff: new files in forbidden directories, added and renamed paths, and
 * added lines minus any value the same file already held at the merge base. `sha` is
 * null for the net diff and the commit's short id for a single commit's own diff.
 */
function scanDiff({ files, newFiles, added }, sha, ctx, base, origin) {
  const { allow } = ctx
  const findings = []
  const flag = (path, line, rule, value) => findings.push({ path, line, rule, value, sha })
  // A rename in this very diff is known before its lines are read: a value the file held
  // under its old name is not new.
  for (const f of files) if (f.from) origin.set(f.path, origin.get(f.from) ?? f.from)
  for (const f of newFiles) {
    // A file the merge base already holds is restored, not new (delete, then put back).
    if (inForbiddenDir(f.path) && !pathExempt(f.path, 'new-file', allow) && !base.exists(f.path)) flag(f.path, 1, 'new-file', '')
  }
  for (const f of files) {
    if (!ADDED.includes(f.status)) continue
    const held = base.pathValues(origin.get(f.path) ?? f.path)
    for (const hit of scanText(f.path, ctx, PATH_RULES, 'path')) {
      if (pathExempt(f.path, hit.rule, allow)) continue
      if (held.has(`${hit.rule}\0${hit.value.toLowerCase()}`)) continue
      flag(f.path, 1, hit.rule, hit.value)
    }
  }
  let linesRead = 0
  const filesRead = new Set()
  for (const { path, line, text } of added) {
    linesRead += 1
    filesRead.add(path)
    for (const hit of scanText(text, ctx, undefined, bareScope(path), svgContext(path, text))) {
      if (pathExempt(path, hit.rule, allow)) continue
      if (base.heldValue(origin.get(path) ?? path, path, hit.rule, hit.value)) continue
      flag(path, line, hit.rule, hit.value)
    }
  }
  return { findings, linesRead, filesRead }
}

/**
 * Does any text file in the merge base's tree already say this name the way the guard reads
 * it: as a whole word? git grep -w also stops at "-", "." and "/", so it only finds candidates.
 */
function namedAtBase(dir, rev, name) {
  let lines
  try {
    lines = git(dir, ['grep', '-I', '-h', '-i', '-F', '-e', name, rev, '--']).split('\n')
  } catch {
    return false // no match, or git could not look: keep watching the name
  }
  const word = bareNamePatterns([name]).word
  return lines.some((line) => line.match(word))
}

const revisions = (dir, args) => git(dir, ['rev-list', ...args, '--']).split('\n').filter(Boolean)

/** A revision as a full commit id. A name that starts with "--" is a name, never an option. */
const resolveRev = (dir, rev) => git(dir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim()

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
        'A repository admin sets it as an Actions secret (Settings, Secrets and variables, Actions, Secrets), holding the private repository names ONE PER LINE, ' +
        'so the log masks each name on its own (a comma-separated value is read too, but the log masks only the whole string). ' +
        'A pull request from a fork gets no secrets, so it fails here too.',
    )
    return 2
  }

  const dir = resolve(args.dir)
  const range = `${args.base}...${args.head}`
  let baseSha
  let headSha
  let mergeBase
  let net
  let commits
  let messages
  let allowText
  try {
    baseSha = resolveRev(dir, args.base)
    headSha = resolveRev(dir, args.head)
    mergeBase = git(dir, ['merge-base', baseSha, headSha]).trim()
    // Every commit the head publishes that the base does not hold, oldest first, with its
    // parents. History is disclosed whole, so a value one commit adds and a later one
    // removes counts. "Not in the base" rather than "after the merge base": with two
    // merge bases (a criss-cross merge) the second one's commits are public already.
    commits = revisions(dir, ['--reverse', '--parents', headSha, '--not', baseSha]).map((row) => {
      const [sha, ...parents] = row.split(' ')
      return { sha, short: sha.slice(0, 7), parents }
    })
    messages = git(dir, ['log', '-z', '--format=%H%n%B', headSha, '--not', baseSha, '--'])
    if (commits.length > 0) net = readDiff(dir, mergeBase, headSha)
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

  // Nothing to read is its own answer, not a pass and not a crash: a wrong base or head,
  // or a push with nothing outgoing. A caller that wants to treat it as a pass says so.
  if (commits.length === 0) {
    out.error(`privacy-guard: ${range} holds no commits, so there was nothing to read. Check the base and head.`)
    return EXIT_NOTHING_TO_READ
  }

  let allow
  try {
    allow = parseAllowlist(allowText)
  } catch (error) {
    out.error(`privacy-guard: ${error.message}`)
    return 2
  }

  const open = names.filter((n) => !allow.repos.includes(n))
  // A bare name is watched only while the repository has never said it. Most private
  // repositories are named for a site that is public, and the merge base already says
  // their names in dozens of files: flagging them again discloses nothing new, and the
  // only way out of a false red would be a rewrite. The org-prefixed form is always read.
  const unsaid = open.filter((n) => !namedAtBase(dir, mergeBase, n))
  const ctx = { privateRepo: privateRepoPattern(open), bareNames: bareNamePatterns(unsaid), allow }

  // What the merge base holds: whether a path exists there, the values the same rule finds
  // in a path, and in a file's text, compared whole. A file that holds one value does not
  // excuse a longer or shorter one that contains it.
  const existsCache = new Map()
  const pathCache = new Map()
  const textCache = new Map()
  const base = {
    exists(path) {
      if (!existsCache.has(path)) {
        let there = false
        try {
          there = git(dir, ['cat-file', '-t', `${mergeBase}:${path}`]).trim() === 'blob'
        } catch {
          // not at the merge base
        }
        existsCache.set(path, there)
      }
      return existsCache.get(path)
    },
    pathValues(path) {
      if (!pathCache.has(path)) {
        const held = this.exists(path) ? scanText(path, ctx, PATH_RULES, 'path') : []
        pathCache.set(path, new Set(held.map((h) => `${h.rule}\0${h.value.toLowerCase()}`)))
      }
      return pathCache.get(path)
    },
    heldValue(key, path, rule, value) {
      const mode = bareScope(path)
      const cacheKey = `${key}\0${mode}`
      if (!textCache.has(cacheKey)) {
        let held = new Set()
        try {
          const text = git(dir, ['show', `${mergeBase}:${key}`])
          held = new Set(scanText(text, ctx, undefined, mode).map((h) => `${h.rule}\0${h.value.toLowerCase()}`))
        } catch {
          // a new file held nothing
        }
        textCache.set(cacheKey, held)
      }
      return textCache.get(cacheKey).has(`${rule}\0${value.toLowerCase()}`)
    },
  }

  const findings = []
  const seen = new Set()
  const take = (list) => {
    for (const f of list) {
      const key = `${f.path}\0${f.rule}\0${f.value.toLowerCase()}`
      if (f.rule !== 'new-file' && seen.has(key)) continue // one value in one file, once
      seen.add(key)
      findings.push(f)
    }
  }

  let linesRead = 0
  let filesRead = new Set()
  try {
    const first = scanDiff(net, null, ctx, base, new Map())
    take(first.findings)
    linesRead = first.linesRead
    filesRead = first.filesRead

    // Then each commit's own diff. The net diff above is what a merge would land; this is
    // what the push publishes. A value added in one commit and removed in the next is in
    // the second and not the first. A merge commit contributes what it wrote itself.
    const origin = new Map()
    for (const c of commits) {
      let diff
      if (c.parents.length > 1) diff = readMerge(dir, c.parents, c.sha)
      else diff = readDiff(dir, c.parents[0] ?? EMPTY_TREE, c.sha)
      take(scanDiff(diff, c.short, ctx, base, origin).findings)
    }
  } catch (error) {
    out.error(`privacy-guard: cannot trust the diff, so nothing was checked: ${error.message}`)
    return 2
  }

  // Commit messages are public too. The finding is "commit <sha>", never the text. An
  // allowlisted `commit <sha>` exempts that commit's message and nothing else.
  // -z separates commits with NUL, which a commit message cannot hold; a control character
  // a message can hold (\x01, \x02) would otherwise split an entry and hide text.
  let messageCount = 0
  for (const entry of messages.split('\0').filter((e) => e.trim() !== '')) {
    const nl = entry.indexOf('\n')
    const full = entry.slice(0, nl).trim()
    const sha = full.slice(0, 7)
    const body = entry.slice(nl + 1)
    messageCount += 1
    if (allow.commits.some((c) => full.toLowerCase().startsWith(c))) continue
    body.split('\n').forEach((text, i) => {
      for (const hit of scanText(text, ctx, COMMIT_RULES, 'word')) {
        findings.push({ path: `commit ${sha}`, line: i + 1, rule: hit.rule, value: hit.value, sha, message: true })
      }
    })
  }

  // A file whose own path holds a value is shown by a short hash of the path, never the
  // path: the path is the value. No file annotation for it either.
  const masked = new Map()
  const hidden = (path) => {
    if (!masked.has(path)) masked.set(path, scanText(path, ctx, PATH_RULES, 'path').length > 0)
    return masked.get(path)
  }
  const actions = env.GITHUB_ACTIONS === 'true'
  const shown = findings.slice(0, 200)
  for (const f of shown) {
    const what = `${RULES[f.rule]} [${f.rule}]`
    if (f.message) {
      out.log(`${f.path}: message line ${f.line}: ${what}`)
      continue
    }
    const secret = hidden(f.path)
    const place = secret ? `path hash ${shortHash(f.path)}` : f.path
    if (f.sha) {
      // Found in one commit's own diff: the line may be gone from the final tree, so no file annotation.
      if (actions) out.log(`::error title=privacy-guard::commit ${f.sha}: ${escapeProperty(place)}:${f.line}: ${what}`)
      else out.log(`commit ${f.sha}: ${place}:${f.line}: ${what}`)
    } else if (secret) {
      if (actions) out.log(`::error title=privacy-guard::${escapeProperty(place)}:${f.line}: ${what}`)
      else out.log(`${place}:${f.line}: ${what}`)
    } else if (actions) out.log(`::error file=${escapeProperty(f.path)},line=${f.line},title=privacy-guard::${what}`)
    else out.log(`${f.path}:${f.line}: ${what}`)
  }
  if (findings.length > shown.length) out.log(`... and ${findings.length - shown.length} more`)

  // The allowlist, this script and the workflow decide what the guard lets through, so
  // say when a change touches them. They are control-plane files and need a human read.
  const touched = net.files.filter((f) =>
    [ALLOWLIST_PATH, 'scripts/privacy-guard.mjs', '.github/workflows/privacy-guard.yml'].includes(f.path),
  )
  if (actions && touched.length > 0) {
    out.log('::warning title=privacy-guard::This change edits the guard, its workflow or its allowlist. Read every line it adds.')
  }

  if (findings.length > 0) {
    out.log(
      `privacy-guard: ${findings.length} finding(s) on what ${range} adds. This repository is public; ` +
        'remove the value, or describe it without naming it. Runbooks, plans and handoffs belong in the private ops repository. ' +
        'The finding names the rule and the place, never the value, so the log does not repeat it; a file whose own name holds the value is shown by a hash of its path (the first 8 hex of the path\'s sha1). ' +
        'History is public too: a value that a later commit removes still counts, so rewrite the branch before it is pushed. ' +
        'A commit message that cannot be rewritten has one way out: a `commit <sha>` line in the allowlist, merged first.',
    )
    return 1
  }
  out.log(
    `privacy-guard: OK, read ${linesRead} added line(s) in ${filesRead.size} file(s), ${net.files.length} path(s) and ${messageCount} commit message(s) in ${range}, and each of ${commits.length} commit diff(s) on its own`,
  )
  return 0
}

// Is this file the one node was started on? Compare real paths of both sides: a symlinked
// path (the macOS temp dir is one) differs from the module's real URL, and under
// --preserve-symlinks-main the module URL is the link while argv[1] is not. Taking the
// script for an import would exit 0 having read nothing. When a path cannot be resolved,
// fall back to the file name: running when unsure is safe, silence is not.
const isMain = (() => {
  const started = process.argv[1]
  if (!started) return false
  const here = fileURLToPath(import.meta.url)
  try {
    return realpathSync(started) === realpathSync(here)
  } catch {
    return basename(started) === basename(here)
  }
})()
if (isMain) {
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
