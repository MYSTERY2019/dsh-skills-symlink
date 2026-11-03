import { readFileSync, unwatchFile, watchFile } from 'node:fs'

import z from '@deepseek-ai/schemastery'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

import {
  DEFAULT_CONFIG_FILE,
  describeProjectSkillConfig,
  expandSkillRoots,
  findProjectRoot,
  isInside,
  isValidMaxDepth,
  MAX_DEPTH,
  MAX_EXPANDED_ROOTS,
  readProjectSkillConfigWithStatus,
  realpathDeep,
  resolveConfigPath,
  resolveSkillRoots,
  sanitizeIgnorePatterns,
} from './project-config.js'
import { diagnosticsFor } from './diagnostics.js'
import { mountProjectSkillPathRoutes } from './routes.js'

const DEFAULT_WATCH_INTERVAL_MS = 500
const MIN_WATCH_INTERVAL_MS = 10
const DEFAULT_MAX_PROJECTS = 128
const MAX_REMEMBERED_WARNINGS = 512
const MAX_REMEMBERED_INFO = 512
const MAX_REMEMBERED_CANDIDATES = 20000
// Cap on how many resolved root paths a single log block lists.
const MAX_LOGGED_ROOTS = 32

/** This package's own version, for the apply() log line. */
export const VERSION = readPackageVersion()

export const name = 'dsh-skills-symlink'
export const inject = ['skills']
export const SETTINGS_NAMESPACE = 'dsh-skills-symlink'

// Numeric options are typed loosely on purpose. A value out of range (a typo
// such as maxDepth: 2.5 or configWatchIntervalMs: 0) is replaced by its
// default with a warning in the plugin log, instead of failing the schema:
// a failed schema stops the whole plugin from loading, and a bad watcher
// value used to throw inside the host and stop DSH from starting.
export const Config = z.object({
  providerName: z.string().min(1).default('dsh-skills-symlink'),
  configFile: z.string().min(1).default(DEFAULT_CONFIG_FILE),
  allowExternalPaths: z.boolean().default(false),
  // 1 = <root>/<skill>/SKILL.md (DSH's own layout)
  // 2 = also <root>/<category>/<skill>/SKILL.md
  // 3+ = one further group/category level each
  maxDepth: z.number().default(1),
  // Directory names skipped while descending. Exact names or `prefix*`.
  // Blank, non-string or path-shaped entries are dropped with a warning.
  ignore: z.array(z.any()).default([]),
  // Upper bound on discovery roots (configured + promoted) per project.
  // Watch-only folders do not count; they have their own fixed cap of 2000.
  maxRoots: z.number().default(MAX_EXPANDED_ROOTS),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(200),
  watchPollIntervalMs: z.number().default(100),
  // Defaults to the value of allowExternalPaths: with external paths off, the
  // watcher does not follow links out of the project either.
  watchFollowSymlinks: z.boolean(),
  configWatchIntervalMs: z.number().default(DEFAULT_WATCH_INTERVAL_MS),
  watchMaxProjects: z.number().default(DEFAULT_MAX_PROJECTS),
  // DSH 0.2.x does not print plugin logs anywhere, so the plugin also appends
  // its info/warn lines to <profile>/logs/dsh-skills-symlink.log (or logFile:
  // an absolute path, or a path relative to the profile directory).
  // Set diagnosticsFile: false to turn the file off.
  diagnosticsFile: z.boolean().default(true),
  logFile: z.string().default(''),
})

