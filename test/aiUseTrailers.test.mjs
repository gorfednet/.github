/**
 * The AI Use Levels trailer gate (scripts/gates/check-ai-use-trailers.mjs). Runs the real script over
 * throwaway git repositories, against a copy of ai-use-levels v1.3.0 (test/fixtures/ai-use-levels-1.3.0).
 *
 * Audit of 21 November 2026 (plan row 1.90): since 18 November, 50 agent commits reached main with a
 * Door that isn't one (`no-undo`), 32 with no tag, 126 with no AI-Use-Standing line, and 10 with the
 * tools out of order. check-trailers.mjs in ai-use-levels passes a commit with no tag and never
 * requires the pointer, so nothing caught them. Each failure below is one of those, planted.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const SCRIPT = path.resolve('scripts/gates/check-ai-use-trailers.mjs')
const SPEC_DIR = path.resolve('test/fixtures/ai-use-levels-1.3.0')
const POINTER = 'AI-Use-Standing: https://example.org/docs/delegation.md 2026-11-18'
const CO = (...models) => models.map((m) => `Co-Authored-By: Claude ${m} <noreply@example.org>`).join('\n')

const dirs = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}

/** A repository on `main` with one root commit, and a branch `topic` carrying the given messages. */
function repo(messages, { mergeMainBad = false, mergeMessage = 'Merge main into topic' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-use-trailers-'))
  dirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'dev@example.org')
  git(dir, 'config', 'user.name', 'Dev')
  writeFileSync(path.join(dir, 'a.txt'), 'root\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'root')
  git(dir, 'checkout', '-q', '-b', 'topic')
  messages.forEach((message, i) => {
    writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', message)
  })
  if (mergeMainBad) {
    // main gains an agent commit with no tag. Merging it into the topic must not make it the PR's own.
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(path.join(dir, 'other.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `Untagged work on main\n\n${CO('Sonnet 5.5')}`)
    git(dir, 'checkout', '-q', 'topic')
    git(dir, 'merge', '-q', '--no-ff', 'main', '-m', mergeMessage)
  }
  return dir
}

function gate(dir, ...extra) {
  const run = spawnSync('node', [SCRIPT, '--spec-dir', SPEC_DIR, '--base', 'main', '--head', 'topic', ...extra], { cwd: dir, encoding: 'utf8' })
  return { code: run.status, out: run.stdout, err: run.stderr }
}

const good = (tool = 'Claude Sonnet 5.5', models = ['Sonnet 5.5']) =>
  `Change\n\n${CO(...models)}\nAI-Use: L3 made undo unread (${tool})\n${POINTER}`

describe('an agent commit that follows the rules', () => {
  it('passes, and the count says it was read', () => {
    const run = gate(repo([good()]))
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /1 commit\(s\), 1 with a Claude co-author, 0 bad/)
  })

  it('passes with two tools in models.json order and both named in Co-Authored-By', () => {
    const run = gate(repo([good('Claude Fable 5.2 + Claude Sonnet 5.5', ['Fable 5.2', 'Sonnet 5.5'])]))
    assert.equal(run.code, 0, run.err)
  })
})

describe('each gap the audit found fails', () => {
  const cases = [
    ['no tag', `Change\n\n${CO('Sonnet 5.5')}`, /no AI-Use trailer/],
    ['a Door that is not one (no-undo)', `Change\n\n${CO('Sonnet 5.5')}\nAI-Use: L3 made no-undo (Claude Sonnet 5.5)\n${POINTER}`, /unknown token at "no-undo"/],
    ['no pointer', `Change\n\n${CO('Sonnet 5.5')}\nAI-Use: L3 made undo unread (Claude Sonnet 5.5)`, /no AI-Use-Standing line/],
    ['tools out of order', good('Claude Sonnet 5.5 + Claude Fable 5.2', ['Sonnet 5.5', 'Fable 5.2']), /out of order, expected Claude Fable 5\.2 \+ Claude Sonnet 5\.5/],
    ['a model the Co-Authored-By lacks', good('Claude Fable 5.2 + Claude Sonnet 5.5', ['Sonnet 5.5']), /Co-Authored-By names Sonnet 5\.5, the tag names Fable 5\.2 \+ Sonnet 5\.5/],
    ['a pointer to a path a reader cannot open', `Change\n\n${CO('Sonnet 5.5')}\nAI-Use: L3 made undo unread (Claude Sonnet 5.5)\nAI-Use-Standing: docs/delegation.md 2026-11-18`, /must be an https URL/],
    ['a tag with no Claude co-author line at all (bad Door still read)', `Change\n\nAI-Use: L3 made no-undo (Claude Sonnet 5.5)`, /unknown token at "no-undo"/],
    ['a co-authored commit rated L0', `Change\n\n${CO('Sonnet 5.5')}\nAI-Use: L0\n${POINTER}`, /an agent commit is L3, or L2/],
    ['a version suffix that hides out-of-order tools', `Change\n\n${CO('Sonnet 5.5', 'Fable 5.2')}\nAI-Use: L3 made undo unread (Claude Sonnet 5.5 + Claude Fable 5.2) v1\n${POINTER}`, /out of order/],
    ['two AI-Use lines', `${good()}\nAI-Use: L3 made undo unread (Claude Sonnet 5.5)`, /2 AI-Use lines/],
    ['two pointers', `${good()}\n${POINTER}`, /2 AI-Use-Standing lines/],
    ['L1 with a Door', `Change\n\n${CO('Sonnet 5.5')}\nAI-Use: L1 undo (Claude Sonnet 5.5)\n${POINTER}`, /L1 takes no Door/],
  ]
  for (const [name, message, pattern] of cases) {
    it(`fails on ${name}`, () => {
      const run = gate(repo([message]))
      assert.equal(run.code, 1)
      assert.match(run.err, pattern)
    })
  }

  it('names the bad commit and passes the good one beside it', () => {
    const dir = repo([good(), `Change\n\n${CO('Sonnet 5.5')}`])
    const run = gate(dir)
    assert.equal(run.code, 1)
    assert.ok(run.err.startsWith(git(dir, 'rev-parse', 'topic').slice(0, 9)), run.err)
    assert.match(run.out, /2 commit\(s\), 2 with a Claude co-author, 1 bad/)
  })
})

describe('near misses that must pass', () => {
  it('a commit with no Claude co-author and no tag claims nothing', () => {
    const run = gate(repo(['Plain commit by a person']))
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /0 with a Claude co-author/)
  })

  it('an untagged agent commit already on main, merged into the topic, is not the PR\'s own', () => {
    const run = gate(repo([good()], { mergeMainBad: true }))
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /2 commit\(s\)/)
  })

  it('an agent merge commit with no tag takes no line', () => {
    const run = gate(repo([good()], { mergeMainBad: true, mergeMessage: `Merge main into topic\n\n${CO('Sonnet 5.5')}` }))
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /2 commit\(s\), 2 with a Claude co-author, 0 bad/)
  })

  it('a tagged agent merge commit is checked like any other', () => {
    const run = gate(repo([good()], { mergeMainBad: true, mergeMessage: `Merge main\n\n${CO('Sonnet 5.5')}\nAI-Use: L3 made no-undo (Claude Sonnet 5.5)\n${POINTER}` }))
    assert.equal(run.code, 1)
    assert.match(run.err, /unknown token at "no-undo"/)
  })

  it('a good commit with an indented quoted tag beside its real one passes', () => {
    const run = gate(repo([`${good()}\n    AI-Use: L3 made no-undo (Claude Sonnet 5.5)`]))
    assert.equal(run.code, 0, run.err)
  })

  it('an indented quoted tag alone leaves the commit untagged, so it fails', () => {
    const run = gate(repo([`Change\n\n${CO('Sonnet 5.5')}\n    AI-Use: L3 made undo unread (Claude Sonnet 5.5)`]))
    assert.equal(run.code, 1)
    assert.match(run.err, /no AI-Use trailer/)
  })
})

