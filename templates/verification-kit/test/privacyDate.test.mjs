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
    assert.match(r.stderr, /not the day of any commit/)
  })

  it('fails a date that moves with no policy change', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ date: '2026-11-20' }) }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /date moved from 2026-11-01 to 2026-11-20 but the policy text did not change/)
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
    assert.equal(r.status, 1)
    assert.match(r.stderr, /date moved/)
  })

  it('--today overrides the commit dates', () => {
    const r = run(repo({ base: pageHtml(), change: pageHtml({ body: sentences + ' More.', date: '2026-12-25' }) }), ['--today', '2026-12-25'])
    assert.equal(r.status, 0, r.stderr)
  })
})
