#!/usr/bin/env node
/**
 * Severity-aware npm audit gate for portfolio repos.
 *
 * Policy:
 * - Production/runtime (npm audit --omit=dev): fail on high/critical.
 * - Full tree: warn on moderate/low production and dev-only findings.
 *
 * Usage:
 *   node scripts/npm-audit-gate.mjs
 *   node scripts/npm-audit-gate.mjs --workspace=server --lockfile-dir=server
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluateAuditFindings,
  formatGateSummary,
  parseAuditReport,
  readAllowlistFile,
} from './npm-audit-gate-lib.mjs'

const root = process.env.NPM_AUDIT_GATE_ROOT
  ? path.resolve(process.env.NPM_AUDIT_GATE_ROOT)
  : process.cwd()

function cleanNpmEnv() {
  const env = { ...process.env }
  delete env.npm_config_devdir
  delete env.NPM_CONFIG_DEVDIR
  return env
}

function parseArgs(argv) {
  const workspaces = []
  for (const arg of argv) {
    if (arg.startsWith('--workspace=')) {
      const [id, dir] = arg.slice('--workspace='.length).split(':')
      workspaces.push({ id: id || 'root', label: id || 'root', lockfileDir: dir || '.' })
    }
  }
  if (workspaces.length === 0) {
    workspaces.push({ id: 'root', label: 'root', lockfileDir: '.' })
  }
  const allowlistArg = argv.find((arg) => arg.startsWith('--allowlist='))
  return {
    workspaces,
    allowlistPath: allowlistArg ? path.resolve(allowlistArg.slice('--allowlist='.length)) : null,
    jsonMode: argv.includes('--json'),
  }
}

function runNpmAudit(lockfileDir, omitDev) {
  const cwd = path.resolve(root, lockfileDir)
  const args = ['audit', '--json']
  if (omitDev) args.push('--omit=dev')
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: cleanNpmEnv(),
  })
  const stdout = result.stdout?.trim()
  if (!stdout) {
    const detail = result.stderr?.trim() || result.error?.message || 'no stdout'
    throw new Error(`npm audit failed in ${lockfileDir}: ${detail}`)
  }
  return JSON.parse(stdout)
}

function main() {
  const flags = parseArgs(process.argv.slice(2))
  const nowIso = process.env.NPM_AUDIT_GATE_NOW ?? new Date().toISOString()
  const allowlist = readAllowlistFile(flags.allowlistPath, nowIso)

  /** @type {ReturnType<typeof evaluateAuditFindings>['failures']} */
  const failures = []
  /** @type {ReturnType<typeof evaluateAuditFindings>['warnings']} */
  const warnings = []

  for (const workspace of flags.workspaces) {
    const lockfile = path.join(root, workspace.lockfileDir, 'package-lock.json')
    if (!existsSync(lockfile)) {
      if (workspace.lockfileDir === '.') {
        console.log(`[npm-audit-gate] skip ${workspace.id}: no package-lock.json`)
        continue
      }
      throw new Error(`missing lockfile: ${lockfile}`)
    }

    const productionReport = runNpmAudit(workspace.lockfileDir, true)
    const allReport = runNpmAudit(workspace.lockfileDir, false)
    const prodFindings = parseAuditReport(productionReport, {
      workspace: workspace.id,
      scope: 'production',
    })
    const allFindings = parseAuditReport(allReport, {
      workspace: workspace.id,
      scope: 'all',
    })
    const evaluated = evaluateAuditFindings({ prodFindings, allFindings, allowlist })
    failures.push(...evaluated.failures)
    warnings.push(...evaluated.warnings)

    if (!flags.jsonMode) {
      console.log(
        `[npm-audit-gate] ${workspace.label} (${workspace.lockfileDir}) production=${prodFindings.length} all=${allFindings.length}`,
      )
    }
  }

  const summary = formatGateSummary({
    failures,
    warnings,
    allowlistPath: flags.allowlistPath,
  })

  if (flags.jsonMode) {
    console.log(JSON.stringify({ ok: failures.length === 0, failures, warnings }, null, 2))
  } else {
    console.log('')
    console.log(summary)
  }

  if (failures.length > 0) {
    process.exit(1)
  }
}

main()
