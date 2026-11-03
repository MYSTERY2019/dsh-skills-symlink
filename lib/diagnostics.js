import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const DIAGNOSTICS_FILE_NAME = 'dsh-skills-symlink.log'
const MAX_LOG_BYTES = 512 * 1024
const MAX_PENDING_LINES = 2000
const sinks = new WeakMap()

/**
 * Where the diagnostics file goes, or undefined for none.
 *
 * DSH 0.2.x keeps plugin `ctx.logger` output in an in-memory buffer only, so
 * info and warn lines are not visible anywhere by default. The plugin also
 * appends its own lines to a small file:
 *   logFile, absolute path        -> that file
 *   logFile, relative path        -> resolved against the profile directory
 *   logFile ''                    -> <profile dir>/logs/dsh-skills-symlink.log
 *   diagnosticsFile: false        -> no file, logger only
 * Without a profile directory (older hosts) a relative or empty logFile means
 * no file; the reason is logged once.
 */
export function resolveDiagnosticsFile(ctx, config = {}) {
  return resolveDiagnosticsTarget(ctx, config).file
}

function resolveDiagnosticsTarget(ctx, config) {
  if (config.diagnosticsFile === false) return { file: undefined }
  const profileDir = safeGet(ctx, 'profileContext')?.dir
  const hasProfile = typeof profileDir === 'string' && profileDir.length > 0
  if (typeof config.logFile === 'string' && config.logFile.length > 0) {
    if (isAbsolute(config.logFile)) return { file: config.logFile }
    if (hasProfile) return { file: resolve(profileDir, config.logFile) }
    return { file: undefined, reason: `logFile ${JSON.stringify(config.logFile)} is relative and the host has no profile directory` }
  }
  if (!hasProfile) return { file: undefined }
  return { file: join(profileDir, 'logs', DIAGNOSTICS_FILE_NAME) }
}

/**
 * One sink per plugin context: logger plus the optional diagnostics file.
 * File writes are queued and done asynchronously, so logging never blocks
 * the host's event loop. `flush()` resolves once queued lines are written.
 */
export function diagnosticsFor(ctx, config = {}) {
  const existing = sinks.get(ctx)
  if (existing !== undefined) return existing
  const { file, reason } = resolveDiagnosticsTarget(ctx, config)
  let fileBroken = false
  let pending = []
  let chain = Promise.resolve()
  let scheduled = false

  const drain = async () => {
    scheduled = false
    const lines = pending
    pending = []
    if (lines.length === 0 || fileBroken) return
    try {
      await mkdir(dirname(file), { recursive: true })
      await rotateIfLarge(file)
      await appendFile(file, lines.join(''))
    } catch (error) {
      fileBroken = true
      ctx.logger.warn(`dsh-skills-symlink: cannot write diagnostics file ${file}: ${error?.message ?? error}`)
    }
  }

  const write = (level, message) => {
    if (file === undefined || fileBroken) return
    if (pending.length >= MAX_PENDING_LINES) return
    pending.push(`${new Date().toISOString()} [${level}] ${message}\n`)
    if (scheduled) return
    scheduled = true
    chain = chain.then(drain, drain)
  }

  const sink = {
    file,
    info(message) {
      ctx.logger.info(message)
      write('info', message)
    },
    warn(message) {
      ctx.logger.warn(message)
      write('warn', message)
    },
    flush() {
      return chain
    },
  }
  sinks.set(ctx, sink)
  if (reason !== undefined) ctx.logger.warn(`dsh-skills-symlink: no diagnostics file: ${reason}`)
  return sink
}

async function rotateIfLarge(file) {
  let size = 0
  try {
    size = (await stat(file)).size
  } catch {
    return
  }
  if (size < MAX_LOG_BYTES) return
  await rename(file, `${file}.1`)
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}
