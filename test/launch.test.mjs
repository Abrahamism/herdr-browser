import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchArgs, parseDevToolsActivePort } from '../src/launch.mjs'

test('launchArgs contains required flags', () => {
  const args = launchArgs({ userDataDir: '/tmp/ud', port: 0, extensions: [], headless: true })
  assert.ok(args.some((a) => a.startsWith('--user-data-dir=')))
  assert.ok(args.some((a) => a === '--remote-debugging-port=0'))
  assert.ok(args.includes('--headless=new'))
  assert.ok(!args.some((a) => a.startsWith('--load-extension=')))
})

test('launchArgs load-extension only when extensions exist', () => {
  const args = launchArgs({ userDataDir: '/tmp/ud', port: 0, extensions: ['/ext/a'], headless: false })
  const ext = args.find((a) => a.startsWith('--load-extension='))
  assert.ok(ext)
  assert.equal(ext, '--load-extension=/ext/a')
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
