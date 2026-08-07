#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'

const FAIL_SEVERITIES = new Set(['high', 'critical'])
const WARN_SEVERITIES = new Set(['moderate', 'low', 'info'])

/**
 * @param {unknown} entry
 * @returns {Array<{ id: string; severity: string; title: string; url: string }>}
 */
export function extractAdvisories(entry) {
  const out = []
  for (const via of entry?.via ?? []) {
    if (typeof via === 'object' && via !== null && (via.url || via.source)) {
      const url = String(via.url ?? '')
      const ghsa = url.match(/GHSA-[a-z0-9-]+/i)?.[0]
      out.push({
        id: ghsa ?? `npm-${via.source}`,
        severity: String(via.severity ?? entry.severity ?? 'unknown').toLowerCase(),
        title: String(via.title ?? entry.name ?? 'unknown advisory'),
        url,
      })
    }
  }
  if (out.length === 0 && entry?.severity) {
    out.push({
      id: String(entry.name ?? 'unknown'),
      severity: String(entry.severity).toLowerCase(),
      title: String(entry.name ?? 'unknown'),
      url: '',
    })
  }
  return out
}

/**
 * @param {Record<string, unknown>} report
 * @param {{ workspace: string; scope: 'production' | 'all' }} ctx
 */
export function parseAuditReport(report, ctx) {
  const vulns = report?.vulnerabilities ?? {}
  /** @type {Array<{
   *   workspace: string;
   *   scope: 'production' | 'all';
   *   package: string;
   *   severity: string;
   *   advisoryId: string;
   *   title: string;
   *   url: string;
   *   fixAvailable: boolean;
   *   range: string;
   * }>} */
  const findings = []

  for (const [name, rawEntry] of Object.entries(vulns)) {
    const entry = /** @type {Record<string, unknown>} */ (rawEntry)
    for (const advisory of extractAdvisories(entry)) {
      findings.push({
        workspace: ctx.workspace,
        scope: ctx.scope,
        package: name,
        severity: advisory.severity,
        advisoryId: advisory.id,
        title: advisory.title,
        url: advisory.url,
        fixAvailable: Boolean(entry.fixAvailable),
        range: String(entry.range ?? ''),
      })
    }
  }

  return findings
}

/** @param {{ workspace: string; package: string; advisoryId: string }} finding */
export function findingKey(finding) {
  return `${finding.workspace}:${finding.package}:${finding.advisoryId}`
}

/**
 * @param {unknown} raw
 * @param {string} [nowIso]
 */
export function loadAllowlist(raw, nowIso = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object') {
    return { entries: [], expired: [], invalid: 'allowlist must be a JSON object' }
  }
  const parsed = /** @type {{ version?: number; expires?: string; entries?: unknown[] }} */ (raw)
  const expires = parsed.expires?.trim()
  if (expires) {
    const expiresMs = Date.parse(expires)
    if (!Number.isFinite(expiresMs)) {
      return { entries: [], expired: [], invalid: `invalid allowlist expires: ${expires}` }
    }
    if (expiresMs < Date.parse(nowIso)) {
      return { entries: [], expired: [], invalid: `allowlist expired on ${expires}` }
    }
  }

  const entries = []
  const expired = []
  for (const item of parsed.entries ?? []) {
    if (!item || typeof item !== 'object') continue
    const row = /** @type {{ workspace?: string; advisoryId?: string; package?: string; expires?: string }} */ (
      item
    )
    const workspace = row.workspace?.trim()
    const advisoryId = row.advisoryId?.trim()
    const pkg = row.package?.trim()
    if (!workspace || !advisoryId || !pkg) continue
    const rowExpires = row.expires?.trim()
    if (rowExpires) {
      const rowExpiresMs = Date.parse(rowExpires)
      if (!Number.isFinite(rowExpiresMs) || rowExpiresMs < Date.parse(nowIso)) {
        expired.push({ workspace, advisoryId, package: pkg, expires: rowExpires })
        continue
      }
    }
    entries.push({ workspace, advisoryId, package: pkg, expires: rowExpires ?? null })
  }

  return { entries, expired, invalid: null }
}

