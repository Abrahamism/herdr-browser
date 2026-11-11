import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchArgs, parseDevToolsActivePort, stateOwnsProfile } from '../src/launch.mjs'

test('launchArgs contains required flags', () => {
  const args = launchArgs({ userDataDir: '/tmp/ud', port: 0, extensions: [], headless: true })
  assert.ok(args.some((a) => a.startsWith('--user-data-dir=')))
  assert.ok(args.some((a) => a === '--remote-debugging-port=0'))
  assert.ok(args.includes('--headless=new'))
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'))
  assert.ok(!args.some((a) => a.startsWith('--load-extension=')))
})

test('launchArgs load-extension only when extensions exist', () => {
  const args = launchArgs({ userDataDir: '/tmp/ud', port: 0, extensions: ['/ext/a'], headless: false })
  const ext = args.find((a) => a.startsWith('--load-extension='))
  assert.ok(ext)
  assert.equal(ext, '--load-extension=/ext/a')
})

test('a remembered state only speaks for its own profile', () => {
  const userData = join('C:', 'hb', 'profiles', 'default', 'user-data')
  assert.equal(stateOwnsProfile({ port: 1, userData }, userData, 'win32'), true)
  assert.equal(stateOwnsProfile({ port: 1, userData: userData.toUpperCase() }, userData, 'win32'), true)
  const other = join('C:', 'hb', 'profiles', 'cf-login', 'user-data')
  assert.equal(stateOwnsProfile({ port: 1, userData: other }, userData, 'win32'), false)
  // Written before the state recorded its root: nothing contradicts the caller, keep reusing.
  assert.equal(stateOwnsProfile({ port: 1 }, userData, 'win32'), true)
  assert.equal(stateOwnsProfile({}, userData, 'win32'), false)
  assert.equal(stateOwnsProfile(null, userData, 'win32'), false)
})

test('parseDevToolsActivePort valid', () => {
  const { port, wsPath } = parseDevToolsActivePort('9222\n/devtools/browser/abc\n')
  assert.equal(port, 9222)
  assert.equal(wsPath, '/devtools/browser/abc')
})

test('parseDevToolsActivePort invalid', () => {
  assert.throws(() => parseDevToolsActivePort('nope'), /invalid DevToolsActivePort/)
  assert.throws(() => parseDevToolsActivePort('0'), /invalid DevToolsActivePort/)
})
