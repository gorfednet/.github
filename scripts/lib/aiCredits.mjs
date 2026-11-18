/**
 * The AI credit ledger (plan row 1.40): which tools made a site, with the evidence for each credit kept apart by grade.
 *
 * Three grades, never mixed:
 *   recorded  a `Co-Authored-By` or `AI-Use:` trailer on a commit, or a Claude Code transcript whose model id and
 *             working folder match the repository. Counted from the repository's own history and this Mac's transcripts.
 *   stated    the owner's word, quoted and dated, from the repository's `docs/ai-use/credits.config.json`.
 *   inferred  a Cursor commit dated against the models Cursor offered that month. Ledger only.
 *
 * A tag or statement (`tagTools`) uses recorded and stated credits only. AI Use Levels 1.2 has no way to say "likely",
 * so an inferred model never reaches a tag. A Cursor commit with no model is credited as `Cursor`, a product name 1.2 accepts.
 *
 * Everything here is pure: git output and transcript rows go in, a ledger comes out. `scripts/ai-credits.mjs` does the I/O.
 * A transcript is read for model ids, timestamps and working folders only (`scripts/lib/prCost.mjs` scanFile); no text
 * from one is ever kept.
 */

export const SCHEMA = 'ai-credits/1'
export const STANDARD = 'AI Use Levels 1.2'
export const GRADES = {
  recorded: 'A Co-Authored-By or AI-Use trailer on a commit, or a Claude Code transcript whose model id and working folder match this repository.',
  stated: "The owner's own words, quoted and dated.",
  inferred: 'A Cursor commit with no model, dated against the models Cursor offered that month. Ledger only: never in a tag, because 1.2 has no way to say "likely".',
}

/** `claude-opus-5-5` to `Claude Opus 5.5`; a dated id (`claude-haiku-4-5-20251001`) drops the date. Anything else is null. */
export function toolFromModelId(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id ?? '').trim().toLowerCase())
  if (!m) return null
  const family = m[1][0].toUpperCase() + m[1].slice(1)
  return `Claude ${family} ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}`
}

const PRODUCTS = [
  [/^cursor(?: agent)?$/i, 'Cursor'],
  [/^(?:github )?copilot$/i, 'GitHub Copilot'],
  [/^(?:openai )?codex$/i, 'Codex'],
  [/^chatgpt$/i, 'ChatGPT'],
  [/^gemini(?: cli)?$/i, 'Gemini'],
  [/^claude code$/i, 'Claude Code'],
]

/** A tool name as git or a tag writes it, cleaned: spaces collapsed, a context-size note dropped. */
export function cleanTool(name) {
  return String(name ?? '').replace(/\s*\((?:\d+[mk] context|\d+[mk])\)\s*$/i, '').replace(/\s+/g, ' ').trim()
}

/**
 * What one `Co-Authored-By` name is. `humans`: names that are people (the commit authors, plus the config's).
 * kind: `tool` (with `tool`), `human`, `bot` or `unclassified`. Nothing is dropped silently: an unrecognised name is returned.
 */
export function classifyCoAuthor({ name, email = '' }, humans = new Set()) {
  const clean = cleanTool(name)
  if (!clean) return { kind: 'unclassified', name: '' }
  if (humans.has(clean.toLowerCase())) return { kind: 'human', name: clean }
  if (/\[bot\]$/i.test(clean) || /^github-actions/i.test(clean) || /^dependabot/i.test(clean) || /bot@/i.test(email) || /^github$/i.test(clean)) return { kind: 'bot', name: clean }
  for (const [re, tool] of PRODUCTS) if (re.test(clean)) return { kind: 'tool', tool }
  if (/^claude\b/i.test(clean)) return { kind: 'tool', tool: clean.replace(/^claude/i, 'Claude') }
  return { kind: 'unclassified', name: clean }
}

