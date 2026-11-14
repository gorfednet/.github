/**
 * The fleet-status row "Installed tools behind main" (13 November 2026 incidents, ship-bot/INCIDENTS.md).
 *
 * Every tool this Mac runs must come from a detached worktree that ship-bot advances after each merge
 * (`.claude/worktrees/gates-main` in .github, `.claude/worktrees/tools-main` in ops), or be a copy of a
 * committed file. Three kinds are read:
 *
 *   - links: symlinks in ~/.local/bin and ~/.config/herdr-core that point under the clone root;
 *   - LaunchAgents: net.gorfed.*.plist program arguments under the clone root;
 *   - copies: the files `COPIES` names (hooks, the capacity app, ship-bot's install), matched by content
 *     against every committed version of their source on origin/main.
 *
 * A link or agent is flagged when it resolves into a working checkout instead of a tool worktree, or when
 * its worktree's HEAD is behind origin/main. A copy is flagged when it differs from origin/main: the
 * entry says how many commits to its source it is behind, or that it matches no committed version.
 *
 * Refs come from the fetch the clones-behind row already ran. `fetched: false` (no fetch, or a failed
 * one in a repository a tool comes from) means the result is not a measurement, and the row is null.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Worktree names ship-bot advances (ship-bot/lib/gates-worktree.mjs TOOL_WORKTREES). */
export const TOOL_WORKTREE_NAMES = ['gates-main', 'tools-main']

/** Installed copies of committed files: where the copy lives (under home) and its source (clone dir, path). */
export const COPIES = [
  { tool: 'gh-poll-guard hook', copy: '.claude/hooks/gh-poll-guard.py', clone: 'gorfednet.github', source: 'docs/claude-home/hooks/gh-poll-guard.py' },
  { tool: 'capacity check', copy: '.desk/capacity-app/capacity.mjs', clone: 'gorfednet.github', source: 'capacity/capacity.mjs' },
  { tool: 'capacity heartbeat helper', copy: '.desk/capacity-app/lib/heartbeat.mjs', clone: 'gorfednet.github', source: 'ship-bot/lib/heartbeat.mjs' },
  { tool: 'capacity usage helper', copy: '.desk/capacity-app/lib/usageAlert.mjs', clone: 'gorfednet.github', source: 'scripts/lib/usageAlert.mjs' },
  { tool: 'ship-bot', copyDir: '.ship-bot/app', clone: 'gorfednet.github', sourceDir: 'ship-bot', skip: ['gate-scripts', 'node_modules'] },
]

const LINK_DIRS = ['.local/bin', '.config/herdr-core', '.config/herdr-core/templates']

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (dir, ...args) => {
  try {
    return git(dir, ...args)
  } catch {
    return null
  }
}
const inside = (p, root) => p === root || p.startsWith(root + sep)

/** Program paths a LaunchAgent runs (every argument that is an absolute path to a file). */
function plistPaths(file) {
  try {
    const json = execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(json).filter((a) => typeof a === 'string' && a.startsWith('/'))
  } catch (e) {
    if (e.code !== 'ENOENT') return null
  }
  // No plutil (Linux CI): read the XML plist directly.
  try {
    const arr = readFileSync(file, 'utf8').match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
    if (!arr) return null
    return [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).filter((a) => a.startsWith('/'))
  } catch {
    return null
  }
}

/** Links and agents into the clone root: [{tool, target}], plus anything unreadable. */
export function linkedTools(home, root, { launchAgents = join(home, 'Library', 'LaunchAgents') } = {}) {
  const out = []
  const unread = []
  for (const d of LINK_DIRS) {
    const dir = join(home, d)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (!lstatSync(p).isSymbolicLink()) continue
        const target = resolve(dir, readlinkSync(p))
        if (inside(target, root)) out.push({ tool: `~/${d}/${name}`, target })
      } catch {
        unread.push(`~/${d}/${name}`)
      }
    }
  }
  if (existsSync(launchAgents)) {
    for (const name of readdirSync(launchAgents).filter((n) => /^net\.gorfed\..*\.plist$/.test(n))) {
      const paths = plistPaths(join(launchAgents, name))
      if (paths === null) {
        unread.push(`LaunchAgent ${name}`)
        continue
      }
      for (const target of paths.filter((t) => inside(t, root))) out.push({ tool: `LaunchAgent ${name.replace(/\.plist$/, '')}`, target })
    }
  }
  return { out, unread }
}

