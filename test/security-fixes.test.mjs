// Regression tests for the fixes made after the independent audit of v0.4.0.
// Each test failed on the audited code and passes on the fixed code.
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

import ProjectSkillPaths from '../lib/index.js'
import { parseProjectSkillConfig, resolveSkillRoots, writeProjectSkillConfig } from '../lib/project-config.js'
import { bootPlugin, readLogEventually } from './plugin-harness.mjs'

const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-symlink-probe-'))
  try {
    await symlink(dir, join(dir, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})()
const symlinkTest = canSymlink ? test : test.skip

async function writeSkill(parent, name, body = 'body') {
  await mkdir(join(parent, name), { recursive: true })
  await writeFile(join(parent, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n\n${body}\n`)
}

async function fixture(prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const project = join(base, 'project')
  const outside = join(base, 'outside')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh'), { recursive: true })
  await mkdir(outside, { recursive: true })
  return { base, project, outside }
}

async function writeProjectConfig(project, skillPaths) {
  await writeFile(
    join(project, '.dsh', 'skill-paths.yaml'),
    `version: 1\nskillPaths:\n${skillPaths.map((path) => `  - ${path}`).join('\n')}\n`,
  )
}

async function names(env, cwd) {
  const listed = await env.list(cwd)
  return listed.map((skill) => skill.name).sort()
}

// --- [fatal] allowExternalPaths: false bypassed through symbolic links ------

for (const maxDepth of [1, 3]) {
  symlinkTest(`[fatal] a configured root that is a symlink out of the project is dropped (maxDepth ${maxDepth})`, async () => {
    const { base, project, outside } = await fixture('dsh-sec-root-link-')
    await writeSkill(join(outside, 'cat'), 'secret-cat')
    await writeSkill(outside, 'secret-flat')
    await symlink(outside, join(project, 'linked'), 'dir')
    await writeSkill(join(project, 'skills'), 'inside')
    await writeProjectConfig(project, ['linked', 'skills'])
    const env = await bootPlugin({ watch: false, maxDepth })
    try {
      assert.deepEqual(await names(env, project), ['inside'])
      assert.ok(env.warnings.some((line) => /linked.*outside the project/.test(line)), env.warnings.join('\n'))
    } finally {
      await env.close()
      await rm(base, { recursive: true, force: true })
    }
  })
}

symlinkTest('[fatal] a missing path below a symlinked folder is judged by where it really lands', () => {
  return (async () => {
    const { base, project, outside } = await fixture('dsh-sec-deep-')
    await symlink(outside, join(project, 'linked'), 'dir')
    try {
      assert.throws(
        () => resolveSkillRoots(project, ['linked/not-yet'], { allowExternalPaths: false }),
        { code: 'external-path' },
      )
      const rejected = []
      const roots = resolveSkillRoots(project, ['linked/not-yet', 'skills'], {
        allowExternalPaths: false,
        onRejected: (message) => rejected.push(message),
      })
      assert.deepEqual(roots.map((root) => root.configuredPath), ['skills'])
      assert.equal(rejected.length, 1)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })()
})

symlinkTest('[guard] a symlinked category below a real root is not followed out of the project', async () => {
  const { base, project, outside } = await fixture('dsh-sec-cat-link-')
  await writeSkill(join(outside, 'leak'), 'secret-cat')
  await writeSkill(join(project, 'skills', 'web'), 'inside')
  await symlink(join(outside, 'leak'), join(project, 'skills', 'leak'), 'dir')
  await writeProjectConfig(project, ['skills'])
  const env = await bootPlugin({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await names(env, project), ['inside'])
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

for (const maxDepth of [1, 2]) {
  symlinkTest(`[fatal] a symlinked skill folder pointing out of the project is not listed (maxDepth ${maxDepth})`, async () => {
    const { base, project, outside } = await fixture('dsh-sec-skill-link-')
    await writeSkill(outside, 'secret-skill')
    const parent = maxDepth === 1 ? join(project, 'skills') : join(project, 'skills', 'web')
    await writeSkill(parent, 'inside')
    await symlink(join(outside, 'secret-skill'), join(parent, 'secret-skill'), 'dir')
    await writeProjectConfig(project, ['skills'])
    const env = await bootPlugin({ watch: false, maxDepth })
    try {
      assert.deepEqual(await names(env, project), ['inside'])
      assert.equal(await env.ctx.skills.get('secret-skill', { cwd: project }), undefined)
      assert.ok(env.warnings.some((line) => /secret-skill.*resolves outside the project/.test(line)))
    } finally {
      await env.close()
      await rm(base, { recursive: true, force: true })
    }
  })
}

symlinkTest('[fatal] get() re-checks the real path: a skill swapped for a link after list() is not loaded', async () => {
  const { base, project, outside } = await fixture('dsh-sec-swap-')
  await writeSkill(join(project, 'skills'), 'swapped', 'inside body')
  await writeSkill(join(outside, 'x'), 'swapped', 'OUTSIDE SECRET')
  await writeProjectConfig(project, ['skills'])
  const env = await bootPlugin({ watch: false })
  try {
    assert.deepEqual(await names(env, project), ['swapped'])
    await rm(join(project, 'skills', 'swapped'), { recursive: true, force: true })
    await symlink(join(outside, 'x', 'swapped'), join(project, 'skills', 'swapped'), 'dir')
    const loaded = await env.ctx.skills.get('swapped', { cwd: project })
    assert.ok(loaded === undefined || !String(loaded.content ?? loaded.body ?? '').includes('OUTSIDE SECRET'))
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

symlinkTest('[guard] with allowExternalPaths: true, symlinked roots still work', async () => {
  const { base, project, outside } = await fixture('dsh-sec-allowed-')
  await writeSkill(join(outside, 'cat'), 'shared')
  await symlink(outside, join(project, 'linked'), 'dir')
  await writeProjectConfig(project, ['linked'])
  const env = await bootPlugin({ watch: false, maxDepth: 2, allowExternalPaths: true })
  try {
    assert.deepEqual(await names(env, project), ['shared'])
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

// --- [high] settings route: host auth, workspace scope, safe writes ---------

test('[high] the settings route is a Fetch route of the host connection, not a bare HTTP route', async () => {
  const env = await bootPlugin({ watch: false }, { workspaces: [] })
  try {
    assert.equal(env.routes.length, 1)
    assert.equal(env.route.path, '/api/dsh-skills-symlink/config')
    assert.equal(env.route.requestBody, 'buffered')
  } finally {
    await env.close()
  }
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /webServer|ctx\.server/)
})

test('[high] the route refuses folders that are not DSH workspaces, for reading and writing', async () => {
  const { base, project } = await fixture('dsh-sec-ws-')
  const stranger = join(base, 'stranger')
  await mkdir(stranger, { recursive: true })
  const env = await bootPlugin({ watch: false }, { workspaces: [project] })
  try {
    const read = await env.get({ projectRoot: stranger })
    assert.equal(read.status, 403)
    assert.equal(read.body.code, 'not-a-workspace')
    const write = await env.post({ projectRoot: stranger, skillPaths: ['skills'] })
    assert.equal(write.status, 403)
    await assert.rejects(lstat(join(stranger, '.dsh')), { code: 'ENOENT' })
    const ok = await env.post({ projectRoot: project, skillPaths: ['skills'] })
    assert.equal(ok.status, 200)
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('[high] POST needs same origin, application/json and at most 16 KiB', async () => {
  const { base, project } = await fixture('dsh-sec-post-')
  const env = await bootPlugin({ watch: false }, { workspaces: [project] })
  try {
    const cross = await env.post({ projectRoot: project, skillPaths: [] }, { origin: 'http://evil.example' })
    assert.equal(cross.status, 403)
    assert.equal(cross.body.code, 'forbidden-origin')
    const text = await env.post(JSON.stringify({ projectRoot: project, skillPaths: [] }), { contentType: 'text/plain' })
    assert.equal(text.status, 415)
    const huge = await env.post({ projectRoot: project, skillPaths: ['x'.repeat(17 * 1024)] })
    assert.equal(huge.status, 413)
    const bad = await env.post('{nope', {})
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'invalid-json')
    await assert.rejects(lstat(join(project, '.dsh', 'skill-paths.yaml')), { code: 'ENOENT' })
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

symlinkTest('[high] POST never writes through a symlinked .dsh folder', async () => {
  const { base, project, outside } = await fixture('dsh-sec-dshlink-')
  await rm(join(project, '.dsh'), { recursive: true, force: true })
  await symlink(outside, join(project, '.dsh'), 'dir')
  const env = await bootPlugin({ watch: false }, { workspaces: [project] })
  try {
    const write = await env.post({ projectRoot: project, skillPaths: ['skills'] })
    assert.equal(write.status, 400)
    assert.equal(write.body.code, 'unsafe-config-path')
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

symlinkTest('[high] POST never writes through a symlinked config file', async () => {
  const { base, project, outside } = await fixture('dsh-sec-filelink-')
  const victim = join(outside, 'victim.txt')
  await writeFile(victim, 'keep me\n')
  await symlink(victim, join(project, '.dsh', 'skill-paths.yaml'), 'file')
  try {
    await assert.rejects(writeProjectSkillConfig(project, ['skills']), { code: 'unsafe-config-path' })
    assert.equal(await readFile(victim, 'utf8'), 'keep me\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// --- [high] configWatchIntervalMs: 0 stopped the host ------------------------

test('[high] configWatchIntervalMs: 0 and other bad watcher values do not stop the host', async () => {
  const { base, project } = await fixture('dsh-sec-interval-')
  await writeSkill(join(project, 'skills'), 'still-works')
  await writeProjectConfig(project, ['skills'])
  const env = await bootPlugin({
    configWatchIntervalMs: 0,
    watchStabilityThresholdMs: 0,
    watchPollIntervalMs: -5,
    watchMaxProjects: 0,
  })
  try {
    assert.deepEqual(await names(env, project), ['still-works'])
    for (const key of ['configWatchIntervalMs', 'watchStabilityThresholdMs', 'watchPollIntervalMs', 'watchMaxProjects']) {
      assert.ok(env.warnings.some((line) => line.includes(`${key} must be an integer`)), key)
    }
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

// --- [high] a failed save left a half-valid file behind ----------------------

test('[high] a rejected save leaves the old file untouched and no temporary file behind', async () => {
  const { base, project } = await fixture('dsh-sec-atomic-')
  await writeSkill(join(project, 'skills'), 'kept')
  await writeProjectConfig(project, ['skills'])
  const before = await readFile(join(project, '.dsh', 'skill-paths.yaml'), 'utf8')
  const env = await bootPlugin({ watch: false }, { workspaces: [project] })
  try {
    const external = await env.post({ projectRoot: project, skillPaths: ['skills', '../elsewhere'] })
    assert.equal(external.status, 400)
    assert.equal(external.body.code, 'external-path')
    const invalid = await env.post({ projectRoot: project, skillPaths: ['skills', 42] })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'invalid-config')
    assert.equal(await readFile(join(project, '.dsh', 'skill-paths.yaml'), 'utf8'), before)
    assert.deepEqual(await readdir(join(project, '.dsh')), ['skill-paths.yaml'])
    assert.deepEqual(await names(env, project), ['kept'])

    const good = await env.post({ projectRoot: project, skillPaths: ['skills', 'more'] })
    assert.equal(good.status, 200)
    assert.deepEqual(await readdir(join(project, '.dsh')), ['skill-paths.yaml'])
    assert.match(await readFile(join(project, '.dsh', 'skill-paths.yaml'), 'utf8'), /- more/)
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

// --- [high] the README example emptied the project ---------------------------

test('[high] plugin options written into the project file are ignored with a hint, not fatal', async () => {
  const { base, project } = await fixture('dsh-sec-readme-')
  await writeSkill(join(project, 'skills', 'web'), 'alpha')
  await writeFile(join(project, '.dsh', 'skill-paths.yaml'), 'version: 1\nmaxDepth: 2\nignore: [_archive]\nskillPaths:\n  - skills\n')
  const env = await bootPlugin({ watch: false, maxDepth: 2 })
  try {
    assert.deepEqual(await names(env, project), ['alpha'])
    assert.ok(env.warnings.some((line) => /unknown field "maxDepth".*plugin row/.test(line)), env.warnings.join('\n'))
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
  // The settings card's save path stays strict.
  assert.throws(() => parseProjectSkillConfig('version: 1\nmaxDepth: 2\nskillPaths: []\n'), /unknown field "maxDepth"/)
})

test('[high] one external entry no longer empties the whole project', async () => {
  const { base, project } = await fixture('dsh-sec-partial-')
  await writeSkill(join(project, 'skills'), 'kept')
  await writeProjectConfig(project, ['../somewhere-else', 'skills', '42'])
  const env = await bootPlugin({ watch: false })
  try {
    assert.deepEqual(await names(env, project), ['kept'])
    assert.ok(env.warnings.some((line) => /somewhere-else.*outside the project/.test(line)))
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('[high] every YAML example in both READMEs parses and lists its skills', async () => {
  for (const file of ['README.md', 'README.zh.md']) {
    const text = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1])
    const projectFiles = blocks.filter((block) => /^version: 1/m.test(block) && /skillPaths:/.test(block))
    assert.ok(projectFiles.length > 0, `${file} shows a project file example`)
    for (const block of projectFiles) {
      // Strict parse: the example must not need the lenient reader.
      const document = parseProjectSkillConfig(block, file)
      assert.ok(document.skillPaths.length > 0)
      // Copy-paste must work with the default plugin row. An example that
      // needs allowExternalPaths has to say so in the block itself.
      const needsExternal = /allowExternalPaths: true/.test(block)
      const project = await mkdtemp(join(tmpdir(), 'dsh-readme-example-'))
      try {
        if (needsExternal) {
          assert.throws(() => resolveSkillRoots(project, document.skillPaths), /outside the project/,
            `${file}: an example marked as needing allowExternalPaths should really need it`)
        }
        const roots = resolveSkillRoots(project, document.skillPaths, { allowExternalPaths: needsExternal })
        assert.equal(roots.length, document.skillPaths.length, `${file}: ${block}`)
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    }
  }
})

// --- [medium] watch-only folders ate the maxRoots budget ---------------------

test('[medium] empty folders watched for new skills do not consume maxRoots', async () => {
  const { base, project } = await fixture('dsh-sec-watchonly-')
  for (let index = 0; index < 6; index += 1) await mkdir(join(project, 'lib', `a-empty-${index}`), { recursive: true })
  await writeSkill(join(project, 'lib', 'z-real'), 'real-skill')
  await writeProjectConfig(project, ['lib'])
  const env = await bootPlugin({ watch: true, maxDepth: 2, maxRoots: 3, configWatchIntervalMs: 50 }, { workspaces: [project] })
  try {
    assert.deepEqual(await names(env, project), ['real-skill'])
    const view = await env.get({ projectRoot: project })
    assert.equal(view.body.watchOnlyRoots.length, 6)
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

// --- [medium] shadowing was only reported at maxDepth > 1, once per name ------

test('[medium] shadowed skills are reported with both paths at maxDepth 1 too, again when they change', async () => {
  const { base, project } = await fixture('dsh-sec-shadow-')
  await writeSkill(join(project, 'one'), 'dup')
  await writeSkill(join(project, 'two'), 'dup')
  await writeProjectConfig(project, ['one', 'two'])
  const env = await bootPlugin({ watch: false })
  try {
    await names(env, project)
    const first = env.warnings.filter((line) => line.includes('is shadowed by'))
    assert.equal(first.length, 1)
    assert.ok(first[0].includes(join(project, 'two', 'dup', 'SKILL.md')))
    assert.ok(first[0].includes(join(project, 'one', 'dup', 'SKILL.md')))
    await names(env, project)
    assert.equal(env.warnings.filter((line) => line.includes('is shadowed by')).length, 1, 'no repeat while unchanged')

    await writeSkill(join(project, 'three'), 'dup')
    await writeProjectConfig(project, ['one', 'two', 'three'])
    const provider = [...env.ctx.skills.layers.global.providers.values()][0]?.provider
    await provider.list({ cwd: project })
    assert.equal(env.warnings.filter((line) => line.includes('is shadowed by')).length, 3, 'reported again after a change')
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

// --- [medium] single-root discovery reached into list() internals ------------

test('[medium] single-root discovery runs on its own scanner and never touches the provider watchers', async () => {
  const { base, project } = await fixture('dsh-sec-scanner-')
  await writeSkill(join(project, 'lib', 'cat'), 'scanned')
  await writeProjectConfig(project, ['lib'])
  const env = await bootPlugin({ watch: false, maxDepth: 2 })
  try {
    const provider = [...env.ctx.skills.layers.global.providers.values()][0]?.provider
    let observed = 0
    const original = provider.watchManager.observeRoots.bind(provider.watchManager)
    provider.watchManager.observeRoots = async (...args) => {
      observed += 1
      return original(...args)
    }
    const found = await provider.discoverSingleRoot({ path: join(project, 'lib', 'cat'), kind: 'project', rank: 250 })
    assert.deepEqual(found.map((candidate) => candidate.name), ['scanned'])
    assert.equal(observed, 0)
    assert.ok(provider.scanner instanceof FileSystemSkillProvider)
    assert.notEqual(provider.scanner, provider)
    assert.equal(typeof provider.scanner.scan, 'function')
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})

// --- [low] diagnostics ---------------------------------------------------------

test('[low] a relative logFile is resolved against the profile directory', async () => {
  const profileDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-sec-profile-')))
  const env = await bootPlugin({ watch: false, logFile: 'custom/plugin.log' }, { profileDir })
  try {
    const text = await readLogEventually(join(profileDir, 'custom', 'plugin.log'), /applied v/)
    assert.match(text, /applied v/)
  } finally {
    await env.close()
    await rm(profileDir, { recursive: true, force: true })
  }
  const source = await readFile(new URL('../lib/diagnostics.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /appendFileSync|statSync|renameSync|mkdirSync/)
})

// --- [low] client subject matching and error codes --------------------------

test('[low] the client matches its own plugin page by structured subject fields', async () => {
  const source = (await readFile(new URL('../client/client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  assert.doesNotMatch(source, /JSON\.stringify\(subject\)/)
  const body = source.match(/function isOwnSubject\(subject\) \{([\s\S]*?)\n  \}\n/)[1]
  const isOwnSubject = new Function('PACKAGE_NAME', `return function (subject) {${body}}`)('dsh-skills-symlink')
  assert.equal(isOwnSubject({ kind: 'bundle', pkg: { name: 'dsh-skills-symlink' } }), true)
  assert.equal(isOwnSubject({ kind: 'row', pkg: { name: 'x' }, row: { moduleName: 'dsh-skills-symlink' } }), true)
  assert.equal(isOwnSubject({ kind: 'bundle', pkg: { name: 'other', description: 'see dsh-skills-symlink' } }), false)
  assert.equal(isOwnSubject({ kind: 'official', note: 'dsh-skills-symlink' }), false)
  assert.equal(isOwnSubject(null), false)
  assert.match(source, /ERROR_KEYS\[body\.code\]/)
})

test('[guard] apply() still loads without a host connection', async () => {
  const env = await bootPlugin({ watch: false }, { connection: false })
  try {
    assert.equal(env.routes.length, 0)
  } finally {
    await env.close()
  }
  // ctx.inject(['connection']) simply never runs without the service: no throw.
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ProjectSkillPaths, { watch: false })
})

test('[high] same-origin check compares Origin with Host, because the host rewrites the Request URL', async () => {
  const { isSameOrigin } = await import('../lib/routes.js')
  assert.equal(isSameOrigin('http://127.0.0.1:43120', '127.0.0.1:43120'), true)
  assert.equal(isSameOrigin('http://localhost:5173', 'localhost:5173'), true)
  assert.equal(isSameOrigin('http://[::1]:43120', '[::1]:43120'), true)
  assert.equal(isSameOrigin('http://evil.example', '127.0.0.1:43120'), false)
  assert.equal(isSameOrigin('http://127.0.0.1:1', '127.0.0.1:43120'), false)
  assert.equal(isSameOrigin('null', '127.0.0.1:43120'), false)
  assert.equal(isSameOrigin('file://', '127.0.0.1:43120'), false)
  assert.equal(isSameOrigin('http://127.0.0.1:43120', null), false)
  // what DSH 0.2.1-rc.5 really hands the route: an internal URL plus the browser's Host
  const { base, project } = await fixture('dsh-sec-host-')
  const env = await bootPlugin({ watch: false }, { workspaces: [project] })
  try {
    const ok = await env.post({ projectRoot: project, skillPaths: ['skills'] })
    assert.equal(ok.status, 200)
    const forged = await env.post({ projectRoot: project, skillPaths: ['skills'] },
      { headers: { host: 'attacker.example:43120' } })
    assert.equal(forged.status, 403)
    assert.equal(forged.body.code, 'forbidden-origin')
  } finally {
    await env.close()
    await rm(base, { recursive: true, force: true })
  }
})