export function apply(ctx, config = {}) {
  let provider
  const log = diagnosticsFor(ctx, config)

  // The Host namespace is paired with the Client card of the same key.
  // It intentionally has no user fields: project paths live with the project,
  // in .dsh/skill-paths.yaml, instead of in the global DSH settings document.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, z.object({}), { base: {} })
  })

  // The settings card's route is an exact Fetch route of the host's own client
  // connection, so the host's Host/Origin fence, cookie authentication and
  // owner check run before the plugin sees a request.
  ctx.inject(['connection'], (connectionCtx) => {
    const fetchRegistry = connectionCtx.connection?.fetch
    if (!fetchRegistry || typeof fetchRegistry.register !== 'function') {
      log.warn('dsh-skills-symlink: the host connection has no fetch registry; the settings card cannot load or save')
      return
    }
    mountProjectSkillPathRoutes(fetchRegistry, {
      configFile: config.configFile ?? DEFAULT_CONFIG_FILE,
      allowExternalPaths: config.allowExternalPaths ?? false,
      invalidate: () => provider?.invalidate(),
      inspect: async (projectRoot) => {
        if (provider === undefined) throw new Error('the skills provider is not registered yet')
        return provider.inspectProject(projectRoot)
      },
      knownProjects: async () => knownProjectRoots(ctx, provider),
      onError: (error) => log.warn(`dsh-skills-symlink: settings route failed: ${errorMessage(error)}`),
    })
  })

  ctx.skills.registerProvider((control) => {
    provider = new ProjectSkillPathProvider(ctx, control, config)
    return provider
  })

  // Proof that the plugin really applied inside this host: if this line is
  // missing from the plugin log, the plugin never ran (for example the host
  // skipped the bundle as incompatible before loading any code).
  const effective = provider?.expansionOptions() ?? normalizeOptions(config, () => {})
  const profile = safeGet(ctx, 'profileContext')
  log.info(
    `dsh-skills-symlink: applied v${VERSION}, provider registered with the skills registry ` +
    `(maxDepth=${effective.maxDepth}, configuredRoots=0 in plugin config; roots come from each project's ` +
    `${config.configFile ?? DEFAULT_CONFIG_FILE}, ignore=${effective.ignore.length}, ` +
    `allowExternalPaths=${effective.allowExternalPaths}` +
    `${typeof profile?.name === 'string' ? `, profile=${profile.name}` : ''})`,
  )

  ctx.effect(function* disposeProjectSkillPaths() {
    yield async () => {
      await provider?.dispose()
      await log.flush()
    }
  }, 'dsh-skills-symlink watchers')
}

/**
 * Projects the settings route may read or write: the workspaces DSH has
 * registered, plus the projects sessions of this provider have resolved.
 */
async function knownProjectRoots(ctx, provider) {
  const paths = []
  const registry = safeGet(ctx, 'workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    try {
      const entities = await registry.list()
      for (const entity of Array.isArray(entities) ? entities : []) {
        if (typeof entity?.path === 'string') paths.push(entity.path)
      }
    } catch {
      // fall through to the projects sessions have used
    }
  }
  if (provider !== undefined) paths.push(...provider.projectStates.keys())
  return paths
}

/**
 * Validate the plugin row. Every problem becomes a warning and the default,
 * never an exception: an exception here runs inside registerProvider() and
 * would stop the host.
 */
export function normalizeOptions(config = {}, warn = () => {}) {
  const maxDepth = normalizeMaxDepth(config.maxDepth, warn)
  const allowExternalPaths = config.allowExternalPaths === true
  return {
    maxDepth,
    ignore: sanitizeIgnorePatterns(config.ignore ?? [], maxDepth > 1 ? warn : () => {}),
    maxRoots: integerOption('maxRoots', config.maxRoots, MAX_EXPANDED_ROOTS, 1, MAX_EXPANDED_ROOTS, warn),
    allowExternalPaths,
    configWatchIntervalMs: integerOption(
      'configWatchIntervalMs', config.configWatchIntervalMs, DEFAULT_WATCH_INTERVAL_MS, MIN_WATCH_INTERVAL_MS, 60_000, warn,
    ),
    watchMaxProjects: integerOption('watchMaxProjects', config.watchMaxProjects, DEFAULT_MAX_PROJECTS, 1, 10_000, warn),
    watchStabilityThresholdMs: integerOption(
      'watchStabilityThresholdMs', config.watchStabilityThresholdMs, 200, 1, 60_000, warn,
    ),
    watchPollIntervalMs: integerOption('watchPollIntervalMs', config.watchPollIntervalMs, 100, 1, 60_000, warn),
    watchFollowSymlinks: typeof config.watchFollowSymlinks === 'boolean' ? config.watchFollowSymlinks : allowExternalPaths,
  }
}

