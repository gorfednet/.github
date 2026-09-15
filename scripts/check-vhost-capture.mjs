#!/usr/bin/env node
/**
 * The ten live nginx vhosts were unversioned. infra/nginx/vhosts/ is a copy of
 * them, and a copy is a liability unless something says so out loud.
 *
 * Two failure modes, both of which have to be loud:
 *
 * 1. Someone edits a file in infra/nginx/vhosts/, CI passes, and they believe
 *    production changed. Nothing reads that directory. The per-file hash makes
 *    the edit fail with a message saying where the live configuration is.
 *
 * 2. The host changes and the snapshot silently becomes a description of a
 *    configuration nobody runs. The honest check would diff against the host,
 *    but the host is reachable only over Tailscale and a runner has no route to
 *    it — and a check that cannot run reports the same green as one that passed.
 *    So the deferral is dated: recaptureBy fails when it lapses.
 *
 * Usage: node scripts/check-vhost-capture.mjs [--today YYYY-MM-DD]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'infra/nginx/vhosts'
const MANIFEST = 'infra/nginx/CAPTURE.json'
const README = 'infra/nginx/README.md'

const todayArg = process.argv.includes('--today')
  ? process.argv[process.argv.indexOf('--today') + 1]
  : process.env.VHOST_CAPTURE_TODAY
const today = new Date(`${todayArg ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`)

const problems = []

if (!existsSync(MANIFEST)) {
  console.error(`\n✗ ${MANIFEST} is missing. The capture cannot verify itself.\n`)
  process.exit(1)
}

const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'))

if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.capturedAt ?? '')) {
  problems.push('capturedAt must be YYYY-MM-DD. An undated snapshot dates itself to whenever you are reading it.')
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.recaptureBy ?? '')) {
  problems.push(
    'recaptureBy must be YYYY-MM-DD. Without an expiry this directory becomes a ' +
      'description of a configuration nobody runs, and reads as current forever.',
  )
} else if (today > new Date(`${doc.recaptureBy}T00:00:00Z`)) {
  problems.push(
    `the capture was due for renewal on ${doc.recaptureBy}, which has passed. ` +
      `Re-copy ${doc.sourcePath} from ${doc.host} and move the date, or say why it no longer matters.`,
  )
}

for (const field of ['host', 'container', 'sourcePath']) {
  if (typeof doc[field] !== 'string' || doc[field] === '') {
    problems.push(
      `${field} must say where the live configuration actually lives. A snapshot ` +
        'whose origin is unrecorded cannot be re-taken by anyone but its author.',
    )
  }
}

const files = doc.files ?? {}

// Fail closed. An empty manifest would satisfy every per-file assertion below by
// having none to make, which is the same output as a clean verification.
if (Object.keys(files).length < 10) {
  problems.push(
    `the manifest lists ${Object.keys(files).length} file(s). There are more than ` +
      'that on the host, and every hash check would pass over the gap.',
  )
}

for (const [name, expected] of Object.entries(files)) {
  const path = join(DIR, name)
  if (!existsSync(path)) {
    problems.push(`${name} is in the manifest but not in ${DIR}. The record is incomplete.`)
    continue
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== expected) {
    problems.push(
      `${name} no longer matches the bytes captured from ${doc.host}.\n` +
        `      This directory configures NOTHING — nothing reads it, no container mounts it.\n` +
        `      If you meant to change the live site, edit ${doc.sourcePath} on ${doc.host},\n` +
        '      reload nginx, then re-capture and update CAPTURE.json.',
    )
  }
}

// A file present but unlisted is the same drift in the other direction.
if (existsSync(DIR)) {
  for (const name of readdirSync(DIR)) {
    if (!Object.hasOwn(files, name)) {
      problems.push(`${name} is in ${DIR} but not in the manifest, so nothing verifies it.`)
    }
  }
}

// The README carries the reason the gate is a date and a hash rather than a diff.
// Without it the next reader sees hashes over configuration files and reasonably
// concludes this directory is the source of truth.
if (!existsSync(README)) {
  problems.push(`${README} is missing. Nothing then says this directory does not deploy.`)
} else {
  const text = readFileSync(README, 'utf8')
  if (!/does not configure anything|configures NOTHING|not a deploy source/i.test(text)) {
    problems.push(
      `${README} no longer states that this directory does not configure anything. ` +
        'That sentence is the point of the file.',
    )
  }
}

if (problems.length > 0) {
  console.error(`\n✗ vhost capture: ${problems.length} problem(s).\n`)
  for (const p of problems) console.error(`    - ${p}`)
  console.error('')
  process.exit(1)
}

console.log(
  `✓ vhost capture: ${Object.keys(files).length} file(s) from ${doc.host}:${doc.sourcePath}, ` +
    `captured ${doc.capturedAt}, renew by ${doc.recaptureBy}`,
)
