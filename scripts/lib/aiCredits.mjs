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
  recorded: 'A Co-Authored-By or AI-Use trailer on a commit, a commit the tool authored itself, or a Claude Code transcript whose model id and working folder match this repository.',
  stated: "The owner's own words, quoted and dated.",
  inferred: 'A Cursor commit with no model, dated against the models Cursor offered around then. Ledger only. It never goes in a tag, because 1.2 has no way to say "likely".',
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
  for (const [re, tool] of PRODUCTS) if (re.test(clean)) return { kind: 'tool', tool }
  if (/\[bot\]$/i.test(clean) && /claude|copilot|codex|cursor|gemini|openai|anthropic/i.test(clean)) return { kind: 'unclassified', name: clean }
  if (/\[bot\]$/i.test(clean) || /^github-actions/i.test(clean) || /^dependabot/i.test(clean) || /bot@/i.test(email) || /^github$/i.test(clean)) return { kind: 'bot', name: clean }
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
 * The tools a commit credits: its co-author trailers, an `AI-Use` trailer, and its author when the author is a tool
 * (`Cursor Agent` committing as itself). An `AI-Use` tool counts unless a co-author already names it (`Claude Sonnet` is the
 * family `Claude Sonnet 5.5` was written under). An `AI-Use` model that disagrees with every co-author's family is
 * `conflicting` and credits nothing: the line was a template, or the commit was edited. `Claude Code` is the harness,
 * not a model. `AI-Use: L3 made (A + B)` names two tools.
 */
export function commitTools(body, humans, author = '') {
  const { coAuthors, aiUse } = parseTrailers(body)
  const tools = []
  const humansSeen = []
  const bots = []
  const unclassified = []
  const authorKind = author ? classifyCoAuthor({ name: author }, new Set()) : null
  if (authorKind?.kind === 'tool' && authorKind.tool !== 'Claude Code') tools.push(authorKind.tool)
  for (const c of coAuthors) {
    const k = classifyCoAuthor(c, humans)
    if (k.kind === 'tool' && k.tool !== 'Claude Code') tools.push(k.tool)
    else if (k.kind === 'human') humansSeen.push(k.name)
    else if (k.kind === 'bot') bots.push(k.name)
    else if (k.kind === 'unclassified') unclassified.push(k.name || '(empty)')
  }
  const named = [...tools]
  const harness = []
  const unversioned = []
  const conflicting = []
  for (const a of aiUse) {
    for (const part of a.tool.split(' + ')) {
      const k = classifyCoAuthor({ name: part }, new Set())
      if (k.kind !== 'tool') {
        if (part) unclassified.push(part)
        continue
      }
      if (k.tool === 'Claude Code') {
        harness.push('Claude Code')
        continue
      }
      const family = (t) => t.split(' ').slice(0, 2).join(' ')
      if (named.some((t) => t === k.tool || t.startsWith(`${k.tool} `))) continue
      const sameFamily = named.filter((t) => family(t) === family(k.tool))
      if (sameFamily.length > 0) {
        // The co-author names this family. An unversioned name agrees with it; another version contradicts it.
        if (k.tool === family(k.tool)) continue
        conflicting.push(k.tool)
        continue
      }
      if (named.length > 0) {
        conflicting.push(k.tool)
        continue
      }
      tools.push(k.tool)
      if (/^claude (opus|sonnet|haiku|fable)$/i.test(k.tool)) unversioned.push(k.tool)
    }
  }
  return { tools: [...new Set(tools)], harness: [...new Set(harness)], humans: humansSeen, bots, unclassified, unversioned, conflicting }
}

export const monthOf = (iso) => new Date(iso).toISOString().slice(0, 7)
export const dayOf = (iso) => new Date(iso).toISOString().slice(0, 10)

/** Does a repository path fall under a source (a file, or a folder named with or without a trailing slash)? */
export const underSource = (file, source) => {
  const s = source.replace(/\/+$/, '')
  return file === s || file.startsWith(`${s}/`)
}

