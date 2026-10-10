/**
 * What triggers a workflow, read from the `on:` block, and which workflows
 * speak for a branch's health. The reader fails closed: text it does not
 * understand throws, so the fleet report says "could not check".
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { parseFlow, speaksForBranch, stripComment, workflowTriggers } from '../scripts/lib/workflowTriggers.mjs'

describe('workflowTriggers', () => {
  it('reads a scalar, a flow list, a flow map and a block list', () => {
    assert.deepEqual(workflowTriggers('on: push\n'), { events: ['push'], push: {} })
    assert.deepEqual(workflowTriggers('name: x\non: [pull_request, workflow_dispatch]\n'), { events: ['pull_request', 'workflow_dispatch'] })
    assert.deepEqual(workflowTriggers("on: {push: {branches: [main, 'rel/**']}, schedule: [{cron: '0 7 * * *'}]}\n"), {
      events: ['push', 'schedule'],
      push: { branches: ['main', 'rel/**'] },
    })
    assert.deepEqual(workflowTriggers('"on":\n  - push\n  - workflow_dispatch\n'), { events: ['push', 'workflow_dispatch'], push: {} })
  })

  it('reads push filters from a block map, with the list at the key indent or deeper, and comments', () => {
    const text = 'on:\n  push: # why\n    branches:\n    - main\n    tags:\n      - "v*" # releases\n    paths:\n      - "src/**"\n  pull_request:\njobs:\n  a: {}\n'
    assert.deepEqual(workflowTriggers(text), {
      events: ['push', 'pull_request'],
      push: { branches: ['main'], tags: ['v*'] },
    })
  })

  it('is not confused by a literal block full of trigger-shaped lines under another event', () => {
    const text = 'on:\n  workflow_dispatch:\n    inputs:\n      note:\n        description: |\n          on: push\n          push:\n            branches: [main]\n  schedule:\n    - cron: "0 1 * * *"\n'
    assert.deepEqual(workflowTriggers(text), { events: ['workflow_dispatch', 'schedule'] })
  })

  it('stops at the next top-level key, so a later `push:` in a job is not the trigger', () => {
    assert.deepEqual(workflowTriggers('on:\n  workflow_dispatch:\nenv:\n  push: 1\n'), { events: ['workflow_dispatch'] })
  })

  it('throws, rather than guessing, on a file with no readable triggers', () => {
    assert.throws(() => workflowTriggers('name: x\njobs: {}\n'), /no top-level `on:` key/)
    assert.throws(() => workflowTriggers('on:\njobs: {}\n'), /nothing under it/)
    assert.throws(() => workflowTriggers('on: [push\n'), /malformed list/)
    assert.throws(() => workflowTriggers('on:\n  push:\n    branches: [main\n'), /malformed list/)
  })

  it('does not take the word `on` inside a quoted value or a comment for the key', () => {
    assert.throws(() => workflowTriggers('# on: push\nname: "on: push"\n'), /no top-level `on:` key/)
  })
})

describe('parseFlow and stripComment', () => {
  it('parses nested flow values and null', () => {
    assert.deepEqual(parseFlow('{a: [1, "b, c"], d: ~, e: }'), { a: ['1', 'b, c'], d: null, e: null })
  })
  it('strips a comment but not a # inside quotes or a word', () => {
    assert.equal(stripComment('a: b # c'), 'a: b ')
    assert.equal(stripComment('a: "b # c"'), 'a: "b # c"')
    assert.equal(stripComment('a: b#c'), 'a: b#c')
  })
})

describe('speaksForBranch', () => {
  const verdict = (text) => speaksForBranch(workflowTriggers(text), 'main')

  it('judges a push to the branch, a schedule, and a workflow that follows another', () => {
    assert.deepEqual(verdict('on: push\n'), { judged: true })
    assert.deepEqual(verdict('on:\n  push:\n    branches: [main]\n'), { judged: true })
    assert.deepEqual(verdict('on:\n  push:\n    branches-ignore: [wip/**]\n'), { judged: true })
    assert.deepEqual(verdict('on:\n  push:\n    paths: ["src/**"]\n'), { judged: true })
    assert.deepEqual(verdict('on:\n  schedule:\n    - cron: "0 7 * * *"\n'), { judged: true })
    assert.deepEqual(verdict('on:\n  workflow_run:\n    workflows: [ci]\n'), { judged: true })
  })

  it('judges a push that has both branches and tags, matched by glob and with negation', () => {
    assert.deepEqual(verdict('on:\n  push:\n    branches: [main]\n    tags: ["v*"]\n'), { judged: true })
    assert.deepEqual(verdict("on:\n  push:\n    branches: ['**', '!wip/**']\n"), { judged: true })
    assert.deepEqual(speaksForBranch(workflowTriggers("on:\n  push:\n    branches: ['**', '!wip/**']\n"), 'wip/x'), { judged: false, why: 'push to other branches only' })
  })

  it('does not judge tag-only, manual-only, pull-request-only, reusable-only or other-branch workflows, and says why', () => {
    assert.deepEqual(verdict('on:\n  push:\n    tags: ["v*"]\n  workflow_dispatch:\n'), { judged: false, why: 'tag-only' })
    assert.deepEqual(verdict('on:\n  push:\n    tags-ignore: ["wip-*"]\n'), { judged: false, why: 'tag-only' })
    assert.deepEqual(verdict('on:\n  workflow_dispatch:\n'), { judged: false, why: 'manual only' })
    assert.deepEqual(verdict('on: [pull_request]\n'), { judged: false, why: 'pull requests only' })
    assert.deepEqual(verdict('on: workflow_call\n'), { judged: false, why: 'reusable only' })
    assert.deepEqual(verdict('on: [workflow_dispatch, workflow_call]\n'), { judged: false, why: 'manual or reusable only' })
    assert.deepEqual(verdict('on:\n  push:\n    branches: [release/**]\n'), { judged: false, why: 'push to other branches only' })
  })
})