/**
 * Runs DSH's own discovery for one root at a time. It is a separate, plain
 * FileSystemSkillProvider with watching off whose only override is roots(),
 * the provider's public extension point, so the plugin does not depend on
 * how list() is implemented inside.
 */
class SingleRootScanner extends FileSystemSkillProvider {
  constructor(ctx, control, providerName) {
    super(ctx, control, {
      providerName,
      includeDefaultRoots: false,
      watch: false,
      watchUsePolling: false,
      watchStabilityThresholdMs: 200,
      watchPollIntervalMs: 100,
      watchMaxProjects: 1,
      watchFollowSymlinks: false,
    })
    this.pending = new Map()
    this.sequence = 0
  }

  async roots(cwd) {
    const root = this.pending.get(cwd)
    return root === undefined ? [] : [root]
  }

  async scan(root) {
    // A unique key per call keeps parallel scans apart.
    this.sequence = (this.sequence + 1) % Number.MAX_SAFE_INTEGER
    const key = `\u0000dsh-skills-symlink-scan:${this.sequence}`
    this.pending.set(key, root)
    try {
      const output = await this.list({ cwd: key })
      return Array.isArray(output) ? output : (output?.candidates ?? [])
    } finally {
      this.pending.delete(key)
    }
  }
}

export class ProjectSkillPathProvider extends FileSystemSkillProvider {
  constructor(ctx, control, config = {}) {
    const pendingWarnings = []
    const options = normalizeOptions(config, (message) => pendingWarnings.push(message))

    super(ctx, control, {
      providerName: config.providerName ?? 'dsh-skills-symlink',
      includeDefaultRoots: false,
      watch: config.watch ?? true,
      watchUsePolling: config.watchUsePolling ?? false,
      watchStabilityThresholdMs: options.watchStabilityThresholdMs,
      watchPollIntervalMs: options.watchPollIntervalMs,
      watchMaxProjects: options.watchMaxProjects,
      watchFollowSymlinks: options.watchFollowSymlinks,
    })

    this.pluginContext = ctx
    this.invalidate = control.invalidate
    this.configFile = config.configFile ?? DEFAULT_CONFIG_FILE
    this.allowExternalPaths = options.allowExternalPaths
    this.warnings = new Set()
    this.log = diagnosticsFor(ctx, config)
    this.maxDepth = options.maxDepth
    this.ignore = options.ignore
    this.maxRoots = options.maxRoots
    this.watchConfig = config.watch ?? true
    this.configWatchIntervalMs = options.configWatchIntervalMs
    this.maxProjects = options.watchMaxProjects
    this.configWatchers = new Map()
    this.projectRoots = new Map()
    this.projectConfigs = new Map()
    this.projectExpansions = new Map()
    this.projectStates = new Map()
    this.shadowPrints = new Map()
    this.candidateProjects = new Map()
    this.infoKeys = new Set()
    this.scanAbort = new AbortController()
    this.scanner = new SingleRootScanner(ctx, {
      invalidate: () => {},
      signal: this.scanAbort.signal,
    }, config.providerName ?? 'dsh-skills-symlink')
    for (const message of pendingWarnings) this.warnOnce(message)
  }

  /** The effective expansion settings, after validation. */
  expansionOptions() {
    return {
      maxDepth: this.maxDepth,
      ignore: [...this.ignore],
      maxRoots: this.maxRoots,
      allowExternalPaths: this.allowExternalPaths,
      watchOnly: this.watchConfig && this.maxDepth > 1,
    }
  }

  async roots(cwd) {
    const project = await this.resolveProject(cwd)
    return project === undefined ? [] : project.roots
  }

