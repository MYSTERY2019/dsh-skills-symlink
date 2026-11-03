// The settings card's route. It now runs as an exact Fetch route of the host
// connection (behind the host's own Host/Origin fence and cookie auth), so the
// tests drive it with standard Request objects instead of Node req/res.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { bootPlugin } from './plugin-harness.mjs'

async function writeSkill(parent, name) {
  await mkdir(join(parent, name), { recursive: true })
  await writeFile(join(parent, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n\nbody\n`)
}

test('settings route writes and reads project-local YAML', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-project-skill-ui-')))
  const env = await bootPlugin({}, { workspaces: [root] })
  try {
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'skills'))
    assert.equal(env.route.path, '/api/dsh-skills-symlink/config')
    assert.deepEqual(env.route.methods, ['GET', 'POST'])

    const post = await env.post({ projectRoot: root, skillPaths: ['skills'] })
    assert.equal(post.status, 200)
    assert.equal(post.body.roots[0].exists, true)
    assert.match(await readFile(join(root, '.dsh', 'skill-paths.yaml'), 'utf8'), /skillPaths:\n  - skills/)

    const got = await env.get({ projectRoot: root })
    assert.equal(got.status, 200)
    assert.deepEqual(got.body.skillPaths, ['skills'])
    assert.equal(got.body.projectRoot, root)

    const relative = await env.get({ projectRoot: '.', baseRoot: root })
    assert.equal(relative.status, 200)
    assert.equal(relative.body.projectRoot, root)
  } finally {
    await env.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('settings route reports the resolved roots and what each one holds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-project-skill-structure-')))
  const env = await bootPlugin({ maxDepth: 2 }, { workspaces: [root] })
  try {
    await mkdir(join(root, '.git'))
    await mkdir(join(root, '.dsh'), { recursive: true })
    await writeSkill(join(root, 'skills', 'web'), 'alpha')
    await writeSkill(join(root, 'skills', 'ops'), 'beta')
    await writeSkill(join(root, 'more', 'web'), 'alpha')
    await mkdir(join(root, 'skills', 'empty'), { recursive: true })
    await writeFile(join(root, '.dsh', 'skill-paths.yaml'), 'version: 1\nskillPaths:\n  - skills\n  - more\n')

    const { status, body } = await env.get({ projectRoot: root })
    assert.equal(status, 200)
    assert.ok(Array.isArray(body.structure) && body.structure.length > 0, 'structure is reported')
    for (const entry of body.structure) {
      assert.equal(typeof entry.path, 'string')
      assert.ok(Array.isArray(entry.skills))
      // Every root keeps the text the user wrote for its configured root.
      assert.ok(['skills', 'more'].includes(entry.configuredPath), entry.configuredPath)
    }
    const unique = new Set(body.structure.flatMap((entry) => entry.skills.map((skill) => skill.name)))
    assert.deepEqual([...unique].sort(), ['alpha', 'beta'])
    assert.equal(body.skillCount, unique.size)
    assert.equal(body.skillFileCount, body.structure.reduce((sum, entry) => sum + entry.skills.length, 0))
    assert.equal(body.skillFileCount, 3)
    assert.equal(body.duplicateSkills, body.skillFileCount - body.skillCount)
    assert.equal(body.duplicates.length, 1)
    assert.equal(body.duplicates[0].name, 'alpha')
    assert.equal(body.duplicates[0].winner, join(root, 'skills', 'web', 'alpha', 'SKILL.md'))
    assert.deepEqual(body.duplicates[0].shadowed, [join(root, 'more', 'web', 'alpha', 'SKILL.md')])
    assert.equal(body.rootCount, body.structure.length)
    assert.ok(Array.isArray(body.watchOnlyRoots))
    assert.ok(body.watchOnlyRoots.includes(join(root, 'skills', 'empty')))
    assert.ok(!body.expandedRoots.some((entry) => body.watchOnlyRoots.includes(entry.path)))
    assert.deepEqual(body.expandedRoots.map((entry) => entry.path), body.structure.map((entry) => entry.path))

    // The card shows what a session lists: same names, same winner.
    const listed = await env.list(root)
    const names = (Array.isArray(listed) ? listed : listed.candidates).map((candidate) => candidate.name)
    for (const name of unique) assert.ok(names.includes(name), `session lists ${name}`)
  } finally {
    await env.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('client bundle declares the project settings card', async () => {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(source, /__ModuleLoader__\.load/)
  // The host exposes settings contributions as tabs of the Plugins section; the
  // old `settingsScope` / `settings.plugin.item` pair does not exist here.
  assert.match(source, /settings\.plugins\.tab/)
  assert.match(source, /id: NS/)
  assert.match(source, /\.dsh\/skill-paths\.yaml/)
})
