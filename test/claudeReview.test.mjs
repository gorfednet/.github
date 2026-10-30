/**
 * The shared Claude reviewer: its verdict parser, the script that builds what it reads, and the
 * shape of the workflow, action and caller template. Ported from bindercurve.com's
 * reviewVerdict.test.ts, review-input.test.ts and claudeReviewWorkflow.contract.test.ts, which pin
 * the same properties there.
 *
 * The reviewer is a merge gate. On 2026-10-17 a 384-file release train was reviewed through
 * `gh pr diff`, which GitHub refuses past 300 files, so the reviewer saw one or two commits and
 * still wrote a clean verdict. And the job holds the owner's Claude token and a token that can
 * write to the pull request while its checkout is the pull request's head, so nothing from that
 * checkout may run in it.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { buildReviewInput } from '../.github/actions/review-input/review-input.mjs'
import { claudeReviewVerdict, REVIEW_BOT_LOGIN } from '../scripts/lib/reviewVerdict.mjs'

const workflow = readFileSync('.github/workflows/claude-review.yml', 'utf8')
const action = readFileSync('.github/actions/review-input/action.yml', 'utf8')
const template = readFileSync('templates/claude-review.yml', 'utf8')
const scriptSource = readFileSync('.github/actions/review-input/review-input.mjs', 'utf8')

/** The text of one workflow step: from its `- name:` line to the next step. Throws when missing. */
function step(text, name) {
  const start = text.indexOf(`- name: ${name}\n`)
  if (start === -1) throw new Error(`no step named "${name}"`)
  const next = text.indexOf('\n      - ', start + 1)
  return text.slice(start, next === -1 ? undefined : next)
}

describe('claudeReviewVerdict', () => {
  const HEAD = 'a'.repeat(40)
  const OLD = 'b'.repeat(40)
  const bot = (body, created_at = '2026-10-13T10:00:00Z') => ({ body, user: { login: REVIEW_BOT_LOGIN }, html_url: 'https://x/1', created_at })
  const line = (head, findings) => `Reviewed.\n<!-- claude-review head=${head} findings=${findings} -->`

  it('is clean for a bot verdict on the head with no findings', () => {
    assert.equal(claudeReviewVerdict([bot(line(HEAD, 0))], HEAD).state, 'clean')
  })

  it('reports findings with their count', () => {
    const verdict = claudeReviewVerdict([bot(line(HEAD, 3))], HEAD)
    assert.equal(verdict.state, 'findings')
    assert.equal(verdict.findings, 3)
  })

  it('is not-run when only an earlier head was reviewed', () => {
    const verdict = claudeReviewVerdict([bot(line(OLD, 0))], HEAD)
    assert.equal(verdict.state, 'not-run')
    assert.deepEqual(verdict.reviewedHeads, [OLD])
  })

  it('ignores a verdict line a person pasted', () => {
    assert.equal(claudeReviewVerdict([{ body: line(HEAD, 0), user: { login: 'gorfednet' } }], HEAD).state, 'not-run')
  })

  it('takes the latest verdict for the head when it was reviewed twice', () => {
    const verdict = claudeReviewVerdict([bot(line(HEAD, 2), '2026-10-13T10:00:00Z'), bot(line(HEAD, 0), '2026-10-13T11:00:00Z')], HEAD)
    assert.equal(verdict.state, 'clean')
  })

  it('ignores bot comments without the marker or with a malformed one', () => {
    assert.equal(claudeReviewVerdict([bot('All good!'), bot('<!-- claude-review head=abc findings=0 -->')], HEAD).state, 'not-run')
  })
})

