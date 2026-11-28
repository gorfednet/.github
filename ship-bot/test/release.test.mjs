import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planDeploy } from '../lib/deploy-plan.mjs'
import { planRelease } from '../lib/release.mjs'

const REL = { tagPrefix: 'v' }
const TAGS = ['v3.9.5', 'v3.9.6', 'v3.10.2', 'nightly', 'v9', 'v4.0.0-rc1', 'other-9.9.9']

describe('planRelease: the automatic patch tag for a description with no Release line (plan row 1.101)', () => {
  it('no line: one patch above the newest tag by version order, with the title as the sentence', () => {
    assert.deepEqual(planRelease(REL, 'Just a fix.', TAGS, { title: 'Fix the rates table' }), { kind: 'release', version: '3.10.3', tag: 'v3.10.3', message: 'Fix the rates table', auto: true })
    assert.equal(planRelease(REL, '', ['v3.9.9', 'v3.9.10'], { title: 'x' }).tag, 'v3.9.11')
    // The tag list comes in no order: the newest is found by version, wherever it sits.
    assert.equal(planRelease(REL, '', ['v3.10.2', 'v3.9.6', 'v3.2.40'], { title: 'x' }).tag, 'v3.10.3')
    assert.equal(planRelease(REL, '', ['v3.10.2', 'v3.9.6'], { title: '#412 follow-up' }).message, '#412 follow-up')
    assert.equal(planRelease({ tagPrefix: 'site-' }, null, ['site-1.2.3', 'v9.9.9'], { title: 'x' }).tag, 'site-1.2.4')
  })

  it('a patch line: the stated version and its own sentence, never the title', () => {
    assert.deepEqual(planRelease(REL, 'Release: 3.10.3 The site reads the new figures.', TAGS, { title: 'Fix the rates table' }), { kind: 'release', version: '3.10.3', tag: 'v3.10.3', message: 'The site reads the new figures.' })
  })

  it('a higher line: a minor or a major bump wins over the automatic patch', () => {
    assert.equal(planRelease(REL, 'Release: 3.11.0 A new page.', TAGS, { title: 'Fix' }).tag, 'v3.11.0')
    assert.equal(planRelease(REL, 'Release: 4.0.0 The new site.', TAGS, { title: 'Fix' }).tag, 'v4.0.0')
  })

  it('a wrong line is still refused: the title never rescues it', () => {
    assert.match(planRelease(REL, 'Release: 3.9.6 Old.', TAGS, { title: 'Fix' }).reason, /already exists/)
    assert.match(planRelease(REL, 'Release: 3.10.1 Lower.', TAGS, { title: 'Fix' }).reason, /must be higher than the newest tag v3\.10\.2/)
    assert.match(planRelease(REL, 'release: 3.10.3 Lower case.', TAGS, { title: 'Fix' }).reason, /needs a version and a sentence/)
    assert.equal(planRelease(REL, 'Release: nonsense', TAGS, { title: 'Fix' }).auto, undefined)
  })

  it('no line and no title given: no release, as before (a row that deploys only from a labelled release)', () => {
    assert.deepEqual(planRelease(REL, 'Just a fix.', TAGS), { kind: 'none' })
    assert.deepEqual(planRelease(REL, 'Just a fix.', TAGS, {}), { kind: 'none' })
  })

  it('no line and nothing to plan from fails closed: no tag to bump, or a title that is empty, too long or has a control character', () => {
    const auto = (title, tags = TAGS) => planRelease(REL, 'Just a fix.', tags, { title })
    assert.deepEqual({ ...auto('Fix', ['nightly', 'v3.9', 'other-1.2.3']), reason: undefined }, { kind: 'invalid', auto: true, reason: undefined })
    assert.match(auto('Fix', []).reason, /no vX\.Y\.Z tag to bump/)
    for (const empty of ['', '   ', '\n\t', null]) assert.match(auto(empty).reason, /title is empty/, JSON.stringify(empty))
    assert.match(auto('x'.repeat(301)).reason, /title is 301 characters; the limit is 300/)
    assert.equal(auto('x'.repeat(300)).kind, 'release')
    assert.match(auto('Fix\u0000 it').reason, /control character/)
    assert.match(auto('Fix\u001b[31m it').reason, /control character/)
    assert.equal(auto('  Fix \t the\n thing  ').message, 'Fix the thing')
  })
})

describe('planDeploy: which rows tag automatically', () => {
  const ctx = { tags: async () => TAGS, mainSha: async () => 'a', headCovers: async () => 'ahead', repoState: {} }
  const pr = (over = {}) => ({ title: 'Fix the rates table', body: 'Just a fix.', labels: [], ...over })

  it('a deployOn "merge" tag row with no line deploys with the automatic tag', async () => {
    const plan = await planDeploy({ release: REL, deployOn: 'merge' }, pr(), ctx)
    assert.deepEqual(plan, { deploy: true, kind: 'merge', tag: { kind: 'release', version: '3.10.3', tag: 'v3.10.3', message: 'Fix the rates table', auto: true } })
  })

  it('a deployOn "merge" tag row never deploys untagged: a title that cannot be the sentence stops the merge', async () => {
    const plan = await planDeploy({ release: REL, deployOn: 'merge' }, pr({ title: undefined }), ctx)
    assert.equal(plan.deploy, false)
    assert.equal(plan.kind, 'invalid')
    assert.equal(plan.key, 'release-auto')
  })

  it('a wrong line on a "merge" row keeps its own reason and key', async () => {
    const plan = await planDeploy({ release: REL, deployOn: 'merge' }, pr({ body: 'Release: 3.9.6 Old.' }), ctx)
    assert.equal(plan.key, 'release-line')
    assert.match(plan.reason, /the `Release:` line is wrong: tag v3\.9\.6 already exists/)
  })

  it('a deployOn "release" tag row is unchanged: no line and no label is a plain merge, and a labelled one still needs its line', async () => {
    assert.deepEqual(await planDeploy({ release: REL, deployOn: 'release' }, pr(), ctx), { deploy: false, kind: 'none' })
    const labelled = await planDeploy({ release: REL, deployOn: 'release' }, pr({ labels: [{ name: 'release' }] }), ctx)
    assert.match(labelled.reason, /needs a `Release: X\.Y\.Z One sentence\.` line/)
    const hotfix = await planDeploy({ release: REL, deployOn: 'release' }, pr({ labels: [{ name: 'hotfix' }], body: 'Exemption: outage down' }), ctx)
    assert.match(hotfix.reason, /needs a `Release: X\.Y\.Z One sentence\.` line/)
  })

  it('a row with no release key is untouched by the title', async () => {
    assert.deepEqual(await planDeploy({ release: null, deployOn: 'merge' }, pr(), ctx), { deploy: true, kind: 'merge', tag: null })
  })
})