/** The trailers of one commit message: `{ coAuthors: [{name, email}], aiUse: [{raw, tool}] }`. A line must start with the key. */
export function parseTrailers(body) {
  const coAuthors = []
  const aiUse = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const co = /^co-authored-by:\s*(.*?)\s*(?:<([^>]*)>)?\s*$/i.exec(line)
    if (co) {
      coAuthors.push({ name: co[1], email: co[2] ?? '' })
      continue
    }
    const ai = /^ai-use:\s*(.+?)\s*$/i.exec(line)
    if (ai) {
      const open = ai[1].indexOf('(')
      const close = ai[1].lastIndexOf(')')
      const tool = open >= 0 && close > open ? cleanTool(ai[1].slice(open + 1, close)) : ''
      aiUse.push({ raw: ai[1], tool })
    }
  }
  return { coAuthors, aiUse }
}

/**
 * The tools a commit credits, from its trailers. A tool named only in an `AI-Use` trailer counts unless a co-author on
 * the same commit already names it (`Claude Sonnet` is the family `Claude Sonnet 5.5` was written under). `Claude Code`
 * is the harness, not a model: it is reported as `harness`, never as a credit.
 */
export function commitTools(body, humans) {
  const { coAuthors, aiUse } = parseTrailers(body)
  const tools = []
  const humansSeen = []
  const bots = []
  const unclassified = []
  for (const c of coAuthors) {
    const k = classifyCoAuthor(c, humans)
    if (k.kind === 'tool' && k.tool !== 'Claude Code') tools.push(k.tool)
    else if (k.kind === 'human') humansSeen.push(k.name)
    else if (k.kind === 'bot') bots.push(k.name)
    else if (k.kind === 'unclassified') unclassified.push(k.name || '(empty)')
  }
  const harness = []
  const unversioned = []
  for (const a of aiUse) {
    if (!a.tool) continue
    if (/^claude code$/i.test(a.tool)) {
      harness.push('Claude Code')
      continue
    }
    if (tools.some((t) => t === a.tool || t.startsWith(`${a.tool} `))) continue
    tools.push(a.tool)
    if (/^claude (opus|sonnet|haiku|fable)$/i.test(a.tool)) unversioned.push(a.tool)
  }
  return { tools: [...new Set(tools)], harness: [...new Set(harness)], humans: humansSeen, bots, unclassified, unversioned }
}

export const monthOf = (iso) => new Date(iso).toISOString().slice(0, 7)
export const dayOf = (iso) => new Date(iso).toISOString().slice(0, 10)

/** Does a repository path fall under a source (a file, or a folder named with or without a trailing slash)? */
export const underSource = (file, source) => {
  const s = source.replace(/\/+$/, '')
  return file === s || file.startsWith(`${s}/`)
}

/**
 * Parse `git log --reverse --name-only` written with the format `%x1e%H%x1f%P%x1f%aI%x1f%aN%x1f%cI%x1f%B%x1f`:
 * one record per commit, the message, then the files it touched (none for a merge). `merge` is true for 2 or more parents.
 */
export function parseGitLog(raw) {
  const commits = []
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue
    const [sha, parents, authored, author, committed, body, rest = ''] = rec.split('\x1f')
    commits.push({ sha: sha.trim(), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1, authored, author, committed, body, files: rest.split('\n').map((f) => f.trim()).filter(Boolean) })
  }
  return commits
}

const byCountThenName = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])

/** Per-tool commit counts, biggest hand first. */
export const ranked = (counts) => [...Object.entries(counts)].sort(byCountThenName).map(([tool]) => tool)

/**
 * Build the ledger. Inputs:
 *   commits      from `parseGitLog`, oldest first.
 *   meta         `{ repo, ref, head, mergeCommits, command, script }`.
 *   config       the repository's `credits.config.json`: `{ humans?, groups?, pages?, stated? }`.
 *   transcripts  rows `{ month, model, turns, sessions, subagent, first, last }` for this repository, or null when not read
 *                (`readInfo` says how: `{ indexedAt, files, earliest }`).
 *   cursorModels `{ source, months: { "2026-05": { models: [...], source } } }`, or null.
 */
