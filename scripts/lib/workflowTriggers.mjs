/**
 * What triggers a GitHub Actions workflow, read from the `on:` block of its
 * file, and whether that makes it speak for the health of a branch.
 *
 * This repository has no dependencies and its checks run on a bare Node, so
 * there is no YAML library to use. Rather than a regex over the whole file this
 * is a small reader for exactly the part that matters, and it fails closed:
 * anything it does not understand in the `on:` block throws, and the caller
 * reports "could not check", never a guess. It reads the `on:` key, which may
 * be a scalar, a flow list or map (`[push, pull_request]`, `{push: {...}}`) or a
 * block map or list, and for `push` the branch and tag filters. Everything
 * under the other events (workflow_dispatch inputs, schedule crons) is skipped
 * by indentation, so a literal block full of colons cannot confuse it.
 */

/** Text up to a YAML comment: a `#` at the start or after whitespace, outside quotes. */
export function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s[{,:]/.test(line[i - 1])) quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

function unquote(text) {
  const t = text.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1)
  return t
}

/** A scalar, flow list or flow map from `text`, as plain JS values. Throws on anything else. */
export function parseFlow(text) {
  let pos = 0
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1
  }
  const scalar = (stops) => {
    skip()
    if (text[pos] === '"' || text[pos] === "'") {
      const q = text[pos]
      const end = text.indexOf(q, pos + 1)
      if (end < 0) throw new Error(`unterminated quote in \`${text}\``)
      const value = text.slice(pos + 1, end)
      pos = end + 1
      return value
    }
    const start = pos
    while (pos < text.length && !stops.includes(text[pos])) {
      // A plain scalar inside a flow map may not contain ": ".
      if (text[pos] === ':' && stops.includes(':') && (pos + 1 >= text.length || /[\s,\]}]/.test(text[pos + 1]))) break
      pos += 1
    }
    const raw = text.slice(start, pos).trim()
    return raw === '' || raw === '~' || raw === 'null' ? null : raw
  }
  const value = (stops) => {
    skip()
    if (text[pos] === '[') {
      pos += 1
      const list = []
      for (;;) {
        skip()
        if (text[pos] === ']') {
          pos += 1
          return list
        }
        list.push(value(',]'))
        skip()
        if (text[pos] === ',') pos += 1
        else if (text[pos] !== ']') throw new Error(`malformed list in \`${text}\``)
      }
    }
    if (text[pos] === '{') {
      pos += 1
      const map = {}
      for (;;) {
        skip()
        if (text[pos] === '}') {
          pos += 1
          return map
        }
        const key = scalar(':,}')
        skip()
        if (text[pos] === ':') {
          pos += 1
          map[key] = value(',}')
        } else {
          map[key] = null
        }
        skip()
        if (text[pos] === ',') pos += 1
        else if (text[pos] !== '}') throw new Error(`malformed map in \`${text}\``)
      }
    }
    return scalar(stops)
  }
  const result = value('')
  skip()
  if (pos < text.length) throw new Error(`unexpected text after the value in \`${text}\``)
  return result
}

const indentOf = (line) => line.length - line.trimStart().length
const asList = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v])
const PUSH_KEYS = ['branches', 'branches-ignore', 'tags', 'tags-ignore']

/** Normalise a push configuration to `{ branches, branchesIgnore, tags, tagsIgnore }` (undefined = not given). */
function pushConfig(raw) {
  const config = {}
  if (raw === null || raw === undefined) return config
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('`push:` is not a map of filters')
  for (const key of PUSH_KEYS) {
    if (!(key in raw)) continue
    const list = asList(raw[key])
    if (list.some((v) => typeof v !== 'string')) throw new Error(`\`push: ${key}\` holds something other than patterns`)
    config[key.replace(/-(\w)/, (_m, c) => c.toUpperCase())] = list
  }
  return config
}

/**
 * The events a workflow file is triggered by.
 *
 * @param {string} text the workflow file
 * @returns {{ events: string[], push?: object }} `push` is present when push is an event
 */
