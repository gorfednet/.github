/**
 * What each monitorClass allows a production-healthcheck caller to do.
 *
 * The class lives on the fleet registry. This module is the gate: a
 * static-marketing site whose caller omits `run-playwright` inherits the
 * shared default of true, which is a weekly Playwright install on a site
 * that barely changes. Found on 4thcltr.com, 2026-09-21.
 *
 * A caller is a workflow that `uses:` the shared production-healthcheck.
 * The reusable workflow itself is not a caller.
 */

export const MONITOR_CLASSES = Object.freeze({
  'active-product': { allowPlaywright: true },
  'active-site': { allowPlaywright: false },
  'static-marketing': { allowPlaywright: false },
  dormant: { allowPlaywright: false },
  tool: { allowPlaywright: false },
  'org-shared': { allowPlaywright: false },
})

/**
 * @param {string} monitorClass
 * @param {Map<string, string> | Iterable<[string, string]>} workflows
 * @returns {string | null} a problem, or null if the class and the workflows agree
 */
export function assertMonitorWorkflow(monitorClass, workflows) {
  const spec = MONITOR_CLASSES[monitorClass]
  if (!spec) {
    return `unknown monitorClass "${monitorClass}"`
  }

  const byPath = workflows instanceof Map ? workflows : new Map(workflows)
  for (const [path, text] of byPath) {
    if (!isHealthcheckCaller(text)) continue
    const playwright = callerPlaywright(text)
    if (!spec.allowPlaywright && playwright !== false) {
      return (
        `${path}: monitorClass ${monitorClass} forbids live Playwright; ` +
        'set run-playwright: false (omitting it defaults to true on the shared workflow).'
      )
    }
  }
  return null
}

function isHealthcheckCaller(text) {
  return (
    /uses:\s*gorfednet\/\.github\/\.github\/workflows\/production-healthcheck\.yml/.test(text) ||
    /uses:\s*.*\/production-healthcheck\.yml/.test(text)
  )
}

/**
 * @param {string} text
 * @returns {boolean | 'omitted'}
 */
export function callerPlaywright(text) {
  if (/run-playwright:\s*false\b/.test(text)) return false
  if (/run-playwright:\s*true\b/.test(text)) return true
  return 'omitted'
}