describe('tags the spec allows', () => {
  it('passes a non-model tool and a reach parenthetical beside a Claude model', () => {
    const run = gate(repo([good('Claude Opus 5.5 + Cursor', ['Opus 5.5']), good('Claude Opus 5.5 (agent)', ['Opus 5.5'])]))
    assert.equal(run.code, 0, run.err)
  })

  it('passes a person\'s own tag with no Claude co-author and no pointer', () => {
    const run = gate(repo(['Change\n\nAI-Use: L1 drafted (Claude Opus 5.5)']))
    assert.equal(run.code, 0, run.err)
  })
})

describe('review round 2', () => {
  it('a model newer than the pinned list still matches its Co-Authored-By', () => {
    const run = gate(repo([good('Claude Opus 9.9', ['Opus 9.9'])]))
    assert.equal(run.code, 0, run.err)
  })

  it('a pointer with no tag beside it fails, on a merge commit too', () => {
    const run = gate(repo([good()], { mergeMainBad: true, mergeMessage: 'Merge main\n\nAI-Use-Standing: docs/x.md 2026-02-30' }))
    assert.equal(run.code, 1)
    assert.match(run.err, /no AI-Use tag beside it/)
  })
})

describe('a later commit corrects a pushed one (never a rewrite)', () => {
  it('passes when a good later commit names the bad one', () => {
    const dir = repo([`Change\n\n${CO('Sonnet 5.5')}`])
    const bad = git(dir, 'rev-parse', 'topic').slice(0, 9)
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `${good()}\nAI-Use-Corrects: ${bad}`)
    const run = gate(dir)
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /1 corrected by a later commit/)
  })

  it('fails when the correcting commit carries no tag at all', () => {
    const dir = repo([`Change\n\n${CO('Sonnet 5.5')}`])
    const bad = git(dir, 'rev-parse', 'topic').slice(0, 9)
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `fixup\n\nAI-Use-Corrects: ${bad}`)
    assert.equal(gate(dir).code, 1)
  })

  it('fails when the correcting commit is itself bad', () => {
    const dir = repo([`Change\n\n${CO('Sonnet 5.5')}`])
    const bad = git(dir, 'rev-parse', 'topic').slice(0, 9)
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `Fix\n\n${CO('Sonnet 5.5')}\nAI-Use-Corrects: ${bad}`)
    assert.equal(gate(dir).code, 1)
  })

  it('fails when the named prefix matches another commit', () => {
    const dir = repo([`Change\n\n${CO('Sonnet 5.5')}`])
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `${good()}\nAI-Use-Corrects: 0000000`)
    assert.equal(gate(dir).code, 1)
  })
})

