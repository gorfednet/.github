#!/usr/bin/env node
/**
 * Git pre-push hook: refuse a push that would publish private detail to a PUBLIC repository
 * (plan row 1.30g; replaces the shell-text parser of .github 216).
 *
 * Git hands the hook the remote name, its URL and one line per ref it is about to send:
 * `<local ref> <local sha> <remote ref> <remote sha>`. Whatever the shell spelling of the
 * push, those lines are what goes out, so nothing here reads a command.
 *
 * - A repository on the local private list passes untouched, and so does a remote that is a path on
 *   this machine. Any other remote counts as public. For a gorfednet repository not on the list, gh is
 *   asked for the list once more first (a repository made since the list was cut); other owners are
 *   never looked up.
 * - The list is a local file (private-repos.txt, one owner/name per line), refreshed from gh
 *   at install, at most once a day by the first push after it goes stale (a failure is ignored), and
 *   by that one extra ask. gh is only ever asked for the whole list, never about one repository.
 * - The target's allowlist is read from the remote's default branch tip, as the remote reports it now,
 *   never from the push boundary, the working tree or any commit the pusher sent: a change can't clear
 *   itself (one new `site` line counts for its own push), and a branch cut before an exemption landed still sees it.
 * - Outgoing commits are those reachable from the sent shas and not from anything the remote
 *   holds now (`git ls-remote`, not tracking refs, which go stale). scripts/privacy-guard.mjs
 *   reads them (messages, every commit's diff, the net diff). Ref names, and an annotated tag's
 *   own name, tagger line and message, are read here.
 * - It fails closed once the remote is public: any error ends in a refusal (exit 1).
 *
 * Installed by install-git-hooks.sh into ~/.claude/git-hooks, with privacy-guard.mjs beside it.
 * `git push --no-verify` skips every git hook; the deny entry for it lives in ops control/claude-home.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIST = process.env.PUBLIC_PUSH_GUARD_LIST || join(HERE, 'private-repos.txt')
const GUARD = process.env.PUBLIC_PUSH_GUARD_SCRIPT || join(HERE, 'privacy-guard.mjs')
// The fleet's plan of record, copied in by install-git-hooks.sh: its public sites count as said in every repository.
const FLEET = process.env.PUBLIC_PUSH_GUARD_FLEET || join(HERE, 'fleet.json')
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const ZERO = /^0+$/
const NAME_RULES = ['private-ip', 'session-id', 'tailnet-name', 'internal-host', 'private-repo']
const TAGGER_RULES = ['private-ip', 'session-id', 'tailnet-name', 'internal-host']

class Refuse extends Error {}
const refuse = (message) => {
  throw new Refuse(message)
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 40_000, ...opts })
export const git = (args, opts) => run('git', ['-c', 'core.quotepath=false', ...args], opts)
/** A git call that must work: a failure reads as "can't tell", never as "nothing there". */
const must = (args, what) => {
  const r = git(args)
  if (r.status !== 0) refuse(`git could not ${what}.`)
  return r.stdout
}

// The host is matched whole, straight after the scheme and any userinfo (or at the start of an scp-style URL).
// Userinfo holds no `?`, `#` or backslash: an https URL with a `#` before the at sign has its host before the `#`, and the rest is a fragment.
const GITHUB_URL = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#\\\s]+@)?(?:ssh\.)?github\.com(?::\d+)?\/+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
const GITHUB_SCP = /^(?:[^@/:\s]+@)?(?:ssh\.)?github\.com:\/*([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

/**
 * owner/name from a GitHub URL, lowercase; null for anything else: ssh://, https:// (with userinfo or a port) or
 * scp-style on github.com. A github.com that only appears inside another host's name or in a path is not GitHub.
 */
