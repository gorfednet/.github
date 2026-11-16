#!/usr/bin/env node
/**
 * Refuse a push or a pull request text that would publish private detail to a PUBLIC
 * repository (plan row 1.30 f). Claude Code user-level PreToolUse hook on Bash, started by
 * public-push-guard.sh. Live copy: ~/.claude/hooks/. Record copy: scripts/claude-hooks/.
 *
 * Why: a branch pushed to a public repository is world-readable at once, force push and
 * branch delete are denied, and history counts as disclosed. The pull request check runs
 * only after the push. This runs before.
 *
 * It fails CLOSED. Claude Code lets a call through when a hook exits 1, crashes or times
 * out (only exit 2 or a deny decision blocks), so every failure after the command is known
 * to publish, including a crash, ends in a deny decision, and every outside call has its
 * own timeout inside a total budget.
 *
 * What it reads:
 *   git push        every ref the push would send (named refspecs, --all, --tags, --mirror,
 *                   push.default=matching, remote.<n>.push), minus what the remote already
 *                   holds (`git ls-remote`, not stale tracking refs). Each outgoing commit
 *                   is scanned on its own, so add-then-remove across two commits is seen,
 *                   and the whole range is scanned once as well (merge commits).
 *   gh pr/issue/release create|edit|comment, gh api writes
 *                   the command text and any --body-file, scanned for the same rules.
 *   gh pr create    also the push of HEAD it may make.
 *   gh repo edit --visibility, gh repo create --public, gh api visibility writes: refused.
 * A private repository passes untouched. A public one runs scripts/privacy-guard.mjs from
 * gorfednet/.github main. The private repository list is read at run time with
 * `gh repo list gorfednet --visibility private`, held in memory and passed to the guard in
 * its environment; it is never written to disk.
 *
 * Anything it can't resolve (a variable it has no value for, a command substitution in a
 * directory, `eval`) is checked conservatively or refused, never skipped.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BUDGET_MS = 150_000
const started = Date.now()
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_COMMITS = 150
const TEXT_RULES = ['private-ip', 'session-id', 'tailnet-name', 'internal-host', 'private-repo', 'owner-quote']
const PRIVATE_TTL_MS = 5 * 60 * 1000
const PRIVATE_GRACE_MS = 60 * 60 * 1000 // when gh is down, a repository seen private within the hour passes
const GUARD_TTL_MS = 30 * 60 * 1000
// The test overrides below are honoured only when this is set, never in a live session.
const TEST_MODE = process.env.PUBLIC_PUSH_GUARD_TEST === '1'

class Deny extends Error {}
const deny = (message) => {
  throw new Deny(message)
}

function run(cmd, args, { cwd, env, timeout = 15_000, input } = {}) {
  if (Date.now() - started > BUDGET_MS) deny('public-push-guard: ran out of time reading this call, so it is refused. Try again.')
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      env: env ?? process.env,
      encoding: 'utf8',
      timeout,
      input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true, status: 0, stdout, stderr: '' }
  } catch (e) {
    return { ok: false, status: typeof e.status === 'number' ? e.status : -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), timedOut: e.code === 'ETIMEDOUT' }
  }
}

// ---------------------------------------------------------------- shell reading

const OPERATORS = ['&&', '||', ';;', ';', '|&', '|', '&', '\n']

/**
 * Read a shell command into statements. A statement is { words: [{ text, open }], cwd }.
 * `open` is true when the word holds an expansion we have no value for. A subshell, a
 * command substitution, `bash -c '...'` and `eval '...'` are read as statements of their
 * own; `uncertain` is set when something we couldn't read could still hold a push.
 */
