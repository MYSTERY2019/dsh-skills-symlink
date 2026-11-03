// v0.6.0: host compatibility metadata and the info logs that prove the plugin
// applied and what its roots() saw. Runs the real @deepseek-ai/dsh-skill registry.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import ProjectSkillPaths, { VERSION } from '../lib/index.js'
import { readLogEventually } from './plugin-harness.mjs'

async function writeSkill(parent, name) {
  const directory = join(parent, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), ['---', `name: ${name}`, `description: Fixture for ${name}.`, '---', '', 'body', ''].join('\n'))
}

async function makeProject({ config = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-observability-'))
  const project = join(base, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  if (config) {
    await mkdir(join(project, '.dsh'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skill-paths.yaml'), 'version: 1\nskillPaths:\n  - lib\n')
  }
  return { base, project }
}

async function boot(config, { profileDir } = {}) {
  const ctx = new Context()
  if (profileDir !== undefined) ctx.provide('profileContext', { name: 'fixture', dir: profileDir })
  const info = []
  const warnings = []
  ctx.logger.info = (...args) => info.push(args.join(' '))
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const registryFiber = ctx.plugin(SkillRegistry)
  await registryFiber
  const fiber = ctx.plugin(ProjectSkillPaths, config)
  await fiber
  return {
    ctx,
    info,
    warnings,
    mine: () => info.filter((line) => line.startsWith('dsh-skills-symlink:')),
    async close() {
      await fiber.dispose()
      await registryFiber.dispose()
    },
  }
}

test('package.json declares the dsh requirement where DSH 0.2 reads it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  // DSH 0.2.x (dsh-app-boot evaluatePluginCompatibility) reads only the
  // top-level engines.dsh; without it, it falls back to peerDependencies, and a
  // ^0.1 peer range made 0.2.x hosts skip the whole bundle before any code ran.
  // Bounded to the host line the plugin is tested against (0.2.x; the
  // settings route needs the 0.2 connection Fetch registry).
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.5')
  assert.equal(manifest.dsh.engines, undefined)
  for (const name of ['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-skill-filesystem']) {
    assert.doesNotMatch(manifest.peerDependencies[name], /^\^0\./, `${name} must not use a caret 0.x range`)
    assert.equal(manifest.peerDependencies[name], manifest.engines.dsh)
    assert.equal(manifest.devDependencies[name], '0.2.1-rc.5', `${name}: tests run against the 0.2 host packages`)
  }
  assert.equal(VERSION, manifest.version)
})

test('apply() logs one info line with version, maxDepth and configured roots', async () => {
  const env = await boot({ watch: false, maxDepth: 3, ignore: ['_drafts', '_old'] })
  try {
    const applied = env.mine().filter((line) => /applied v/.test(line))
    assert.equal(applied.length, 1)
    assert.match(applied[0], new RegExp(`applied v${VERSION.replace(/\./g, '\\.')}`))
    assert.match(applied[0], /maxDepth=3/)
    assert.match(applied[0], /configuredRoots=0/)
    assert.match(applied[0], /ignore=2/)
  } finally {
    await env.close()
  }
})

test('the first roots() call for a project logs cwd, project root, root count and config hit', async () => {
  const { base, project } = await makeProject()
  await writeSkill(join(project, 'lib'), 'alpha')
  await writeSkill(join(project, 'lib'), 'beta')
  const env = await boot({ watch: false })
  try {
    const cwd = join(project, 'lib')
    assert.deepEqual((await env.ctx.skills.list({ cwd })).map((s) => s.name).sort(), ['alpha', 'beta'])
    await env.ctx.skills.list({ cwd })
    const first = env.mine().filter((line) => /roots\(\) first call/.test(line))
    assert.equal(first.length, 1, 'logged once per project, not on every list')
    assert.ok(first[0].includes(`cwd=${cwd}`))
    assert.ok(first[0].includes(`projectRoot=${project}`))
    assert.match(first[0], /configFile=found/)
    assert.match(first[0], /configuredRoots=1, roots=1/)
    assert.deepEqual(env.warnings, [])
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('the roots() log lists every resolved root path, not just a count', async () => {
  const { base, project } = await makeProject()
  await writeSkill(join(project, 'lib'), 'alpha')
  await writeSkill(join(project, 'vendor'), 'beta')
  await writeFile(join(project, '.dsh', 'skill-paths.yaml'), 'version: 1\nskillPaths:\n  - lib\n  - vendor\n')
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    await env.ctx.skills.list({ cwd: project })
    const lines = env.mine()
    const header = lines.find((line) => /roots\(\) first call/.test(line))
    assert.match(header, /watchOnlyRoots=\d+/)
    // Without the paths, a root that sweeps in an unrelated category is invisible
    // until someone rebuilds the expansion by hand.
    assert.ok(
      lines.includes(`dsh-skills-symlink:   root[0] ${join(project, 'lib')}`),
      `root[0] line missing, got:\n${lines.join('\n')}`,
    )
    assert.ok(
      lines.includes(`dsh-skills-symlink:   root[1] ${join(project, 'vendor')}`),
      `root[1] line missing, got:\n${lines.join('\n')}`,
    )
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('a missing project config is logged as info, never as a warning', async () => {
  const { base, project } = await makeProject({ config: false })
  const env = await boot({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await env.ctx.skills.list({ cwd: project }), [])
    const missing = env.mine().filter((line) => /no project config at/.test(line))
    assert.equal(missing.length, 1)
    assert.ok(missing[0].includes(join(project, '.dsh', 'skill-paths.yaml')))
    assert.ok(env.mine().some((line) => /configFile=missing/.test(line)))
    assert.deepEqual(env.warnings, [])
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('log lines also go to <profile>/logs/dsh-skills-symlink.log when the host gives a profile dir', async () => {
  const { base, project } = await makeProject()
  await writeSkill(join(project, 'lib'), 'alpha')
  const profileDir = join(base, 'profile')
  const env = await boot({ watch: false, maxDepth: 2 }, { profileDir })
  try {
    await env.ctx.skills.list({ cwd: project })
    const text = await readLogEventually(join(profileDir, 'logs', 'dsh-skills-symlink.log'), /roots\(\) first call/)
    assert.match(text, /\[info\] dsh-skills-symlink: applied v.*maxDepth=2.*profile=fixture/)
    assert.match(text, /\[info\] dsh-skills-symlink: roots\(\) first call for cwd=/)
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('logFile overrides the diagnostics path and diagnosticsFile: false turns it off', async () => {
  const { base, project } = await makeProject({ config: false })
  const logFile = join(base, 'custom', 'psp.log')
  const profileDir = join(base, 'profile')
  let env = await boot({ watch: false, logFile }, { profileDir })
  try {
    await env.ctx.skills.list({ cwd: project })
    const text = await readLogEventually(logFile, /no project config at /)
    assert.match(text, /\[info\] dsh-skills-symlink: no project config at /)
  } finally {
    await env.close()
  }
  env = await boot({ watch: false, diagnosticsFile: false }, { profileDir })
  try {
    await env.ctx.skills.list({ cwd: project })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await assert.rejects(readFile(join(profileDir, 'logs', 'dsh-skills-symlink.log'), 'utf8'), { code: 'ENOENT' })
    assert.ok(env.mine().some((line) => /applied v/.test(line)), 'logger still gets the lines')
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('roots() without a cwd contributes nothing, like upstream, and says so once', async () => {
  const env = await boot({ watch: false })
  try {
    assert.deepEqual(await env.ctx.skills.list({}), [])
    assert.deepEqual(await env.ctx.skills.list({ cwd: '' }), [])
    const noCwd = env.mine().filter((line) => /roots\(\) called with cwd=/.test(line))
    assert.equal(noCwd.length, 1)
    assert.match(noCwd[0], /cwd=undefined/)
    assert.deepEqual(env.warnings, [])
  } finally {
    await env.close()
  }
})
