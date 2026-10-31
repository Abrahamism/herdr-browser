import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addExtension, extensionPaths, listExtensions, removeExtension } from '../src/extensions.mjs'
import { importProfile, sourceUserData } from '../src/profile.mjs'

function sandbox(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, env: { HERDR_BROWSER_HOME: root, LOCALAPPDATA: root } }
}

function writeExtension(dir, manifest) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
}

test('add, list and remove an unpacked extension', () => {
  const { root, env } = sandbox('hb-ext-')
  const dir = join(root, 'demo-extension')
  writeExtension(dir, { manifest_version: 3, name: 'Demo', version: '1.0.0' })

  const entry = addExtension('default', dir, env, 'win32')
  assert.equal(entry.name, 'Demo')
  assert.deepEqual(extensionPaths('default', env, 'win32'), [dir])

  const list = listExtensions('default', env, 'win32')
  assert.equal(list.length, 1)
  assert.equal(list[0].present, true)

  // Adding the same directory twice must not duplicate it.
  addExtension('default', dir, env, 'win32')
  assert.equal(listExtensions('default', env, 'win32').length, 1)

  assert.equal(removeExtension('default', dir, env, 'win32'), true)
  assert.equal(listExtensions('default', env, 'win32').length, 0)
  assert.equal(removeExtension('default', dir, env, 'win32'), false)
  rmSync(root, { recursive: true, force: true })
})

test('rejects a directory without a manifest', () => {
  const { root, env } = sandbox('hb-ext-bad-')
  const dir = join(root, 'not-an-extension')
  mkdirSync(dir, { recursive: true })
  assert.throws(() => addExtension('default', dir, env, 'win32'), /manifest\.json/)
  rmSync(root, { recursive: true, force: true })
})

test('imports cookies and extensions from the real profile', () => {
  const { root, env } = sandbox('hb-import-')
  const source = sourceUserData('brave', { env, plat: 'win32' })
  const profile = join(source, 'Default')
  mkdirSync(join(profile, 'Network'), { recursive: true })
  writeFileSync(join(source, 'Local State'), '{"os_crypt":{}}')
  writeFileSync(join(profile, 'Cookies'), 'cookie-db')
  writeFileSync(join(profile, 'Network', 'Cookies'), 'network-cookie-db')
  const extension = join(profile, 'Extensions', 'abcdefghijklmnop', '1.0.0')
  writeExtension(extension, { manifest_version: 3, name: 'Imported', version: '1.0.0' })

  const result = importProfile({
    from: 'brave',
    profile: 'default',
    env,
    plat: 'win32',
    running: () => false
  })

  assert.ok(result.copied.includes('Local State'))
  assert.ok(result.copied.includes('Cookies'))
  assert.ok(result.copied.includes('Network/Cookies'))
  const target = join(root, 'profiles', 'default', 'user-data')
  assert.equal(readFileSync(join(target, 'Default', 'Cookies'), 'utf8'), 'cookie-db')
  assert.equal(result.extensions.found, 1)
  assert.equal(result.extensions.registered, 1)
  assert.equal(listExtensions('default', env, 'win32')[0].name, 'Imported')
  assert.ok(existsSync(join(target, 'Local State')))
  rmSync(root, { recursive: true, force: true })
})

test('refuses to import while the source browser is running unless forced', () => {
  const { root, env } = sandbox('hb-import-busy-')
  const source = sourceUserData('brave', { env, plat: 'win32' })
  mkdirSync(join(source, 'Default'), { recursive: true })
  writeFileSync(join(source, 'Local State'), '{}')

  assert.throws(
    () => importProfile({ from: 'brave', profile: 'default', env, plat: 'win32', running: () => true }),
    /is running/
  )
  const forced = importProfile({
    from: 'brave',
    profile: 'default',
    env,
    plat: 'win32',
    force: true,
    running: () => true
  })
  assert.ok(forced.copied.includes('Local State'))
  rmSync(root, { recursive: true, force: true })
})