  async list(options = {}) {
    try {
      if (this.maxDepth === 1) {
        // DSH's own single-level scan, unchanged; the plugin only removes
        // skills whose real file leaves the project and reports shadowing.
        const output = await super.list(options)
        const listed = Array.isArray(output) ? output : (output?.candidates ?? [])
        const projectRoot = await this.projectRootFor(options.cwd)
        const candidates = await this.filterCandidates(listed, projectRoot)
        this.reportShadowedSkills(candidates, projectRoot)
        if (Array.isArray(output)) return candidates
        return { ...output, candidates }
      }
      return await this.listExpanded(options)
    } catch (error) {
      if (this.disposal !== undefined) throw error
      this.warnOnce(`list() failed for cwd=${String(options.cwd)}: ${errorMessage(error)}`)
      return { candidates: [], complete: false }
    }
  }

  /**
   * Loading a skill re-checks where its file really is, so a link swapped
   * between list() and get() cannot pull in a file from outside the project.
   */
  async get(candidate, options) {
    if (!this.allowExternalPaths) {
      const file = candidateFile(candidate)
      const projectReal = file === undefined ? undefined : this.candidateProjects.get(file)
      if (file === undefined || projectReal === undefined) {
        this.warnOnce(`refused to load skill "${candidate?.name}": it was not listed for a project by this provider`)
        return undefined
      }
      const real = await realpathDeep(file)
      if (!isInside(projectReal, real)) {
        this.warnOnce(`refused to load skill "${candidate?.name}": ${file} now resolves outside the project (${real})`)
        return undefined
      }
    }
    return super.get(candidate, options)
  }

  async listExpanded(options) {
    const project = await this.resolveProject(options.cwd)
    if (project === undefined) return []

    let complete = true
    try {
      await this.watchManager.observeRoots([...project.roots, ...project.watchOnly])
    } catch (error) {
      if (this.disposal !== undefined) throw error
      complete = false
    }

    const { candidates, failed } = await this.scanRoots(project.roots)
    if (failed) complete = false
    const kept = await this.filterCandidates(candidates, project.projectRoot)
    this.reportShadowedSkills(kept, project.projectRoot)
    return complete ? kept : { candidates: kept, complete }
  }

  /**
   * Scan each root with DSH's own discovery. A promoted (category) root
   * only contributes skill directories: a loose .md file directly in a
   * category folder is a note, not a flat skill.
   */
  async scanRoots(roots) {
    const candidates = []
    let failed = false
    for (const root of roots) {
      let found
      try {
        found = await this.discoverSingleRoot(root)
      } catch (error) {
        if (this.disposal !== undefined) throw error
        failed = true
        this.warnOnce(`skipped root ${root.path}: ${errorMessage(error)}`)
        continue
      }
      const expanded = root.depth !== undefined
      for (const candidate of found) {
        if (expanded && candidate.locator?.directory === root.path) continue
        candidates.push({ candidate, root })
      }
    }
    return { candidates: candidates.map((entry) => entry.candidate), entries: candidates, failed }
  }

  /** Run DSH's own discovery for exactly one root, without touching watchers. */
  async discoverSingleRoot(root) {
    return this.scanner.scan(root)
  }

  /**
   * With allowExternalPaths: false, drop every skill whose file really lives
   * outside the project, whatever link led there (a symlinked root, category
   * or skill folder). Kept skills are remembered for the check in get().
   */
  async filterCandidates(candidates, projectRoot) {
    if (this.allowExternalPaths) return candidates
    if (projectRoot === undefined) return candidates.length === 0 ? candidates : []
    const projectReal = await realpathDeep(projectRoot)
    const kept = []
    for (const candidate of candidates) {
      const file = candidateFile(candidate)
      if (file === undefined) {
        this.warnOnce(`skill "${candidate?.name}" has no file path; skipped while allowExternalPaths is false`)
        continue
      }
      const real = await realpathDeep(file)
      if (!isInside(projectReal, real)) {
        this.warnOnce(
          `skill "${candidate.name}" at ${file} resolves outside the project (${real}); skipped. ` +
          'Set allowExternalPaths: true in the plugin row to allow it',
        )
        continue
      }
      this.rememberCandidate(file, projectReal)
      kept.push(candidate)
    }
    return kept
  }

