import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CURSOR_SCRIPT, fillScript, resolveRefScript, snapshotScript } from '../src/inject.mjs'

const MODULE_SOURCE = readFileSync(new URL('../src/inject.mjs', import.meta.url), 'utf8')
const SCAN_LINE =
  'const scan = () => Array.from(document.querySelectorAll(SELECTOR)).filter(visible).slice(0, MAX_ITEMS);'

test('the element scan is defined once, not copied per script', () => {
  const definitions = MODULE_SOURCE.match(/const SELECTOR = \[/g) ?? []
  assert.equal(definitions.length, 1, 'a second copy of the scan can drift and silently retarget refs')
  for (const script of [snapshotScript(), resolveRefScript('e2'), fillScript('e2', 'hi')]) {
    assert.ok(script.includes(SCAN_LINE), 'every script must share the same ref table')
  }
})

test('refs are positions in that table, never DOM attributes', () => {
  assert.ok(!MODULE_SOURCE.includes('data-herdr-browser-ref'), 'the page must not see our refs')
  assert.match(snapshotScript(), /ref: 'e' \+ \(index \+ 1\)/)
  assert.match(resolveRefScript('e5'), /scan\(\)\[index\]/)
  assert.match(resolveRefScript('e5'), /replace\(\/\^e\/, ''\)/)
  assert.match(fillScript('e5', 'x'), /scan\(\)\[index\]/)
})

test('a missing ref fails loudly with the instruction to resnapshot', () => {
  assert.match(resolveRefScript('e9'), /ref e9 not found; run snapshot again/)
  assert.match(fillScript('e9', 'x'), /ref e9 not found; run snapshot again/)
})

test('the value is embedded as a JSON literal, quotes included', () => {
  const script = fillScript('e1', 'a"b')
  assert.ok(script.includes('const value = "a\\"b"'))
})

test('the cursor lives in a closed shadow root with no window globals', () => {
  assert.match(CURSOR_SCRIPT, /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/)
  assert.ok(!CURSOR_SCRIPT.includes('window.__hbPos'))
  assert.ok(!CURSOR_SCRIPT.includes('window.__hbPaint'))
  assert.ok(!CURSOR_SCRIPT.includes('__herdrBrowserCursorVersion'))
  assert.match(CURSOR_SCRIPT, /if \(document\.querySelector\('\[data-hb-c\]'\)\) return 'already'/)
  assert.match(CURSOR_SCRIPT, /host\.paint = \(x, y\)/)
})
