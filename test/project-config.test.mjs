import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  findProjectRoot,
  isInside,
  parseProjectSkillConfig,
  resolveConfigPath,
  resolveSkillRoots,
} from '../lib/project-config.js'

test('parses the versioned project config', () => {
  assert.deepEqual(parseProjectSkillConfig(`
version: 1
skillPaths:
  - .codex/skills
  - tools/skills
`), {
    version: 1,
    skillPaths: ['.codex/skills', 'tools/skills'],
  })
})

test('rejects typos and malformed path entries', () => {
  assert.throws(
    () => parseProjectSkillConfig('version: 1\nskillPath: []\n'),
    /unknown field "skillPath"/,
  )
  assert.throws(
    () => parseProjectSkillConfig('version: 1\nskillPaths: [""]\n'),
    /must be a non-empty string/,
  )
})

test('resolves project paths, removes duplicates, and assigns project rank', () => {
  const project = resolve('C:/work/example')
  const roots = resolveSkillRoots(project, ['.codex/skills', '.codex/skills'])
  assert.equal(roots.length, 1)
  assert.equal(roots[0].path, resolve(project, '.codex/skills'))
  assert.equal(roots[0].source, 'project-config')
  assert.equal(roots[0].rank, 250)
})

test('blocks external paths unless explicitly enabled', () => {
  const project = resolve('C:/work/example')
  assert.throws(
    () => resolveSkillRoots(project, ['../shared/skills']),
    /outside the project/,
  )
  assert.equal(
    resolveSkillRoots(project, ['../shared/skills'], { allowExternalPaths: true })[0].path,
    resolve(project, '../shared/skills'),
  )
})

test('keeps the config file inside the project', () => {
  const project = resolve('C:/work/example')
  assert.equal(resolveConfigPath(project), resolve(project, '.dsh/skill-paths.yaml'))
  assert.throws(() => resolveConfigPath(project, '../skill-paths.yaml'), /inside the project/)
  assert.equal(isInside(project, resolve(project, 'nested')), true)
  assert.equal(isInside(project, resolve(project, '..')), false)
})

test('finds the nearest git root and otherwise falls back to cwd', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-symlink-'))
  const project = join(base, 'project')
  const nested = join(project, 'src', 'nested')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(nested, { recursive: true })
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  assert.equal(await findProjectRoot(nested), project)

  const plain = join(base, 'plain')
  await mkdir(plain)
  assert.equal(await findProjectRoot(plain), plain)
})
