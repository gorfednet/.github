/**
 * A tracked copy of an unversioned live configuration is a liability unless
 * something enforces what it is. The dangerous reading is the natural one: a
 * directory of nginx configs under version control, with hashes, looks exactly
 * like the source of truth. It is not — nothing on the host reads it.
 *
 * So the cases below are mostly about the checker refusing the two ways this
 * record goes wrong: edited as though it deployed, and left to rot past the
 * point where it describes anything real.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const CHECK = resolve('scripts/check-vhost-capture.mjs')
const MANIFEST = 'infra/nginx/CAPTURE.json'
const DIR = 'infra/nginx/vhosts'

/**
 * A copy of the real capture, so fixtures stay realistic rather than testing a
 * two-file toy that would not exercise the fail-closed floor.
 */
function withCapture(mutate = () => {}, today = '2026-09-14') {
  const root = mkdtempSync(join(tmpdir(), 'vhost-'))
  mkdirSync(join(root, 'infra/nginx/vhosts'), { recursive: true })
  cpSync(DIR, join(root, DIR), { recursive: true })
  cpSync(MANIFEST, join(root, MANIFEST))
  cpSync('infra/nginx/README.md', join(root, 'infra/nginx/README.md'))

  mutate({
    root,
    manifest: () => JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')),
    writeManifest: (doc) =>
      writeFileSync(join(root, MANIFEST), JSON.stringify(doc, null, 2) + '\n'),
  })

  try {
    return spawnSync('node', [CHECK, '--today', today], { cwd: root, encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the live vhost capture', () => {
  it('passes on the capture as committed', () => {
    const result = withCapture()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /file\(s\) from dapyllil/)
  })

  it('fails when a tracked config is edited, because editing it deploys nothing', () => {
    const result = withCapture(({ root }) => {
      const path = join(root, DIR, 'ssatcy.com.conf')
      writeFileSync(path, readFileSync(path, 'utf8').replace('listen 80;', 'listen 443 ssl;'))
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no longer matches the bytes captured/)
    // The message has to say where the live configuration is, or the next person
    // edits the same file again. Read from the manifest rather than written out:
    // the literal form would be a machine path in a tracked file, and an earlier
    // draft of this assertion only escaped check-machine-paths because a regex
    // escapes its slashes — which is passing for a cosmetic reason.
    const { sourcePath, host } = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    assert.match(result.stderr, /configures NOTHING/)
    assert.ok(
      result.stderr.includes(`${sourcePath} on ${host}`),
      `expected the failure to name where the live config lives, got:\n${result.stderr}`,
    )
  })

  // The dates come from the manifest rather than being written here, so taking a
  // fresh capture (which moves recaptureBy) cannot break these two by itself.
  const renewBy = JSON.parse(readFileSync(MANIFEST, 'utf8')).recaptureBy
  const dayAfterRenewal = new Date(Date.parse(`${renewBy}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10)

  it('fails once the renewal date has passed', () => {
    const result = withCapture(() => {}, dayAfterRenewal)
    assert.equal(result.status, 1)
    assert.ok(
      result.stderr.includes(`due for renewal on ${renewBy}, which has passed`),
      `expected the failure to name the lapsed date, got:\n${result.stderr}`,
    )
  })

  it('passes on the last day before renewal is due', () => {
    const result = withCapture(() => {}, renewBy)
    assert.equal(result.status, 0, result.stderr)
  })

  it('fails when the snapshot carries no expiry at all', () => {
    const result = withCapture(({ manifest, writeManifest }) => {
      const doc = manifest()
      delete doc.recaptureBy
      writeManifest(doc)
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /recaptureBy must be YYYY-MM-DD/)
  })

  it('fails when the manifest forgets where the live configuration lives', () => {
    const result = withCapture(({ manifest, writeManifest }) => {
      const doc = manifest()
      doc.sourcePath = ''
      writeManifest(doc)
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /must say where the live configuration actually lives/)
  })

  it('fails closed on a nearly-empty manifest rather than verifying two files', () => {
    const result = withCapture(({ manifest, writeManifest }) => {
      const doc = manifest()
      const [first] = Object.entries(doc.files)
      doc.files = Object.fromEntries([first])
      writeManifest(doc)
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /lists 1 file\(s\)/)
  })

  it('fails when a config is present but unlisted, so nothing verifies it', () => {
    const result = withCapture(({ root }) => {
      writeFileSync(join(root, DIR, 'untracked.example.com.conf'), 'server { listen 80; }\n')
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /untracked\.example\.com\.conf is in .* but not in the manifest/)
  })

  it('fails when a listed config is missing from the directory', () => {
    const result = withCapture(({ root }) => {
      rmSync(join(root, DIR, 'gorfed.net.conf'))
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /gorfed\.net\.conf is in the manifest but not in/)
  })

  it('fails when the README stops saying this directory does not deploy', () => {
    const result = withCapture(({ root }) => {
      writeFileSync(join(root, 'infra/nginx/README.md'), '# nginx\n\nThe vhosts.\n')
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no longer states that this directory does not configure anything/)
  })

  it('covers all ten fleet sites, not an arbitrary subset', () => {
    const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const sites = [
      '4thcltr.com',
      'anal0g.org',
      'blackpixelrecords.com',
      'denseware.com',
      'gorfed.net',
      'gorfmusic.com',
      'promptboi.com',
      'rowanmcarthur.com',
      'ssatcy.com',
      'subrythm.com',
    ]
    for (const site of sites) {
      assert.ok(
        Object.hasOwn(doc.files, `${site}.conf`),
        `${site} serves live traffic but its vhost is not captured`,
      )
    }
  })

  it('records that this layer is port 80 only, contradicting any 443 claim in a repo', () => {
    const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    for (const name of Object.keys(doc.files)) {
      if (name.startsWith('00-')) continue
      const conf = readFileSync(join(DIR, name), 'utf8')
      assert.match(conf, /listen 80;/, `${name} should listen on 80`)
      assert.doesNotMatch(
        conf,
        /listen\s+443/,
        `${name} listens on 443, which contradicts the README and the recon: TLS ` +
          'terminates at Cloudflare in front of this host',
      )
    }
  })

  it('keeps the branded error pages wired on every site vhost', () => {
    const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    for (const name of Object.keys(doc.files)) {
      if (name.startsWith('00-')) continue
      const conf = readFileSync(join(DIR, name), 'utf8')
      assert.match(conf, /error_page 404 \/404\.html;/, `${name} lost its 404 directive`)
      assert.match(conf, /error_page 500 502 503 504 \/500\.html;/, `${name} lost its 5xx directive`)
    }
  })
})