/**
 * net.gorfed.* LaunchAgents whose program (first argument) resolves under a dot-folder of home, such as
 * ~/.hermes/node/bin/node. Read-only; the app paths (~/.ship-bot/app, ~/.desk/...) are later arguments, never the program.
 */
/** ProgramArguments[0] of a plist: plutil on macOS, else the XML itself (Linux CI has no plutil). Throws when absent. */
export function firstProgramArgument(file) {
  try {
    return execFileSync('plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const m = readFileSync(file, 'utf8').match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)
  if (!m) throw new Error(`no ProgramArguments in ${file}`)
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export function privateInterpreters(home, launchAgents) {
  const out = []
  if (!existsSync(launchAgents)) return out
  const homeReal = existsSync(home) ? realpathSync(home) : home
  for (const name of readdirSync(launchAgents).filter((n) => /^net\.gorfed\..*\.plist$/.test(n))) {
    const agent = name.replace(/\.plist$/, '')
    let program
    try {
      program = firstProgramArgument(join(launchAgents, name))
    } catch {
      continue // no ProgramArguments (a Program key), or unreadable: nothing to say about an interpreter
    }
    if (!program.startsWith('/')) continue
    let real
    try {
      real = realpathSync(program)
    } catch {
      out.push({ agent, program, real: program, missing: true }) // a dangling program: the agent can't start
      continue
    }
    const rel = relative(homeReal, real)
    if (!rel.startsWith('..') && !rel.startsWith(sep) && /^\.[^/]+\//.test(rel.split(sep).join('/'))) out.push({ agent, program, real })
  }
  return out
}

/** The checkout a path lives in, and whether it is a ship-bot-advanced tool worktree. */
function checkoutOf(target) {
  let dir = target
  try {
    dir = statSync(target).isDirectory() ? target : dirname(target)
  } catch {
    return null
  }
  const top = tryGit(dir, 'rev-parse', '--show-toplevel')
  if (!top) return null
  const real = realpathSync(top)
  const name = real.split(sep).at(-1)
  const tool = TOOL_WORKTREE_NAMES.includes(name) && real.split(sep).at(-2) === 'worktrees' && real.split(sep).at(-3) === '.claude'
  return { top: real, tool }
}

/** How many commits on origin/main touched `path` since the newest committed version whose blob is `blob`; null when none matches. */
function behindForBlob(clone, path, blob) {
  const log = tryGit(clone, 'log', '--format=%H', 'origin/main', '--', path)
  if (log === null) return { unread: true }
  for (const c of log.split('\n').filter(Boolean)) {
    if (tryGit(clone, 'rev-parse', '--verify', '--quiet', `${c}:${path}`) === blob) {
      return { behind: Number(git(clone, 'rev-list', '--count', `${c}..origin/main`, '--', path)) }
    }
  }
  return { behind: null }
}

function filesUnder(dir, skip) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const rel = relative(dir, p)
      if (skip.includes(rel.split(sep)[0])) continue
      if (lstatSync(p).isDirectory()) walk(p)
      else out.push(rel)
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * @returns {{ behind: {tool: string, source: string, behind: number|null, detail: string}[], checked: number, unread: string[], repos: string[] }}
 *   `repos`: the clones the tools come from (the caller checks each was fetched).
 */
export function installedTools({ home = homedir(), root, launchAgents } = {}) {
  const behind = []
  const unread = []
  const repos = new Set()
  let checked = 0
  const rootReal = existsSync(root) ? realpathSync(root) : root

  // Links and agents, grouped by the checkout they resolve into.
  const links = linkedTools(home, root, { launchAgents })
  unread.push(...links.unread)
  const byTop = new Map()
  for (const l of links.out) {
    const co = checkoutOf(l.target)
    checked++
    if (!co) {
      behind.push({ tool: l.tool, source: l.target, behind: null, detail: 'points at a path that is missing or not in a git checkout' })
      continue
    }
    if (!byTop.has(co.top)) byTop.set(co.top, { ...co, tools: [] })
    byTop.get(co.top).tools.push(l.tool)
  }
  for (const co of byTop.values()) {
    const main = tryGit(co.top, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')
    const common = tryGit(co.top, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if (common) repos.add(dirname(common))
    const tools = co.tools.join(', ')
    const where = relative(rootReal, co.top) || co.top
    if (!main) {
      unread.push(where)
      continue
    }
    const count = tryGit(co.top, 'rev-list', '--count', 'HEAD..origin/main')
    const n = count === null ? NaN : Number(count)
    if (!Number.isFinite(n)) {
      unread.push(where) // a failed count is not 0
      continue
    }
    if (!co.tool) {
      behind.push({ tool: tools, source: where, behind: n, detail: 'runs from a working checkout, not a ship-bot-advanced tools worktree' })
      continue
    }
    const onBranch = tryGit(co.top, 'symbolic-ref', '-q', 'HEAD')
    const dirty = tryGit(co.top, 'status', '--porcelain', '--untracked-files=no')
    const atMain = tryGit(co.top, 'rev-parse', 'HEAD') === main
    if (dirty === null) unread.push(where)
    else if (onBranch || dirty !== '' || !atMain) {
      const why = [onBranch ? `on branch ${onBranch.replace('refs/heads/', '')}` : '', dirty ? 'tracked files changed' : '', !atMain ? (n > 0 ? 'behind origin/main' : 'not at origin/main') : ''].filter(Boolean).join(', ')
      behind.push({ tool: tools, source: where, behind: n, detail: `tools worktree ${why}` })
    }
  }

  // Interpreters inside another tool's private folder (14 November 2026: ship-bot and capacity ran on
  // Hermes's Node through a symlink; archiving Hermes would have stopped the only merger).
  for (const p of privateInterpreters(home, launchAgents ?? join(home, 'Library', 'LaunchAgents'))) {
    checked++
    if (p.missing) behind.push({ tool: `LaunchAgent ${p.agent}`, source: p.program, behind: null, detail: `runs ${p.program}, which does not exist` })
    else behind.push({ tool: `LaunchAgent ${p.agent}`, source: p.program, behind: null, detail: `runs ${p.real}, inside another tool's private folder` })
  }

  // Copies of committed files.
  for (const c of COPIES) {
    const clone = join(root, c.clone)
    if (!existsSync(clone)) {
      unread.push(c.clone)
      continue
    }
    repos.add(clone)
    if (c.copy) {
      const file = join(home, c.copy)
      if (!existsSync(file)) continue // not installed on this Mac
      checked++
      const blob = tryGit(clone, 'hash-object', '--', file)
      const head = tryGit(clone, 'rev-parse', '--verify', '--quiet', `origin/main:${c.source}`)
      if (!blob || !head) {
        unread.push(`~/${c.copy}`)
        continue
      }
      if (blob === head) continue
      const r = behindForBlob(clone, c.source, blob)
      if (r.unread) unread.push(`~/${c.copy}`)
      else behind.push({ tool: c.tool, source: `~/${c.copy}`, behind: r.behind, detail: r.behind === null ? `matches no committed version of ${c.clone}/${c.source}` : `copy of ${c.clone}/${c.source}` })
      continue
    }
    const dir = join(home, c.copyDir)
    if (!existsSync(dir)) continue
    checked++
    let stale = 0
    let unknown = 0
    let worst = 0
    for (const rel of filesUnder(dir, c.skip)) {
      const src = `${c.sourceDir}/${rel.split(sep).join('/')}`
      const blob = tryGit(clone, 'hash-object', '--', join(dir, rel))
      const head = tryGit(clone, 'rev-parse', '--verify', '--quiet', `origin/main:${src}`)
      if (blob && head && blob === head) continue
      if (!head) {
        unknown++ // removed from main, or never committed
        continue
      }
      const r = behindForBlob(clone, src, blob)
      if (r.behind === null || r.unread) unknown++
      else {
        stale++
        worst = Math.max(worst, r.behind)
      }
    }
    if (stale + unknown > 0) {
      const parts = [stale ? `${stale} files behind` : '', unknown ? `${unknown} files match no version on main` : ''].filter(Boolean)
      behind.push({ tool: c.tool, source: `~/${c.copyDir}`, behind: stale ? worst : null, detail: `copy of ${c.clone}/${c.sourceDir}: ${parts.join(', ')}` })
    }
  }
  return { behind, checked, unread, repos: [...repos] }
}

/** The renderer's text for one entry. */
export const showInstalled = (t) => `${t.tool} (${t.source}: ${t.behind === null ? '' : `${t.behind} behind, `}${t.detail})`
