// Regression tests for the v0.4.0 audit findings. Each test names the finding
// it covers. Integration tests run the real @deepseek-ai/dsh-skill registry.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import ProjectSkillPaths, { Config, normalizeOptions, ProjectSkillPathProvider } from '../lib/index.js'
// Namespace import so this file also loads against older versions (used to
// show which tests fail before the fix).
import * as projectConfig from '../lib/project-config.js'
import { bootPlugin } from './plugin-harness.mjs'

const { expandSkillRoots, resolveSkillRoots } = projectConfig
const sanitizeIgnorePatterns = (...args) => projectConfig.sanitizeIgnorePatterns(...args)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function writeSkill(parent, directoryName, skillName = directoryName) {
  const directory = join(parent, directoryName)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${skillName}`,
    `description: Fixture for ${skillName}.`,
    '---',
    '',
    `LOCATED_AT ${directory}`,
    '',
  ].join('\n'))
  return directory
}

async function writeDoc(path, name) {
  await writeFile(path, ['---', `name: ${name}`, 'description: Prose, not a skill.', '---', '', 'doc', ''].join('\n'))
}

async function makeProject(skillPaths = ['lib']) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-audit-regression-'))
  const project = join(base, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh'), { recursive: true })
  await writeFile(join(project, '.dsh', 'skill-paths.yaml'), [
    'version: 1',
    'skillPaths:',
    ...skillPaths.map((path) => `  - ${JSON.stringify(path)}`),
    '',
  ].join('\n'))
  return { base, project }
}

/**
 * Boot a real registry. `mode: 'plugin'` goes through the plugin's Config
 * schema; `mode: 'direct'` constructs the provider class with the raw config.
 */
async function boot(config, mode = 'plugin') {
  const ctx = new Context()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const registryFiber = ctx.plugin(SkillRegistry)
  await registryFiber
  let provider
  const fiber = mode === 'direct'
    ? ctx.plugin({
      name: 'direct-dsh-skills-symlink',
      inject: ['skills'],
      apply(child) {
        child.skills.registerProvider((control) => {
          provider = new ProjectSkillPathProvider(child, control, config)
          return provider
        })
        child.effect(function* disposeDirect() {
          yield async () => { await provider?.dispose() }
        }, 'direct provider')
      },
    })
    : ctx.plugin(ProjectSkillPaths, config)
  await fiber
  provider ??= [...ctx.skills.layers.global.providers.values()][0]?.provider
  return {
    ctx,
    provider,
    warnings,
    async names(cwd) {
      return (await ctx.skills.list({ cwd })).map((skill) => skill.name).sort()
    },
    async close() {
      await fiber.dispose()
      await registryFiber.dispose()
    },
  }
}

function root(path, projectRoot = '') {
  return { path, configuredPath: '.', source: 'project-config', rank: 250, projectRoot }
}

/** True when this process can read a mode-000 file (root or CAP_DAC_OVERRIDE). */
async function permissionsAreBypassed() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perm-probe-'))
  const file = join(dir, 'probe')
  await writeFile(file, 'x')
  await chmod(file, 0o000)
  try {
    await readFile(file)
    return true
  } catch {
    return false
  } finally {
    await chmod(file, 0o644)
    await rm(dir, { recursive: true, force: true })
  }
}

// [blocker] pure group directories are walked through at maxDepth 3

test('[blocker] maxDepth 3 promotes leaf categories under a pure group directory', async () => {
  const { project } = await makeProject()
  const lib = join(project, 'lib')
  await writeSkill(join(lib, 'writing', 'drafts'), 'f1')
  await writeSkill(join(lib, 'writing', 'notes'), 'r1')
  await writeSkill(join(lib, 'engineering', 'tools'), 't1')

  const roots = await expandSkillRoots(resolveSkillRoots(project, ['lib']), { maxDepth: 3 })
  assert.deepEqual(roots.map((entry) => entry.path), [
    lib,
    join(lib, 'engineering', 'tools'),
    join(lib, 'writing', 'drafts'),
    join(lib, 'writing', 'notes'),
  ])
  // A pure group is never itself a root.
  assert.equal(roots.some((entry) => entry.path === join(lib, 'writing')), false)

  const env = await boot({ watch: false, maxDepth: 3 })
  try {
    assert.deepEqual(await env.names(project), ['f1', 'r1', 't1'])
  } finally {
    await env.close()
  }
})

test('[blocker] maxDepth 2 does not descend into a pure group (skills stay out of range)', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'group', 'cat'), 'too-deep')
  await writeSkill(join(project, 'lib', 'cat'), 'in-range')
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await env.names(project), ['in-range'])
  } finally {
    await env.close()
  }
})

// [high] non-integer maxDepth

test('[high] Config schema accepts loose numbers and normalizeOptions falls back to defaults with a warning', () => {
  // A schema failure would stop the whole plugin from loading, so the schema
  // only checks the type; ranges are enforced by normalizeOptions with a warning.
  for (const value of [2.5, Number.NaN, 0, 7]) {
    assert.equal(Config({ maxDepth: value }).maxDepth, value)
    const warnings = []
    assert.equal(normalizeOptions({ maxDepth: value }, (line) => warnings.push(line)).maxDepth, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /maxDepth must be an integer between 1 and 6/)
  }
  assert.equal(Config({ maxDepth: 3 }).maxDepth, 3)
  assert.equal(normalizeOptions({ maxDepth: 3 }).maxDepth, 3)
  assert.equal(Config({}).maxDepth, 1)
})

for (const value of [2.5, Number.NaN, 0, 9]) {
  test(`[high] a provider built with maxDepth ${value} falls back to 1 instead of dropping every skill`, async () => {
    const { project } = await makeProject()
    await writeSkill(join(project, 'lib'), 'top')
    await writeSkill(join(project, 'lib', 'cat'), 'nested')
    const env = await boot({ watch: false, maxDepth: value }, 'direct')
    try {
      assert.deepEqual(await env.names(project), ['top'])
      assert.equal(env.warnings.filter((line) => /maxDepth must be an integer/.test(line)).length, 1)
      assert.match(env.warnings[0], /using 1/)
    } finally {
      await env.close()
    }
  })
}

// [high] blank / null ignore entries

for (const bad of ['', '   ', null, 42]) {
  test(`[high] ignore entry ${JSON.stringify(bad)} is dropped with a warning at maxDepth 2`, async () => {
    const { project } = await makeProject()
    await writeSkill(join(project, 'lib'), 'top')
    await writeSkill(join(project, 'lib', 'cat'), 'nested')
    await writeSkill(join(project, 'lib', 'legacy'), 'old')
    const env = await boot({ watch: false, maxDepth: 2, ignore: [bad, 'legacy'] }, 'direct')
    try {
      assert.deepEqual(await env.names(project), ['nested', 'top'])
      assert.equal(env.warnings.filter((line) => /ignore entry .* dropped/.test(line)).length, 1)
    } finally {
      await env.close()
    }
  })
}

test('[high] blank ignore entries through the plugin schema keep every skill', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib'), 'top')
  await writeSkill(join(project, 'lib', 'cat'), 'nested')
  const env = await boot({ watch: false, maxDepth: 3, ignore: ['', '  '] })
  try {
    assert.deepEqual(await env.names(project), ['nested', 'top'])
  } finally {
    await env.close()
  }
})

test('[high] maxDepth 1 stays silent about ignore entries, like upstream', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib'), 'top')
  const env = await boot({ watch: false, ignore: [''] }, 'direct')
  try {
    assert.deepEqual(await env.names(project), ['top'])
    assert.deepEqual(env.warnings, [])
  } finally {
    await env.close()
  }
})

test('[high] sanitizeIgnorePatterns drops and reports unusable entries', () => {
  const warnings = []
  const result = sanitizeIgnorePatterns(['', ' ', null, 3, 'a/b', 'a\\b', 'x*y', 'q?', ' keep ', 'pre*'], (m) => warnings.push(m))
  assert.deepEqual(result, ['keep', 'pre*'])
  assert.equal(warnings.length, 8)
  assert.deepEqual(sanitizeIgnorePatterns(undefined), [])
  assert.deepEqual(sanitizeIgnorePatterns('legacy', (m) => warnings.push(m)), [])
})

// [medium] documentation .md inside a promoted category

test('[medium] doc .md files directly in an expanded category are not skills and do not shadow a real one', async () => {
  const { project } = await makeProject()
  const mixed = join(project, 'lib', 'mixed')
  const real = await writeSkill(mixed, 'real-skill')
  await writeDoc(join(mixed, 'README.md'), 'real-skill')
  await writeDoc(join(mixed, 'notes.md'), 'notes')
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    const listed = await env.ctx.skills.list({ cwd: project })
    assert.deepEqual(listed.map((skill) => skill.name), ['real-skill'])
    assert.equal(listed[0].resourceBase.path, real)
    const loaded = await env.ctx.skills.get('real-skill', { cwd: project })
    assert.match(loaded.content, /LOCATED_AT/)
  } finally {
    await env.close()
  }
})

test('[medium] flat .md skills in a configured root are still discovered at maxDepth 2', async () => {
  const { project } = await makeProject()
  await mkdir(join(project, 'lib'), { recursive: true })
  await writeDoc(join(project, 'lib', 'flat.md'), 'flat-skill')
  await writeSkill(join(project, 'lib', 'cat'), 'nested')
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await env.names(project), ['flat-skill', 'nested'])
  } finally {
    await env.close()
  }
})

// [medium] hot reload into existing empty categories and groups

async function waitForNames(env, project, expected) {
  let names = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    names = await env.names(project)
    if (expected.every((name) => names.includes(name))) return names
    await sleep(150)
  }
  return names
}

test('[medium] the first skill added to an existing empty category is picked up by the watcher', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'existing')
  await mkdir(join(project, 'lib', 'empty-cat'), { recursive: true })
  const env = await boot({ maxDepth: 2, watchStabilityThresholdMs: 50, watchPollIntervalMs: 50 })
  try {
    assert.deepEqual(await env.names(project), ['existing'])
    await writeSkill(join(project, 'lib', 'empty-cat'), 'first-in-empty')
    assert.deepEqual(await waitForNames(env, project, ['first-in-empty']), ['existing', 'first-in-empty'])
  } finally {
    await env.close()
  }
})

test('[medium] a new category created inside an existing empty group is picked up at maxDepth 3', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'existing')
  await mkdir(join(project, 'lib', 'group'), { recursive: true })
  const env = await boot({ maxDepth: 3, watchStabilityThresholdMs: 50, watchPollIntervalMs: 50 })
  try {
    assert.deepEqual(await env.names(project), ['existing'])
    await writeSkill(join(project, 'lib', 'group', 'new-cat'), 'first-in-group')
    assert.deepEqual(await waitForNames(env, project, ['first-in-group']), ['existing', 'first-in-group'])
  } finally {
    await env.close()
  }
})

test('[medium] watch: false registers no watch-only roots', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'existing')
  await mkdir(join(project, 'lib', 'empty-cat'), { recursive: true })
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    await env.names(project)
    assert.deepEqual(env.provider.describeProject(project).watchOnlyRoots, [])
  } finally {
    await env.close()
  }
})

// [medium] same-name skills across categories

test('[medium] same-name skills resolve by depth, then code-point order, and the warning names both paths', async () => {
  const { project } = await makeProject()
  const lib = join(project, 'lib')
  await writeSkill(join(lib, 'b-cat'), 'x', 'dup')
  const winner = await writeSkill(join(lib, 'a-cat'), 'y', 'dup')
  await writeSkill(join(lib, 'A-group', 'c'), 'z', 'dup')
  const env = await boot({ watch: false, maxDepth: 3 })
  try {
    const listed = await env.ctx.skills.list({ cwd: project })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].resourceBase.path, winner)
    const shadow = env.warnings.filter((line) => /is shadowed by/.test(line))
    assert.equal(shadow.length, 2)
    assert.ok(shadow.every((line) => line.includes(join(winner, 'SKILL.md'))))
    assert.ok(shadow.some((line) => line.includes(join(lib, 'b-cat', 'x', 'SKILL.md'))))
    assert.ok(shadow.some((line) => line.includes(join(lib, 'A-group', 'c', 'z', 'SKILL.md'))))
  } finally {
    await env.close()
  }
})

test('[medium] expansion order is code-point order, independent of creation order', async () => {
  const { project } = await makeProject()
  const lib = join(project, 'lib')
  // No two names differ only by case: on case-insensitive file systems
  // (Windows, default macOS) "b" and "B" would be the same directory.
  for (const name of ['b', 'a', 'C', '_x', 'a2']) await writeSkill(join(lib, name), `${name}-skill`)
  const roots = await expandSkillRoots(resolveSkillRoots(project, ['lib']), { maxDepth: 2 })
  assert.deepEqual(roots.slice(1).map((entry) => entry.path.slice(lib.length + 1)), ['C', '_x', 'a', 'a2', 'b'])
})

// [medium] root fan-out: maxRoots is configurable

test('[medium] maxRoots is a validated plugin option and bounds the roots per project', async () => {
  assert.equal(Config({}).maxRoots, 2000)
  assert.equal(Config({ maxRoots: 10 }).maxRoots, 10)
  for (const value of [0, 2001, 1.5]) {
    const warnings = []
    assert.equal(normalizeOptions({ maxRoots: value }, (line) => warnings.push(line)).maxRoots, 2000)
    assert.match(warnings[0], /maxRoots must be an integer between 1 and 2000/)
  }

  const { project } = await makeProject()
  for (let index = 0; index < 6; index += 1) await writeSkill(join(project, 'lib', `c${index}`), `s${index}`)
  const env = await boot({ watch: false, maxDepth: 2, maxRoots: 4 })
  try {
    assert.deepEqual(await env.names(project), ['s0', 's1', 's2'])
    assert.equal(env.provider.describeProject(project).roots.length, 4)
    assert.equal(env.warnings.filter((line) => /maxRoots 4/.test(line)).length, 1)
  } finally {
    await env.close()
  }
})

// [low] readdir failures are reported, and one bad root no longer drops the rest

test('[low] an unreadable category directory is reported with its path', async (t) => {
  if (await permissionsAreBypassed()) {
    t.skip('process bypasses file permissions (root or CAP_DAC_OVERRIDE)')
    return
  }
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'ok'), 'good')
  await writeSkill(join(project, 'lib', 'group', 'cat'), 'hidden')
  await chmod(join(project, 'lib', 'group'), 0o000)
  try {
    const warnings = []
    const roots = await expandSkillRoots(resolveSkillRoots(project, ['lib']), {
      maxDepth: 3,
      warn: (message) => warnings.push(message),
    })
    assert.deepEqual(roots.map((entry) => entry.path), [join(project, 'lib'), join(project, 'lib', 'ok')])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /cannot read directory .*group \(EACCES\)/)
  } finally {
    await chmod(join(project, 'lib', 'group'), 0o755)
  }
})

test('[low] a missing directory stays silent', async () => {
  const warnings = []
  const roots = await expandSkillRoots([root(join(tmpdir(), 'dsh-definitely-missing-dir'))], {
    maxDepth: 3,
    warn: (message) => warnings.push(message),
  })
  assert.equal(roots.length, 1)
  assert.deepEqual(warnings, [])
})

test('[low] one root that DSH cannot read only drops itself at maxDepth >= 2', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'ok'), 'good')
  await writeSkill(join(project, 'lib', 'bad'), 'sibling')
  // A SKILL.md that is a directory makes DSH's reader throw EISDIR.
  await mkdir(join(project, 'lib', 'bad', 'broken', 'SKILL.md'), { recursive: true })
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await env.names(project), ['good'])
    assert.equal(env.warnings.filter((line) => /skipped root .*bad/.test(line)).length, 1)
  } finally {
    await env.close()
  }
})

// [low] fair maxRoots budget across configured paths

test('[low] maxRoots is shared fairly between configured paths and the warning names the path', async () => {
  const { project } = await makeProject(['big', 'small'])
  for (let index = 0; index < 20; index += 1) {
    await writeSkill(join(project, 'big', `c${String(index).padStart(2, '0')}`), `b${index}`)
  }
  for (let index = 0; index < 3; index += 1) await writeSkill(join(project, 'small', `s${index}`), `m${index}`)
  const warnings = []
  const roots = await expandSkillRoots(resolveSkillRoots(project, ['big', 'small']), {
    maxDepth: 2,
    maxRoots: 10,
    warn: (message) => warnings.push(message),
  })
  const under = (name) => roots.filter((entry) => entry.path.startsWith(join(project, name) + sep)).length
  assert.equal(roots.length, 10)
  assert.equal(under('small'), 3)
  assert.equal(under('big'), 5)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /"big"/)
  assert.match(warnings[0], /kept 5/)
})

// [low] symlinks

// Creating symlinks needs Developer Mode or elevation on Windows; without it
// symlink() fails with EPERM. Skip there instead of failing.
let symlinkSupport
async function symlinksUnavailable() {
  symlinkSupport ??= (async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-symlink-probe-'))
    try {
      await mkdir(join(base, 'target'))
      await symlink(join(base, 'target'), join(base, 'link'), 'dir')
      return undefined
    } catch (error) {
      return `cannot create symlinks here (${error?.code ?? error})`
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })()
  return symlinkSupport
}

test('[low] symlinked aliases and self-referencing links add no duplicate roots', async (t) => {
  const unavailable = await symlinksUnavailable()
  if (unavailable) {
    t.skip(unavailable)
    return
  }
  const { project } = await makeProject()
  const lib = join(project, 'lib')
  await writeSkill(join(lib, 'cat'), 's1')
  await symlink(join(lib, 'cat'), join(lib, 'alias'))
  await symlink('.', join(lib, 'cat', 'self'))
  await mkdir(join(lib, 'group'), { recursive: true })
  await symlink('..', join(lib, 'group', 'up'))
  const roots = await expandSkillRoots(resolveSkillRoots(project, ['lib']), { maxDepth: 5 })
  assert.deepEqual(roots.map((entry) => entry.path), [lib, join(lib, 'alias')])

  const env = await boot({ watch: false, maxDepth: 5 })
  try {
    assert.deepEqual(await env.names(project), ['s1'])
    assert.deepEqual(env.warnings, [])
  } finally {
    await env.close()
  }
})

test('[low] a symlinked category leaving the project needs allowExternalPaths', async (t) => {
  const unavailable = await symlinksUnavailable()
  if (unavailable) {
    t.skip(unavailable)
    return
  }
  const { base, project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'inside')
  await writeSkill(join(base, 'outside', 'cat'), 'outside-skill')
  await symlink(join(base, 'outside', 'cat'), join(project, 'lib', 'ext'))

  const blocked = await boot({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await blocked.names(project), ['inside'])
    assert.equal(blocked.warnings.filter((line) => /resolves outside the project/.test(line)).length, 1)
  } finally {
    await blocked.close()
  }

  const allowed = await boot({ watch: false, maxDepth: 2, allowExternalPaths: true })
  try {
    assert.deepEqual(await allowed.names(project), ['inside', 'outside-skill'])
  } finally {
    await allowed.close()
  }
})

// [low] ignore semantics

test('[low] ignore is case-insensitive where paths are (caseInsensitive), exact elsewhere', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'Legacy'), 'old')
  await writeSkill(join(project, 'lib', 'cat'), 'kept')
  const resolved = resolveSkillRoots(project, ['lib'])
  const sensitive = await expandSkillRoots(resolved, { maxDepth: 2, ignore: ['legacy'], caseInsensitive: false })
  assert.equal(sensitive.some((entry) => entry.path.endsWith('Legacy')), true)
  const insensitive = await expandSkillRoots(resolved, { maxDepth: 2, ignore: ['legacy'], caseInsensitive: true })
  assert.equal(insensitive.some((entry) => entry.path.endsWith('Legacy')), false)
})

test('[low] ignore never removes a configured root', async () => {
  const { project } = await makeProject(['legacy'])
  await writeSkill(join(project, 'legacy'), 'top')
  await writeSkill(join(project, 'legacy', 'legacy'), 'nested-legacy')
  const env = await boot({ watch: false, maxDepth: 2, ignore: ['legacy'] })
  try {
    assert.deepEqual(await env.names(project), ['top'])
  } finally {
    await env.close()
  }
})

test('[low] ignore never hides a skill directory, only category and group folders', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'legacy')
  await writeSkill(join(project, 'lib', 'legacy'), 'in-ignored-category')
  const env = await boot({ watch: false, maxDepth: 2, ignore: ['legacy'] })
  try {
    assert.deepEqual(await env.names(project), ['legacy'])
  } finally {
    await env.close()
  }
})

test('[low] path-shaped ignore entries are rejected by the strict API', async () => {
  await assert.rejects(() => expandSkillRoots([root(tmpdir())], { maxDepth: 2, ignore: ['a/b'] }), TypeError)
  await assert.rejects(() => expandSkillRoots([root(tmpdir())], { maxDepth: 2, ignore: ['a*b'] }), TypeError)
})

// [low] flat-only categories and templates (documented behaviour)

test('[low] a category holding only flat .md files is not promoted', async () => {
  const { project } = await makeProject()
  await mkdir(join(project, 'lib', 'flat-only'), { recursive: true })
  await writeDoc(join(project, 'lib', 'flat-only', 'only.md'), 'flat-only-skill')
  await writeSkill(join(project, 'lib', 'cat'), 'dir-skill')
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await env.names(project), ['dir-skill'])
  } finally {
    await env.close()
  }
})

test('[low] ignore: [templates] keeps scaffolds out at maxDepth 3', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'real')
  await writeSkill(join(project, 'lib', 'cat', 'templates'), 'scaffold')
  const env = await boot({ watch: false, maxDepth: 3, ignore: ['templates'] })
  try {
    assert.deepEqual(await env.names(project), ['real'])
  } finally {
    await env.close()
  }
})

// [suggestion] diagnostics

test('[suggestion] describeProject separates configured, discovery and watch-only roots', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'cat'), 'a')
  await mkdir(join(project, 'lib', 'empty'), { recursive: true })
  const env = await boot({ maxDepth: 2, watchStabilityThresholdMs: 50 })
  try {
    await env.names(project)
    const described = env.provider.describeProject(project)
    assert.equal(described.maxDepth, 2)
    assert.deepEqual(described.configuredRoots, [join(project, 'lib')])
    assert.deepEqual(described.roots, [join(project, 'lib'), join(project, 'lib', 'cat')])
    assert.deepEqual(described.watchOnlyRoots, [join(project, 'lib', 'empty')])
  } finally {
    await env.close()
  }
})

test('[suggestion] the settings route reports expanded roots when maxDepth > 1', async () => {
  const { project } = await makeProject()
  await writeSkill(join(project, 'lib', 'group', 'cat'), 'a')
  const env = await bootPlugin({ watch: false, maxDepth: 3 }, { workspaces: [project] })
  let status
  let payload
  try {
    ;({ status, body: payload } = await env.get({ projectRoot: project }))
  } finally {
    await env.close()
  }
  assert.equal(status, 200)
  assert.equal(payload.maxDepth, 3)
  assert.deepEqual(payload.expandedRoots.map((entry) => entry.path), [
    join(project, 'lib'),
    join(project, 'lib', 'group', 'cat'),
  ])
})

// [low] lockfile drift

test('[low] package-lock.json resolves from registry.npmjs.org and is the only lockfile', async () => {
  const root = new URL('../', import.meta.url)
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  const resolved = Object.values(lock.packages).map((entry) => entry.resolved).filter(Boolean)
  assert.ok(resolved.length > 0)
  for (const url of resolved) assert.match(url, /^https:\/\/registry\.npmjs\.org\//)
  await assert.rejects(() => readFile(new URL('pnpm-lock.yaml', root)), { code: 'ENOENT' })
  assert.equal(pkg.packageManager, undefined)
})