/**
 * The files a commit touched, from `--name-status -M` lines (`M\tpath`, `R087\told\tnew`) or plain `--name-only` lines.
 * A pure rename (R100) touched no content, so it credits nothing; a rename with edits credits the new path.
 */
export function filesOf(rest) {
  const files = []
  for (const raw of rest.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const cols = line.split('\t')
    if (cols.length === 1) files.push(line)
    else if (/^R100$|^C100$/.test(cols[0])) continue
    else files.push(cols[cols.length - 1])
  }
  return files
}

/**
 * Parse `git log --reverse --name-status -M` written with the format `%x1e%H%x1f%P%x1f%aI%x1f%aN%x1f%cI%x1f%B%x1f`:
 * one record per commit, the message, then the files it touched (none for a merge). `merge` is true for 2 or more parents.
 */
export function parseGitLog(raw) {
  const commits = []
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue
    const [sha, parents, authored, author, committed, body, rest = ''] = rec.split('\x1f')
    commits.push({ sha: sha.trim(), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1, authored: new Date(authored).toISOString(), author, committed: new Date(committed).toISOString(), body, files: filesOf(rest) })
  }
  return commits
}

const byCountThenName = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])

/** Per-tool commit counts, biggest hand first. */
export const ranked = (counts) => [...Object.entries(counts)].sort(byCountThenName).map(([tool]) => tool)

/**
 * Build the ledger. Inputs:
 *   commits      from `parseGitLog`, oldest first.
 *   meta         `{ repo, ref, head, command, script }`.
 *   config       the repository's `credits.config.json`:
 *                `{ humans?, groups?, pages?, stated?, transcriptCredit? }`. `stated` entries that carry a `tool` must
 *                name that tool in their quote. `transcriptCredit` is `{ "<tool>": { by, date, why } }`: a decision to credit a
 *                model that has transcripts and no trailer. A transcript can't show whether a model wrote anything, so none is
 *                credited without one.
 *   transcripts  rows `{ month, model, turns, sessions, subagent, first, last }` for this repository, or null when not read
 *                (`readInfo` says how: `{ indexedAt, files, earliest }`).
 *   prior        the ledger written last time. A transcript count never goes down: transcripts get cleaned up, a credit
 *                found once stays found.
 *   cursorModels `{ source, months: { "2026-05": { models: [...], source } } }`, or null.
 */
