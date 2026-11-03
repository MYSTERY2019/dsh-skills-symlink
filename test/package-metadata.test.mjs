import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJsonUrl = new URL('../package.json', import.meta.url)
const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const clientUrl = new URL('../client/client.js', import.meta.url)

test('package, bundle patch, and client bundle use the public plugin name', async () => {
  const manifest = JSON.parse(await readFile(packageJsonUrl, 'utf8'))
  const patch = await readFile(patchUrl, 'utf8')
  const client = await readFile(clientUrl, 'utf8')

  assert.equal(manifest.name, 'dsh-skills-symlink')
  assert.match(patch, /name: dsh-skills-symlink/)
  assert.match(client, /id: 'dsh-skills-symlink'/)
})

test('package ships every file required for an installable DSH bundle', async () => {
  const manifest = JSON.parse(await readFile(packageJsonUrl, 'utf8'))

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.files.includes('client'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
})