describe('buildReviewInput', { timeout: 60_000 }, () => {
  const dirs = []
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  /** A git environment that cannot reach the developer's own repository or config. */
  function cleanEnv() {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
    return {
      ...env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    }
  }

  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'review-input-'))
    dirs.push(dir)
    const git = (...args) =>
      execFileSync('git', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const write = (file, text) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    const commit = (message) => {
      git('add', '-A')
      git('commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q', '-b', 'main')
    return { dir, git, write, commit }
  }

  const read = (out, name) => readFileSync(join(out, name), 'utf8')

  it('writes the whole diff for a plain branch, and no train files', () => {
    const repo = makeRepo()
    repo.write('a.txt', 'one\ntwo\nthree\n')
    const base = repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('a.txt', 'one\nTWO-CHANGED\nthree\n')
    repo.write('src/new.ts', 'export const added = 1\n')
    const head = repo.commit('feature work')
    const out = join(repo.dir, 'out')

    const result = buildReviewInput({ repoDir: repo.dir, base, head, outDir: out })

    assert.equal(result.train, false)
    assert.match(read(out, 'full.diff'), /\+TWO-CHANGED/)
    assert.match(read(out, 'full.diff'), /\+export const added = 1/)
    assert.match(read(out, 'files.txt'), /src\/new\.ts/)
    assert.match(read(out, 'README.txt'), /^MODE: ordinary/m)
    for (const name of ['merges.diff', 'own.diff', 'carried.txt']) assert.equal(existsSync(join(out, name)), false, name)
  })

  it('throws on a base that does not exist rather than writing empty input', () => {
    const repo = makeRepo()
    repo.write('a.txt', 'x\n')
    const head = repo.commit('base')
    assert.throws(() => buildReviewInput({ repoDir: repo.dir, base: '0'.repeat(40), head, outDir: join(repo.dir, 'out') }))
  })

  it('reports a release train and isolates the hand-made resolution and the train’s own commits', () => {
    const repo = makeRepo()
    repo.write('shared.txt', 'alpha\nbeta\ngamma\n')
    const base = repo.commit('base')
    repo.git('checkout', '-q', '-b', 'carried-x', base)
    repo.write('shared.txt', 'X-SIDE-LINE\nbeta\ngamma\n')
    repo.write('x-only.ts', 'export const carriedX = "carried-x-content"\n')
    repo.commit('carried x work')
    repo.git('checkout', '-q', '-b', 'carried-y', base)
    repo.write('shared.txt', 'Y-SIDE-LINE\nbeta\ngamma\n')
    repo.commit('carried y work')
    repo.git('checkout', '-q', '-b', 'train', base)
    repo.git('merge', '--no-ff', '-q', '-m', 'Merge carried x', 'carried-x')
    assert.throws(() => repo.git('merge', '--no-ff', '-m', 'Merge carried y', 'carried-y'))
    repo.write('shared.txt', 'HAND-RESOLVED-LINE\nbeta\ngamma\n')
    repo.git('add', 'shared.txt')
    repo.git('commit', '-q', '--no-edit')
    repo.write('train-fix.ts', 'export const fix = "written-on-the-train"\n')
    const head = repo.commit('fix on the train')
    const out = join(repo.dir, 'out')

    const result = buildReviewInput({ repoDir: repo.dir, base, head, outDir: out })

    assert.equal(result.train, true)
    assert.match(read(out, 'README.txt'), /^MODE: train/m)
    assert.match(read(out, 'merges.diff'), /HAND-RESOLVED-LINE/)
    assert.match(read(out, 'own.diff'), /written-on-the-train/)
    assert.doesNotMatch(read(out, 'own.diff'), /carried-x-content/)
    assert.match(read(out, 'carried.txt'), /carried branch/)
  })
})

describe('the shared workflow reads the whole diff', () => {
  it('builds the review input after a full-history checkout and before the review', () => {
    const checkout = workflow.indexOf('actions/checkout@')
    const build = workflow.indexOf('- name: Build the review input')
    const review = workflow.indexOf('- name: Review\n')
    assert.ok(checkout > -1 && build > checkout && review > build, 'checkout, build, review in that order')
    assert.match(workflow, /fetch-depth: 0\n/)
  })

  it('resolves the base sha beside the head', () => {
    const body = step(workflow, 'Resolve the pull request head')
    assert.match(body, /\.base\.sha/)
    assert.match(body, /echo "base=.*" >> "\$GITHUB_OUTPUT"/)
  })

  it('tells the reviewer to read the README and review a train from merges.diff and own.diff', () => {
    const body = step(workflow, 'Review')
    for (const file of ['review-input/README.txt', 'review-input/full.diff', 'review-input/merges.diff', 'review-input/own.diff']) {
      assert.ok(body.includes(file), file)
    }
  })
})