export function buildLedger({ commits: all, meta, config = {}, transcripts = null, readInfo = null, prior = null, cursorModels = null, generated = new Date().toISOString() }) {
  for (const e of config.stated ?? []) {
    if (e.tool && !String(e.quote ?? '').toLowerCase().includes(e.tool.toLowerCase())) throw new Error(`stated credit for ${e.tool}: the quoted words don't name it (${JSON.stringify(e.quote)})`)
    if (e.tool && e.scope !== 'site') throw new Error(`stated credit for ${e.tool}: only a site-wide scope is read`)
  }
  const pagesCfg = config.pages ?? {}
  const groups = config.groups ?? {}
  for (const [page, gs] of Object.entries(pagesCfg)) for (const g of gs) if (!groups[g]) throw new Error(`page ${page} names group ${g}, which the config doesn't define`)

  // People: authors who aren't tools, plus the config's names. A tool that authors a commit is a credit, not a person.
  const authorKinds = new Map()
  for (const c of all) if (!authorKinds.has(c.author)) authorKinds.set(c.author, classifyCoAuthor({ name: c.author }, new Set()).kind)
  const humans = new Set([...(config.humans ?? []), ...[...authorKinds].filter(([, k]) => k !== 'tool').map(([n]) => n)].map((n) => n.toLowerCase()))

  const toolsOf = (c) => commitTools(c.body, humans, c.author)
  const openTrailers = (t) => t.unclassified.length > 0 || t.unversioned.length > 0 || t.conflicting.length > 0
  // A plain merge (a pull request landing, main merged in by a person) says nothing about a tool. A merge a tool wrote, or
  // one whose trailers need a look, stays in.
  const commits = all.filter((c) => {
    if (!c.merge) return true
    const t = toolsOf(c)
    return t.tools.length > 0 || openTrailers(t)
  })
  const plainMerges = all.length - commits.length
  const toolMerges = commits.filter((c) => c.merge).length

  const siteTools = new Map() // tool -> { shas, merges, first, last }
  const months = new Map()
  const open = { unclassifiedCoAuthors: {}, unversionedTrailers: {}, conflictingTrailers: {} }
  const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1)
  const harness = {}
  const botCounts = {}
  const humanCounts = {}
  let withTrailer = 0
  let noTrailer = 0
  const perCommit = []

  for (const c of commits) {
    const t = toolsOf(c)
    for (const n of t.unclassified) bump(open.unclassifiedCoAuthors, n)
    for (const n of t.unversioned) bump(open.unversionedTrailers, n)
    for (const n of t.conflicting) bump(open.conflictingTrailers, n)
    for (const n of t.harness) bump(harness, n)
    for (const n of t.bots) bump(botCounts, n)
    for (const n of t.humans) bump(humanCounts, n)
    const m = monthOf(c.authored)
    const mo = months.get(m) ?? { commits: 0, noTool: 0, tools: {} }
    mo.commits++
    if (t.tools.length > 0) withTrailer++
    else {
      noTrailer++
      mo.noTool++
    }
    for (const tool of t.tools) {
      mo.tools[tool] = (mo.tools[tool] ?? 0) + 1
      const s = siteTools.get(tool) ?? { shas: [], merges: 0, authored: 0, first: c.authored, last: c.authored }
      s.shas.push(c.sha.slice(0, 10))
      if (authorKinds.get(c.author) === 'tool' && classifyCoAuthor({ name: c.author }, new Set()).tool === tool) s.authored++
      if (c.merge) s.merges++
      if (c.authored < s.first) s.first = c.authored
      if (c.authored > s.last) s.last = c.authored
      siteTools.set(tool, s)
    }
    months.set(m, mo)
    perCommit.push({ c, tools: t.tools })
  }

  // Transcript evidence: per tool, per month, kept as the larger of this read and the last ledger's.
  const transcriptTools = new Map() // tool -> { turns, subagentTurns, sessions, first, last }
  const transcriptMonths = {}
  const unknownModels = {}
  for (const r of transcripts ?? []) {
    const tool = toolFromModelId(r.model)
    if (!tool) {
      bump(unknownModels, r.model)
      continue
    }
    const t = transcriptTools.get(tool) ?? { turns: 0, subagentTurns: 0, sessions: 0, first: r.first, last: r.last }
    t.turns += r.turns
    if (r.subagent) t.subagentTurns += r.turns
    t.sessions += r.sessions
    if (r.first < t.first) t.first = r.first
    if (r.last > t.last) t.last = r.last
    transcriptTools.set(tool, t)
    const mt = ((transcriptMonths[r.month] ??= {})[tool] ??= { turns: 0, subagentTurns: 0, sessions: 0 })
    mt.turns += r.turns
    if (r.subagent) mt.subagentTurns += r.turns
    mt.sessions += r.sessions
  }
  if (prior) {
    for (const [m, perTool] of Object.entries(prior.months ?? {})) {
      for (const [tool, v] of Object.entries(perTool.transcripts ?? {})) {
        const mt = ((transcriptMonths[m] ??= {})[tool] ??= { turns: 0, subagentTurns: 0, sessions: 0 })
        for (const k of ['turns', 'subagentTurns', 'sessions']) mt[k] = Math.max(mt[k], v[k] ?? 0)
      }
    }
    for (const t of prior.tools ?? []) {
      const ev = t.evidence?.find((e) => e.kind === 'transcript')
      if (!ev) continue
      const cur = transcriptTools.get(t.tool) ?? { turns: 0, subagentTurns: 0, sessions: 0, first: `${ev.first}T00:00:00.000Z`, last: `${ev.last}T00:00:00.000Z` }
      cur.turns = Math.max(cur.turns, ev.turns)
      cur.subagentTurns = Math.max(cur.subagentTurns, ev.subagentTurns ?? 0)
      cur.sessions = Math.max(cur.sessions, ev.sessions ?? 0)
      if (`${ev.first}T00:00:00.000Z` < cur.first) cur.first = `${ev.first}T00:00:00.000Z`
      if (`${ev.last}T00:00:00.000Z` > cur.last) cur.last = `${ev.last}T00:00:00.000Z`
      transcriptTools.set(t.tool, cur)
    }
  }

  // Site-wide credits.
  const commitCounts = Object.fromEntries([...siteTools].map(([k, v]) => [k, v.shas.length]))
  const order = [...new Set([...siteTools.keys(), ...transcriptTools.keys()])].sort((a, b) => {
    const ca = commitCounts[a] ?? 0
    const cb = commitCounts[b] ?? 0
    if (ca !== cb) return cb - ca
    return (transcriptTools.get(b)?.turns ?? 0) - (transcriptTools.get(a)?.turns ?? 0) || a.localeCompare(b)
  })
  const credit = config.transcriptCredit ?? {}
  const tools = []
  for (const tool of order) {
    const evidence = []
    const s = siteTools.get(tool)
    if (s) evidence.push({ kind: 'trailer', commits: s.shas.length, ofWhichMerges: s.merges, ofWhichAuthoredByTheTool: s.authored, first: dayOf(s.first), last: dayOf(s.last), shas: s.shas })
    const tr = transcriptTools.get(tool)
    if (tr) evidence.push({ kind: 'transcript', turns: tr.turns, subagentTurns: tr.subagentTurns, sessions: tr.sessions, first: dayOf(tr.first), last: dayOf(tr.last) })
    const entry = { tool, grade: 'recorded', credited: Boolean(s) || Boolean(credit[tool]), commits: s?.shas.length ?? 0, firstSeen: dayOf(s ? (tr && tr.first < s.first ? tr.first : s.first) : tr.first), lastSeen: dayOf(s ? (tr && tr.last > s.last ? tr.last : s.last) : tr.last), evidence }
    if (!s && credit[tool]) entry.creditDecision = credit[tool]
    tools.push(entry)
  }
  const transcriptOnly = order.filter((t) => !siteTools.has(t))
  const stated = (config.stated ?? []).map((e) => ({ grade: 'stated', ...e }))
  const tagTools = deriveTagTools({ tools, stated })

  // Inferred: Cursor commits by month against Cursor's model list. Never in tagTools.
  const inferred = []
  if (siteTools.has('Cursor')) {
    for (const [m, mo] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
      const n = mo.tools.Cursor
      if (!n) continue
      const offered = cursorModels?.months?.[m]
      inferred.push({ grade: 'inferred', tool: 'Cursor', month: m, commits: n, models: offered?.models ?? null, default: offered?.default ?? null, source: offered?.source ?? cursorModels?.source ?? null, otherSources: offered?.other_sources ?? [], note: offered?.note ?? null, basis: offered ? 'Models Cursor had launched by the end of this month, from the pages listed. A commit may predate a model. Models with no dated launch are left out.' : 'No model list for this month yet.' })
    }
  }

  const monthOut = {}
  for (const m of [...new Set([...months.keys(), ...Object.keys(transcriptMonths)])].sort()) {
    const mo = months.get(m) ?? { commits: 0, noTool: 0, tools: {} }
    monthOut[m] = { commits: mo.commits, commitsWithNoTool: mo.noTool, tools: Object.fromEntries(Object.entries(mo.tools).sort(byCountThenName)) }
    if (transcriptMonths[m]) monthOut[m].transcripts = transcriptMonths[m]
    const inf = inferred.find((i) => i.month === m)
    if (inf) monthOut[m].inferred = { Cursor: inf.models }
  }
  // A month with Claude trailers and no transcripts is a hole in the transcript evidence, said so.
  const claudeMonthsWithoutTranscripts = Object.entries(monthOut).filter(([, v]) => Object.keys(v.tools).some((t) => t.startsWith('Claude')) && !v.transcripts).map(([m]) => m)

  // Per-page entries: a page's commits are the ones touching any file under its groups.
  const pages = {}
  const emptyGroups = []
  const groupNames = Object.keys(groups)
  if (groupNames.length > 0) {
    const touched = perCommit.map(({ c }) => new Set(groupNames.filter((g) => c.files.some((f) => groups[g].some((src) => underSource(f, src))))))
    for (const g of groupNames) if (!touched.some((t) => t.has(g))) emptyGroups.push(g)
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

  // A person can settle an open item in the config: `acknowledged: { conflictingTrailers: { names: [...], by, date, why } }`.
  // The item moves to `settled`, with who decided, so a tag can be written from the ledger and the decision stays visible.
  const settled = {}
  for (const [key, decision] of Object.entries(config.acknowledged ?? {})) {
    if (!open[key]) throw new Error(`acknowledged: ${key} is not an open list`)
    if (!decision.by || !decision.date || !decision.why) throw new Error(`acknowledged ${key}: by, date and why are required`)
    settled[key] = { ...decision, counts: {} }
    for (const name of decision.names ?? []) {
      if (open[key][name] === undefined) continue
      settled[key].counts[name] = open[key][name]
      delete open[key][name]
    }
  }

  const repoRows = transcripts ?? []
  const earliestForRepo = repoRows.length > 0 || prior?.transcripts?.earliestForRepo ? [prior?.transcripts?.earliestForRepo, ...repoRows.map((r) => dayOf(r.first))].filter(Boolean).sort()[0] : null
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
    order: 'Commits that name the tool, then transcript responses, then name. It indicates the biggest hand without measuring it.',
    transcriptOnlyTools: transcriptOnly,
    tools,
    stated,
    inferred,
    months: monthOut,
    pages,
    pagesApproximate: Boolean(config.pagesApproximate),
    pageBasis: config.pageBasis ?? null,
    transcripts: !readInfo && prior?.transcripts?.read ? prior.transcripts : readInfo ? { read: true, indexedAt: readInfo.indexedAt, allProjectsOnThisMac: { files: readInfo.files, earliest: readInfo.earliest }, earliestForRepo, monthsWithClaudeTrailersAndNoTranscripts: claudeMonthsWithoutTranscripts } : { read: false },
    people: { humans: humanCounts, bots: botCounts },
    harness,
    open: { ...open, unknownModels, emptyGroups },
    settled,
    limits: [
      'Commits are every commit reachable from the ref, with dates converted to UTC. A plain merge (a pull request landing, or main merged in with no tool trailer) is counted apart and ignored.',
      'A merge a tool wrote counts for the site. It lists no files, so it counts for no page. A commit with several trailers for one tool counts once. A commit a tool authored itself counts for that tool.',
      'A commit with no tool trailer may still be tool-made. No tool is dropped because a later commit lacks a trailer.',
      "A trailer names the session that committed. When a builder's branch is squashed back under the main session's trailer, the builder's model is missing from that commit.",
      'A page is credited from commits that touched a file under its groups, at the path the file had in that commit. A pure rename credits nothing. A rename with edits credits the new path. A group should list old paths too.',
      "An AI-Use trailer whose model disagrees with the commit's co-author credits nothing. It is listed under open.conflictingTrailers.",
      "Transcripts are one Mac's Claude Code sessions in a folder of this repository or a worktree of it. The ledger keeps the largest count seen. They show a model worked in the repository. They don't show which page it touched or whether it wrote anything.",
      'A model with transcripts and no trailer is credited only on a recorded decision (transcriptCredit). Sessions on another machine and in Cursor are missing. So is any worktree pruned before the first index run.',
      'Order is by commits that name the tool. It indicates the biggest hand without measuring it. A squashed pull request counts once however large.',
      'Tool use that leaves no trace (a chat window, a pasted answer, a design tool) is missing. It becomes a credit only when the owner states it.',
    ],
  }
}