export const slugOf = (url) => {
  const u = String(url ?? '').trim()
  const m = GITHUB_URL.exec(u) ?? GITHUB_SCP.exec(u)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

/** Refresh the private list from gh. False when gh can't answer or the write fails; the list on disk then stands. */
export function refresh() {
  try {
    const r = run('gh', ['repo', 'list', 'gorfednet', '--visibility', 'private', '--limit', '1000', '--json', 'nameWithOwner', '--jq', '.[].nameWithOwner'], { timeout: 20_000 })
    if (r.status !== 0 || !r.stdout.trim()) return false
    const tmp = `${LIST}.${process.pid}.tmp`
    writeFileSync(tmp, r.stdout.toLowerCase(), { mode: 0o600 })
    renameSync(tmp, LIST)
    return true
  } catch {
    return false
  }
}

/** The private repositories, as owner/name. A missing list is an error, never an empty one. */
export function privateList() {
  if (existsSync(LIST) && Date.now() - statSync(LIST).mtimeMs > REFRESH_AFTER_MS && !refresh()) {
    // The one place a push may call gh, at most once a day. If gh can't answer, the list stands and the next try is in an hour.
    try {
      const retry = new Date(Date.now() - REFRESH_AFTER_MS + 60 * 60 * 1000)
      utimesSync(LIST, retry, retry)
    } catch {
      // a list we can't touch is still a list
    }
  }
  if (!existsSync(LIST)) refuse(`the private repository list (${LIST}) is missing, so this push can't be classified. Run install-git-hooks.sh.`)
  const lines = readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'))
  if (lines.length === 0) refuse(`the private repository list (${LIST}) is empty, so this push can't be classified. Run install-git-hooks.sh.`)
  return new Set(lines)
}

/** A remote that is a path on this machine (or file://), not a host: nothing is published by pushing to it. */
export const isLocalPath = (url) => /^(?:\/|\.\.?\/|file:\/\/)/.test(String(url ?? ''))

/**
 * The slug a push goes to. An insteadOf rewrite hides it from the URL git passes, so a configured URL
 * counts only when its rewritten form is the very URL this push goes to (git runs the hook once per push URL).
 */
export function remoteSlug(name, url, cwd) {
  // A path on this machine is never a GitHub repository, even when it ends in github.com/<owner>/<name>.git.
  const slugOfRemote = (u) => (isLocalPath(u) ? null : slugOf(u))
  const direct = slugOfRemote(url)
  if (direct) return direct
  const configured = ['url', 'pushurl'].flatMap((k) => git(['config', '--get-all', `remote.${name}.${k}`], { cwd }).stdout.split('\n')).filter(Boolean)
  if (!url) return slugOfRemote(configured[0]) // no push in hand (the gh text hook): the remote's own URL
  const same = configured.find((raw) => raw === url || git(['ls-remote', '--get-url', raw], { cwd }).stdout.trim() === url)
  return same ? slugOfRemote(same) : null
}

const ALLOW_PATH = '.github/privacy-guard-allow.txt'

/**
 * The target repository's allowlist as the remote's default branch holds it right now. That commit is
 * fetched, when this clone lacks it, while the remote is asked what it holds. A change in the push can't clear itself, and a stale clone still sees
 * an exemption main gained since. Nothing readable (no HEAD, no file, a failed fetch) is no exemptions.
 */
export function allowTextAtRemote(headSha) {
  if (!headSha) return ''
  const r = git(['show', `${headSha}:${ALLOW_PATH}`])
  return r.status === 0 ? r.stdout : ''
}

/** privacy-guard's own functions, plus the scanning context for names and messages. A name the allowlist's `repo` lines clear is not scanned for. */
export async function loadGuard(list, allowText = '', head = '') {
  if (!existsSync(GUARD)) refuse(`${GUARD} is missing, so the guard can't run.`)
  const mod = await import(pathToFileURL(GUARD).href)
  const names = [...list].map((s) => s.split('/').pop()).join(',')
  const allow = mod.parseAllowlist(allowText)
  // No installed fleet.json (an older install) adds no sites; a broken one stops the push rather than reading as none.
  if (existsSync(FLEET)) {
    try {
      allow.sites.push(...mod.fleetSites(readFileSync(FLEET, 'utf8')).filter((x) => !allow.sites.includes(x)))
    } catch (error) {
      refuse(`${FLEET} can't be read (${error.message}), so the fleet's public sites are unknown. Reinstall the hooks with install-git-hooks.sh.`)
    }
  }
  const open = mod.parsePrivateRepos(names).filter((n) => !allow.repos.includes(n))
  // As privacy-guard reads a bare name: watched while the remote's default branch has never said it, and on a line that says private once it has.
  // Without that commit here nothing counts as said, which watches every name.
  const known = /^[0-9a-f]{40,64}$/.test(head) && git(['cat-file', '-e', `${head}^{commit}`]).status === 0
  const unsaid = open.filter((n) => !known || (!allow.sites.includes(n.toLowerCase()) && !mod.namedAtBase('.', head, n)))
  const said = open.filter((n) => !unsaid.includes(n))
  const ctx = { privateRepo: mod.privateRepoPattern(open), bareNames: mod.bareNamePatterns(unsaid), saidNames: mod.bareNamePatterns(said).word, allow }
  return { mod, ctx, names }
}

/** What the remote holds right now, asked of the remote itself (a tracking ref goes stale, or points at another repository after a set-url): the commits this clone has, and the default branch tip. */
function remoteState(url, updates) {
  const r = git(['ls-remote', url], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000 })
  if (r.status !== 0) refuse('git could not read what the remote already holds (git ls-remote failed), so the outgoing commits can\'t be told from published ones. Check the network and credentials, then push again.')
  const lines = r.stdout.split('\n').map((l) => l.split(/\s/))
  const head = lines.find((l) => l[1] === 'HEAD')?.[0] ?? ''
  // The default branch tip is fetched when this clone lacks it (the clone is behind): its history is what a branch cut earlier is measured against, and its allowlist is read.
  if (/^[0-9a-f]{40,64}$/.test(head) && git(['cat-file', '-e', `${head}^{commit}`]).status !== 0) git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', url, head], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 })
  const shas = [...lines.map((l) => l[0]), ...updates.map((u) => u.rsha)]
  const holds = [...new Set(shas)].filter((s) => /^[0-9a-f]{40,64}$/.test(s) && !ZERO.test(s) && git(['cat-file', '-e', `${s}^{commit}`]).status === 0)
  return { holds, head }
}