  rememberCandidate(file, projectReal) {
    this.candidateProjects.delete(file)
    this.candidateProjects.set(file, projectReal)
    while (this.candidateProjects.size > MAX_REMEMBERED_CANDIDATES) {
      const oldest = this.candidateProjects.keys().next()
      if (oldest.done) break
      this.candidateProjects.delete(oldest.value)
    }
  }

  async projectRootFor(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    return findProjectRoot(cwd)
  }

  /**
   * Compute a project's roots from its config file. Problems with single
   * entries are warnings; only the bad entry is skipped.
   */
  async computeProjectRoots(projectRoot) {
    const configPath = resolveConfigPath(projectRoot, this.configFile)
    const warnings = []
    const warn = (message) => {
      warnings.push(message)
      this.warnOnce(message)
    }
    const rejected = []
    const { found, document } = await readProjectSkillConfigWithStatus(configPath, { lenient: true, warn })
    const resolved = resolveSkillRoots(projectRoot, document.skillPaths, {
      allowExternalPaths: this.allowExternalPaths,
      onRejected: (message, configuredPath) => {
        rejected.push({ configuredPath, reason: message })
        warn(message)
      },
    })
    const expanded = await expandSkillRoots(resolved, {
      maxDepth: this.maxDepth,
      ignore: this.ignore,
      maxRoots: this.maxRoots,
      allowExternalPaths: this.allowExternalPaths,
      // Watch the directories in between too, so the first skill added to an
      // empty category or group is noticed by the DSH watcher.
      watchOnly: this.watchConfig && this.maxDepth > 1,
      warn,
    })
    return { configPath, found, document, resolved, rejected, expanded, warnings }
  }

  async resolveProject(cwd) {
    if (cwd === undefined || cwd.length === 0) {
      this.infoOnce(
        'no-cwd',
        `roots() called with cwd=${cwd === undefined ? 'undefined' : JSON.stringify(cwd)}; ` +
        'no project can be resolved, contributing 0 roots',
      )
      return undefined
    }

    const projectRoot = await findProjectRoot(cwd)
    const configPath = resolveConfigPath(projectRoot, this.configFile)
    this.observeConfig(projectRoot, configPath)

    const { found, resolved, expanded } = await this.computeProjectRoots(projectRoot)
    const roots = expanded.filter((root) => root.watchOnly !== true)
    const watchOnly = expanded.filter((root) => root.watchOnly === true)

    await this.releaseRemovedProjectRoots(projectRoot, expanded)
    this.projectRoots.set(projectRoot, expanded.map((root) => root.path))
    this.projectConfigs.set(projectRoot, configPath)
    const resolution = {
      configured: resolved.map((root) => root.path),
      roots: roots.map((root) => root.path),
      watchOnly: watchOnly.map((root) => root.path),
    }
    this.projectExpansions.set(projectRoot, resolution)
    this.reportProjectState(cwd, projectRoot, configPath, found, resolution)
    return { projectRoot, roots, watchOnly }
  }