export function buildLedger({ commits: all, meta, config = {}, transcripts = null, readInfo = null, cursorModels = null, generated = new Date().toISOString() }) {
  // A plain merge (a pull request landing, main merged in by a person) says nothing about a tool. A merge a tool wrote
  // (it carries a trailer) is the tool's work and stays in.
  const humans0 = new Set([...(config.humans ?? []), ...all.map((c) => c.author)].map((n) => n.toLowerCase()))
  const commits = all.filter((c) => !c.merge || commitTools(c.body, humans0).tools.length > 0)
  const plainMerges = all.length - commits.length
  const toolMerges = commits.filter((c) => c.merge).length
  const humans = new Set([...(config.humans ?? []), ...commits.map((c) => c.author)].map((n) => n.toLowerCase()))
  const groups = config.groups ?? {}
  const pagesCfg = config.pages ?? {}

  const siteTools = new Map() // tool -> { shas:[], first, last }
  const months = new Map()
  const unclassified = {}
  const unversioned = {}
  const harness = {}
  let withTrailer = 0
  let noTrailer = 0
  const perCommit = []

  for (const c of commits) {
    const t = commitTools(c.body, humans)
    for (const n of t.unclassified) unclassified[n] = (unclassified[n] ?? 0) + 1
    for (const n of t.unversioned) unversioned[n] = (unversioned[n] ?? 0) + 1
    for (const n of t.harness) harness[n] = (harness[n] ?? 0) + 1
    const m = monthOf(c.authored)
    const mo = months.get(m) ?? { commits: 0, noTool: 0, tools: {} }
    mo.commits++
    if (t.tools.length > 0) withTrailer++
    else noTrailer++
    if (t.tools.length === 0) mo.noTool++
    for (const tool of t.tools) {
      mo.tools[tool] = (mo.tools[tool] ?? 0) + 1
      const s = siteTools.get(tool) ?? { shas: [], merges: 0, first: c.authored, last: c.authored }
      s.shas.push(c.sha.slice(0, 10))
      if (c.merge) s.merges++
      if (c.authored < s.first) s.first = c.authored
      if (c.authored > s.last) s.last = c.authored
      siteTools.set(tool, s)
    }
    months.set(m, mo)
    perCommit.push({ c, tools: t.tools })
  }

  // Transcript evidence: per model, per month.
  const transcriptTools = new Map() // tool -> { turns, sessions, first, last, subagentTurns }
  const transcriptMonths = {}
  const unknownModels = {}
  for (const r of transcripts ?? []) {
    const tool = toolFromModelId(r.model)
    if (!tool) {
      unknownModels[r.model] = (unknownModels[r.model] ?? 0) + r.turns
      continue
    }
    const t = transcriptTools.get(tool) ?? { turns: 0, subagentTurns: 0, sessions: 0, first: r.first, last: r.last }
    t.turns += r.turns
    if (r.subagent) t.subagentTurns += r.turns
    t.sessions += r.sessions
    if (r.first < t.first) t.first = r.first
    if (r.last > t.last) t.last = r.last
    transcriptTools.set(tool, t)
    const mo = (transcriptMonths[r.month] ??= {})
    const mt = (mo[tool] ??= { turns: 0, subagentTurns: 0, sessions: 0 })
    mt.turns += r.turns
    if (r.subagent) mt.subagentTurns += r.turns
    mt.sessions += r.sessions
  }

  // Site-wide credits.
  const tools = []
  const commitCounts = Object.fromEntries([...siteTools].map(([k, v]) => [k, v.shas.length]))
  const allNames = new Set([...siteTools.keys(), ...transcriptTools.keys()])
  const order = [...allNames].sort((a, b) => {
    const ca = commitCounts[a] ?? 0
    const cb = commitCounts[b] ?? 0
    if (ca !== cb) return cb - ca
    return (transcriptTools.get(b)?.turns ?? 0) - (transcriptTools.get(a)?.turns ?? 0) || a.localeCompare(b)
  })
  for (const tool of order) {
    const evidence = []
    const s = siteTools.get(tool)
    if (s) evidence.push({ kind: 'trailer', commits: s.shas.length, ofWhichMerges: s.merges, first: dayOf(s.first), last: dayOf(s.last), shas: s.shas })
    const tr = transcriptTools.get(tool)
    if (tr) evidence.push({ kind: 'transcript', turns: tr.turns, subagentTurns: tr.subagentTurns, sessions: tr.sessions, first: dayOf(tr.first), last: dayOf(tr.last) })
    tools.push({ tool, grade: 'recorded', commits: s?.shas.length ?? 0, first: dayOf(s ? (tr && tr.first < s.first ? tr.first : s.first) : tr.first), last: dayOf(s ? (tr && tr.last > s.last ? tr.last : s.last) : tr.last), evidence })
  }
  const transcriptOnly = order.filter((t) => !siteTools.has(t))

  // Stated credits (the owner's word) are kept apart and add tools only where they name one.
  const stated = (config.stated ?? []).map((e) => ({ ...e }))
  const statedTools = stated.filter((e) => e.tool).map((e) => e.tool)
  const tagTools = [...order]
  for (const t of statedTools) if (!tagTools.includes(t)) tagTools.push(t)

  // Inferred: Cursor commits by month against Cursor's model list for that month. Never in tagTools.
  const inferred = []
  if (siteTools.has('Cursor')) {
    for (const [m, mo] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
      const n = mo.tools.Cursor
      if (!n) continue
      const offered = cursorModels?.months?.[m]
      inferred.push({ grade: 'inferred', tool: 'Cursor', month: m, commits: n, models: offered?.models ?? null, source: offered?.source ?? cursorModels?.source ?? null, basis: offered ? 'the models Cursor offered that month' : 'no model list for this month yet' })
    }
  }

  // Per-month entries.
  const monthOut = {}
  for (const m of [...new Set([...months.keys(), ...Object.keys(transcriptMonths)])].sort()) {
    const mo = months.get(m) ?? { commits: 0, noTool: 0, tools: {} }
    monthOut[m] = { commits: mo.commits, commitsWithNoTool: mo.noTool, tools: Object.fromEntries(Object.entries(mo.tools).sort(byCountThenName)) }
    if (transcriptMonths[m]) monthOut[m].transcripts = transcriptMonths[m]
    const inf = inferred.find((i) => i.month === m)
    if (inf) monthOut[m].inferred = { Cursor: inf.models }
  }

  // Per-page entries: a page's commits are the ones touching any file under its groups.
  const pages = {}
  const groupNames = Object.keys(groups)
  if (groupNames.length > 0) {
    const touched = perCommit.map(({ c }) => new Set(groupNames.filter((g) => c.files.some((f) => groups[g].some((s) => underSource(f, s))))))
    for (const [page, gs] of Object.entries(pagesCfg).sort(([a], [b]) => a.localeCompare(b))) {
      const counts = {}
      let n = 0
      let first = null
      let last = null
      let withTool = 0
      perCommit.forEach(({ c, tools: ts }, i) => {
        if (!gs.some((g) => touched[i].has(g))) return
        n++
        if (ts.length > 0) withTool++
        for (const t of ts) counts[t] = (counts[t] ?? 0) + 1
        if (first === null || c.authored < first) first = c.authored
        if (last === null || c.authored > last) last = c.authored
      })
      pages[page] = { groups: gs, commits: n, commitsWithNoTool: n - withTool, first: first && dayOf(first), last: last && dayOf(last), tools: Object.fromEntries(Object.entries(counts).sort(byCountThenName)), tagTools: ranked(counts) }
    }
  }

  const first = commits[0]
  return {
    schema: SCHEMA,
    standard: STANDARD,
    repo: meta.repo,
    ref: meta.ref,
    head: meta.head,
    generated,
    firstCommit: first ? { sha: first.sha.slice(0, 10), date: dayOf(first.authored) } : null,
    command: meta.command,
    script: meta.script,
    grades: GRADES,
    counts: { commits: commits.length, toolMergeCommits: toolMerges, plainMergeCommitsIgnored: plainMerges, withToolTrailer: withTrailer, withNoToolTrailer: noTrailer },
    tagTools,
    transcriptOnlyTools: transcriptOnly,
    tools,
    stated,
    inferred,
    months: monthOut,
    pages,
    transcripts: readInfo ? { read: true, ...readInfo, unknownModels } : { read: false },
    harness,
    unversionedTrailers: unversioned,
    unclassifiedCoAuthors: unclassified,
    limits: [
      'Commits are every commit reachable from the ref, dated by author date in UTC, except a plain merge (a pull request landing, main merged in with no tool trailer), which is counted apart and ignored. A merge a tool wrote (main merged into a branch, trailer on it) counts for the site but not for a page, since a merge lists no files. A commit with no tool trailer may still be tool-made; no tool is dropped because a later commit lacks a trailer. A commit with several trailers for one tool counts once.',
      'A page is credited from commits that touched a file under its groups, at the path the file had in that commit. A file renamed later keeps its earlier commits only under the old path.',
      'Transcripts are this Mac\'s Claude Code sessions in a folder of this repository (or a worktree of it). Sessions on another machine, or in Cursor, are not in them. A transcript shows a model worked in the repository, not which page it touched.',
      'Model use that leaves no trace (a chat window, a pasted answer) is not in the ledger. It becomes a credit only if the owner states it.',
    ],
  }
}