function readShell(source, state) {
  const out = { statements: [], uncertain: false, text: source }
  const stack = []
  let cwd = state.cwd
  const vars = { ...state.vars }
  const exported = { ...(state.exported ?? {}) }
  let i = 0
  let words = []
  let word = null
  let pendingHeredocs = []

  const expandVar = (name) => (name in vars ? vars[name] : name in process.env ? process.env[name] : undefined)
  const startWord = () => (word ??= { text: '', open: false, quoted: false })
  const endWord = () => {
    if (word) words.push(word)
    word = null
  }
  const nested = (text) => {
    const inner = readShell(text, { cwd, vars, exported })
    inner.statements.forEach((x) => { x.nested = true })
    out.statements.push(...inner.statements)
    if (inner.uncertain) out.uncertain = true
    return inner
  }
  const endStatement = () => {
    endWord()
    if (words.length === 0) return
    handle(words)
    words = []
  }
  const handle = (ws) => {
    // leading VAR=value assignments set a variable (for the rest of the command) and are kept as env
    const env = {}
    let k = 0
    while (k < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k].text)) {
      const eq = ws[k].text.indexOf('=')
      env[ws[k].text.slice(0, eq)] = ws[k].open ? undefined : ws[k].text.slice(eq + 1)
      k += 1
    }
    let rest = ws.slice(k)
    if (rest.length > 0 && basename(rest[0].text) === 'env') {
      // env [-i] NAME=value cmd ...: the assignments belong to the command
      let m = 1
      while (m < rest.length && (rest[m].text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[m].text))) {
        const t = rest[m].text
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) env[t.slice(0, t.indexOf('='))] = rest[m].open ? undefined : t.slice(t.indexOf('=') + 1)
        m += 1
      }
      rest = rest.slice(m)
    }
    if (rest.length === 0) {
      for (const [n, v] of Object.entries(env)) if (v !== undefined) vars[n] = v
      return
    }
    const cmd = basename(rest[0].text)
    if (rest[0].open && !/^(git|gh)$/.test(cmd)) out.uncertain = true // a command we could not name
    if (['cd', 'pushd'].includes(cmd) && rest.length >= 2) {
      const target = rest.slice(1).find((w) => !w.text.startsWith('-') || w.text === '-')
      if (!target || target.open || target.text === '-' || /[*?[{]/.test(target.text)) cwd = null // a glob or brace expands to something we can't see
      else if (cwd !== null) cwd = resolvePath(target.text, cwd)
    } else if (cmd === 'popd') {
      cwd = null // we do not track the directory stack
    }
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(cmd) || cmd === 'eval') {
      const at = cmd === 'eval' ? 0 : rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text))
      if (cmd !== 'eval' && at < 0) out.uncertain = true // a script file, here-document or pipe: not read
      if (at >= 0 || cmd === 'eval') {
        const body = rest.slice(at + 1).filter((w) => cmd === 'eval' || !w.text.startsWith('-'))
        if (body.length === 0 || body.some((w) => w.open)) out.uncertain = true
        if (body.length > 0) nested(cmd === 'eval' ? body.map((w) => w.text).join(' ') : body[0].text)
      }
    }
    if (cmd === 'export') {
      for (const w of rest.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.text)
        if (m && !w.open) {
          vars[m[1]] = m[2]
          exported[m[1]] = m[2]
        }
      }
    }
    out.statements.push({ words: rest, env: { ...exported, ...env }, cwd })
  }

  while (i < source.length) {
    const c = source[i]
    const two = source.slice(i, i + 2)
    if (c === '\\') {
      if (source[i + 1] === '\n') {
        i += 2
        continue
      }
      startWord().text += source[i + 1] ?? ''
      i += 2
    } else if (c === "'") {
      const end = source.indexOf("'", i + 1)
      if (end < 0) {
        out.uncertain = true
        startWord().text += source.slice(i + 1)
        break
      }
      const w = startWord()
      w.text += source.slice(i + 1, end)
      w.quoted = true
      i = end + 1
    } else if (c === '"') {
      const w = startWord()
      w.quoted = true
      i += 1
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          w.text += '"$`\\'.includes(source[i + 1]) ? source[i + 1] : source.slice(i, i + 2)
          i += 2
        } else if (source[i] === '$' || source[i] === '`') {
          i = expand(source, i, w)
        } else {
          w.text += source[i]
          i += 1
        }
      }
      if (i >= source.length) out.uncertain = true
      i += 1
    } else if (c === '$' || c === '`') {
      i = expand(source, i, startWord())
    } else if (c === '#' && !word) {
      while (i < source.length && source[i] !== '\n') i += 1
    } else if (two === '<<' && source[i + 2] !== '<') {
      // here-document: its body is data, not commands
      let j = i + 2
      if (source[j] === '-') j += 1
      while (source[j] === ' ') j += 1
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(source.slice(j))
      if (m) {
        pendingHeredocs.push(m[2])
        i = j + m[0].length
      } else {
        out.uncertain = true
        i += 2
      }
    } else if (/[<>]/.test(c)) {
      // redirection: drop it with its target (and a leading fd digit already in the word)
      if (word && /^[0-9&]+$/.test(word.text)) word = null
      i += 1
      while (/[<>&|]/.test(source[i] ?? '')) i += 1
      while (source[i] === ' ') i += 1
      const skip = readShellWord(source, i)
      i = skip
    } else if (c === '(' && !word) {
      endStatement()
      stack.push({ cwd, vars: { ...vars } })
      i += 1
    } else if (c === ')') {
      endStatement()
      const top = stack.pop()
      if (top) {
        cwd = top.cwd
        for (const k of Object.keys(vars)) delete vars[k]
        Object.assign(vars, top.vars)
      }
      i += 1
    } else if (c === '{' || c === '}') {
      if (!word && /[\s]/.test(source[i + 1] ?? ' ')) {
        endStatement()
        i += 1
      } else {
        startWord().text += c
        i += 1
      }
    } else if (c === ' ' || c === '\t') {
      endWord()
      i += 1
    } else {
      const op = OPERATORS.find((o) => source.startsWith(o, i))
      if (op) {
        endStatement()
        i += op.length
        if (op === '\n' && pendingHeredocs.length > 0) {
          for (const delim of pendingHeredocs) {
            const re = new RegExp(`(^|\\n)[\\t ]*${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\t ]*(\\n|$)`)
            const m = re.exec(source.slice(i))
            i = m ? i + m.index + m[0].length : source.length
          }
          pendingHeredocs = []
        }
      } else {
        startWord().text += c
        i += 1
      }
    }
  }
  endStatement()
  return out

  // Expand $NAME, ${NAME}, $(...) and `...` into the word. Returns the new index.
  function expand(src, at, w) {
    if (src[at] === '`') {
      const end = src.indexOf('`', at + 1)
      const inner = end < 0 ? src.slice(at + 1) : src.slice(at + 1, end)
      nested(inner)
      w.open = true
      w.subst = [...(w.subst ?? []), inner.trim()]
      w.text += '`'
      return end < 0 ? src.length : end + 1
    }
    if (src[at + 1] === '(') {
      let depth = 1
      let j = at + 2
      while (j < src.length && depth > 0) {
        if (src[j] === '(') depth += 1
        else if (src[j] === ')') depth -= 1
        j += 1
      }
      if (depth > 0) out.uncertain = true
      nested(src.slice(at + 2, depth > 0 ? src.length : j - 1))
      w.open = true
      w.subst = [...(w.subst ?? []), src.slice(at + 2, depth > 0 ? src.length : j - 1).trim()]
      w.text += '$('
      return j
    }
    if (src[at + 1] === "'" || src[at + 1] === '"') {
      w.open = true // $'...' (ANSI-C quoting) and $"..." can spell anything
      w.text += '$'
      return at + 1
    }
    const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(src.slice(at))
    if (!m) {
      if (src[at + 1] === '{') {
        w.open = true
        const end = src.indexOf('}', at)
        w.text += '${'
        return end < 0 ? src.length : end + 1
      }
      w.text += '$'
      return at + 1
    }
    const val = expandVar(m[1] ?? m[2])
    if (val === undefined) {
      w.open = true
      w.text += m[0]
    } else w.text += val
    return at + m[0].length
  }
}

/** Index after one shell word starting at `at` (used to drop a redirection's target). */
function readShellWord(src, at) {
  let j = at
  let quote = null
  while (j < src.length) {
    const c = src[j]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === "'" || c === '"') quote = c
    else if (/[\s;&|()<>]/.test(c)) break
    j += 1
  }
  return j
}

function resolvePath(p, base) {
  let q = p
  if (q === '~' || q.startsWith('~/')) q = join(homedir(), q.slice(1))
  return q.startsWith('/') ? resolve(q) : resolve(base, q)
}

// ---------------------------------------------------------------- git and gh commands

const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source'])
const PUSH_ARG_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

/**
 * Pushes and gh calls in one statement. A statement can name git or gh at any word
 * (`command git push`, `time git push`, `xargs git push`, `/usr/bin/git push`).
 */
