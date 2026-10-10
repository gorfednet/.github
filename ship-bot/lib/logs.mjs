/**
 * Keep the LaunchAgent's log bounded: past `maxBytes`, ship-bot.log becomes
 * ship-bot.log.1 (replacing any older .1). launchd reopens the log path for
 * each run, so the next run starts a fresh file; the run that rotated keeps
 * writing to the .1 it already holds open.
 */
import { renameSync, statSync } from 'node:fs'

export const MAX_LOG_BYTES = 5 * 1024 * 1024

/** @returns {boolean} whether it rotated */
export function rotateLog(path, maxBytes = MAX_LOG_BYTES) {
  let size
  try {
    size = statSync(path).size
  } catch (cause) {
    if (cause.code === 'ENOENT') return false
    throw cause
  }
  if (size <= maxBytes) return false
  renameSync(path, `${path}.1`)
  return true
}
