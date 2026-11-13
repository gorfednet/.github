#!/usr/bin/env node
/**
 * Create the ship bot's GitHub App from manifest.json, in one browser step.
 *
 *   node ~/.ship-bot/app/github-app/create.mjs [--owner gorfednet] [--org] [--port 47321]
 *
 * gorfednet is a user account, so the default is the user's "new App" page;
 * `--org` uses an organisation's instead.
 *
 * It serves one page on 127.0.0.1 that sends manifest.json to GitHub's "create
 * a GitHub App from a manifest" page for the account. The owner clicks
 * "Create GitHub App" there. GitHub sends the browser back here with a
 * one-time code, which this script swaps for the App's ID and private key:
 *
 * - the key goes to ~/.ship-bot/github-app.pem, mode 600, never printed;
 * - the config gets `githubApp: { appId, privateKeyFile }` (setGithubApp);
 * - the browser moves on to the App's install page, where the owner installs
 *   it on the account for all repositories.
 *
 * The App's client secret and webhook secret are not kept: the bot never uses
 * them. Run once; it refuses if the key file already exists.
 */
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setGithubApp } from '../ship-bot.mjs'
import { isMain } from '../lib/isMain.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The page that posts the manifest to GitHub. */
export function startPage({ org, state, manifest, isOrg = false }) {
  const action = isOrg ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`
  return `<!doctype html><meta charset="utf-8"><title>Create the ship bot App</title>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Sending you to GitHub to create the ship bot's App for ${escapeHtml(org)}.</p>
<button type="submit">Continue to GitHub</button>
</form><script>document.getElementById('f').submit()</script>`
}

/** Swap the one-time code for the App. Unauthenticated, as GitHub specifies. */
export async function convertCode(code, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gorfednet-ship-bot' },
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.id || !data?.pem || !data?.slug) throw new Error(`GitHub did not hand over the App (HTTP ${res.status}${data?.message ? `: ${data.message}` : ''})`)
  return { id: data.id, slug: data.slug, pem: data.pem, owner: data.owner?.login }
}

async function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const org = arg('owner', 'gorfednet')
  const isOrg = argv.includes('--org')
  const port = Number(arg('port', '47321'))
  const botHome = join(homedir(), '.ship-bot')
  const keyFile = join(botHome, 'github-app.pem')
  const configPath = join(botHome, 'config.json')
  if (existsSync(keyFile)) {
    console.error(`create.mjs: ${keyFile} already exists, so the App was made before. Nothing was changed.`)
    return 2
  }
  if (!existsSync(configPath)) {
    console.error(`create.mjs: no ship bot config at ${configPath}; install the ship bot first. Nothing was changed.`)
    return 2
  }
  const state = randomBytes(16).toString('hex')
  const host = `127.0.0.1:${port}`
  const manifest = { ...JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')), redirect_url: `http://127.0.0.1:${port}/done` }

  return new Promise((resolve) => {
    const finish = (code) => {
      server.close()
      clearTimeout(timer)
      resolve(code)
    }
    const server = createServer(async (req, res) => {
      // Only this machine's own address: a page that rebinds a DNS name to
      // 127.0.0.1 sends its own Host and is refused.
      if (req.headers.host !== host) {
        res.writeHead(421).end()
        return
      }
      const url = new URL(req.url, `http://${host}`)
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(startPage({ org, state, manifest, isOrg }))
        return
      }
      if (url.pathname !== '/done') {
        res.writeHead(404).end()
        return
      }
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('This link is not from this run. Nothing was changed.')
        return
      }
      try {
        const app = await convertCode(url.searchParams.get('code'))
        if (app.owner?.toLowerCase() !== org.toLowerCase()) throw new Error(`GitHub handed over an App owned by ${app.owner ?? 'nobody'}, not ${org}. Nothing was saved.`)
        writeFileSync(keyFile, app.pem, { mode: 0o600, flag: 'wx' })
        const install = `https://github.com/apps/${app.slug}/installations/new`
        const code = setGithubApp(configPath, { appId: app.id, privateKeyFile: '~/.ship-bot/github-app.pem' })
        if (code !== 0) {
          console.error(`create.mjs: the App exists (ID ${app.id}) and its key is saved at ${keyFile}, but the config was not changed. Install it at ${install}, then a session adds "githubApp": { "appId": ${app.id}, "privateKeyFile": "~/.ship-bot/github-app.pem" } to the config.`)
          res.writeHead(302, { Location: install }).end()
          finish(1)
          return
        }
        console.log(`Created GitHub App ${app.slug} (ID ${app.id}). Key saved to ${keyFile}. Next: install it on ${org}: ${install}`)
        res.writeHead(302, { Location: install }).end()
        finish(0)
      } catch (cause) {
        console.error(`create.mjs: ${cause.message}`)
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Something went wrong: ${cause.message}`)
        finish(1)
      }
    })
    const timer = setTimeout(() => {
      console.error('create.mjs: no answer from GitHub in 15 minutes. Nothing was changed; run it again.')
      finish(1)
    }, 15 * 60 * 1000)
    server.listen(port, '127.0.0.1', () => {
      const start = `http://127.0.0.1:${port}/`
      console.log(`Opening ${start} in your browser. Click "Create GitHub App" on the GitHub page that follows.`)
      execFile('open', [start], () => {})
    })
  })
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