describe('an exempt repository (--exempt)', () => {
  it('passes a commit with no trailer', () => {
    const run = gate(repo([`Change\n\n${CO('Sonnet 5.5')}`]), '--exempt')
    assert.equal(run.code, 0, run.err)
  })

  it('fails a commit that carries only a pointer', () => {
    const run = gate(repo([`Change\n\n${CO('Sonnet 5.5')}\n${POINTER}`]), '--exempt')
    assert.equal(run.code, 1)
  })

  it('fails a commit that carries a tag, even a well formed one', () => {
    const run = gate(repo([good()]), '--exempt')
    assert.equal(run.code, 1)
    assert.match(run.err, /exempts this repository/)
  })
})

/** A topic that edits a.txt against a main that edits it too, merged with the given strategy. */
function conflictRepo(strategy, message) {
  const dir = repo([good()])
  git(dir, 'checkout', '-q', 'main')
  writeFileSync(path.join(dir, 'a.txt'), 'main side\n')
  git(dir, 'commit', '-q', '-am', 'main edits a')
  git(dir, 'checkout', '-q', 'topic')
  writeFileSync(path.join(dir, 'a.txt'), 'topic side\n')
  git(dir, 'commit', '-q', '-am', `Edit a\n\n${good()}`)
  spawnSync('git', ['merge', '--no-ff', ...(strategy === 'ours' ? ['-s', 'ours'] : []), 'main', '-m', message], { cwd: dir, encoding: 'utf8' })
  if (strategy === 'resolve') {
    writeFileSync(path.join(dir, 'a.txt'), 'resolved by hand\n')
    git(dir, 'commit', '-q', '-a', '-m', message)
  }
  return dir
}