export function workflowTriggers(text) {
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  const start = all.findIndex((l) => /^(?:on|"on"|'on')\s*:(?:\s|$)/.test(l))
  if (start < 0) throw new Error('no top-level `on:` key')
  const inline = stripComment(all[start].replace(/^[^:]*:/, '')).trim()
  const events = []
  let push

  if (inline !== '') {
    const value = parseFlow(inline)
    if (typeof value === 'string') events.push(value)
    else if (Array.isArray(value)) events.push(...value)
    else if (value && typeof value === 'object') {
      events.push(...Object.keys(value))
      if ('push' in value) push = pushConfig(value.push)
    } else throw new Error('`on:` has no events')
    if (events.some((e) => typeof e !== 'string' || e === '')) throw new Error('`on:` lists something that is not an event name')
    return { events, ...(events.includes('push') ? { push: push ?? {} } : {}) }
  }

  // Block form: the lines under `on:` up to the next top-level key.
  const body = []
  for (let i = start + 1; i < all.length; i += 1) {
    const line = stripComment(all[i]).replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (indentOf(line) === 0) break
    body.push(line)
  }
  if (body.length === 0) throw new Error('`on:` has nothing under it')
  const base = indentOf(body[0])
  if (body[0].trim().startsWith('- ')) {
    for (const line of body) {
      if (indentOf(line) === base && line.trim().startsWith('- ')) events.push(unquote(line.trim().slice(2)))
    }
    if (events.length === 0) throw new Error('`on:` lists no events')
    return { events, ...(events.includes('push') ? { push: {} } : {}) }
  }

  for (let i = 0; i < body.length; i += 1) {
    const line = body[i]
    if (indentOf(line) !== base) continue
    const m = /^(\S[^:]*?)\s*:(?:\s+(.*))?$/.exec(line.trim())
    if (!m) throw new Error(`cannot read the event on line \`${line.trim()}\``)
    const name = unquote(m[1])
    events.push(name)
    if (name !== 'push') continue
    // Everything indented deeper belongs to push.
    const sub = []
    for (let j = i + 1; j < body.length && indentOf(body[j]) > base; j += 1) sub.push(body[j])
    if (m[2] !== undefined && m[2].trim() !== '') {
      push = pushConfig(parseFlow(m[2].trim()))
    } else if (sub.length === 0) {
      push = {}
    } else {
      const b2 = indentOf(sub[0])
      const raw = {}
      let current = null
      for (const sl of sub) {
        const ind = indentOf(sl)
        const t = sl.trim()
        if (ind === b2 && !t.startsWith('- ')) {
          const km = /^(\S[^:]*?)\s*:(?:\s+(.*))?$/.exec(t)
          if (!km) throw new Error(`cannot read the push filter on line \`${t}\``)
          current = unquote(km[1])
          raw[current] = km[2] !== undefined && km[2].trim() !== '' ? parseFlow(km[2].trim()) : []
        } else if (t.startsWith('- ') && current !== null && Array.isArray(raw[current])) {
          raw[current].push(unquote(t.slice(2)))
        }
        // Anything else is deeper content of a key this reader does not need (paths, nested values).
      }
      push = pushConfig(raw)
    }
  }
  if (events.length === 0) throw new Error('`on:` lists no events')
  return { events, ...(events.includes('push') ? { push: push ?? {} } : {}) }
}

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*')}$`,
  )

/** GitHub's branch filter: patterns in order, `!` patterns take a match back out. */
function branchMatches(patterns, branch) {
  let matched = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(branch)) matched = !negated
  }
  return matched
}

/** True when a push to `branch` triggers a workflow with this push configuration. */
export function pushRunsOnBranch(push, branch) {
  if (push.branches) return branchMatches(push.branches, branch)
  if (push.branchesIgnore) return !push.branchesIgnore.some((p) => globToRegExp(p).test(branch))
  // Only tag filters given: GitHub runs the workflow for tags and for nothing else.
  if (push.tags || push.tagsIgnore) return false
  return true
}

/**
 * Whether the workflow speaks for `branch`'s health, and if not, a short reason.
 * Workflows that run on a push to the branch, on a schedule (against the default
 * branch) or after another workflow do. Tag-only, manual-only, pull-request-only
 * and reusable-only ones do not: the last run they have on the branch, if any,
 * is not something that branch's state produced.
 *
 * @returns {{ judged: true } | { judged: false, why: string }}
 */
export function speaksForBranch({ events, push }, branch) {
  if (push && pushRunsOnBranch(push, branch)) return { judged: true }
  if (events.includes('schedule') || events.includes('workflow_run')) return { judged: true }
  const others = events.filter((e) => e !== 'push')
  if (push) {
    const tagOnly = (push.tags || push.tagsIgnore) && !push.branches && !push.branchesIgnore
    if (others.every((e) => e === 'workflow_dispatch' || e === 'workflow_call' || /^pull_request/.test(e))) return { judged: false, why: tagOnly ? 'tag-only' : 'push to other branches only' }
  }
  if (events.every((e) => e === 'workflow_dispatch')) return { judged: false, why: 'manual only' }
  if (events.every((e) => e === 'workflow_call')) return { judged: false, why: 'reusable only' }
  if (events.every((e) => e === 'workflow_dispatch' || e === 'workflow_call')) return { judged: false, why: 'manual or reusable only' }
  if (events.every((e) => /^pull_request/.test(e) || e === 'workflow_dispatch')) return { judged: false, why: 'pull requests only' }
  return { judged: false, why: `runs on ${events.join(', ')}` }
}
