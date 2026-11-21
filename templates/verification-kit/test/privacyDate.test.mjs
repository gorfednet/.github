/**
 * check-privacy-date: one failing case per rule, and the near-misses that decide
 * whether a rule is as narrow as it claims. Each case builds a real git history
 * in a temp directory (made-up domains only) so the check reads a genuine diff.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { parseDate, visibleText } from '../bin/check-privacy-date.mjs'

const CHECKER = fileURLToPath(new URL('../bin/check-privacy-date.mjs', import.meta.url))
const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const sentences = Array.from({ length: 12 }, (_, i) => `We keep item number ${i} of your data for thirty days and then delete it.`).join(' ')
const stamp = (iso) => `Last changed <time datetime="${iso}">shown</time>.`

function pageHtml({ body = sentences, date = '2026-11-01', nav = 'Home About', footer = '© 2026 Example' } = {}) {
  return `<!doctype html><html><body><header><nav>${nav}</nav></header><main><h1>Privacy</h1><p>${body}</p><p>${stamp(date)}</p></main><footer>${footer}</footer></body></html>`
}

const CONFIG = {
  pages: [{
    name: 'privacy',
    file: 'privacy.html',
    region: ['<main', '</main>'],
    datePattern: 'Last changed\\s*<time[^>]*datetime="(\\d{4}-\\d\\d-\\d\\d)"[^>]*>[^<]*</time>',
  }],
}

function git(dir, args, env = {}) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
}

/** main has `base`; a branch commits `change` dated `onDay`. Returns the repo. */
function repo({ base, change, onDay = '2026-11-20T12:00:00-05:00', config = CONFIG, extraFiles = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'privdate-'))
  dirs.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'a@example.test'])
  git(dir, ['config', 'user.name', 'a'])
  writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify(config))
  writeFileSync(join(dir, 'privacy.html'), base)
  for (const [n, c] of Object.entries(extraFiles)) writeFileSync(join(dir, n), c)
  git(dir, ['add', '-A'])
  const old = { GIT_AUTHOR_DATE: '2026-11-01T12:00:00-05:00', GIT_COMMITTER_DATE: '2026-11-01T12:00:00-05:00' }
  git(dir, ['commit', '-qm', 'base'], old)
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(dir, ['checkout', '-qb', 'pr'])
  if (change !== undefined) writeFileSync(join(dir, 'privacy.html'), change)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'pr', '--allow-empty'], { GIT_AUTHOR_DATE: onDay, GIT_COMMITTER_DATE: onDay })
  return dir
}

const run = (dir, extra = []) =>
  spawnSync('node', [CHECKER, '--config', 'privacy.config.json', '--base', 'origin/main', ...extra], { cwd: dir, encoding: 'utf8' })

describe('parseDate', () => {
  it('reads the three forms and refuses the rest', () => {
    assert.equal(parseDate('2026-11-18'), '2026-11-18')
    assert.equal(parseDate('18 November 2026'), '2026-11-18')
    assert.equal(parseDate('November 18, 2026'), '2026-11-18')
    assert.equal(parseDate('2026-02-30'), null)
    assert.equal(parseDate('soon'), null)
  })
})

describe('visibleText', () => {
  it('ignores tags, comments, JSX spacers and wrapping', () => {
    assert.equal(visibleText('<p>a  <b>b</b>{\' \'}c</p><!-- x -->\n{/* y */}'), 'a b c')
  })
})

