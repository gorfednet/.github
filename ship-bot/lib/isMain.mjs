import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Is this module the script node was asked to run? Same approach as the
 * verification kit's lib/isMain.mjs: compare resolved paths, because a
 * symlinked or space-containing path makes the naive string comparison fail
 * silently, and then the CLI does nothing and exits 0.
 */
export function isMain(importMetaUrl) {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(invoked)
  } catch {
    return false
  }
}