const GLOB = /[*?[{]/

function commandsIn(stmt) {
  const found = []
  const words = stmt.words
  for (let at = 0; at < words.length; at += 1) {
    const prog = basename(words[at].text)
    if (prog === 'git') {
      let dir = stmt.cwd
      let gitDir = stmt.env.GIT_DIR
      let k = at + 1
      let unresolvedDir = stmt.cwd === null
      const cfg = [] // -c key=value pairs: they change the remote and refs a push uses
      if (stmt.env.GIT_DIR !== undefined || 'GIT_DIR' in stmt.env) unresolvedDir ||= stmt.env.GIT_DIR === undefined || GLOB.test(stmt.env.GIT_DIR)
      while (k < words.length && words[k].text.startsWith('-')) {
        const w = words[k]
        const [name, attached] = w.text.split(/=(.*)/s)
        if (GIT_ARG_OPTS.has(name)) {
          const val = attached !== undefined && name.startsWith('--') ? { text: attached, open: w.open } : words[k + 1]
          if (val === undefined) break
          if (name === '-c' && !val.open) cfg.push(val.text)
          if (name === '-C') {
            if (val.open || dir === null || GLOB.test(val.text)) unresolvedDir = true // a variable, or a pattern the shell or xargs fills in
            else dir = resolvePath(val.text, dir)
          } else if (name === '--git-dir' || name === '--work-tree') {
            if (val.open || GLOB.test(val.text)) unresolvedDir = true
            else if (name === '--git-dir') gitDir = resolvePath(val.text, dir ?? process.cwd())
            else dir = resolvePath(val.text, dir ?? process.cwd())
          }
          k += attached !== undefined && name.startsWith('--') ? 1 : 2
        } else k += 1
      }
      // An open word in the subcommand position (git pu${X}sh) could expand to push: read it as one.
      if (words[k]?.text === 'push' || words[k]?.open) found.push({ kind: 'push', dir, gitDir, cfg, unresolvedDir, args: words.slice(k + 1) })
    } else if (prog === 'gh') {
      const args = words.slice(at + 1)
      found.push({ kind: 'gh', dir: stmt.cwd, unresolvedDir: stmt.cwd === null, args, env: stmt.env })
    }
  }
  return found
}

function ghAction(args) {
  // first two positional words, skipping flags (and the value of -R/--repo)
  const pos = []
  for (let k = 0; k < args.length && pos.length < 2; k += 1) {
    const t = args[k].text
    if (t === '-R' || t === '--repo') k += 1
    else if (!t.startsWith('-')) pos.push(t)
  }
  return pos
}

const flagValue = (args, names) => {
  for (let k = 0; k < args.length; k += 1) {
    const t = args[k].text
    for (const n of names) {
      if (/^-[A-Za-z]$/.test(n) && t.length > 2 && t.startsWith(n) && !t.startsWith('--')) return { text: t.slice(2), open: args[k].open }
      if (t === n) return args[k + 1]
      if (n.startsWith('--') && t.startsWith(`${n}=`)) return { text: t.slice(n.length + 1), open: args[k].open }
    }
  }
  return undefined
}

// ---------------------------------------------------------------- GitHub remotes

/** owner/name when a URL names a GitHub repository, else null. Handles the usual spellings. */
function githubSlug(url) {
  const u = String(url).trim()
  const m =
    /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?(?:www\.|ssh\.)?github\.com(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/*$/i.exec(u)
  return m ? `${m[1]}/${m[2]}` : null
}

/** A host alias (an ssh config Host) that really is github.com. */
function sshAliasIsGithub(url) {
  const m = /^(?:ssh:\/\/)?(?:[^@/\s]+@)?([A-Za-z0-9._-]+)(?::|\/)/.exec(url)
  if (!m || url.startsWith('/') || url.startsWith('.') || /^[a-z]+:\/\//i.test(url) && !url.startsWith('ssh://')) return false
  const r = run('ssh', ['-G', m[1]], { timeout: 4000 })
  return r.ok && /^hostname (?:ssh\.)?github\.com$/im.test(r.stdout)
}

function looksLocal(url) {
  return url.startsWith('/') || url.startsWith('.') || url.startsWith('~') || url.startsWith('file://')
}

// ---------------------------------------------------------------- cache, visibility, guard

function cacheDir(session) {
  try {
    const root = join(process.env.TMPDIR || tmpdir(), `public-push-guard-${process.getuid?.() ?? 0}`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const st = lstatSync(root)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return null
    const dir = join(root, session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'none')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return { root, dir }
  } catch {
    return null
  }
}

/** PUBLIC, PRIVATE or INTERNAL. A repository known to be private may be remembered for 5 minutes. */
function visibilityOf(slug, cache) {
  const file = cache ? join(cache.dir, `vis-${createHash('sha1').update(slug).digest('hex').slice(0, 16)}`) : null
  let cached = null
  let age = Infinity
  if (file && existsSync(file)) {
    cached = readFileSync(file, 'utf8')
    age = Date.now() - statSync(file).mtimeMs
    if (cached === 'PUBLIC') return cached // public stays public for the session
    if (cached === 'PRIVATE' && age < PRIVATE_TTL_MS) return cached
  }
  const r = run('gh', ['repo', 'view', slug, '--json', 'visibility', '-q', '.visibility'], { timeout: 10_000 })
  const v = r.stdout.trim()
  if (r.ok && ['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(v)) {
    if (file && v !== 'INTERNAL') writeFileSync(file, v, { mode: 0o600 })
    return v
  }
  if (cached === 'PRIVATE' && age < PRIVATE_GRACE_MS) return cached // gh is down; this one was private within the hour
  deny(`public-push-guard: could not read the visibility of ${slug} (is gh signed in and online?), so this call is refused. Fix gh, then try again.`)
}

/** Fetch a file from gorfednet/.github main to `out`, atomically. Returns false when absent. */
function fetchMain(path, out) {
  const have = existsSync(out) && statSync(out).size > 0
  if (have && Date.now() - statSync(out).mtimeMs < GUARD_TTL_MS) return true // main's copy is re-read every 30 minutes
  const r = run('gh', ['api', `repos/gorfednet/.github/contents/${path}?ref=main`, '--jq', '.content'], { timeout: 15_000 })
  if (!r.ok) {
    if (have) return true // gh is down: the copy read earlier stands
    if (/Not Found/i.test(r.stderr + r.stdout)) return false
    deny(`public-push-guard: ${path} could not be read from gorfednet/.github main (gh failed), so the guard can't run. Check gh, then try again.`)
  }
  const body = Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64')
  if (body.length === 0) deny(`public-push-guard: ${path} on gorfednet/.github main came back empty, so the guard can't run.`)
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, out)
  return true
}

let guardState = null

/** The guard module and file, the private-name pattern and the allowlist; loaded on first use. */
async function loadGuard(cache) {
  if (guardState) return guardState
  const override = TEST_MODE ? process.env.PUBLIC_PUSH_GUARD_SCRIPT : undefined
  let file = override
  let validated = Boolean(override)
  const dir = cache?.dir ?? join(tmpdir(), `public-push-guard-nocache-${process.pid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const known = cache ? join(cache.root, 'known-good-privacy-guard.mjs') : null
  if (!override) {
    file = join(dir, 'privacy-guard.mjs')
    if (!fetchMain('scripts/privacy-guard.mjs', file)) {
      if (known && existsSync(known)) file = known
      else deny('public-push-guard: scripts/privacy-guard.mjs is not on gorfednet/.github main yet, so the guard can\'t run.')
    }
    if (!run('node', ['--check', file]).ok) {
      if (known && existsSync(known) && file !== known) file = known // main's copy is broken: use the last good one
      else deny('public-push-guard: the guard script failed its syntax check, so it can\'t run.')
    }
    validated = true
    if (known && file !== known) {
      try {
        writeFileSync(`${known}.${process.pid}.tmp`, readFileSync(file))
        renameSync(`${known}.${process.pid}.tmp`, known)
      } catch {
        /* the last-good copy is a convenience */
      }
    }
  }
  if (!validated || !existsSync(file)) deny(`public-push-guard: the privacy guard script is missing (${file}), so it can't run.`)
  const mod = await import(pathToFileURL(file).href)

  const list = run('gh', ['repo', 'list', 'gorfednet', '--visibility', 'private', '--limit', '1000', '--json', 'name', '--jq', '[.[].name] | join(",")'], { timeout: 20_000 })
  const names = list.stdout.trim()
  if (!list.ok || !names) deny('public-push-guard: the private repository list could not be read (gh repo list gorfednet --visibility private), so the guard can\'t run. Check gh, then try again.')

  guardState = { mod, file, names, dir }
  return guardState
}

/**
 * The guard with the exemptions that apply to one repository. The .github allowlist applies to
 * .github only (a path exemption for one repository must not open a hole in another), and is
 * main's copy. Any other public repository gets the copy at the nearest published commit, so
 * an exemption added by a commit in this very push has no effect until it has been published.
 */
async function scoped(cache, target, slug, publishedSha) {
  const base = await loadGuard(cache)
  let text = ''
  let file = null
  if (slug === 'gorfednet/.github') {
    const override = TEST_MODE ? process.env.PUBLIC_PUSH_GUARD_ALLOW : undefined
    file = override || join(base.dir, 'privacy-guard-allow.txt')
    if (!override && !fetchMain('.github/privacy-guard-allow.txt', file)) file = null
    text = file && existsSync(file) ? readFileSync(file, 'utf8') : ''
  } else if (publishedSha) {
    const r = git(target, ['show', `${publishedSha}:.github/privacy-guard-allow.txt`])
    text = r.ok ? r.stdout : ''
  }
  if (!file) {
    file = join(base.dir, `allow-${createHash('sha1').update(`${slug}\0${text}`).digest('hex').slice(0, 12)}.txt`)
    writeFileSync(file, text, { mode: 0o600 })
  }
  let allow
  try {
    allow = base.mod.parseAllowlist(text)
  } catch (e) {
    deny(`public-push-guard: the guard allowlist can't be read (${e.message}), so the guard can't run.`)
  }
  const privateNames = base.mod.parsePrivateRepos(base.names).filter((n) => !allow.repos.includes(n))
  return { ...base, ctx: { privateRepo: base.mod.privateRepoPattern(privateNames), allow }, allowFile: file }
}

/** Guard output without any value: a path that itself holds a value is shown as a hash. */
function redact(out, g) {
  return out
    .split('\n')
    .map((line) => {
      const m = /^(.+?):(\d+): (.*)$/.exec(line)
      if (!m || m[1].startsWith('commit ') || m[1].startsWith('privacy-guard')) return line
      const hits = g.mod.scanText(m[1], g.ctx, TEXT_RULES.filter((r) => r !== 'owner-quote'))
      return hits.length > 0 ? `path#${createHash('sha1').update(m[1]).digest('hex').slice(0, 8)}:${m[2]}: ${m[3]}` : line
    })
    .join('\n')
}

// ---------------------------------------------------------------- the check

const git = (target, args, opts) => {
  const base = target.gitDir ? [`--git-dir=${target.gitDir}`] : []
  const cfg = (target.cfg ?? []).flatMap((kv) => ['-c', kv])
  return run('git', [...(target.dir ? ['-C', target.dir] : []), ...base, ...cfg, '-c', 'core.quotepath=false', ...args], opts)
}

/** A git call that must succeed: a failure reads as "can't tell", never as "nothing there". */
function must(target, args, what, opts) {
  const r = git(target, args, opts)
  if (!r.ok) deny(`public-push-guard: git could not ${what}, so this call is refused.`)
  return r.stdout
}

/** Remotes a push could go to. `spec` is a name, a URL, or null for the repository default. */
function remotesFor(target, spec, branch) {
  const cfg = (key) => {
    const r = git(target, ['config', '--get', key])
    return r.ok ? r.stdout.trim() : ''
  }
  const all = must(target, ['remote'], 'list the remotes').split('\n').filter(Boolean)
  let chosen
  if (spec && spec.open) chosen = all // unresolved: any remote
  else if (spec) chosen = [spec.text]
  else chosen = [cfg(`branch.${branch}.pushRemote`) || cfg('remote.pushDefault') || cfg(`branch.${branch}.remote`) || (all.includes('origin') ? 'origin' : all[0]) || 'origin']
  return chosen.map((name) => {
    if (all.includes(name)) {
      const urls = new Set()
      for (const key of [`remote.${name}.url`, `remote.${name}.pushurl`]) {
        const r = git(target, ['config', '--get-all', key])
        if (r.ok) r.stdout.split('\n').filter(Boolean).forEach((u) => urls.add(u))
      }
      const expanded = git(target, ['remote', 'get-url', '--push', '--all', name])
      if (expanded.ok) expanded.stdout.split('\n').filter(Boolean).forEach((u) => urls.add(u))
      return { name, urls: [...urls] }
    }
    return { name, urls: [name], isUrl: true }
  })
}

function publicSlugs(remote, cache) {
  const slugs = []
  let unknown = false
  for (const url of remote.urls) {
    const slug = githubSlug(url)
    if (slug) slugs.push(slug)
    else if (!looksLocal(url) && sshAliasIsGithub(url)) {
      const m = /[:/]+([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/*$/.exec(url)
      if (m) slugs.push(`${m[1]}/${m[2]}`)
      else unknown = true
    }
  }
  return { slugs: [...new Set(slugs)], unknown }
}

/**
 * Refs a push would send: { refs: [{ref, sha}], unresolved: [name] }. A refspec is a string, or
 * { open: true } for one made of an expansion we have no value for (then every local branch is read).
 */
function refsToSend(target, flags, refspecs) {
  const listRefs = (patterns) => {
    const r = git(target, ['for-each-ref', '--format=%(refname) %(objectname)', ...patterns])
    if (!r.ok) deny('public-push-guard: git could not list the local refs, so this call is refused.')
    return r.stdout.split('\n').filter(Boolean).map((l) => ({ ref: l.split(' ')[0], sha: l.split(' ')[1] }))
  }
  const out = new Map()
  const unresolved = []
  const add = (items) => items.forEach((x) => out.set(x.ref, x))
  if (flags.mirror) add(listRefs([]))
  if (flags.all) add(listRefs(['refs/heads']))
  if (flags.tags) add(listRefs(['refs/tags']))
  const specs = refspecs.length > 0 ? refspecs : flags.configured
  let useHead = specs.length === 0 && !flags.all && !flags.mirror
  if (useHead && flags.matching) {
    useHead = false
    add(listRefs(['refs/heads']))
  }
  const resolveOne = (name) => {
    const r = git(target, ['rev-parse', '-q', '--verify', `${name}^{commit}`])
    return r.ok ? [{ ref: name, sha: r.stdout.trim() }] : []
  }
  for (const item of specs) {
    if (typeof item !== 'string') {
      useHead = true
      add(listRefs(['refs/heads']))
      continue
    }
    const spec = item.replace(/^\+/, '')
    if (spec === ':') {
      add(listRefs(['refs/heads'])) // `:` alone is "matching"
      continue
    }
    if (spec === '' || spec.startsWith(':')) continue // a delete publishes nothing
    const colon = spec.indexOf(':')
    const src = colon >= 0 ? spec.slice(0, colon) : spec
    if (src === 'HEAD') {
      useHead = true
      continue
    }
    if (/[*?[]/.test(src)) {
      add(listRefs(src.startsWith('refs/') ? [src] : [`refs/heads/${src}`, `refs/tags/${src}`]))
      continue
    }
    const items = resolveOne(src)
    if (items.length === 0) items.push(...resolveOne(`refs/heads/${src}`), ...resolveOne(`refs/tags/${src}`))
    if (items.length === 0) unresolved.push(src)
    add(items)
  }
  if (useHead) add(resolveOne('HEAD').map((x) => ({ ...x, ref: 'HEAD' })))
  return { refs: [...out.values()], unresolved }
}

/** Commits the remote lacks: reachable from the sent refs, not from anything the remote holds now. */
function outgoing(target, remote, sent) {
  if (sent.length === 0) return { commits: [], boundary: [], tips: [] }
  const ls = git(target, ['ls-remote', remote.name], { timeout: 25_000 })
  if (!ls.ok) deny(`public-push-guard: could not read what ${remote.isUrl ? 'the remote' : remote.name} already holds (git ls-remote failed), so the outgoing commits can't be told apart from published ones and this push is refused. Check the network and credentials, then try again.`)
  const known = []
  for (const line of ls.stdout.split('\n')) {
    const sha = line.split(/\s+/)[0]
    if (/^[0-9a-f]{40,64}$/.test(sha) && git(target, ['cat-file', '-e', `${sha}^{commit}`]).ok) known.push(sha)
  }
  const tips = [...new Set(sent.map((x) => x.sha))]
  const rest = [...tips, ...(known.length ? ['--not', ...known] : [])]
  const commits = must(target, ['rev-list', '--reverse', '--topo-order', ...rest], 'list the outgoing commits', { timeout: 30_000 }).split('\n').filter(Boolean)
  const boundary = must(target, ['rev-list', '--boundary', ...rest], 'list the published boundary', { timeout: 30_000 })
    .split('\n')
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1))
  return { commits, boundary, tips }
}

function runGuard(target, g, base, head) {
  const env = { ...process.env, PRIVATE_REPOS: g.names, ...(target.gitDir ? { GIT_DIR: target.gitDir } : {}) }
  const args = [realpathSync(g.file), '--base', base, '--head', head, '--dir', target.dir ?? '.']
  if (g.allowFile) args.push('--allow', g.allowFile)
  const r = run('node', args, { cwd: target.dir ?? undefined, env, timeout: 40_000 })
  const out = `${r.stdout}${r.stderr}`.trim()
  // A clean run says so. Silence is a guard that did not run (it once did nothing when started
  // through a symlinked path), and must not read as a pass.
  if (r.ok && !/^privacy-guard: OK/m.test(out)) return { status: -2, out: out || 'the guard printed nothing' }
  return { status: r.ok ? 0 : r.status, out }
}

function refuse(slug, g, out) {
  deny(
    `public-push-guard refused: this would publish private detail to ${slug}, which is public.\n${redact(out, g)}\n` +
      'A push to a public repository can\'t be taken back, so nothing was sent.',
  )
}

const messageHits = (g, sha, text) => {
  const hits = g.mod.scanText(text, g.ctx, TEXT_RULES)
  return hits.length > 0 ? `commit ${sha.slice(0, 7)}: message: ${[...new Set(hits.map((h) => `[${h.rule}]`))].join(' ')}` : null
}

async function checkPush(target, remote, sent, slug, cache, names = []) {
  const { commits, boundary, tips } = outgoing(target, remote, sent)
  const tagNames = sent
    .filter(({ ref }) => ref !== 'HEAD')
    .map(({ ref }) => `refs/tags/${ref.replace(/^refs\/tags\//, '')}`)
    .filter((name) => git(target, ['for-each-ref', '--format=%(objecttype)', name]).stdout.trim() === 'tag')
  if (sent.length === 0) return
  if (commits.length > MAX_COMMITS) deny(`public-push-guard: ${slug} is public and this push carries ${commits.length} new commits, more than the ${MAX_COMMITS} the hook reads one by one. Push in smaller pieces.`)
  const nearest = boundary.length > 0 ? must(target, ['merge-base', '--independent', ...boundary], 'find the published base').split('\n').filter(Boolean) : []
  // Exemptions come from what is already published, never from a commit in this push.
  const g = await scoped(cache, target, slug, nearest[0] ?? boundary[0])
  // Branch and tag names are public too.
  for (const name of [...names, ...sent.map((x) => x.ref).filter((x) => x !== 'HEAD')]) {
    const hits = g.mod.scanText(name, g.ctx, TEXT_RULES.filter((r) => r !== 'owner-quote'))
    if (hits.length > 0) deny(`public-push-guard refused: a branch or tag name in this push would publish private detail to ${slug}, which is public: name#${createHash('sha1').update(name).digest('hex').slice(0, 8)} [${hits[0].rule}]`)
  }
  // An annotated tag carries a message of its own, and it is public too.
  for (const name of tagNames) {
    const text = must(target, ['for-each-ref', '--format=%(contents)', name], 'read a tag message')
    const hits = g.mod.scanText(text, g.ctx, TEXT_RULES)
    if (hits.length > 0) deny(`public-push-guard refused: this would publish private detail to ${slug}, which is public.\ntag ${name.slice(10, 50)}: message: ${[...new Set(hits.map((h) => `[${h.rule}]`))].join(' ')}`)
  }
  const scan = (base, head, label) => {
    const r = runGuard(target, g, base, head)
    if (r.status === 0) return
    if (r.status === 1 && /privacy-guard:/.test(r.out)) refuse(slug, g, r.out)
    deny(`public-push-guard: ${slug} is public and the privacy guard could not run on ${label} (exit ${r.status}), so this is refused: ${redact(r.out, g)}`)
  }
  // The whole range per tip. Its base is the one published commit nearest the tips; with two
  // unrelated ones the commits are read singly. A commit and its revert leave an empty diff.
  if (nearest.length === 1) {
    const outSet = new Set(commits)
    for (const tip of tips.filter((t) => outSet.has(t))) {
      const d = git(target, ['diff', '--quiet', nearest[0], tip])
      if (d.status === 1) scan(nearest[0], tip, 'the outgoing range')
      else if (!d.ok) deny('public-push-guard: git could not compare the outgoing range, so this call is refused.')
    }
  }
  for (const sha of commits) {
    const parents = must(target, ['rev-list', '--parents', '-n', '1', sha], 'read a commit').trim().split(' ').slice(1)
    const msg = must(target, ['log', '-1', '--format=%B', sha], 'read a commit message')
    const bad = messageHits(g, sha, msg)
    if (bad) deny(`public-push-guard refused: this would publish private detail to ${slug}, which is public.\n${bad}`)
    if (parents.length === 0) deny(`public-push-guard: ${slug} is public and this push carries a root commit (${sha.slice(0, 7)}), which the guard can't diff. Create the repository with its first commit by hand, after reading it.`)
    if (parents.length > 1) {
      // A merge commit: what it adds beyond every parent (a conflict resolution, or content slipped
      // into the merge) is shown by the combined diff. What it brings from a side is read as that side's commits.
      const lines = must(target, ['diff-tree', '--cc', '-p', '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv', sha], 'read a merge commit', { timeout: 30_000 }).split('\n')
      const own = '+'.repeat(parents.length)
      let inHunk = false
      let path = ''
      for (const line of lines) {
        if (line.startsWith('diff --cc ')) {
          inHunk = false
          path = line.slice(10)
          const named = g.mod.scanText(path, g.ctx, TEXT_RULES.filter((r) => r !== 'owner-quote')).filter((h) => !g.mod.pathExempt(path, h.rule, g.ctx.allow))
          if (named.length > 0) deny(`public-push-guard refused: this would publish private detail to ${slug}, which is public.\nmerge ${sha.slice(0, 7)}: a path it adds [${named[0].rule}]`)
        } else if (line.startsWith('@@@')) inHunk = true
        else if (inHunk && line.startsWith(own)) {
          const hits = g.mod.scanText(line.slice(own.length), g.ctx, [...TEXT_RULES, 'email']).filter((h) => !g.mod.pathExempt(path, h.rule, g.ctx.allow))
          if (hits.length > 0) deny(`public-push-guard refused: this would publish private detail to ${slug}, which is public.\nmerge ${sha.slice(0, 7)}: content of its own in path#${createHash('sha1').update(path).digest('hex').slice(0, 8)} [${hits[0].rule}]`)
        }
      }
      continue
    }
    if (must(target, ['diff-tree', '-r', '--name-only', '-z', parents[0], sha], 'read a commit diff') === '') continue // an empty commit: its message was read
    scan(parents[0], sha, `commit ${sha.slice(0, 7)}`)
  }
}

/** Scan text that will be posted to a public repository (a pull request title and body, a comment). */
async function checkText(text, slug, cache, target) {
  const g = await scoped(cache, target, slug, null)
  const hits = g.mod.scanText(text, g.ctx, TEXT_RULES)
  if (hits.length > 0) {
    const rules = [...new Set(hits.map((h) => h.rule))]
    deny(`public-push-guard refused: the text of this command would publish private detail to ${slug}, which is public: ${rules.map((r) => `[${r}]`).join(' ')}. Remove the value, or describe it without naming it. The guard doesn't repeat the value.`)
  }
}

const GH_TEXT_ACTIONS = new Set(['pr create', 'pr new', 'pr edit', 'pr comment', 'pr review', 'pr close', 'issue create', 'issue new', 'issue edit', 'issue comment', 'pr reopen', 'issue reopen', 'issue close', 'release create', 'release edit', 'pr merge', 'repo edit', 'label create', 'label edit'])
const SLUG_RE = /(?:^|[\s"'=:/@])github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/\s"'?#]|$)/g

/** A body file or api field file the call reads. Returns its text, or denies when it can't be read. */
function readBodyFile(word, base, heredoc) {
  if (word.open) deny('public-push-guard: a body file is named through a variable the hook can\'t read, so this call is refused.')
  if (word.text === '-') {
    if (heredoc) return '' // the here-document is part of the command text, which is scanned whole
    deny('public-push-guard: this call reads its text from standard input, which the hook can\'t read, so it is refused. Write the text to a file and use a literal --body-file.')
  }
  try {
    return readFileSync(resolvePath(word.text, base), 'utf8')
  } catch {
    deny(`public-push-guard: the file ${word.text} can't be read, so this call is refused.`)
  }
}

/** The literal subcommand word of a git command, or null when an option or the word itself holds an expansion. */
function gitSubcommand(words) {
  let k = 1
  while (k < words.length && words[k].text.startsWith('-')) {
    if (words[k].open) return null
    k += GIT_ARG_OPTS.has(words[k].text) ? 2 : 1
  }
  const w = words[k]
  return w && !w.open && /^[a-z][a-z-]*$/.test(w.text) ? w.text : null
}

const PUSH_BOOL_FLAGS = new Set(['-f', '--force', '--force-if-includes', '-u', '--set-upstream', '-n', '--dry-run', '-v', '--verbose', '-q', '--quiet', '--no-verify', '--verify', '--porcelain', '--atomic', '--no-atomic', '--prune', '--thin', '--no-thin', '--no-signed', '--no-follow-tags', '--progress', '--no-progress', '-4', '--ipv4', '-6', '--ipv6', '--no-recurse-submodules', '--no-force-with-lease', '--no-force-if-includes'])
const PUSH_ATTACHED = /^--(?:force-with-lease|signed|recurse-submodules|push-option|receive-pack|exec|repo)=/

const GH_WRITE = /\b(?:create|new|edit|comment|review|merge|close|reopen|upload)\b/
// -fbody=x and -Fbody=x carry the value on the flag itself, so nothing may be required after the letter.
const GH_API_WRITE = /(?:-X|--method)[ =]*(?:POST|PATCH|PUT|DELETE)|\s(?:-[fF]|--field|--raw-field|--input)/i

/**
 * Anything that could push or write to GitHub is checked only when it is one plain command the
 * hook has fully read: git or gh as the first word, a literal directory, nothing it has no value
 * for. Anything else is refused: a session can always rephrase, and a false refusal costs little.
 * Returns false when the command holds no git or gh at all (a push word in an echo).
 */
function plain(parsed) {
  // A git command whose subcommand is a plain word other than push (commit, log, ...) can't push, whatever its
  // arguments hold: a commit message from a here-document or a variable is routine. Only when nothing else in
  // the command, a substitution included, mentions git or gh.
  const top = parsed.statements.filter((x) => !x.nested)
  const gitish = (x) => x.words.some((w) => ['git', 'gh'].includes(basename(w.text)))
  if (!parsed.uncertain && top.length === 1 && basename(top[0].words[0].text) === 'git' && gitSubcommand(top[0].words) !== null && gitSubcommand(top[0].words) !== 'push' && parsed.statements.every((x) => x === top[0] || !gitish(x))) return false
  const refuse = (why) => deny(`public-push-guard: this command could push or write to GitHub, and the hook checks only one plain command it can read in full (${why}). Run the push or gh write as one plain command from the target directory, with a literal --body-file.`)
  const sts = parsed.statements
  if (parsed.uncertain) refuse('it holds something the hook can\'t read')
  if (sts.some((x) => x.cwd === null || x.words.some((w) => w.open))) refuse('it uses a variable, a substitution or a directory the hook has no value for')
  if (sts.some((x) => x.words.some((w) => (!w.quoted && /[*?[{]/.test(w.text.replace(/\{(?:owner|repo|branch)\}/g, ''))) || w.text.startsWith('--work-tree') || w.text.startsWith('--config-env')))) refuse('it uses a glob, a brace, --work-tree or --config-env')
  if (!sts.some((x) => x.words.some((w) => ['git', 'gh'].includes(basename(w.text))))) return false
  if (sts.length !== 1) refuse('it has more than one command, a pipe, a loop or a wrapper')
  if (!['git', 'gh'].includes(basename(sts[0].words[0].text))) refuse('git or gh sits behind a wrapper')
  if (Object.keys(sts[0].env).some((k) => !['GIT_DIR', 'GH_REPO'].includes(k))) refuse('it sets an environment variable')
  return true
}

// `cd <existing literal directory> && ` in front is safe: if the cd fails, nothing after it runs.
const CD_PREFIX = /^\s*cd\s+(?:'([^']*)'|"([^"$`\\]*)"|([^\s;&|$`\\"'()*?[\]{}<>]+))\s*&&\s*/

async function main() {
  const raw = readFileSync(0, 'utf8')
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    if (/push|gh/.test(raw)) deny('public-push-guard: could not read the hook input, and it mentions a push or gh, so this call is refused.')
    return
  }
  if ((payload.tool_name ?? 'Bash') !== 'Bash') return
  const command = payload.tool_input?.command
  if (typeof command !== 'string' || command === '') return
  let cwd = payload.cwd || process.cwd()
  const session = String(payload.session_id ?? '')

  // Could this push or write to GitHub anywhere in it? Quotes and backslashes are dropped first.
  const stripped = command.replace(/[\\'"]/g, '')
  const expands = /[$`]/.test(command)
  const pushText = /push/.test(stripped) || (/\bgit\b/.test(stripped) && expands)
  const ghText = /\bgh\b/.test(stripped) && (GH_WRITE.test(stripped) || (/\bapi\b/.test(stripped) && GH_API_WRITE.test(stripped)) || expands)
  if (!pushText && !ghText) return

  let body = command
  const cd = CD_PREFIX.exec(body)
  if (cd) {
    const dir = resolvePath(cd[1] ?? cd[2] ?? cd[3], cwd)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) deny(`public-push-guard: this command starts with a cd to ${dir.slice(0, 80)}, which is not a directory here, so it is refused.`)
    cwd = dir
    body = body.slice(cd[0].length)
  }
  const parsed = readShell(body, { cwd, vars: {} })
  if (!plain(parsed)) return
  const calls = commandsIn(parsed.statements[0])
  if (!calls.some((c) => c.kind === 'push' || c.kind === 'gh')) return

  const cache = cacheDir(session)
  const visited = new Set()
  const heredoc = /<<-?\s*['"]?[A-Za-z0-9_.-]+/.test(command)

  for (const c of calls) {
    if (c.kind !== 'push') continue
    if (c.unresolvedDir) deny('public-push-guard: this push runs in a directory the hook can\'t work out. Write the path out, then try again.')
    const target = { dir: c.dir ?? cwd, gitDir: c.gitDir, cfg: c.cfg }
    const probe = git(target, ['rev-parse', '--git-dir'])
    if (!probe.ok && !/not a git repository|cannot change to|No such file or directory/i.test(probe.stderr)) deny('public-push-guard: git could not open the repository for this push (' + probe.stderr.trim().split('\n')[0].slice(0, 120) + '), so it is refused.')
    if (!probe.ok) continue // not a repository: git itself will refuse
    const flags = { all: false, mirror: false, tags: false, matching: false, configured: [] }
    const positional = []
    let delete_ = false
    const args = c.args
    for (let k = 0; k < args.length; k += 1) {
      const t = args[k].text
      if (t.startsWith('--repo=')) positional.unshift({ text: t.slice(7), open: false })
      else if (t === '--repo') positional.unshift(args[(k += 1)]) // --repo names the remote
      else if (['-o', '--push-option', '--receive-pack', '--exec'].includes(t)) k += 1
      else if (t === '--recurse-submodules') {
        if (['check', 'on-demand', 'only', 'no'].includes(args[k + 1]?.text)) k += 1
      } else if (t === '--all' || t === '--branches') flags.all = true
      else if (t === '--mirror') flags.mirror = true
      else if (t === '--tags' || t === '--follow-tags') flags.tags = true
      else if (t === '--delete' || t === '-d') delete_ = true
      else if (t === 'tag' && positional.length >= 1) positional.push({ text: `refs/tags/${args[(k += 1)]?.text ?? ''}`, open: false })
      else if (PUSH_ATTACHED.test(t) || PUSH_BOOL_FLAGS.has(t)) continue
      else if (t.startsWith('-') && t !== '-') deny(`public-push-guard: this push has an option the hook doesn't know (${t.slice(0, 30)}), so it is refused. Drop it, or run the push without it.`)
      else positional.push(args[k])
    }
    if (delete_) continue // deleting a remote ref publishes nothing
    const branchR = git(target, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = branchR.ok ? branchR.stdout.trim() : ''
    const [remoteSpec, ...specWords] = positional
    const refspecs = specWords.map((w) => w.text)
    // Branch and tag names are public too.
    const names = [...(refspecs.length === 0 ? [branch] : []), ...refspecs.map((x) => x.replace(/^\+/, '').split(':').pop().replace(/^refs\/(?:heads|tags)\//, '')), ...(refspecs.some((x) => x === 'HEAD' || x.startsWith('HEAD:')) ? [branch] : [])].filter(Boolean)
    for (const remote of remotesFor(target, remoteSpec, branch)) {
      const { slugs, unknown } = publicSlugs(remote, cache)
      if (slugs.length === 0 && unknown) deny(`public-push-guard: could not tell whether the remote "${remote.name}" is on GitHub, so this push is refused.`)
      if (slugs.length === 0) continue
      const cfgPush = git(target, ['config', '--get-all', `remote.${remote.name}.push`])
      flags.configured = cfgPush.ok ? cfgPush.stdout.split('\n').filter(Boolean) : []
      const pd = git(target, ['config', '--get', 'push.default'])
      flags.matching = pd.ok && pd.stdout.trim() === 'matching'
      // push.default only applies when nothing else names the refs: --all, --mirror, --tags and a configured push still send.
      if (pd.ok && pd.stdout.trim() === 'nothing' && refspecs.length === 0 && !flags.all && !flags.mirror && !flags.tags && flags.configured.length === 0) continue
      for (const slug of slugs) {
        if (visibilityOf(slug, cache) === 'PRIVATE') continue
        const { refs, unresolved } = refsToSend(target, flags, refspecs)
        if (refs.length === 0 && unresolved.length > 0 && refspecs.length > 0) {
          deny(`public-push-guard: ${slug} is public and the ref ${unresolved[0].slice(0, 60)} doesn't resolve here, so there is nothing the hook can read. Check the name, then try again.`)
        }
        const key = `${slug}|${refs.map((x) => x.sha).join(',')}|${names.join(',')}`
        if (visited.has(key)) continue
        visited.add(key)
        await checkPush(target, remote, refs, slug, cache, names)
      }
    }
  }

  for (const c of calls) {
    if (c.kind !== 'gh') continue
    const [a, b] = ghAction(c.args)
    const action = `${a ?? ''} ${b ?? ''}`.trim()
    const isApi = a === 'api'
    const method = flagValue(c.args, ['-X', '--method'])?.text ?? ''
    const hasFields = c.args.some((w) => /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(w.text) || /^-[fF]./.test(w.text))
    // -X GET with fields sends them as a query string: a read.
    const writesApi = isApi && !/^GET$/i.test(method) && (/^(?:POST|PATCH|PUT|DELETE)$/i.test(method) || hasFields)
    const visibilityWord = flagValue(c.args, ['--visibility'])?.text
    const apiFieldText = c.args.map((w) => w.text).join(' ')
    const isVisibility =
      (a === 'repo' && b === 'edit' && visibilityWord === 'public') ||
      (a === 'repo' && b === 'create' && c.args.some((w) => w.text === '--public')) ||
      (writesApi && /(?:visibility=public|private=false)\b|"visibility"\s*:\s*"public"/.test(apiFieldText))
    const inputWord = isApi ? flagValue(c.args, ['--input']) : undefined
    let inputText = null // null: not read (standard input, a file that isn't there)
    if (inputWord && inputWord.text !== '-') {
      try {
        inputText = readFileSync(resolvePath(inputWord.text, c.dir ?? cwd), 'utf8')
      } catch {
        inputText = null
      }
    }
    if (isVisibility || /"visibility"\s*:\s*"public"|"private"\s*:\s*false/.test(inputText ?? '')) deny('public-push-guard: this would make a repository public. The rule is that no repository goes from private to public. The owner does that by hand, never a session.')
    // A graphql call is a read only when its query is a literal -f field with no mutation in it. A query read from a file (-F query=@file, --input) is a write.
    const isGraphqlRead = isApi && c.args.some((w) => w.text === 'graphql') && c.args.every((w) => !/^(?:--input|-F|--field)/.test(w.text)) && !/mutation/i.test(apiFieldText)
    const writesText = GH_TEXT_ACTIONS.has(action) || (writesApi && !isGraphqlRead)
    const creates = action === 'pr create' || action === 'pr new'
    if (!writesText && !creates) continue
    const target = { dir: c.dir ?? cwd }

    // The repositories it could reach: the working directory's GitHub remotes, plus --repo, GH_REPO,
    // every github.com URL in the arguments and the endpoint of a gh api call. A URL inside a body
    // adds a repository to check; it never replaces the working directory's.
    const hard = new Set()
    const soft = new Set() // from a URL: may not be a repository at all (orgs, user-attachments)
    const repoFlag = flagValue(c.args, ['--repo', '-R'])
    const clean = (x) => x.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '')
    if (repoFlag) hard.add(clean(repoFlag.text))
    const envRepo = c.env?.GH_REPO ?? process.env.GH_REPO
    if (envRepo && !repoFlag) hard.add(clean(envRepo))
    for (const w of c.args) for (const m of w.text.matchAll(SLUG_RE)) soft.add(`${m[1]}/${m[2]}`)
    if (a === 'repo' && b) for (const w of c.args) if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(w.text)) hard.add(w.text)
    if (isApi) {
      const endpoint = c.args.find((w) => /^(?:https:\/\/api\.github\.com)?\/?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(w.text))
      const m = endpoint && /repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(endpoint.text)
      if (m) hard.add(`${m[1]}/${m[2]}`)
    }
    const isRepo = git(target, ['rev-parse', '--git-dir']).ok
    const fromDir = new Set()
    if (isRepo) {
      for (const name of must(target, ['remote'], 'list the remotes').split('\n').filter(Boolean)) {
        for (const r of remotesFor(target, { text: name, open: false }, '')) publicSlugs(r, cache).slugs.forEach((x) => fromDir.add(x))
      }
    }
    let slugs = [...new Set([...hard, ...fromDir, ...soft])]
    // A write that names no repository (graphql, orgs/..., from a directory that isn't a repository): read as public.
    if (fromDir.size === 0 && hard.size === 0 && writesApi && !isGraphqlRead) slugs = ['(unattributed gh api write)', ...soft]
    for (const slug of slugs) {
      if (!slug.startsWith('(')) {
        let vis
        try {
          vis = visibilityOf(slug, cache)
        } catch (e) {
          if (soft.has(slug) && !hard.has(slug) && !fromDir.has(slug)) continue // a URL that isn't a repository
          throw e
        }
        if (vis === 'PRIVATE') continue
      }
      if (writesText) {
        await checkText(command, slug, cache, target)
        if (inputWord && inputText === null) deny(`public-push-guard: this gh api call reads its body from ${inputWord.text === '-' ? 'standard input' : `${inputWord.text}, which the hook can't read here`}, and ${slug} is public, so it is refused. Write the body to a file first, in an earlier call.`)
        if (inputText) await checkText(inputText, slug, cache, target)
        const fileFlags = isApi ? [] : ['--body-file', '-F', '--notes-file']
        for (const flag of fileFlags) {
          const v = flagValue(c.args, [flag])
          if (v) await checkText(readBodyFile(v, target.dir, heredoc), slug, cache, target)
        }
        if (isApi) {
          // -F / --field read a value that starts with @ as a file; -f / --raw-field never do
          for (let k = 0; k < c.args.length; k += 1) {
            const t = c.args[k].text
            const val = t === '-F' || t === '--field' ? c.args[k + 1] : /^-F./.test(t) ? { text: t.slice(2), open: c.args[k].open } : t.startsWith('--field=') ? { text: t.slice(8), open: c.args[k].open } : null
            const m = val && /^[^=\s]+=@(.+)$/.exec(val.text)
            if (m) await checkText(readBodyFile({ text: m[1], open: val.open }, target.dir, false), slug, cache, target)
          }
        }
      }
      if (creates) {
        // gh pr create can push the branch itself: read what HEAD would send
        const branchR = git(target, ['rev-parse', '--abbrev-ref', 'HEAD'])
        for (const remote of remotesFor(target, null, branchR.ok ? branchR.stdout.trim() : '')) {
          if (!publicSlugs(remote, cache).slugs.includes(slug)) continue
          const { refs } = refsToSend(target, { all: false, mirror: false, tags: false, matching: false, configured: [] }, [])
          await checkPush(target, remote, refs, slug, cache, [branchR.stdout.trim()])
        }
      }
    }
  }
}

try {
  await main()
} catch (e) {
  const reason = e instanceof Deny ? e.message : `public-push-guard: failed unexpectedly (${String(e?.message ?? e).split('\n')[0]}), so this call is refused.`
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`)
}
process.exit(0)