describe('check-privacy-date', () => {
  it('passes a PR that touches neither policy nor date', () => {
    const base = pageHtml()
    const r = run(repo({ base, change: base.replace('Example', 'Example Ltd') }))
    assert.equal(r.status, 0, r.stderr)
  })

  it('fails a policy change with the date left alone', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' We now also keep logs.' }) }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /policy text changed but the shown date is still 2026-11-01/)
  })

  it('passes a policy change with the date moved to the PR day', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' We now also keep logs.', date: '2026-11-20' }) }))
    assert.equal(r.status, 0, r.stderr)
  })

  it('reads the PR day in Toronto time, not UTC', () => {
    // 21:30 on 20 Nov in Toronto is 02:30 on 21 Nov in UTC.
    const r = run(repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' More.', date: '2026-11-20' }), onDay: '2026-11-20T21:30:00-05:00' }))
    assert.equal(r.status, 0, r.stderr)
  })

  it('fails a policy change dated to some other day', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' More.', date: '2026-11-18' }) }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /not the day of the latest commit that changed the policy text/)
  })

  it('warns, and does not fail, when the date moves with no visible policy change', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ date: '2026-11-20' }) }))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /::warning title=Privacy date::privacy: the date moved from 2026-11-01 to 2026-11-20/)
  })

  it('near miss: a footer-only and nav-only change stays green', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ footer: '© 2026 Example, Privacy, Terms', nav: 'Home About Contact' }) }))
    assert.equal(r.status, 0, r.stderr)
  })

  it('near miss: reflowing the markup is not a policy change', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml().replace('<p>', '<p>\n   ').replace('</p><p>', '</p>\n\n<p>') }))
    assert.equal(r.status, 0, r.stderr)
  })

  it('fails closed on a page that is not there', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml(), config: { pages: [{ ...CONFIG.pages[0], file: 'nope.html' }] } }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not exist at HEAD/)
  })

  it('fails closed on a date it cannot parse', () => {
    const bad = pageHtml().replace('2026-11-01', '2026-13-45')
    const r = run(repo({ base: bad, change: bad }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /not a date I can parse/)
  })

  it('fails closed on a page with no date line', () => {
    const none = pageHtml().replace(/Last changed[^<]*<time[^>]*>[^<]*<\/time>\./, '')
    const r = run(repo({ base: none, change: none }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /found no date/)
  })

  it('fails closed on a region that matches nothing', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml(), config: { pages: [{ ...CONFIG.pages[0], region: ['<article', '</article>'] }] } }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /matches nothing/)
  })

  it('fails closed when the region leaves almost no text', () => {
    const tiny = `<main><p>Hi.</p><p>${stamp('2026-11-01')}</p></main>`
    const r = run(repo({ base: tiny, change: tiny }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /characters of policy text/)
  })

  it('fails closed on an empty page list and an unresolvable base', () => {
    assert.equal(run(repo({ base: pageHtml(), change: pageHtml(), config: { pages: [] } })).status, 1)
    const dir = repo({ base: pageHtml(), change: pageHtml() })
    const r = spawnSync('node', [CHECKER, '--config', 'privacy.config.json', '--base', 'origin/missing'], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /failed/)
  })

  it('near miss: a date in another file is read from that file', () => {
    const cfg = { pages: [{ name: 'p', file: 'privacy.html', region: ['<main', '</main>'], dateFile: 'date.ts', datePattern: "REVISED = '(\\d{4}-\\d\\d-\\d\\d)'" }] }
    const html = pageHtml().replace(/<p>Last changed.*?<\/p>/, '')
    const dir = repo({ base: html, change: html, config: cfg, extraFiles: { 'date.ts': "export const REVISED = '2026-11-01'" } })
    assert.equal(run(dir).status, 0)
    writeFileSync(join(dir, 'date.ts'), "export const REVISED = '2026-11-20'")
    git(dir, ['commit', '-qam', 'bump'], { GIT_AUTHOR_DATE: '2026-11-20T10:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /::warning/)
  })

  it('--today overrides the commit dates', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' More.', date: '2026-12-25' }) }), ['--today', '2026-12-25'])
    assert.equal(r.status, 0, r.stderr)
  })

  it('passes a second same-day policy edit when the date already shows that day', () => {
    const base = pageHtml({ date: '2026-11-20' })
    const r = run(repo({ base, change: pageHtml({ date: '2026-11-20', body: sentences + ' A typo fix.' }) }))
    assert.equal(r.status, 0, r.stderr)
  })

  it('fails a date that moves back, even to a day the PR has a commit', () => {
    const r = run(repo({ base: pageHtml({ date: '2026-11-25' }), change: pageHtml({ date: '2026-11-20', body: sentences + ' More.' }) }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /moved back/)
  })

  it('fails when the visible date and the attribute disagree', () => {
    const cfgVisible = { pages: [{ ...CONFIG.pages[0] }] }
    const html = (shown) => pageHtml().replace('>shown<', `>${shown}<`)
    const base = html('1 November 2026')
    const change = html('1 November 2026').replace('2026-11-01', '2026-11-20').replace(sentences, sentences + ' More.')
    const r = run(repo({ base, change, config: cfgVisible }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /shown text says 1 November 2026 but the date captured is 2026-11-20/)
  })

  it('counts only commits that change the policy text', () => {
    const dir = repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' More.', date: '2026-11-22' }), onDay: '2026-11-20T12:00:00-05:00', extraFiles: {} })
    writeFileSync(join(dir, 'other.txt'), 'x')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'unrelated'], { GIT_AUTHOR_DATE: '2026-11-22T12:00:00-05:00' })
    writeFileSync(join(dir, 'privacy.html'), pageHtml({ body: sentences + ' More.', date: '2026-11-22', footer: 'other footer' }))
    git(dir, ['commit', '-qam', 'footer only'], { GIT_AUTHOR_DATE: '2026-11-22T13:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1, r.stderr)
  })

  it('a page moved with its config, text untouched, needs no date change', () => {
    const dir = repo({ base: pageHtml(), change: undefined })
    git(dir, ['mv', 'privacy.html', 'privacy-new.html'])
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], file: 'privacy-new.html' }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'move'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 0, r.stderr)
  })

  it('fails when the PR edits the policy and widens exclude to hide the edit', () => {
    const dir = repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' We now also keep logs.' }) })
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], exclude: ['We now also keep logs\\.'] }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'hide'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /changes the config's region, exclude or datePattern/)
  })

  it('fails when the PR drops a guarded page from the config', () => {
    const dir = repo({ base: pageHtml(), change: undefined })
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], name: 'other' }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'drop'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /in the base config but not in this PR's config/)
  })

  it('fails closed on an abbreviated shown date it cannot match, and reads a matching one', () => {
    const base = pageHtml().replace('>shown<', '>Nov 1, 2026<')
    const same = base.replace(sentences, sentences + ' More.').replace('2026-11-01', '2026-11-20')
    assert.equal(run(repo({ base, change: same })).status, 1)
    const ok = same.replace('Nov 1, 2026', 'Nov 20, 2026')
    assert.equal(run(repo({ base, change: ok })).status, 0)
    const dotted = same.replace('Nov 1, 2026', 'Nov. 20, 2026')
    assert.equal(run(repo({ base, change: dotted })).status, 0)
    const odd = base.replace('Nov 1, 2026', 'Foo 1, 2026')
    assert.equal(run(repo({ base: odd, change: odd })).status, 1)
  })

  it('passes a config-only PR that widens the scope while the page is untouched', () => {
    const dir = repo({ base: pageHtml(), change: undefined })
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], exclude: ['Home About'] }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'scope only'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 0, r.stderr)
  })

  it('fails closed when the base config does not parse', () => {
    const dir = repo({ base: pageHtml(), change: undefined })
    git(dir, ['checkout', '-q', 'main'])
    writeFileSync(join(dir, 'privacy.config.json'), '{ not json')
    git(dir, ['commit', '-qam', 'break'], { GIT_AUTHOR_DATE: '2026-11-02T12:00:00-05:00' })
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(dir, ['checkout', '-q', 'pr'])
    git(dir, ['rebase', '-q', '--onto', 'main', 'main~1', 'pr'], {})
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify(CONFIG))
    git(dir, ['commit', '-qam', 'fix config'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not parse/)
  })

  it('follows a renamed config, so moving it does not switch the locks off', () => {
    const dir = repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' We now also keep logs.' }) })
    git(dir, ['mv', 'privacy.config.json', 'privacy.moved.json'])
    writeFileSync(join(dir, 'privacy.moved.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], exclude: ['We now also keep logs\\.'] }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'move config'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = spawnSync('node', [CHECKER, '--config', 'privacy.moved.json', '--base', 'origin/main'], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /changes the config's region, exclude or datePattern/)
  })

  it('requires the day of the latest commit that changed the policy, not any commit day', () => {
    const dir = repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' One.', date: '2026-11-19' }), onDay: '2026-11-19T12:00:00-05:00' })
    writeFileSync(join(dir, 'privacy.html'), pageHtml({ body: sentences + ' One. Two.', date: '2026-11-19' }))
    git(dir, ['commit', '-qam', 'later edit'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /latest commit that changed the policy text \(2026-11-20\)/)
  })

  it('refuses an entry re-pointed at a copy while the old page still exists', () => {
    const dir = repo({ base: pageHtml(), change: undefined })
    writeFileSync(join(dir, 'privacy-archive.html'), pageHtml())
    writeFileSync(join(dir, 'privacy.html'), pageHtml({ body: sentences + ' We now also keep logs.' }))
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], file: 'privacy-archive.html' }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'repoint'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /still exists at HEAD/)
  })

  it('catches a policy edit when the config names the page as ./privacy.html', () => {
    const cfg = { pages: [{ ...CONFIG.pages[0], file: './privacy.html' }] }
    const dir = repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' We now also keep logs.' }), config: cfg })
    const r = run(dir)
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /shown date is still/)
  })

  it('refuses a copy as file when dateFile names the real page', () => {
    const dir = repo({ base: pageHtml(), change: undefined })
    writeFileSync(join(dir, 'privacy-archive.html'), pageHtml())
    writeFileSync(join(dir, 'privacy.html'), pageHtml({ body: sentences + ' We now also keep logs.' }))
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...CONFIG.pages[0], file: 'privacy-archive.html', dateFile: 'privacy.html' }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'repoint'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /still exists at HEAD/)
  })

  const dateFileCfg = { pages: [{ name: 'p', file: 'privacy.html', region: ['<main', '</main>'], dateFile: 'a.ts', datePattern: "REVISED = '(\\d{4}-\\d\\d-\\d\\d)'" }] }
  const dateFileRepo = () => {
    const html = pageHtml().replace(/<p>Last changed.*?<\/p>/, '')
    return repo({ base: html, change: undefined, config: dateFileCfg, extraFiles: { 'a.ts': "export const REVISED = '2026-11-01'", 'b.ts': "export const REVISED = '2026-11-01'" } })
  }

  it('lets a config-only PR move dateFile to another file', () => {
    const dir = dateFileRepo()
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...dateFileCfg.pages[0], dateFile: 'b.ts' }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'move date'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 0, r.stderr)
  })

  it('refuses a dateFile change in a PR that also edits the policy', () => {
    const dir = dateFileRepo()
    writeFileSync(join(dir, 'notes.ts'), "export const REVISED = '2026-11-20'")
    writeFileSync(join(dir, 'privacy.html'), pageHtml({ body: sentences + ' We now also keep logs.' }).replace(/<p>Last changed.*?<\/p>/, ''))
    writeFileSync(join(dir, 'privacy.config.json'), JSON.stringify({ pages: [{ ...dateFileCfg.pages[0], dateFile: 'notes.ts' }] }))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'swap date file'], { GIT_AUTHOR_DATE: '2026-11-20T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /changes the entry's dateFile/)
  })

  it('requires the latest author day across policy commits, whatever the log order', () => {
    const dir = repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' One.', date: '2026-11-20' }), onDay: '2026-11-20T12:00:00-05:00' })
    writeFileSync(join(dir, 'privacy.html'), pageHtml({ body: sentences + ' One. Two.', date: '2026-11-18' }))
    git(dir, ['commit', '-qam', 'older author day on top'], { GIT_AUTHOR_DATE: '2026-11-18T12:00:00-05:00' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /\(2026-11-20\)/)
    assert.match(r.stderr, /--reset-author/)
  })
})
