import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidates, detectBrowsers, findBrowser } from '../src/browsers.mjs'

test('candidates win32 with injected env', () => {
  const env = { LOCALAPPDATA: 'C:\\\\users\\\\x', PROGRAMFILES: 'C:\\\\pf' }
  const result = candidates('brave', { env, plat: 'win32' })
  assert.ok(result.some((p) => p.includes('Brave-Browser')))
  assert.ok(result.every((p) => typeof p === 'string'))
})

test('candidates darwin', () => {
  const result = candidates('chrome', { plat: 'darwin' })
  assert.deepEqual(result, ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])
})

test('candidates linux', () => {
  const result = candidates('chromium', { plat: 'linux' })
  assert.ok(result.includes('/usr/bin/chromium'))
})

test('findBrowser with injected exists', () => {
  const env = { LOCALAPPDATA: 'C:\\\\users\\\\x' }
  const exists = (p) => p.endsWith('brave.exe')
  const found = findBrowser('brave', { env, plat: 'win32', exists })
  assert.ok(found && found.name === 'brave')
  assert.ok(found.exe.endsWith('brave.exe'))
})

test('detectBrowsers filters missing', () => {
  const exists = () => false
  assert.deepEqual(detectBrowsers({ exists }), [])
})
