import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { easternDay, parseExemption, releaseNotes, releaseProblems, visibleText } from '../lib/deploy-plan.mjs'

const GOOD = '## Release notes\n\n- The figures page.\n\nLocal gate: gate-run make verify, exit 0, log x\nSmoke: npm run preview, read /\n'

describe('release description parsing (plan row 1.25): near misses fail closed', () => {
  it('a complete description passes', () => {
    assert.deepEqual(releaseProblems(GOOD), [])
  })

  it('a template hidden in an HTML comment or a code fence is not a release', () => {
    assert.notDeepEqual(releaseProblems(`<!--\n${GOOD}-->`), [])
    assert.notDeepEqual(releaseProblems(`\`\`\`\n${GOOD}\`\`\`\n`), [])
    assert.notDeepEqual(releaseProblems(`<!-- unclosed\n${GOOD}`), [])
    assert.equal(releaseNotes(`<!-- ${GOOD} -->`), null)
  })

  it('the gate and smoke lines are not the notes, and an empty or placeholder value is no line', () => {
    assert.match(releaseProblems('## Release notes\n\n- Local gate: x\n- Smoke: y\n').join(), /no bullet saying what ships/)
    for (const v of ['n/a', 'N/A', 'none', 'not run', 'skipped', 'TBD', '-', '...', '<log>', 'todo.', 'n/a (docs only)', 'not run yet', 'no']) {
      assert.match(releaseProblems(GOOD.replace('gate-run make verify, exit 0, log x', v)).join(), /no `Local gate:` line/, v)
    }
  })

  it('a real value that starts with a common word still counts', () => {
    assert.deepEqual(releaseProblems(GOOD.replace('gate-run make verify, exit 0, log x', 'no failures, gate-run make verify, log x')), [])
    assert.deepEqual(releaseProblems(GOOD.replace('npm run preview, read /', 'notes page and / read on npm run preview')), [])
  })

  it('a bullet under a later heading is not a note; a ### notes section ends at the next ## or ###', () => {
    assert.match(releaseProblems('## Release notes\n\nprose\n\n## Next\n\n- [ ] merge\n\nLocal gate: x\nSmoke: y').join(), /no bullet/)
    assert.equal(releaseNotes('### Release notes\n- a\n### Other\n- b').trim(), '- a')
  })

  it('an Exemption line is exactly one, of a known kind, with a reason; hidden ones do not count', () => {
    assert.equal(parseExemption('Exemption: security the token leaks').exemption, 'security')
    assert.equal(parseExemption('Exemption: Security x').kind, 'invalid')
    assert.equal(parseExemption('- Exemption: outage x').kind, 'none')
    assert.equal(parseExemption('<!-- Exemption: outage x -->').kind, 'none')
  })

  it('dates read as Toronto days', () => {
    assert.equal(easternDay(new Date('2026-11-14T03:00:00Z')), '13 November 2026')
    assert.equal(visibleText('a<!-- b -->c'), 'ac')
  })
})