  /**
   * What the settings card shows for one project, computed by the same code
   * the provider lists with (same roots, same filters, same order), without
   * registering watchers.
   */
  async inspectProject(projectRoot) {
    const { configPath, found, document, resolved, rejected, expanded, warnings } =
      await this.computeProjectRoots(projectRoot)
    const roots = expanded.filter((root) => root.watchOnly !== true)
    const watchOnly = expanded.filter((root) => root.watchOnly === true)
    const described = await describeProjectSkillConfig(projectRoot, { skillPaths: resolved.map((root) => root.configuredPath) }, {
      allowExternalPaths: true,
    })

    const { entries } = await this.scanRoots(roots)
    const kept = new Set(await this.filterCandidates(entries.map((entry) => entry.candidate), projectRoot))
    const byRoot = new Map(roots.map((root) => [root.path, []]))
    const winners = new Map()
    const duplicates = new Map()
    for (const { candidate, root } of entries) {
      if (!kept.has(candidate)) continue
      const file = candidateFile(candidate)
      byRoot.get(root.path)?.push({ name: candidate.name, skillFile: file })
      const winner = winners.get(candidate.name)
      if (winner === undefined) {
        winners.set(candidate.name, file)
      } else {
        const entry = duplicates.get(candidate.name) ?? { name: candidate.name, winner, shadowed: [] }
        entry.shadowed.push(file)
        duplicates.set(candidate.name, entry)
      }
    }
    const skillFileCount = [...byRoot.values()].reduce((sum, skills) => sum + skills.length, 0)

    return {
      projectRoot,
      configPath,
      configFound: found,
      skillPaths: document.skillPaths,
      allowExternalPaths: this.allowExternalPaths,
      maxDepth: this.maxDepth,
      ignore: [...this.ignore],
      roots: [
        ...described,
        ...rejected.map((entry) => ({ configuredPath: entry.configuredPath, rejected: entry.reason })),
      ],
      rootCount: roots.length,
      // Every root that is scanned: the configured ones (depth 0) and the
      // category folders promoted below them.
      expandedRoots: roots.map((root) => ({ path: root.path, depth: root.depth ?? 0, configuredPath: root.configuredPath })),
      structure: roots.map((root) => ({
        path: root.path,
        // The text the user wrote for the configured root this came from.
        configuredPath: root.configuredPath,
        depth: root.depth ?? 0,
        skills: byRoot.get(root.path) ?? [],
      })),
      watchOnlyRoots: watchOnly.map((root) => root.path),
      skillCount: winners.size,
      skillFileCount,
      duplicateSkills: skillFileCount - winners.size,
      duplicates: [...duplicates.values()],
      warnings,
    }
  }

  /**
   * Name every shadowed skill with both paths. The warning is repeated
   * whenever the set of shadowed skills of a project changes.
   */
  reportShadowedSkills(candidates, projectRoot) {
    const winners = new Map()
    const messages = []
    for (const candidate of candidates) {
      const winner = winners.get(candidate.name)
      if (winner === undefined) {
        winners.set(candidate.name, candidate)
        continue
      }
      messages.push(
        `skill "${candidate.name}" at ${candidateFile(candidate) ?? candidate.path} is shadowed by ` +
        `${candidateFile(winner) ?? winner.path} ` +
        (this.maxDepth > 1
          ? '(shallower root first, then configured order, then directory name order)'
          : '(earlier configured root first; inside one root, DSH\'s own order)'),
      )
    }
    const key = projectRoot ?? ''
    const print = messages.join('\n')
    if ((this.shadowPrints.get(key) ?? '') === print) return
    this.shadowPrints.delete(key)
    this.shadowPrints.set(key, print)
    while (this.shadowPrints.size > this.maxProjects) {
      const oldest = this.shadowPrints.keys().next()
      if (oldest.done) break
      this.shadowPrints.delete(oldest.value)
    }
    for (const message of messages) this.log.warn(`dsh-skills-symlink: ${message}`)
  }

  warnOnce(message) {
    if (this.warnings.has(message)) return
    if (this.warnings.size >= MAX_REMEMBERED_WARNINGS) this.warnings.clear()
    this.warnings.add(message)
    this.log.warn(`dsh-skills-symlink: ${message}`)
  }

  infoOnce(key, message) {
    if (this.infoKeys.has(key)) return
    if (this.infoKeys.size >= MAX_REMEMBERED_INFO) this.infoKeys.clear()
    this.infoKeys.add(key)
    this.log.info(`dsh-skills-symlink: ${message}`)
  }