/** The names a tag may carry, in order: tools with commits, transcript-only tools with a recorded decision, then stated tools. */
export function deriveTagTools({ tools, stated }) {
  const out = tools.filter((t) => t.credited).map((t) => t.tool)
  for (const e of stated ?? []) if (e.tool && !out.includes(e.tool)) out.push(e.tool)
  return out
}

/** What a ledger still has open: lists a person has to settle before a tag is written from it. */
export function openProblems(ledger) {
  const o = ledger.open ?? {}
  const out = []
  for (const [k, label] of [['unclassifiedCoAuthors', 'a co-author nothing classifies'], ['unversionedTrailers', 'an AI-Use trailer with no model version'], ['conflictingTrailers', 'an AI-Use trailer that disagrees with its commit\'s co-author'], ['unknownModels', 'a transcript model id nothing parses']]) {
    const names = Object.keys(o[k] ?? {})
    if (names.length > 0) out.push(`ledger is open: ${label}: ${names.join(', ')}`)
  }
  if ((o.emptyGroups ?? []).length > 0) out.push(`ledger is open: a page group matches no commit: ${o.emptyGroups.join(', ')}`)
  return out
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
 * What is wrong with a tag against its ledger entry: a credited tool it drops, and a tool it names that the ledger doesn't
 * record or state (an inferred model, a guess). `credited` is the entry's `tagTools`. With `order`, a tag that lists the
 * credited tools in another order than the ledger's is a problem too; the ledger's order only indicates the biggest hand.
 */
export function tagProblems(label, tag, credited, { order = false, drops = true } = {}) {
  const named = toolsOfTag(tag)
  const problems = []
  if (drops) for (const t of credited) if (!named.includes(t)) problems.push(`${label}: the tag drops ${t}, which the ledger records or states`)
  for (const t of named) if (!credited.includes(t)) problems.push(`${label}: the tag names ${t}, which the ledger neither records nor states`)
  const inOrder = credited.filter((t) => named.includes(t))
  const writtenOrder = named.filter((t) => credited.includes(t))
  if (order && problems.length === 0 && inOrder.join('|') !== writtenOrder.join('|')) problems.push(`${label}: the tag lists tools as ${named.join(' + ')}; the ledger's order is ${credited.join(' + ')}`)
  return problems
}

/** Check a site's tag record (`{ site: {tag}, pages: {page: {tag}} }`) against its ledger. Fails closed: no tags to check, or an open ledger, is a problem. */
export function checkRecord(ledger, record, opts = {}) {
  const problems = [...openProblems(ledger)]
  let checked = 0
  if (record.site?.tag) {
    checked++
    problems.push(...tagProblems('site', record.site.tag, ledger.tagTools, opts))
  }
  for (const [page, { tag }] of Object.entries(record.pages ?? {})) {
    checked++
    const entry = ledger.pages?.[page]
    if (!entry) problems.push(`${page}: the ledger has no entry for this page`)
    else if (ledger.pagesApproximate) problems.push(...tagProblems(page, tag, ledger.tagTools, { ...opts, drops: false })) // groups only approximate a page: a tag may name any site tool, and none is required
    else problems.push(...tagProblems(page, tag, entry.tagTools, opts))
  }
  if (checked === 0) problems.push('the record holds no tag to check')
  return problems
}