describe('the review job never runs code from the checkout under review', () => {
  it('builds the input with the action from gorfednet/.github, not a path in the checkout', () => {
    const body = step(workflow, 'Build the review input')
    assert.match(body, /uses: gorfednet\/\.github\/\.github\/actions\/review-input@main\n/)
    assert.doesNotMatch(body, /uses: \.\//)
    assert.doesNotMatch(body, /\brun:/)
  })

  it('runs the action’s own copy of the script, with an empty environment', () => {
    const body = step(action, 'Build the review input')
    assert.match(body, /env -i PATH="\$\{PATH\}" HOME="\$\{HOME\}" node "\$\{GITHUB_ACTION_PATH\}\/review-input\.mjs"/)
    const runs = body.split('\n').filter((line) => /\bnode\b/.test(line) && !line.trim().startsWith('#'))
    assert.ok(runs.length > 0)
    for (const line of runs) assert.ok(line.includes('"${GITHUB_ACTION_PATH}/review-input.mjs"'), line)
    assert.doesNotMatch(body, /\b(bash|sh|python3?)\s+(\.\/)?\S+\//)
    assert.doesNotMatch(body, /\bnpm\b|\bnpx\b/)
  })

  it('gives the action no secret and no token', () => {
    assert.doesNotMatch(action, /secrets\.|GH_TOKEN|GITHUB_TOKEN|github\.token/)
    const body = step(workflow, 'Build the review input')
    assert.doesNotMatch(body, /secrets\.|GH_TOKEN|GITHUB_TOKEN|github\.token/)
  })

  it('keeps the script one self-contained file: node: imports only', () => {
    const specifiers = [...scriptSource.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    assert.ok(specifiers.length > 0)
    for (const specifier of specifiers) assert.match(specifier, /^node:/)
    assert.doesNotMatch(scriptSource, /\brequire\s*\(/)
  })
})

describe('the verdict and the tools', () => {
  it('allows the read-only git commands the reviewer needs and no write command', () => {
    const allowed = /--allowedTools "([^"]+)"/.exec(step(workflow, 'Review'))?.[1]?.split(',') ?? []
    for (const tool of ['Bash(git show:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(gh pr comment:*)', 'Read']) {
      assert.ok(allowed.includes(tool), tool)
    }
    assert.deepEqual(allowed.filter((tool) => tool.startsWith('Bash(git ')).sort(), ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'])
  })

  it('ends with the verdict line that review-status.mjs parses', () => {
    const line = /<!-- claude-review head=\$\{\{ steps\.pr\.outputs\.head \}\} findings=N -->/.exec(workflow)
    assert.ok(line, 'verdict line present')
    const head = 'c'.repeat(40)
    const rendered = line[0].replace('${{ steps.pr.outputs.head }}', head).replace('N', '2')
    const verdict = claudeReviewVerdict([{ body: `Reviewed.\n${rendered}`, user: { login: REVIEW_BOT_LOGIN } }], head)
    assert.equal(verdict.state, 'findings')
    assert.equal(verdict.findings, 2)
  })
})

describe('the caller template', () => {
  it('calls the shared workflow on open, leaving draft, and a comment', () => {
    assert.match(template, /uses: gorfednet\/\.github\/\.github\/workflows\/claude-review\.yml@main\n/)
    assert.match(template, /pull_request:\n\s+types: \[opened, ready_for_review\]/)
    assert.match(template, /issue_comment:\n\s+types: \[created\]/)
  })

  it('passes the token and never routes the reviewer to the pool', () => {
    assert.match(template, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/)
    // The reviewer holds a secret; secret-holding jobs stay GitHub-hosted (owner, 2026-10-19).
    assert.doesNotMatch(template, /HEAVY_RUNS_ON/)
  })

  it('grants every permission the shared job asks for, since a called job cannot exceed its caller', () => {
    const asked = workflow.slice(workflow.indexOf('    permissions:'), workflow.indexOf('    concurrency:'))
    const permissions = [...asked.matchAll(/^\s{6}([a-z-]+): (\w+)$/gm)].map((match) => `${match[1]}: ${match[2]}`)
    assert.ok(permissions.length >= 4, `parsed ${permissions.length} permissions`)
    for (const permission of permissions) assert.ok(template.includes(`  ${permission}\n`), permission)
  })
})

/*
 * What a comment must say to start a review. It used to have to START with "claude review"
 * (`startsWith` in the job's `if`), so a session that explained a push and put the request on
 * the last line got no review, and the pull request waited all night (MoonMan #283 and #292,
 * 2026-10-20). Now any one line of the comment, trimmed, is exactly the request, in any case. A
 * phrase inside a sentence is not a request: "please don't claude review yet" must not fire.
 *
 * The job's `if` keeps a cheap prefilter (the words appear at all, from an owner, member or
 * collaborator, on a pull request, not from a bot); the first step decides exactly, and every
 * other step runs only on its answer.
 */
describe('the review trigger', () => {
  const TRIGGER = step(workflow, 'Is this a review request?')
  const script = (() => {
    const at = TRIGGER.indexOf('run: |\n')
    assert.notEqual(at, -1, 'the trigger step has a run block')
    // The run block is the lines indented deeper than the step; it ends at the first line that is not.
    const lines = TRIGGER.slice(at + 'run: |\n'.length).split('\n')
    const end = lines.findIndex((l) => l.trim() !== '' && !l.startsWith(' '.repeat(10)))
    return (end === -1 ? lines : lines.slice(0, end)).map((l) => l.replace(/^ {10}/, '')).join('\n')
  })()
  const decide = (event, body = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'review-trigger-'))
    const out = join(dir, 'out')
    writeFileSync(out, '')
    execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, EVENT: event, BODY: body, GITHUB_OUTPUT: out } })
    const go = /go=(\w+)/.exec(readFileSync(out, 'utf8'))?.[1]
    rmSync(dir, { recursive: true, force: true })
    return go
  }

  it('fires on the first line, the last line, or a line in the middle', () => {
    assert.equal(decide('issue_comment', 'claude review'), 'true')
    assert.equal(decide('issue_comment', 'claude review\nThe push only fixed lint.'), 'true')
    assert.equal(decide('issue_comment', 'Merged main after #12; a clean merge.\nclaude review'), 'true')
    assert.equal(decide('issue_comment', 'One.\r\n  Claude Review  \r\nTwo.'), 'true')
  })

  it('does not fire on the phrase inside prose, a longer word, or a code-quoted mention', () => {
    assert.equal(decide('issue_comment', 'claude reviewed this head already'), 'false')
    assert.equal(decide('issue_comment', 'please claude review this'), 'false')
    assert.equal(decide('issue_comment', "please don't claude review yet"), 'false')
    assert.equal(decide('issue_comment', 'Ask for it with `claude review` once CI is green.'), 'false')
    assert.equal(decide('issue_comment', ''), 'false')
  })

  it('always proceeds for a pull request event (opened, or out of draft)', () => {
    assert.equal(decide('pull_request'), 'true')
  })

  /** One job's text, from its `  <name>:` line to the next top-level job. */
  const job = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`)
    assert.notEqual(start, -1, `no job ${name}`)
    const next = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/)
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
  }

  it('keeps the guards in the trigger job condition: a pull request, a trusted author, never a bot', () => {
    const trigger = job('trigger')
    const condition = trigger.slice(0, trigger.indexOf('\n    runs-on:'))
    assert.match(condition, /if: >-/, 'the slice is the job condition')
    assert.match(condition, /github\.event\.issue\.pull_request/)
    assert.match(condition, /"OWNER","MEMBER","COLLABORATOR"/)
    assert.match(condition, /github\.event\.comment\.user\.type != 'Bot'/)
    assert.doesNotMatch(workflow, /startsWith\(github\.event\.comment\.body/)
  })

  it('a comment that is not a request never enters the review concurrency group', () => {
    // The group lets a newer pending run replace an older queued one, so a prose mention that
    // reached it could cancel a real request queued behind a running review.
    assert.doesNotMatch(job('trigger'), /concurrency:/)
    const review = job('review')
    assert.match(review, /\n    needs: trigger\n/)
    assert.match(review, /\n    if: needs\.trigger\.outputs\.go == 'true'\n/)
    assert.match(review, /concurrency:/)
    assert.match(job('trigger'), /go: \$\{\{ steps\.trigger\.outputs\.go \}\}/)
  })
})

describe('where the shared reviewer runs', () => {
  it('always runs GitHub-hosted, whatever a caller passes, because it holds the OAuth secret', () => {
    const jobs = workflow.slice(workflow.indexOf('\njobs:'))
    const runsOn = [...jobs.matchAll(/^\s{4}runs-on: (.+)$/gm)].map((match) => match[1])
    assert.ok(runsOn.length >= 1, 'found runs-on lines')
    for (const value of runsOn) assert.equal(value, 'ubuntu-latest')
    assert.doesNotMatch(jobs, /inputs\.runs-on/)
  })
})

describe('claude-review model choice', () => {
  const pick = step(workflow, 'Pick the model')
  const script = /run: \|\n([\s\S]*)$/.exec(pick)[1].replace(/^ {10}/gm, '')

  /** The model the step selects for a repository and requested model. */
  function choose(repo, requested) {
    const dir = mkdtempSync(join(tmpdir(), 'pick-model-'))
    const out = join(dir, 'out')
    writeFileSync(out, '')
    execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, REPO: repo, REQUESTED: requested, GITHUB_OUTPUT: out } })
    const model = /^model=(.*)$/m.exec(readFileSync(out, 'utf8'))[1]
    rmSync(dir, { recursive: true, force: true })
    return model
  }

  it('declares a model input that defaults to auto (Opus, Sonnet on the small sites)', () => {
    assert.match(workflow, /\n {6}model:\n[\s\S]*?default: auto\n/)
  })

  it('passes the chosen model to the action', () => {
    assert.match(step(workflow, 'Review'), /--model \$\{\{ steps\.model\.outputs\.model \}\}/)
  })

  for (const repo of ['promptboi.com', 'denseware.com', 'ssatcy.com', 'gorfmusic.com', 'subrythm.com', 'blackpixelrecords.com', 'anal0g.org', 'rowanmcarthur.com', 'ACID2REAPER']) {
    it(`reviews ${repo} with Sonnet`, () => assert.equal(choose(`gorfednet/${repo}`, 'auto'), 'claude-sonnet-5-5'))
  }

  for (const repo of ['4thcltr.com', 'heuristics.4thcltr.com', 'papers.4thcltr.com', 'gorfed.net', 'bindercurve.com', 'assess', 'ops', '.github']) {
    it(`keeps Opus for ${repo}`, () => assert.equal(choose(`gorfednet/${repo}`, 'auto'), 'claude-opus-5-5'))
  }

  it('does not match a repository that only contains a small site name', () => {
    assert.equal(choose('gorfednet/ssatcy.com-pool', 'auto'), 'claude-opus-5-5')
  })

  it('honours a model a caller passes explicitly, Opus on a small site included', () => {
    assert.equal(choose('gorfednet/promptboi.com', 'claude-haiku-5-5'), 'claude-haiku-5-5')
    assert.equal(choose('gorfednet/promptboi.com', 'claude-opus-5-5'), 'claude-opus-5-5')
  })

  it('treats an empty input as auto', () => {
    assert.equal(choose('gorfednet/promptboi.com', ''), 'claude-sonnet-5-5')
    assert.equal(choose('gorfednet/assess', ''), 'claude-opus-5-5')
  })
})
