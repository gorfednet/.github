/**
 * The real command runner. Every child process the bot starts goes through
 * `run`, so tests can replace it whole and see exactly what would have run.
 *
 * No shell: a command is a program and its arguments. Each call names a `kind`,
 * which is how a dry run refuses everything except the read-only gate scripts
 * (see `guardCommands`).
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Kinds that only read. Everything else changes something somewhere. */
// git-read: git commands that only read refs (the installed bot's freshness check), allowed in dry and observe runs.
export const READ_ONLY_KINDS = new Set(['gate', 'auth', 'git-read'])

const MAX_CAPTURE = 8 * 1024 * 1024

/**
 * @typedef {{cmd: string, args?: string[], cwd?: string, env?: Record<string,string>,
 *   timeoutMs?: number, kind: string}} Command
 * @typedef {{code: number|null, signal?: string, stdout: string, stderr: string, timedOut: boolean, error?: string}} Result
 */

/** @param {Command} command @returns {Promise<Result>} */
export function run({ cmd, args = [], cwd, env, timeoutMs = 10 * 60 * 1000 }) {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const keep = (buf, chunk) => {
      const next = buf + chunk
      return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next
    }
    let child
    try {
      // detached: its own process group, so a timeout can stop the whole tree
      // (npm -> sh -> rsync), not just the parent that would orphan the rest.
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (cause) {
      resolvePromise({ code: null, stdout, stderr, timedOut, error: cause.message })
      return
    }
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal)
      } catch {
        // Group already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 10_000).unref()
    }, timeoutMs)
    // One decoder per stream: a multibyte character split across two chunks stays whole (c.toString() would give U+FFFD twice).
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    child.stdout.on('data', (c) => {
      stdout = keep(stdout, outDecoder.write(c))
    })
    child.stderr.on('data', (c) => {
      stderr = keep(stderr, errDecoder.write(c))
    })
    child.on('error', (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr, timedOut, error: cause.message })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdout = keep(stdout, outDecoder.end())
      stderr = keep(stderr, errDecoder.end())
      resolvePromise({ code: timedOut ? null : code, signal: signal ?? undefined, stdout, stderr, timedOut })
    })
  })
}

export const realRunner = { run }

/**
 * A runner that refuses every command whose kind is not read-only. A dry run
 * uses it, so a bug in the bot's own "would deploy" branch cannot deploy.
 */
export function guardCommands(runner) {
  return {
    run(command) {
      if (!READ_ONLY_KINDS.has(command.kind)) {
        return Promise.reject(new Error(`dry run: refused to run a "${command.kind}" command (${command.cmd})`))
      }
      return runner.run(command)
    },
  }
}

/** True when a command finished on its own with exit 0. */
export const succeeded = (result) => result.code === 0 && !result.timedOut && !result.error