/** Sent refs to the commits the remote lacks, per tip, with the published commit nearest them. */
function outgoing(holds, updates) {
  const rest = ['--not', ...holds]
  const out = []
  for (const tip of new Set(updates.map((u) => must(['rev-parse', '--verify', `${u.sha}^{commit}`], 'resolve a sent ref').trim()))) {
    const commits = must(['rev-list', tip, ...rest], 'list the outgoing commits').split('\n').filter(Boolean)
    if (commits.length === 0) continue
    const bounds = must(['rev-list', '--boundary', tip, ...rest], 'list the published boundary').split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1))
    if (bounds.length === 0) refuse(`${tip.slice(0, 7)} has no published ancestor on the remote to diff against (a root commit, or none of its history is here). Create the repository with its first commit by hand.`)
    const independent = must(['merge-base', '--independent', ...bounds], 'find the published base').split('\n').filter(Boolean)
    // Several published bases: one commit that has them all as parents, so none of their history is read again.
    const base = independent.length === 1 ? independent[0] : must(['-c', 'user.name=guard', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false', 'commit-tree', `${independent[0]}^{tree}`, ...independent.flatMap((b) => ['-p', b]), '-m', 'bases'], 'join the published bases').trim()
    out.push({ tip, base, count: commits.length })
  }
  return out
}

