import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { envSecrets, pagesSecrets } from '../lib/deploy.mjs'
import * as redact from '../lib/redact.mjs'
import { FakeGitHub, HEAD, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const { Redactor } = redact

// A fixture credential, assembled at run time like every other one in this suite.
const API_TOKEN = ['abcd', '1234', 'xyz'].join('')
const SOURCE = '/src/example-site.org'
const repo = { slug: 'gorfednet/example-site.org', name: 'example-site.org', dir: 'example-site.org', sourceDir: SOURCE, workDir: '/work/example-site.org', envFiles: ['.deploy-env'] }
const fsxWith = (text) => ({ exists: (p) => p === `${SOURCE}/.deploy-env`, read: () => text })

describe('an env value that is a public name', () => {
  it('masks the token and leaves the repository name readable', () => {
    const redactor = new Redactor([], { publicNames: redact.publicNames([repo]) })
    redactor.add(envSecrets(repo, fsxWith(`PROJECT=example-site.org\nAPI_TOKEN=${API_TOKEN}\n`)))
    assert.equal(redactor.apply(`gorfednet/example-site.org#63: deploy failed, wrangler said ${API_TOKEN}`), 'gorfednet/example-site.org#63: deploy failed, wrangler said [REDACTED]')
  })

  it('still masks a secret kept under a plain name', () => {
    const redactor = new Redactor([], { publicNames: redact.publicNames([repo]) })
    redactor.add(envSecrets(repo, fsxWith('NAS_HOST=somehostvalue123\nSITE=example-site.org\n')))
    assert.deepEqual([...redactor.secrets], ['somehostvalue123'])
    assert.equal(redactor.apply('gorfednet/example-site.org#63: ssh to somehostvalue123 failed'), 'gorfednet/example-site.org#63: ssh to [REDACTED] failed')
  })

  it('never takes a repo slug, its owner, its basename or its directory name, whatever the name', () => {
    const names = redact.publicNames([{ ...repo, siblings: [{ slug: 'gorfednet/helper-repo', dir: 'helper-repo', path: '/work/helper-repo' }] }])
    for (const name of ['gorfednet/example-site.org', 'gorfednet', 'example-site.org', 'gorfednet/helper-repo', 'helper-repo']) {
      assert.ok(names.includes(name), `${name} is a public name`)
    }
    // Host paths are not repo names: neither a whole path nor a segment of one is allowed.
    for (const name of ['/src/example-site.org', '/work/example-site.org', '/work/helper-repo', 'src', 'work']) {
      assert.ok(!names.includes(name), `${name} is not a public name`)
    }
    const redactor = new Redactor([], { publicNames: names })
    // Secret by name, public by value: the name loses.
    redactor.add(envSecrets(repo, fsxWith(`DEPLOY_TOKEN=example-site.org\nOWNER_KEY=GorfedNet\nREPO_SECRET=gorfednet/example-site.org\nAPI_TOKEN=${API_TOKEN}\n`)))
    assert.deepEqual([...redactor.secrets], [API_TOKEN])
    assert.equal(redactor.apply(`gorfednet/example-site.org#63 in /work/example-site.org: ${API_TOKEN}`), 'gorfednet/example-site.org#63 in /work/example-site.org: [REDACTED]')
    // A name allowed after the value was added is taken back out.
    const late = new Redactor(['example-site.org', API_TOKEN]).allow(names)
    assert.deepEqual([...late.secrets], [API_TOKEN])
    // The near miss: a value that only contains a public name is still a secret.
    assert.equal(new Redactor(['example-site.org-deploy-key'], { publicNames: names }).apply('key example-site.org-deploy-key'), 'key [REDACTED]')
  })

  it('never allows a segment of an absolute path: the host account name stays masked', () => {
    const hosted = {
      ...repo,
      sourceDir: '/Users/exampleuser/Developer/example-site.org',
      workDir: '/Users/exampleuser/.ship-bot/work/example-site.org',
      siblings: [{ slug: 'gorfednet/helper-repo', dir: 'helper-repo', path: '/Users/exampleuser/.ship-bot/work/helper-repo' }],
    }
    const names = redact.publicNames([hosted])
    assert.deepEqual([...names].sort(), ['example-site.org', 'gorfednet', 'gorfednet/example-site.org', 'gorfednet/helper-repo', 'helper-repo'])
    const redactor = new Redactor([], { publicNames: names })
    redactor.add(envSecrets(hosted, { exists: (p) => p === `${hosted.sourceDir}/.deploy-env`, read: () => 'NAS_USER=exampleuser\nSITE=example-site.org\nSTATE=.ship-bot\nROOT=Developer\n' }))
    assert.deepEqual([...redactor.secrets].sort(), ['.ship-bot', 'Developer', 'exampleuser'])
    assert.equal(redactor.apply('gorfednet/example-site.org#63: ssh exampleuser@nas failed'), 'gorfednet/example-site.org#63: ssh [REDACTED]@nas failed')
  })

  it('keeps pattern masking for a secret assignment whatever the known set holds', () => {
    const redactor = new Redactor([], { publicNames: redact.publicNames([repo]) })
    assert.equal(redactor.apply('gorfednet/example-site.org: DEPLOY_TOKEN=example-site.org'), 'gorfednet/example-site.org: DEPLOY_TOKEN=[REDACTED]')
  })

  it('keeps every Pages config value, as before', () => {
    const files = { '/state/cloudflare-pages.env': 'PROJECT=some-project-name\nPLAUSIBLE_ORIGIN=https://stats.example.test\n' }
    const fsx = { exists: (p) => p in files, read: (p) => files[p] }
    assert.deepEqual(pagesSecrets('/state', fsx), ['some-project-name', 'https://stats.example.test', 'stats.example.test'])
  })
})

describe('a deploy whose env file repeats the repository name', () => {
  it('prints the slug in the comment, the deploy log and the bot log, and still masks the password', async () => {
    const slug = 'gorfednet/example-site.org'
    const password = ['nas', 'password', 'fixture', '0042'].join('-')
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 1, stdout: `rsync to example-site.org failed for ${slug} with ${password} on somehostvalue123\n` } : undefined) })
    const github = new FakeGitHub({ pulls: [makePr({ head: { sha: HEAD, repo: { full_name: slug } } })] })
    const s = scenario({ repos: [repoEntry({ slug, dir: 'example-site.org' })], github, runner })
    const source = join(s.config.sourceRoot, 'example-site.org')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, '.deploy-env'), `SITE=example-site.org\nSITE_HOST=example-site.org\nPROJECT=${slug}\nDEPLOY_KEY=example-site.org\nNAS_PASSWORD=${password}\nNAS_HOST=somehostvalue123\n`)
    await s.run()
    const logDir = join(s.config.stateDir, 'logs', 'deploys')
    const log = readFileSync(join(logDir, readdirSync(logDir)[0]), 'utf8')
    const comments = github.commentsPosted().map((w) => w.body).join('\n')
    const everything = [comments, log, s.logs.join('\n')].join('\n')
    assert.ok(!everything.includes(password), 'the password must not be printed anywhere')
    assert.ok(!everything.includes('somehostvalue123'), 'a secret under a plain name must not be printed anywhere')
    assert.ok(!everything.includes('gorfednet/[REDACTED]'), 'the repository name must stay readable')
    assert.match(log, /rsync to example-site\.org failed for gorfednet\/example-site\.org with \[REDACTED\] on \[REDACTED\]/)
    assert.match(comments, /example-site\.org failed/)
    assert.match(s.logs.join('\n'), /gorfednet\/example-site\.org/)
  })
})
