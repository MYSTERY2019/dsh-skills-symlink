import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { expandSkillRoots, resolveSkillRoots } from '../lib/project-config.js'

const ROOT = { path: '', configuredPath: '.', source: 'project-config', rank: 250, projectRoot: '' }

async function makeLibrary() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-expand-roots-'))
  const library = join(base, 'library')

  // category-a holds two skills; category-b holds one.
  await writeSkill(join(library, 'category-a'), 'skill-1')
  await writeSkill(join(library, 'category-a'), 'skill-2')
  await writeSkill(join(library, 'category-b'), 'skill-3')
  // A directory that is itself a skill must not become a root.
  await writeSkill(library, 'flat-skill')
  // Noise that must never be descended into.
  await writeSkill(join(library, 'node_modules'), 'ignored-1')
  await writeSkill(join(library, '.hidden'), 'ignored-2')

  return { base, library }
}

async function writeSkill(parent, name) {
  const directory = join(parent, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Fixture for ${name}.`,
    '---',
    '',
  ].join('\n'))
}

function root(path, projectRoot = '') {
  return { ...ROOT, path, configuredPath: '.', projectRoot }
}

test('maxDepth 1 leaves the configured roots untouched', async () => {
  const { library } = await makeLibrary()
  const roots = [root(library)]
  assert.equal(await expandSkillRoots(roots, { maxDepth: 1 }), roots)
})

test('maxDepth 2 turns each category into its own root', async () => {
  const { library } = await makeLibrary()
  const expanded = await expandSkillRoots([root(library)], { maxDepth: 2 })
  const names = expanded.map((entry) => entry.path).sort()

  assert.deepEqual(names, [
    join(library, 'category-a'),
    join(library, 'category-b'),
    library,
  ].sort())
})

test('a directory carrying its own SKILL.md is never re-listed as a root', async () => {
  const { library } = await makeLibrary()
  const expanded = await expandSkillRoots([root(library)], { maxDepth: 3 })
  const listed = expanded.map((entry) => entry.path)
  assert.equal(listed.includes(join(library, 'flat-skill')), false)
})

test('dot directories and node_modules are skipped at every depth', async () => {
  const { library } = await makeLibrary()
  const expanded = await expandSkillRoots([root(library)], { maxDepth: 3 })
  const listed = expanded.map((entry) => entry.path.toLowerCase())
  assert.equal(listed.some((path) => path.includes('node_modules')), false)
  assert.equal(listed.some((path) => path.includes('.hidden')), false)
})

test('expansion is idempotent and de-duplicates overlapping roots', async () => {
  const { library } = await makeLibrary()
  const once = await expandSkillRoots([root(library)], { maxDepth: 2 })
  const twice = await expandSkillRoots([root(library), root(join(library, 'category-a'))], {
    maxDepth: 2,
  })
  assert.equal(twice.length, once.length)
})

test('expanded roots keep source, rank and projectRoot', async () => {
  const { library, base } = await makeLibrary()
  const expanded = await expandSkillRoots([root(library, base)], { maxDepth: 2 })
  for (const entry of expanded) {
    assert.equal(entry.source, 'project-config')
    assert.equal(entry.rank, 250)
    assert.equal(entry.projectRoot, base)
    assert.equal(entry.configuredPath, '.')
  }
})

test('rejects an out-of-range maxDepth', async () => {
  const { library } = await makeLibrary()
  await assert.rejects(() => expandSkillRoots([root(library)], { maxDepth: 0 }), TypeError)
  await assert.rejects(() => expandSkillRoots([root(library)], { maxDepth: 7 }), TypeError)
  await assert.rejects(() => expandSkillRoots([root(library)], { maxDepth: 1.5 }), TypeError)
})

test('stops at maxRoots and reports it once', async () => {
  const { library } = await makeLibrary()
  const warnings = []
  const expanded = await expandSkillRoots([root(library)], {
    maxDepth: 3,
    maxRoots: 2,
    warn: (message) => warnings.push(message),
  })
  assert.equal(expanded.length, 2)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /maxDepth 3/)
})

test('ignore skips exact names and prefix patterns', async () => {
  const { library } = await makeLibrary()
  await writeSkill(join(library, 'legacy'), 'old-one')
  await writeSkill(join(library, 'legacy_two'), 'old-two')

  const exact = await expandSkillRoots([root(library)], { maxDepth: 2, ignore: ['legacy'] })
  assert.equal(exact.some((entry) => entry.path.endsWith('legacy')), false)
  assert.equal(exact.some((entry) => entry.path.endsWith('legacy_two')), true)

  const prefixed = await expandSkillRoots([root(library)], { maxDepth: 2, ignore: ['legacy*'] })
  assert.equal(prefixed.some((entry) => /legacy/.test(entry.path)), false)
})

test('a documentation folder is not turned into a root', async () => {
  const { library } = await makeLibrary()
  // A folder holding only prose .md files, no skill subdirectories. DSH treats
  // a bare .md at the top of a root as a flat skill, so promoting this folder
  // would surface DESCRIPTION.md as a phantom skill.
  const docs = join(library, 'domain')
  await mkdir(docs, { recursive: true })
  await writeFile(join(docs, 'DESCRIPTION.md'), [
    '---',
    'name: domain-intel',
    'description: Prose, not a skill.',
    '---',
    '',
  ].join('\n'))

  const expanded = await expandSkillRoots([root(library)], { maxDepth: 3 })
  assert.equal(expanded.some((entry) => entry.path.endsWith('domain')), false)
})

test('ignore rejects malformed patterns', async () => {
  const { library } = await makeLibrary()
  await assert.rejects(
    () => expandSkillRoots([root(library)], { maxDepth: 2, ignore: 'legacy' }),
    TypeError,
  )
  await assert.rejects(
    () => expandSkillRoots([root(library)], { maxDepth: 2, ignore: [''] }),
    TypeError,
  )
})

test('resolveSkillRoots output feeds expansion without losing order', async () => {
  const { library, base } = await makeLibrary()
  const resolved = resolveSkillRoots(base, [library], { allowExternalPaths: true })
  const expanded = await expandSkillRoots(resolved, { maxDepth: 2 })
  assert.equal(expanded[0].path, library)
  assert.equal(expanded.length, 3)
})