export async function checkPush(remote, url, updates) {
  const slug = remoteSlug(remote, url)
  if (!slug && isLocalPath(url)) return // a path on this machine publishes nothing, whatever the list holds
  let list = privateList()
  if (slug && list.has(slug)) return // private: never refused
  if (slug && slug.startsWith('gorfednet/') && refresh()) {
    // A repository made since the list was cut (`gh repo create --private --push`) is not on it yet: ask once before calling it public.
    list = privateList()
    if (list.has(slug)) return
  }
  const { holds, head } = remoteState(url, updates)
  const sets = outgoing(holds, updates)
  const allowText = allowTextAtRemote(head)
  const { mod, ctx, names } = await loadGuard(list, allowText, head)
  const scratch = mkdtempSync(join(tmpdir(), 'ppg-'))
  try {
    await scan({ sets, mod, ctx, names, where: slug ?? url, updates, allowText, scratch })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const HELD = '\u0001' // stands in for a dotted private name's own dots while every other dot is read as a slash (scanText drops NUL, not this)

/**
 * Which readings find a private repository name in a ref or tag name: [] when none does.
 *   path  path parts with any extension (`notes/<name>.bak`); a dotted name is read whole
 *   word  words, which also split on `_`, `@`, `+`, `=` and `,` (`notes/<name>_v2`); a said name counts beside `private`
 *   dots  words again, with every dot read as a slash except a dotted private name's own (`v2.<name>`, `<site>.migration`,
 *         `v2.<name>_x`, `private.<name>`), since the other two take a dot join for a host
 * A hyphen joins a longer name in every reading, as in the CI guard, so `<name>-v2` is not the name.
 */
export function nameReadings(mod, ctx, names, text) {
  const dotted = String(names).split(',').filter((n) => n.includes('.')).sort((a, b) => b.length - a.length)
  let held = text
  for (const n of dotted) held = held.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => m.replaceAll('.', HELD))
  const split = held.replace(/\./g, '/').replaceAll(HELD, '.')
  const out = []
  if (mod.scanText(text, ctx, NAME_RULES, 'path').length > 0) out.push('path')
  if (mod.scanText(text, ctx, NAME_RULES, 'word').length > 0) out.push('word')
  if (mod.scanText(split, ctx, NAME_RULES, 'word').length > 0) out.push('dots')
  return out
}

async function scan({ sets, mod, ctx, names, where, updates, allowText, scratch }) {
  const allowFile = join(scratch, 'allow.txt')
  writeFileSync(allowFile, allowText)
  // Always handed over: without --fleet the guard reads fleet.json from the pushed repository's own base. No installed copy is an empty file (no sites).
  const fleetFile = existsSync(FLEET) ? FLEET : join(scratch, 'fleet.json')
  if (fleetFile !== FLEET) writeFileSync(fleetFile, '')
  const fail = (what) => refuse(`${what} would publish private detail to ${where}, which is public (or not known to be private).\nNothing was sent.`)
  const nameHolds = (text) => nameReadings(mod, ctx, names, text).length > 0
  for (const u of updates) {
    // Branch and tag names are public too, and so is an annotated tag's message.
    if (nameHolds(u.rref)) fail('a branch or tag name in this push')
    // Read the objects being sent, not the local ref: a push of `<sha>:refs/tags/v1` has no local ref name. A tag can point at a tag.
    let obj = u.sha
    let depth = 0
    // A failed type read is "can't tell", never "not a tag": it would end the chain unread.
    for (; must(['cat-file', '-t', obj], 'read the type of a sent object').trim() === 'tag'; depth += 1) {
      if (depth === 20) refuse('a chain of more than 20 tags can\'t be read to its end.')
      const [header, ...message] = must(['cat-file', 'tag', obj], 'read a tag').split('\n\n')
      const shown = u.rref.replace(/^refs\/tags\//, '').slice(0, 40)
      // The tag object carries its own name, which a push under another ref name (`<tag>:refs/tags/v1`) still publishes.
      const own = /^tag (.*)$/m.exec(header)?.[1] ?? refuse('a tag object has no name line, so it can\'t be read.')
      if (nameHolds(own)) fail(`the name inside tag ${shown}`)
      // The tagger line is published too. A default identity is built from the machine's host name. Private repository names are not
      // read here: the owner's own address is at a domain that is one.
      if (mod.scanText(/^tagger (.*)$/m.exec(header)?.[1] ?? '', ctx, TAGGER_RULES).length > 0) fail(`the tagger line of tag ${shown}`)
      if (mod.scanText(message.join('\n\n'), ctx, [...NAME_RULES, 'owner-quote'], 'word').length > 0) fail(`the message of tag ${shown}`)
      obj = /^object (\S+)/.exec(header)?.[1] ?? refuse('a tag object has no target, so it can\'t be read.')
    }
  }
  for (const { tip, base, count } of sets) {
    const r = run(process.execPath, [realpathSync(GUARD), '--base', base, '--head', tip, '--dir', '.', '--allow', allowFile, '--fleet', fleetFile], { timeout: 300_000, env: { ...process.env, PRIVATE_REPOS: names, GITHUB_ACTIONS: '' } })
    const out = `${r.stdout}${r.stderr}`.trim()
    if (r.status === 0 && /^privacy-guard: OK/m.test(out)) continue
    refuse(`${count} outgoing commit${count === 1 ? '' : 's'} to ${where}, which is public (or not known to be private), would publish private detail (guard exit ${r.status}).\n${out}\nNothing was sent.`)
  }
}

async function main(argv) {
  if (argv[0] === '--refresh') return refresh() ? 0 : 1
  const [remote = '', url = ''] = argv
  const updates = readFileSync(0, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, rref, rsha] = line.split(' ')
      return { ref, sha, rref, rsha }
    })
    .filter((u) => !ZERO.test(u.sha)) // a delete carries no commits
  if (updates.length > 0) await checkPush(remote, url, updates)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Refuse ? `public-push-guard refused: ${e.message}` : `public-push-guard refused: it crashed (${e.message}), so nothing was sent.`)
      process.exit(1)
    },
  )
}
