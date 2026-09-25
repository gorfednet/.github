import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { MONITOR_CLASSES, assertMonitorWorkflow, callerPlaywright } from '../scripts/monitor-class.mjs'

const caller = (playwright) =>
  [
    'name: production-healthcheck',
    'jobs:',
    '  health:',
    '    uses: gorfednet/.github/.github/workflows/production-healthcheck.yml@main',
    '    with:',
    '      site-url: https://example.test',
    playwright === undefined ? '' : `      run-playwright: ${playwright}`,
  ]
    .filter((line) => line !== '')
    .join('\n')

describe('monitorClass', () => {
  it('names every class the fleet registry is allowed to claim', () => {
    assert.deepEqual(Object.keys(MONITOR_CLASSES).sort(), [
      'active-product',
      'active-site',
      'dormant',
      'org-shared',
      'static-marketing',
      'tool',
    ])
  })

  it('treats an omitted run-playwright as the shared default of true', () => {
    assert.equal(callerPlaywright(caller(undefined)), 'omitted')
    assert.equal(callerPlaywright(caller('false')), false)
    assert.equal(callerPlaywright(caller('true')), true)
  })

  it('fails the 4thcltr shape: static/active-site caller that inherits Playwright', () => {
    const problem = assertMonitorWorkflow('static-marketing', new Map([['.github/workflows/production-healthcheck.yml', caller(undefined)]]))
    assert.match(problem, /forbids live Playwright/)
    assert.match(problem, /defaults to true/)
  })

  it('accepts an explicit false on a quiet site', () => {
    assert.equal(
      assertMonitorWorkflow(
        'static-marketing',
        new Map([['.github/workflows/production-healthcheck.yml', caller('false')]]),
      ),
      null,
    )
  })

  it('lets an active product keep Playwright', () => {
    assert.equal(
      assertMonitorWorkflow(
        'active-product',
        new Map([['.github/workflows/production-healthcheck.yml', caller(undefined)]]),
      ),
      null,
    )
  })

  it('does not treat the reusable workflow itself as a caller', () => {
    const reusable = 'on:\n  workflow_call:\n    inputs:\n      run-playwright:\n        default: true\n'
    assert.equal(assertMonitorWorkflow('org-shared', new Map([['.github/workflows/production-healthcheck.yml', reusable]])), null)
  })
})