describe('row 1.90a preconditions', () => {
  const untaggedMerge = `Merge main\n\n${CO('Sonnet 5.5')}`

  it('an untagged agent merge that resolved a conflict by hand fails', () => {
    const run = gate(conflictRepo('resolve', untaggedMerge))
    assert.equal(run.code, 1)
    assert.match(run.err, /merge commit .* conflict|differs from a fresh merge/)
  })

  it('an untagged agent merge made with -s ours fails (it hides a dropped side)', () => {
    const run = gate(conflictRepo('ours', untaggedMerge))
    assert.equal(run.code, 1)
    assert.match(run.err, /differs from a fresh merge|conflict/)
  })

  it('the same conflicted merge passes once it carries a good tag', () => {
    const run = gate(conflictRepo('resolve', `Merge main\n\n${good()}`))
    assert.equal(run.code, 0, run.err)
  })

  it('an unlisted versioned Claude model skips the tool order check', () => {
    const run = gate(repo([good('Claude Opus 9.9 + Claude Fable 5.2', ['Opus 9.9', 'Fable 5.2'])]))
    assert.equal(run.code, 0, run.err)
  })

  it('near miss: an unlisted tool that is not a Claude model still fails the order check', () => {
    const run = gate(repo([good('Gemini 3 + Claude Fable 5.2', ['Fable 5.2'])]))
    assert.equal(run.code, 1)
    assert.match(run.err, /out of order/)
  })

  it('near miss: an unlisted Claude model still has to be named in Co-Authored-By', () => {
    const run = gate(repo([good('Claude Opus 9.9 + Claude Fable 5.2', ['Fable 5.2'])]))
    assert.equal(run.code, 1)
    assert.match(run.err, /Co-Authored-By names/)
  })

  it('--since skips a commit authored before the cutoff and says so', () => {
    const dir = repo([])
    git(dir, 'checkout', '-q', 'topic')
    writeFileSync(path.join(dir, 'old.txt'), 'x\n')
    git(dir, 'add', '.')
    spawnSync('git', ['commit', '-q', '-m', `Old work\n\n${CO('Sonnet 5.5')}`], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-01T12:00:00Z' } })
    const noCutoff = gate(dir)
    assert.equal(noCutoff.code, 1)
    const run = gate(dir, '--since', '2026-11-18')
    assert.equal(run.code, 1, 'every commit skipped means nothing was checked')
    assert.match(run.err, /nothing was checked/)
    writeFileSync(path.join(dir, 'new.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', good())
    const both = gate(dir, '--since', '2026-11-18')
    assert.equal(both.code, 0, both.err)
    assert.match(both.out, /1 skipped before 2026-11-18/)
  })

  it('--since needs a date', () => {
    const run = gate(repo([good()]), '--since', 'yesterday')
    assert.equal(run.code, 2)
  })

  it('exempt: a later commit with no tag corrects a pushed commit that carries one', () => {
    const dir = repo([good()])
    const bad = git(dir, 'rev-parse', 'topic').slice(0, 9)
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `Fix\n\nAI-Use-Corrects: ${bad}`)
    const run = gate(dir, '--exempt')
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /1 corrected by a later commit/)
  })

  it('exempt: a correcting commit that carries a tag itself does not correct', () => {
    const dir = repo([good()])
    const bad = git(dir, 'rev-parse', 'topic').slice(0, 9)
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `${good()}\nAI-Use-Corrects: ${bad}`)
    assert.equal(gate(dir, '--exempt').code, 1)
  })

  it('exempt: a corrector naming no commit in the range corrects nothing', () => {
    const dir = repo([good()])
    writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'Fix\n\nAI-Use-Corrects: 0000000')
    assert.equal(gate(dir, '--exempt').code, 1)
  })
})

describe('arguments and an empty range fail closed', () => {
  it('exits 2 without --spec-dir', () => {
    const dir = repo([good()])
    const run = spawnSync('node', [SCRIPT, '--base', 'main'], { cwd: dir, encoding: 'utf8' })
    assert.equal(run.status, 2)
  })

  it('exits 1 when the range holds no commit', () => {
    const dir = repo([good()])
    git(dir, 'checkout', '-q', 'main')
    const run = spawnSync('node', [SCRIPT, '--spec-dir', SPEC_DIR, '--base', 'main', '--head', 'main'], { cwd: dir, encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /nothing was checked/)
  })

  it('exits 1 when the base ref does not exist', () => {
    const dir = repo([good()])
    const run = spawnSync('node', [SCRIPT, '--spec-dir', SPEC_DIR, '--base', 'nope', '--head', 'topic'], { cwd: dir, encoding: 'utf8' })
    assert.equal(run.status, 1)
  })
})

describe('the reusable workflow', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync('.github/workflows/ai-use-trailers.yml', 'utf8')
  const readme = readFileSync('test/fixtures/ai-use-levels-1.3.0/README.md', 'utf8')

  it('pins the spec checkout to the commit the test fixture was copied from', () => {
    const pin = /repository: gorfednet\/ai-use-levels\n\s+# v1\.3\.0\n\s+ref: ([0-9a-f]{40})/.exec(workflow)?.[1]
    assert.ok(pin, 'the spec checkout has no 40-character ref')
    assert.ok(readme.includes(pin), 'the fixture README names another commit than the workflow pins')
  })

  it('runs the gate on every outcome of an earlier step', () => {
    const run = workflow.slice(workflow.indexOf('- name: Check the trailers'))
    assert.match(run, /if: \$\{\{ !cancelled\(\) \}\}/)
    assert.match(run, /set -euo pipefail/)
  })

  it('checks the gate out at a gate-ref input that defaults to main, and passes the cutoff', () => {
    assert.match(workflow, /gate-ref:\n(?:.*\n)*?\s+default: 'main'/)
    assert.match(workflow, /ref: \$\{\{ inputs\.gate-ref \}\}/)
    assert.match(workflow, /--since "\$SINCE"/)
    assert.doesNotMatch(workflow, /never reads a moving target/)
  })

  it('reads the head from the event, not from a moving ref', () => {
    assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  })

  it('pins every action by commit', () => {
    for (const use of workflow.matchAll(/uses: (\S+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/, use[1])
  })
})
