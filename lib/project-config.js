import { realpathSync } from 'node:fs'
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parse, stringify } from 'yaml'

export const DEFAULT_CONFIG_FILE = '.dsh/skill-paths.yaml'
export const PROJECT_SKILL_RANK = 250

/** Folders never treated as a skill category, at any depth. */
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '.dsh', '.agents'])

/**
 * Hard ceiling for expanded roots, and the default of the `maxRoots` option.
 * Every root gets its own DSH watcher, so this bounds watcher fan-out.
 */
export const MAX_EXPANDED_ROOTS = 2000

/** Largest accepted `maxDepth`. */
export const MAX_DEPTH = 6

/** Find the nearest Git project root, matching DSH's filesystem skill policy. */
export async function findProjectRoot(cwd) {
  const start = resolve(cwd)
  let current = start

  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** Resolve the per-project config path. The plugin option itself must stay relative. */
export function resolveConfigPath(projectRoot, configFile = DEFAULT_CONFIG_FILE) {
  if (typeof configFile !== 'string' || configFile.trim().length === 0) {
    throw new TypeError('configFile must be a non-empty relative path')
  }
  if (isAbsolute(configFile)) {
    throw new TypeError('configFile must be relative to the project root')
  }

  const target = resolve(projectRoot, configFile)
  if (!isInside(projectRoot, target)) {
    throw new TypeError('configFile must stay inside the project root')
  }
  return target
}

/** Read and validate one project's .dsh/skill-paths.yaml document. */
export async function readProjectSkillConfig(configPath, options = {}) {
  return (await readProjectSkillConfigWithStatus(configPath, options)).document
}

/**
 * Like readProjectSkillConfig, and also says whether the file exists, so the
 * provider can log a missing config instead of contributing 0 roots silently.
 */
export async function readProjectSkillConfigWithStatus(configPath, options = {}) {
  let raw
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { found: false, document: { version: 1, skillPaths: [] } }
    throw error
  }

  return { found: true, document: parseProjectSkillConfig(raw, configPath, options) }
}

/**
 * Persist one project's config document.
 *
 * Everything is validated before the file is touched: the document shape and,
 * with `allowExternalPaths: false`, that every entry stays inside the project
 * by its real path. A rejected save leaves the old file as it was.
 *
 * The write never follows a symbolic link: a symlinked config directory or
 * config file is refused, and the config directory must resolve inside the
 * project. The new content goes to a temporary file in the same directory and
 * replaces the old file with one rename, so a crash never leaves a half file.
 */
