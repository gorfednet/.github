/**
 * ship-bot masks the Cloudflare Pages token wherever a deploy could print it.
 *
 * The bot's own suite (ship-bot/check.sh) runs on the Mac at install time and in no
 * workflow. This is the one piece of it a pull request must not be able to break
 * unseen: site-deploy.sh hands the token to wrangler, the bot posts the end of a
 * failed deploy's output on the pull request, and several of these repositories are
 * public. So the wiring is exercised here too, through the bot's real pass (runOnce)
 * with its fakes. Nothing is contacted; the token and host are made up.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { makeRunner, scenario } from '../ship-bot/test/fakes.mjs'

// Assembled at run time, so no token-shaped string is committed.
const PAGES_TOKEN = ['cf', 'pages', 'FAKEtoken0123456789abcdefghijklmnop'].join('-')
const HOST = 'stats.example.test'

/** A deploy that fails while printing the token and the analytics host. */
const leakyDeploy = () =>
  makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 1, stdout: `wrangler: bad token ${PAGES_TOKEN}\nproxying to https://${HOST}\n` } : undefined) })

/** Everything the pass wrote where someone could read it: comments, the deploy log, its own log lines. */
function written(s) {
  const dir = join(s.config.stateDir, 'logs', 'deploys')
  const logs = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'))
  assert.equal(logs.length, 1, 'the scenario must have run one deploy, or this test proves nothing')
  const comments = s.github.commentsPosted().map((w) => w.body)
  assert.ok(comments.length > 0, 'the failed deploy must have been reported on the pull request')
  return { log: logs[0], all: [...comments, ...logs, ...s.logs].join('\n') }
}

describe('ship-bot and the Cloudflare Pages token', () => {
  it('masks the token and the analytics host from the files in its state directory', async () => {
    const s = scenario({ runner: leakyDeploy() })
    mkdirSync(s.config.stateDir, { recursive: true })
    writeFileSync(join(s.config.stateDir, 'cloudflare-pages.token'), `${PAGES_TOKEN}\n`, { mode: 0o600 })
    writeFileSync(join(s.config.stateDir, 'cloudflare-pages.env'), `PLAUSIBLE_ORIGIN=https://${HOST}\n`)
    await s.run()
    const { log, all } = written(s)
    assert.ok(!all.includes(PAGES_TOKEN), 'the Pages token was printed')
    assert.ok(!all.includes(HOST), 'the analytics host was printed')
    assert.match(log, /wrangler: bad token \[REDACTED\]/)
  })

  it('near miss: without the token file the same output goes out unmasked', async () => {
    const s = scenario({ runner: leakyDeploy() })
    await s.run()
    assert.ok(written(s).log.includes(PAGES_TOKEN), 'the masking above must come from the file, not from a pattern')
  })
})