/**
 * @param {{ workspace: string; advisoryId: string; package: string }} finding
 * @param {{ entries: Array<{ workspace: string; advisoryId: string; package: string }> }} allowlist
 */
export function isAllowlisted(finding, allowlist) {
  return allowlist.entries.some(
    (entry) =>
      entry.workspace === finding.workspace &&
      entry.advisoryId === finding.advisoryId &&
      entry.package === finding.package,
  )
}

/**
 * @param {{
 *   prodFindings: ReturnType<typeof parseAuditReport>;
 *   allFindings: ReturnType<typeof parseAuditReport>;
 *   allowlist: ReturnType<typeof loadAllowlist>;
 * }} input
 */
export function evaluateAuditFindings({ prodFindings, allFindings, allowlist }) {
  const prodKeys = new Set(prodFindings.map((finding) => findingKey(finding)))
  /** @type {Array<ReturnType<typeof parseAuditReport>[number] & { kind: string }>} */
  const failures = []
  /** @type {Array<ReturnType<typeof parseAuditReport>[number] & { kind: string }>} */
  const warnings = []

  for (const finding of prodFindings) {
    if (FAIL_SEVERITIES.has(finding.severity)) {
      if (!isAllowlisted(finding, allowlist)) {
        failures.push({ ...finding, kind: 'production' })
      }
      continue
    }
    if (WARN_SEVERITIES.has(finding.severity)) {
      warnings.push({ ...finding, kind: 'production' })
    }
  }

  for (const finding of allFindings) {
    if (prodKeys.has(findingKey(finding))) continue
    warnings.push({ ...finding, kind: 'dev-only' })
  }

  return { failures, warnings }
}

/**
 * @param {Array<ReturnType<typeof parseAuditReport>[number] & { kind?: string }>} findings
 */
export function formatFindingLines(findings) {
  return findings.map((finding) => {
    const scope = finding.kind === 'dev-only' ? 'dev-only' : 'production'
    const fix =
      finding.fixAvailable === true
        ? 'fix: npm audit fix (workspace lockfile) or upgrade parent dependency'
        : 'fix: review advisory — no automatic fix reported'
    const url = finding.url ? ` ${finding.url}` : ''
    return [
      `  [${finding.severity}] ${finding.workspace}/${finding.package} ${finding.advisoryId} (${scope})`,
      `    ${finding.title}`,
      `    ${fix}${url}`,
    ].join('\n')
  })
}

/**
 * @param {{
 *   failures: ReturnType<typeof evaluateAuditFindings>['failures'];
 *   warnings: ReturnType<typeof evaluateAuditFindings>['warnings'];
 *   allowlistPath?: string | null;
 * }} summary
 */
export function formatGateSummary({ failures, warnings, allowlistPath }) {
  const lines = ['[npm-audit-gate] summary']
  if (allowlistPath) {
    lines.push(`  allowlist: ${allowlistPath}`)
  }
  lines.push(`  production failures (high/critical): ${failures.length}`)
  lines.push(`  warnings (moderate/dev-only): ${warnings.length}`)
  if (failures.length > 0) {
    lines.push('', '[npm-audit-gate] FAIL — unallowlisted production high/critical:')
    lines.push(...formatFindingLines(failures))
  }
  if (warnings.length > 0) {
    lines.push('', '[npm-audit-gate] WARN:')
    lines.push(...formatFindingLines(warnings))
  }
  return lines.join('\n')
}

export function readAllowlistFile(allowlistPath, nowIso) {
  if (!allowlistPath) return loadAllowlist(null, nowIso)
  const abs = path.resolve(allowlistPath)
  const raw = JSON.parse(readFileSync(abs, 'utf8'))
  const loaded = loadAllowlist(raw, nowIso)
  if (loaded.invalid) {
    throw new Error(loaded.invalid)
  }
  return loaded
}