  reportProjectState(cwd, projectRoot, configPath, found, resolution) {
    const state = `${found}:${resolution.configured.length}:${resolution.roots.join('|')}`
    if (this.projectStates.get(projectRoot) === state) return
    const first = !this.projectStates.has(projectRoot)
    this.projectStates.delete(projectRoot)
    this.projectStates.set(projectRoot, state)
    while (this.projectStates.size > this.maxProjects) {
      const oldest = this.projectStates.keys().next()
      if (oldest.done) break
      this.projectStates.delete(oldest.value)
    }

    if (!found) {
      this.log.info(
        `dsh-skills-symlink: no project config at ${configPath}; project ${projectRoot} contributes 0 roots`,
      )
    }
    this.log.info(
      `dsh-skills-symlink: roots() ${first ? 'first call' : 'changed'} for cwd=${cwd}: ` +
      `projectRoot=${projectRoot}, configFile=${found ? 'found' : 'missing'}, ` +
      `configuredRoots=${resolution.configured.length}, roots=${resolution.roots.length}, ` +
      `watchOnlyRoots=${resolution.watchOnly.length}, maxDepth=${this.maxDepth}`,
    )
    // List the paths, not only the counts, so a root that swept in an
    // unrelated category is one grep away.
    const listed = resolution.roots.slice(0, MAX_LOGGED_ROOTS)
    listed.forEach((root, index) => {
      this.log.info(`dsh-skills-symlink:   root[${index}] ${root}`)
    })
    if (resolution.roots.length > listed.length) {
      this.log.info(
        `dsh-skills-symlink:   … ${resolution.roots.length - listed.length} more roots not listed`,
      )
    }
  }

  /** A small diagnostics seam for tests. */
  describeProject(projectRoot) {
    const expansion = this.projectExpansions.get(projectRoot)
    return {
      projectRoot,
      configPath: this.projectConfigs.get(projectRoot),
      maxDepth: this.maxDepth,
      roots: [...(expansion?.roots ?? [])],
      configuredRoots: [...(expansion?.configured ?? [])],
      watchOnlyRoots: [...(expansion?.watchOnly ?? [])],
    }
  }

  observeConfig(projectRoot, configPath) {
    if (!this.watchConfig) return

    const existing = this.configWatchers.get(projectRoot)
    if (existing !== undefined && existing.path === configPath) {
      this.configWatchers.delete(projectRoot)
      this.configWatchers.set(projectRoot, existing)
      return
    }
    if (existing !== undefined) this.closeConfigWatcher(existing)

    const listener = (current, previous) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.nlink === previous.nlink &&
        current.ino === previous.ino
      ) return
      this.invalidate()
    }
    try {
      watchFile(configPath, {
        persistent: false,
        interval: this.configWatchIntervalMs,
      }, listener)
    } catch (error) {
      this.warnOnce(`cannot watch ${configPath}: ${errorMessage(error)}; edits need a new session to apply`)
      return
    }
    this.configWatchers.set(projectRoot, { path: configPath, listener })

    while (this.configWatchers.size > this.maxProjects) {
      const oldest = this.configWatchers.entries().next()
      if (oldest.done) break
      this.configWatchers.delete(oldest.value[0])
      this.closeConfigWatcher(oldest.value[1])
    }
  }

  async releaseRemovedProjectRoots(projectRoot, nextRoots) {
    const previous = this.projectRoots.get(projectRoot) ?? []
    const next = new Set(nextRoots.map((root) => root.path))
    const owner = `project:${projectRoot}`

    await Promise.all(previous
      .filter((path) => !next.has(path))
      .map((path) => this.watchManager.releaseRoot(path, owner)))
  }

  dispose() {
    this.disposalPromise ??= this.disposeAll()
    return this.disposalPromise
  }

  async disposeAll() {
    for (const watcher of this.configWatchers.values()) this.closeConfigWatcher(watcher)
    this.configWatchers.clear()
    this.scanAbort.abort()
    await this.scanner.dispose().catch(() => {})
    await super.dispose()
  }

  closeConfigWatcher(watcher) {
    try {
      unwatchFile(watcher.path, watcher.listener)
    } catch {
      // nothing left to close
    }
  }
}

function candidateFile(candidate) {
  const file = candidate?.locator?.path ?? candidate?.path
  return typeof file === 'string' && file.length > 0 ? file : undefined
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function normalizeMaxDepth(value, warn) {
  if (value === undefined || value === null) return 1
  if (isValidMaxDepth(value)) return value
  warn(`maxDepth must be an integer between 1 and ${MAX_DEPTH}; got ${String(value)}, using 1`)
  return 1
}

function integerOption(name, value, fallback, min, max, warn) {
  if (value === undefined || value === null) return fallback
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value
  warn(`${name} must be an integer between ${min} and ${max}; got ${String(value)}, using ${fallback}`)
  return fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export default { name, inject, Config, apply }
