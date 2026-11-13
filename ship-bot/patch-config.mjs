#!/usr/bin/env node
/**
 * Apply a reviewed row patch to the live ~/.ship-bot/config.json.
 *
 *   node ~/.ship-bot/app/patch-config.mjs ~/.ship-bot/app/patches/<file>.json
 *
 * Sessions never read the live config, so row edits are written as a patch in
 * the repository, reviewed on a pull request, and applied by the owner with
 * this. A patch is {"label": "...", "repos": {"owner/name": {"key": value}}}:
 * each key replaces that key in the named row. A null value removes the key.
 *
 * It backs the file up first (config.json.bak-<label>), validates the result
 * with the installed bot's own validator, and writes only when that passes.
 * It prints the slugs and key names it set, never a value from the file.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateConfig } from './lib/config.mjs'

export function applyPatch(raw, patch) {
  const changed = []
  const problems = []
  for (const [slug, fields] of Object.entries(patch.repos ?? {})) {
    const row = raw.repos.find((r) => r.slug === slug)
    if (!row) {
      problems.push(`${slug}: no such row`)
      continue
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete row[key]
      else row[key] = value
      changed.push(`${slug}: ${value === null ? 'removed' : 'set'} ${key}`)
    }
  }
  return { changed, problems }
}

function main(argv) {
  const [patchPath, configPath = join(homedir(), '.ship-bot', 'config.json')] = argv
  if (!patchPath) {
    console.error('usage: patch-config.mjs <patch.json> [config.json]')
    return 64
  }
  const patch = JSON.parse(readFileSync(patchPath, 'utf8'))
  if (!/^[a-z0-9-]+$/.test(patch.label ?? '')) {
    console.error('patch-config: the patch needs a "label" of lower-case letters, digits and "-"')
    return 64
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  const { changed, problems } = applyPatch(raw, patch)
  const invalid = validateConfig(raw)
  if (problems.length > 0 || invalid.length > 0) {
    // Problems name slugs and keys only, so printing them leaks no value.
    for (const p of [...problems, ...invalid]) console.error(`patch-config: ${p}`)
    console.error('patch-config: nothing written')
    return 1
  }
  const backup = `${configPath}.bak-${patch.label}`
  if (existsSync(backup)) {
    console.error(`patch-config: ${backup} exists; this patch was applied already, nothing written`)
    return 1
  }
  copyFileSync(configPath, backup)
  const tmp = `${configPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, configPath)
  for (const c of changed) console.log(c)
  console.log(`patch-config: written; backup at ${backup}; validateConfig 0 problems`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2))