export async function writeProjectSkillConfig(projectRoot, skillPaths, configFile = DEFAULT_CONFIG_FILE, options = {}) {
  const configPath = resolveConfigPath(projectRoot, configFile)
  if (!Array.isArray(skillPaths)) throw new TypeError('skillPaths must be an array')
  const document = parseProjectSkillConfig(stringify({ version: 1, skillPaths }), configPath)
  resolveSkillRoots(projectRoot, document.skillPaths, { allowExternalPaths: options.allowExternalPaths === true })

  const projectReal = await realpath(projectRoot)
  const configDir = dirname(configPath)
  await ensureRealDirectoryInside(projectRoot, projectReal, configDir)
  const existing = await lstatOrUndefined(configPath)
  if (existing?.isSymbolicLink()) {
    throw new UnsafeConfigPathError(`${configPath} is a symbolic link; refusing to write through it`)
  }
  if (existing && !existing.isFile()) {
    throw new UnsafeConfigPathError(`${configPath} exists and is not a regular file`)
  }

  const body = stringify(document, { lineWidth: 0 })
  const temporary = join(configDir, `.${basename(configPath)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o644)
    await handle.writeFile(body, 'utf8')
    await handle.sync().catch(() => {})
    await handle.close()
    handle = undefined
    await rename(temporary, configPath)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  return { configPath, document }
}

/** A config write that would leave the project or follow a symbolic link. */
export class UnsafeConfigPathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsafeConfigPathError'
    this.code = 'unsafe-config-path'
  }
}

async function ensureRealDirectoryInside(projectRoot, projectReal, directory) {
  if (!isInside(projectRoot, directory)) {
    throw new UnsafeConfigPathError(`${directory} is outside the project`)
  }
  // Walk from the project root down, refusing any symbolic link on the way and
  // creating what is missing, so the final directory is a real one inside.
  const segments = relative(projectRoot, directory).split(sep).filter(Boolean)
  let current = projectRoot
  for (const segment of segments) {
    current = join(current, segment)
    const info = await lstatOrUndefined(current)
    if (info === undefined) {
      try {
        await mkdir(current)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      continue
    }
    if (info.isSymbolicLink()) {
      throw new UnsafeConfigPathError(`${current} is a symbolic link; refusing to write through it`)
    }
    if (!info.isDirectory()) {
      throw new UnsafeConfigPathError(`${current} exists and is not a directory`)
    }
  }
  const real = await realpath(directory)
  if (!isInside(projectReal, real)) {
    throw new UnsafeConfigPathError(`${directory} resolves outside the project (${real})`)
  }
}

async function lstatOrUndefined(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Browser-safe diagnostics for the settings card. */
export async function describeProjectSkillConfig(projectRoot, document, options = {}) {
  const roots = resolveSkillRoots(projectRoot, document.skillPaths, options)
  return Promise.all(roots.map(async (root) => ({
    configuredPath: root.configuredPath,
    resolvedPath: root.path,
    exists: await isDirectory(root.path),
    source: root.source,
    rank: root.rank,
  })))
}

/**
 * Parse the project config without touching the filesystem.
 *
 * Strict by default (the settings card's save path): any problem throws.
 * With `{ lenient: true, warn }` (the provider's read path) a problem with one
 * entry or an unknown key is reported through `warn` and skipped, so one bad
 * line never empties the whole project. A file that cannot be read as a
 * version 1 mapping with a `skillPaths` list still throws.
 */
export function parseProjectSkillConfig(raw, source = DEFAULT_CONFIG_FILE, options = {}) {
  const lenient = options.lenient === true
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  let document
  try {
    document = parse(raw)
  } catch (error) {
    throw new TypeError(`${source}: invalid YAML: ${errorMessage(error)}`)
  }

  if (!isRecord(document)) {
    throw new TypeError(`${source}: expected a YAML mapping`)
  }

  const allowed = new Set(['version', 'skillPaths'])
  for (const key of Object.keys(document)) {
    if (allowed.has(key)) continue
    const hint = PLUGIN_ROW_KEYS.has(key)
      ? `; ${key} is a plugin option and belongs in the plugin row of the DSH profile, not in this file`
      : ''
    const message = `${source}: unknown field ${JSON.stringify(key)}${hint}`
    if (!lenient) throw new TypeError(message)
    warn(`${message}; ignored`)
  }

  if (document.version !== 1) {
    throw new TypeError(`${source}: version must be 1`)
  }
  if (!Array.isArray(document.skillPaths)) {
    throw new TypeError(`${source}: skillPaths must be an array`)
  }

  const skillPaths = []
  for (let index = 0; index < document.skillPaths.length; index += 1) {
    const value = document.skillPaths[index]
    if (typeof value !== 'string' || value.trim().length === 0) {
      const message = `${source}: skillPaths[${index}] must be a non-empty string`
      if (!lenient) throw new TypeError(message)
      warn(`${message}; skipped`)
      continue
    }
    skillPaths.push(value.trim())
  }

  return { version: 1, skillPaths }
}

/**
 * Turn configured roots into DSH filesystem-provider root descriptors.
 * Relative paths resolve from the Git project root. External paths require an
 * explicit host-plugin opt-in so a cloned repository cannot read arbitrary
 * local SKILL files by default.
 */
export function resolveSkillRoots(projectRoot, configuredPaths, options = {}) {
  const allowExternalPaths = options.allowExternalPaths === true
  const onRejected = typeof options.onRejected === 'function' ? options.onRejected : undefined
  const projectReal = allowExternalPaths ? undefined : realpathDeepSync(projectRoot)
  const seen = new Set()
  const roots = []

  for (const configuredPath of configuredPaths) {
    const target = isAbsolute(configuredPath)
      ? resolve(configuredPath)
      : resolve(projectRoot, configuredPath)

    if (!allowExternalPaths) {
      // Both the written path and the path it really points to must stay in
      // the project: a symlink inside the project that points outside it is
      // as external as an absolute path.
      let problem
      if (!isInside(projectRoot, target)) {
        problem = `skill path ${JSON.stringify(configuredPath)} resolves outside the project`
      } else {
        const real = realpathDeepSync(target)
        if (!isInside(projectReal, real)) {
          problem = `skill path ${JSON.stringify(configuredPath)} is a symbolic link (or sits below one) ` +
            `that resolves outside the project (${real})`
        }
      }
      if (problem !== undefined) {
        const message = `${problem}; set allowExternalPaths: true in the plugin row to allow it`
        if (onRejected === undefined) throw new ExternalPathError(message)
        onRejected(message, configuredPath)
        continue
      }
    }

    const key = process.platform === 'win32' ? target.toLowerCase() : target
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({
      path: target,
      configuredPath,
      source: 'project-config',
      rank: PROJECT_SKILL_RANK,
      projectRoot,
    })
  }

  return roots
}

/**
 * Turn configured roots into the set of discovery roots DSH needs at a given
 * depth. DSH scans exactly one level per root, so a category layout
 * (`<root>/<category>/<skill>/SKILL.md`) only becomes discoverable when each
 * category is handed to the provider as its own root.
 *
 * `maxDepth: 1` returns the configured roots unchanged. With `maxDepth: N`
 * every directory between depth 1 and N - 1 below a configured root is
 * visited (descend), but only a directory whose direct children include a
 * skill directory (`<child>/SKILL.md`) is returned as a root (promote). Pure
 * grouping directories are walked through without becoming roots, so a
 * documentation folder never turns into a root and its `.md` files never
 * surface as flat skills.
 *
 * Rules, in order:
 * - Names starting with `.`, the fixed names `.git`, `node_modules`, `.dsh`,
 *   `.agents`, and names matching `ignore` are neither descended nor promoted.
 *   `ignore` only applies to category and group directories, never to a
 *   configured root or to a skill directory.
 * - A directory that carries its own `SKILL.md` is a skill: it is never a root
 *   and is never descended into.
 * - Directories are read in code-point order of their names and the result is
 *   ordered by depth (shallower first), then by configured order, then by that
 *   name order. DSH resolves equal skill names inside one provider by this
 *   order, so it is the tie-break for same-name skills in different categories.
 * - Directories are de-duplicated by their real path (case-insensitive on
 *   Windows), so a symlinked alias or a self-referencing link adds nothing.
 * - With `allowExternalPaths: false`, a configured root or a directory whose
 *   real path leaves the project is skipped with a warning. The configured
 *   root's own real path is not a boundary: a symlinked root that points out
 *   of the project is dropped, not trusted.
 * - `maxRoots` caps the total number of returned roots. Configured roots always
 *   stay; the remaining budget is shared fairly between configured roots, so
 *   one large path cannot starve another. Truncation warns with the path.
 * - With `watchOnly: true`, visited directories that are not promoted are also
 *   returned, flagged `watchOnly: true`, so a caller can watch them for new
 *   skills. They never count toward `maxRoots`; they have their own fixed cap
 *   (MAX_EXPANDED_ROOTS), so empty folders can never push real categories out.
 * - Directories that cannot be read for a reason other than "missing" are
 *   reported through `warn` and skipped.
 */
export async function expandSkillRoots(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 1
  if (!isValidMaxDepth(maxDepth)) {
    throw new TypeError(`maxDepth must be an integer between 1 and ${MAX_DEPTH}`)
  }
  const ignored = normalizeIgnore(options.ignore)
  if (maxDepth === 1) return roots

  const maxRoots = options.maxRoots ?? MAX_EXPANDED_ROOTS
  if (!Number.isSafeInteger(maxRoots) || maxRoots < 1) {
    throw new TypeError('maxRoots must be a positive integer')
  }
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  const walkOptions = {
    maxDepth,
    maxRoots,
    ignored,
    warn,
    caseInsensitive,
    watchOnly: options.watchOnly === true,
    checkExternal: options.allowExternalPaths === false,
  }

  // Configured roots first, de-duplicated by real path.
  const seen = new Set()
  const configured = []
  for (const root of roots) {
    const real = await realpathOrSelf(root.path)
    if (walkOptions.checkExternal && typeof root.projectRoot === 'string' && root.projectRoot.length > 0) {
      const projectReal = await realpathOrSelf(root.projectRoot)
      if (!isInside(projectReal, real)) {
        warn(`skill path ${JSON.stringify(root.configuredPath ?? root.path)} (${root.path}) resolves outside ` +
          `the project (${real}); skipped. Set allowExternalPaths: true in the plugin row to allow it`)
        continue
      }
    }
    const key = pathKey(real, caseInsensitive)
    if (seen.has(key)) continue
    seen.add(key)
    configured.push({ root, real })
  }

  // Walk each configured root on its own (bounded by maxRoots each).
  const walks = []
  for (const [index, { root, real }] of configured.entries()) {
    walks.push({ index, root, ...(await walkConfiguredRoot(root, real, walkOptions)) })
  }

  // Claim directories in global order so overlapping configured roots never
  // produce the same root twice.
  const ordered = walks
    .flatMap((walk) => walk.found.map((entry, position) => ({ ...entry, walk: walk.index, position })))
    .filter((entry) => !entry.watchOnly)
    .sort((left, right) => left.depth - right.depth || left.walk - right.walk || left.position - right.position)
  const claimed = new Map(walks.map((walk) => [walk.index, []]))
  for (const entry of ordered) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    claimed.get(entry.walk).push(entry)
  }

  // Share the remaining budget fairly (max-min) between configured roots.
  const budget = Math.max(0, maxRoots - configured.length)
  const allocation = fairShare(walks.map((walk) => claimed.get(walk.index).length), budget)
  const kept = []
  for (const [slot, walk] of walks.entries()) {
    const entries = claimed.get(walk.index)
    const allowed = allocation[slot]
    kept.push(...entries.slice(0, allowed))
    if (entries.length > allowed || walk.capped) {
      const skipped = entries.length - allowed
      warn(
        `skill path ${JSON.stringify(walk.root.configuredPath ?? walk.root.path)} (${walk.root.path}) ` +
        `has more directories than fit in maxRoots ${maxRoots} at maxDepth ${maxDepth}: ` +
        `kept ${allowed}, skipped ${walk.capped ? 'at least ' : ''}${skipped}`,
      )
    }
  }

  if (configured.length >= maxRoots && claimed.size > 0 && [...claimed.values()].some((entries) => entries.length > 0)) {
    warn(`maxRoots ${maxRoots} is not larger than the ${configured.length} configured root(s), ` +
      'so no category directory can be added; raise maxRoots')
  }

  // Watch-only directories: claimed after the real roots, capped separately.
  const watchOnlyEntries = []
  if (walkOptions.watchOnly) {
    const pending = walks
      .flatMap((walk) => walk.watchFound.map((entry, position) => ({ ...entry, walk: walk.index, position })))
      .sort((left, right) => left.depth - right.depth || left.walk - right.walk || left.position - right.position)
    for (const entry of pending) {
      if (seen.has(entry.key)) continue
      if (watchOnlyEntries.length >= MAX_EXPANDED_ROOTS) {
        warn(`maxDepth ${maxDepth}: more than ${MAX_EXPANDED_ROOTS} empty folders to watch; the rest are not watched`)
        break
      }
      seen.add(entry.key)
      watchOnlyEntries.push(entry)
    }
  }

  kept.sort((left, right) => left.depth - right.depth || left.walk - right.walk || left.position - right.position)
  return [
    ...configured.map(({ root }) => root),
    ...[...kept, ...watchOnlyEntries].map((entry) => {
      const expanded = { ...entry.parent, path: entry.path, depth: entry.depth }
      if (entry.watchOnly) expanded.watchOnly = true
      return expanded
    }),
  ]
}

/** Breadth-first walk below one configured root. */
async function walkConfiguredRoot(root, rootReal, options) {
  const { maxDepth, maxRoots, ignored, warn, caseInsensitive, watchOnly, checkExternal } = options
  const projectReal = typeof root.projectRoot === 'string' && root.projectRoot.length > 0
    ? await realpathOrSelf(root.projectRoot)
    : undefined
  const visited = new Set([pathKey(rootReal, caseInsensitive)])
  const found = []
  const watchFound = []
  let capped = false
  let frontier = [{ path: root.path, depth: 0, entries: await readDirectoryEntries(root.path, warn) }]

  while (frontier.length > 0 && !capped) {
    const next = []
    for (const parent of frontier) {
      for (const entry of parent.entries) {
        if (isSkippedName(entry.name, ignored, caseInsensitive)) continue
        const childPath = join(parent.path, entry.name)
        if (!(await isDirectoryEntry(entry, childPath))) continue
        if (await isFile(join(childPath, 'SKILL.md'))) continue

        const real = await realpathOrSelf(childPath)
        // The boundary is the project's real path only. The configured root's
        // real path is not trusted on its own: if the root itself is a link
        // that leaves the project, nothing below it is in the project either.
        if (checkExternal && !(projectReal !== undefined && isInside(projectReal, real))) {
          warn(`directory ${childPath} resolves outside the project (${real}); skipped. ` +
            'Set allowExternalPaths: true in the plugin row to allow it')
          continue
        }
        const key = pathKey(real, caseInsensitive)
        if (visited.has(key)) continue
        visited.add(key)

        const depth = parent.depth + 1
        const entries = await readDirectoryEntries(childPath, warn)
        const promote = await hasSkillChild(childPath, entries)
        if (promote) {
          if (found.length >= maxRoots) {
            capped = true
            break
          }
          found.push({ path: childPath, depth, key, watchOnly: false, parent: root })
        } else if (watchOnly && watchFound.length < MAX_EXPANDED_ROOTS) {
          watchFound.push({ path: childPath, depth, key, watchOnly: true, parent: root })
        }
        if (depth + 1 < maxDepth) next.push({ path: childPath, depth, entries })
      }
      if (capped) break
    }
    frontier = next
  }

  return { found, watchFound, capped }
}

/** Max-min fair allocation of `budget` between demands. */
function fairShare(demands, budget) {
  const allocation = demands.map(() => 0)
  let remaining = budget
  let open = demands.map((_, index) => index).filter((index) => demands[index] > 0)
  while (remaining > 0 && open.length > 0) {
    const share = Math.max(1, Math.floor(remaining / open.length))
    for (const index of open) {
      if (remaining === 0) break
      const give = Math.min(share, demands[index] - allocation[index], remaining)
      allocation[index] += give
      remaining -= give
    }
    open = open.filter((index) => allocation[index] < demands[index])
  }
  return allocation
}

/** True for a value accepted by `maxDepth`. */
export function isValidMaxDepth(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DEPTH
}

/**
 * Clean an `ignore` list coming from user configuration: drop entries that are
 * not strings, blank, or use an unsupported shape (paths, inner `*`, `?`), and
 * report each dropped entry through `warn`. The result is safe to pass to
 * `expandSkillRoots`, which itself rejects malformed entries.
 */
export function sanitizeIgnorePatterns(value, warn = () => {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warn(`ignore must be an array of directory names; ignoring ${JSON.stringify(value)}`)
    return []
  }
  const result = []
  for (const entry of value) {
    const problem = ignorePatternProblem(entry)
    if (problem !== undefined) {
      warn(`ignore entry ${safeJson(entry)} ${problem}; it was dropped`)
      continue
    }
    result.push(entry.trim())
  }
  return result
}

export function isInside(parent, target) {
  const offset = relative(resolve(parent), resolve(target))
  return offset === '' || (
    offset !== '..' &&
    !offset.startsWith(`..${sep}`) &&
    !isAbsolute(offset)
  )
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** True when `dir` directly contains at least one directory carrying a SKILL.md. */
async function hasSkillChild(dir, entries) {
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue
    const childPath = join(dir, entry.name)
    if (!(await isDirectoryEntry(entry, childPath))) continue
    if (await isFile(join(childPath, 'SKILL.md'))) return true
  }
  return false
}

/** Directory entries sorted by code point; unreadable directories warn once per call. */
async function readDirectoryEntries(path, warn) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.sort((left, right) => compareCodePoints(left.name, right.name))
  } catch (error) {
    if (!isMissingOrNotDirectory(error)) {
      warn(`cannot read directory ${path} (${errorCode(error)}); skipped`)
    }
    return []
  }
}

async function isDirectoryEntry(entry, path) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  return isDirectory(path)
}

/** A configured path that leaves the project while external paths are off. */
export class ExternalPathError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'ExternalPathError'
    this.code = 'external-path'
  }
}

/** Keys that users put in the project file but that belong to the plugin row. */
const PLUGIN_ROW_KEYS = new Set([
  'maxDepth', 'ignore', 'maxRoots', 'allowExternalPaths', 'configFile', 'configWatchIntervalMs',
  'watch', 'watchStabilityThresholdMs', 'watchPollIntervalMs', 'watchFollowSymlinks', 'watchMaxProjects',
])

/**
 * Real path of `path`, also when it does not exist yet: the nearest existing
 * ancestor is resolved and the missing tail is appended. So a missing path
 * below a symlinked directory still reports where it really lands.
 */
export function realpathDeepSync(path) {
  const absolute = resolve(path)
  const tail = []
  let current = absolute
  while (true) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

/** Async form of {@link realpathDeepSync}. */
export async function realpathDeep(path) {
  const absolute = resolve(path)
  const tail = []
  let current = absolute
  while (true) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

async function realpathOrSelf(path) {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

function pathKey(path, caseInsensitive) {
  return caseInsensitive ? path.toLowerCase() : path
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function isSkippedName(name, ignored, caseInsensitive) {
  if (name.startsWith('.')) return true
  if (IGNORED_DIRECTORY_NAMES.has(name)) return true
  return matchesIgnore(name, ignored, caseInsensitive)
}

function ignorePatternProblem(entry) {
  if (typeof entry !== 'string') return 'is not a string'
  const pattern = entry.trim()
  if (pattern.length === 0) return 'is empty'
  if (/[\\/]/.test(pattern)) return 'contains a path separator; only directory names are supported'
  const star = pattern.indexOf('*')
  if (star !== -1 && star !== pattern.length - 1) return 'uses "*" outside the end; only `prefix*` is supported'
  if (pattern.includes('?')) return 'uses "?"; only exact names and `prefix*` are supported'
  return undefined
}

/** `ignore` accepts exact directory names and `prefix*` patterns. */
function normalizeIgnore(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('ignore must be an array of strings')
  return value.map((entry) => {
    const problem = ignorePatternProblem(entry)
    if (problem !== undefined) {
      throw new TypeError(`ignore entries must be non-empty directory names: ${safeJson(entry)} ${problem}`)
    }
    return entry.trim()
  })
}

function matchesIgnore(name, patterns, caseInsensitive) {
  const subject = caseInsensitive ? name.toLowerCase() : name
  for (const raw of patterns) {
    const pattern = caseInsensitive ? raw.toLowerCase() : raw
    if (pattern.endsWith('*')) {
      if (subject.startsWith(pattern.slice(0, -1))) return true
    } else if (subject === pattern) {
      return true
    }
  }
  return false
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isMissingOrNotDirectory(error) {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : errorMessage(error)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