/**
 * The tools a tag names, in the order written. Reads the human form (`L3 · made · no undo · A + B`) and the machine form
 * (`L3 made no undo (A + B)`). A reach note on a tool (`Cursor (IDE)`) is dropped.
 */
export function toolsOfTag(tag) {
  const s = String(tag).trim()
  let list
  if (s.includes(' · ')) list = s.split(' · ').slice(1).filter((p) => !/^(?:touched|drafted|made|rewrote|undo|no undo|unread)$/i.test(p)).join(' · ')
  else {
    const open = s.indexOf('(')
    const close = s.lastIndexOf(')')
    list = open >= 0 && close > open ? s.slice(open + 1, close) : ''
  }
  return list.split(' + ').map((t) => t.replace(/\s*\((?:chat|IDE|app|API|agent)\)\s*$/i, '').trim()).filter(Boolean)
}

/**
 * What is wrong with a tag against its ledger entry: a credited tool it drops, a tool it names that the ledger doesn't
 * record or state (an inferred model, a guess), and a biggest-hand-first order it breaks. `credited` is the entry's `tagTools`.
 */
export function tagProblems(label, tag, credited) {
  const named = toolsOfTag(tag)
  const problems = []
  for (const t of credited) if (!named.includes(t)) problems.push(`${label}: the tag drops ${t}, which the ledger records or states`)
  for (const t of named) if (!credited.includes(t)) problems.push(`${label}: the tag names ${t}, which the ledger neither records nor states`)
  const inOrder = credited.filter((t) => named.includes(t))
  const writtenOrder = named.filter((t) => credited.includes(t))
  if (problems.length === 0 && inOrder.join('|') !== writtenOrder.join('|')) problems.push(`${label}: the tag lists tools as ${named.join(' + ')}; biggest hand first is ${credited.join(' + ')}`)
  return problems
}

/** Check a site's tag record (`{ site: {tag}, pages: {page: {tag}} }`) against its ledger. Returns the problems. */
export function checkRecord(ledger, record) {
  const problems = []
  if (record.site?.tag) problems.push(...tagProblems('site', record.site.tag, ledger.tagTools))
  for (const [page, { tag }] of Object.entries(record.pages ?? {})) {
    const entry = ledger.pages?.[page]
    if (!entry) problems.push(`${page}: the ledger has no entry for this page`)
    else problems.push(...tagProblems(page, tag, entry.tagTools))
  }
  return problems
}
