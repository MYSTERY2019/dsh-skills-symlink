import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import ProjectSkillPaths, { ProjectSkillPathProvider } from '../lib/index.js'

test('exposes configured skills only to the matching project cwd', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-project-provider-'))
  const projectA = join(base, 'project-a')
  const projectB = join(base, 'project-b')

  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectA, '.dsh'), { recursive: true })
  await mkdir(join(projectA, '.codex', 'skills', 'project-demo'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })

  await writeFile(join(projectA, '.dsh', 'skill-paths.yaml'), [
    'version: 1',
    'skillPaths:',
    '  - .codex/skills',
    '',
  ].join('\n'))
  await writeFile(join(projectA, '.codex', 'skills', 'project-demo', 'SKILL.md'), [
    '---',
    'name: project-demo',
    'description: Project A only integration skill.',
    '---',
    '',
    '# Project demo',
    '',
    'PROJECT_SKILL_PATHS_OK',
    '',
  ].join('\n'))

  const ctx = new Context()
  const registryFiber = ctx.plugin(SkillRegistry)
  await registryFiber
  const providerFiber = ctx.plugin(ProjectSkillPaths, { watch: false })
  await providerFiber

  try {
    const projectAList = await ctx.skills.list({ cwd: projectA })
    assert.deepEqual(projectAList.map((skill) => skill.name), ['project-demo'])
    assert.equal(projectAList[0].source, 'project-config')

    const loaded = await ctx.skills.get('project-demo', { cwd: projectA })
    assert.match(loaded.content, /PROJECT_SKILL_PATHS_OK/)

    const projectBList = await ctx.skills.list({ cwd: projectB })
    assert.deepEqual(projectBList, [])
    assert.equal(await ctx.skills.get('project-demo', { cwd: projectB }), undefined)
  } finally {
    await providerFiber.dispose()
    await registryFiber.dispose()
  }
})

test('hot-reloads a changed project path and releases the previous root watcher', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-project-provider-watch-'))
  const project = join(base, 'project')
  const firstRoot = join(project, 'skill-roots', 'first')
  const secondRoot = join(project, 'skill-roots', 'second')
  const configPath = join(project, '.dsh', 'skill-paths.yaml')

  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh'), { recursive: true })
  await writeSkill(firstRoot, 'first-skill')
  await writeSkill(secondRoot, 'second-skill')
  await writeProjectConfig(configPath, ['skill-roots/first'])

  const ctx = new Context()
  const registryFiber = ctx.plugin(SkillRegistry)
  await registryFiber
  let provider
  const providerFiber = ctx.plugin({
    inject: ['skills'],
    apply(pluginContext) {
      pluginContext.skills.registerProvider((control) => {
        provider = new ProjectSkillPathProvider(pluginContext, control, {
          watch: true,
          configWatchIntervalMs: 25,
          watchPollIntervalMs: 25,
          watchStabilityThresholdMs: 25,
        })
        return provider
      })
      return () => provider?.dispose()
    },
  })
  await providerFiber

  try {
    assert.deepEqual(
      (await ctx.skills.list({ cwd: project })).map((skill) => skill.name),
      ['first-skill'],
    )
    assert.equal(provider.watchManager.roots.has(firstRoot), true)

    await writeProjectConfig(configPath, ['skill-roots/second'])
    await waitFor(async () => {
      const names = (await ctx.skills.list({ cwd: project })).map((skill) => skill.name)
      return names.length === 1 && names[0] === 'second-skill'
    })

    assert.equal(provider.watchManager.roots.has(firstRoot), false)
    assert.equal(provider.watchManager.roots.has(secondRoot), true)
  } finally {
    await providerFiber.dispose()
    await registryFiber.dispose()
  }
})

test('maxDepth 2 discovers a category/skill layout in one configured path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-project-provider-depth-'))
  const project = join(base, 'project')
  const library = join(project, 'library')

  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh'), { recursive: true })
  await writeSkill(join(library, 'category-a'), 'nested-one')
  await writeSkill(join(library, 'category-b'), 'nested-two')
  await writeProjectConfig(join(project, '.dsh', 'skill-paths.yaml'), ['library'])

  const ctx = new Context()
  const registryFiber = ctx.plugin(SkillRegistry)
  await registryFiber

  const flat = ctx.plugin(ProjectSkillPaths, { watch: false, maxDepth: 1 })
  await flat
  try {
    assert.deepEqual(await ctx.skills.list({ cwd: project }), [])
  } finally {
    await flat.dispose()
  }

  const deep = ctx.plugin(ProjectSkillPaths, { watch: false, maxDepth: 2 })
  await deep
  try {
    const listed = await ctx.skills.list({ cwd: project })
    assert.deepEqual(
      listed.map((skill) => skill.name).sort(),
      ['nested-one', 'nested-two'],
    )
    for (const skill of listed) assert.equal(skill.source, 'project-config')

    const loaded = await ctx.skills.get('nested-one', { cwd: project })
    assert.match(loaded.content, /# nested-one/)
  } finally {
    await deep.dispose()
    await registryFiber.dispose()
  }
})

async function writeProjectConfig(path, skillPaths) {
  await writeFile(path, [
    'version: 1',
    'skillPaths:',
    ...skillPaths.map((skillPath) => `  - ${skillPath}`),
    '',
  ].join('\n'))
}

async function writeSkill(root, name) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Integration fixture for ${name}.`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'))
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`)
}
