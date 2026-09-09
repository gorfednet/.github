import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Is this module the script node was asked to run?
 *
 * The usual idiom, `import.meta.url === \`file://${process.argv[1]}\``, is
 * wrong in a way that fails silently and only sometimes. `import.meta.url` is
 * a fully resolved file URL — realpath applied, every character percent-encoded
 * where it must be. `process.argv[1]` is closer to what was typed. They agree
 * for a plain absolute path and disagree the moment a symlink, a space, or a
 * non-ASCII character is involved.
 *
 * When they disagree the module loads, runs no CLI, and **exits 0**. A checker
 * invoked through a symlinked directory therefore reports success without
 * checking anything, which is the precise failure this kit exists to refuse —
 * and it was sitting inside two of the kit's own binaries.
 *
 * Proved rather than reasoned about: invoking `assert-checks-started.mjs`
 * through a symlinked kit directory printed nothing and exited 0 before this,
 * and reports the missing argument after it.
 *
 * @param {string} importMetaUrl the caller's `import.meta.url`
 * @returns {boolean}
 */
export function isMain(importMetaUrl) {
  const invoked = process.argv[1]
  if (!invoked) return false

  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(invoked)
  } catch {
    // A path that cannot be resolved is not this module. Returning true would
    // run a CLI during an import; returning false is the conservative half of
    // a comparison that could not be made.
    return false
  }
}
