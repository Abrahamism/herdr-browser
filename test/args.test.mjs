import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, resolveSettings } from '../src/cli.mjs'

test('parseArgs booleans', () => {
  const { flags, positional } = parseArgs(['--json', '--headless'])
  assert.equal(flags.json, true)
  assert.equal(flags.headless, true)
  assert.deepEqual(positional, [])
})

test('parseArgs --key=value', () => {
  const { flags, positional } = parseArgs(['--browser=chrome', '--profile=p'])
  assert.equal(flags.browser, 'chrome')
  assert.equal(flags.profile, 'p')
  assert.deepEqual(positional, [])
})

test('parseArgs --key value', () => {
  const { flags, positional } = parseArgs(['--browser', 'edge', 'pos'])
  assert.equal(flags.browser, 'edge')
  assert.deepEqual(positional, ['pos'])
})

test('parseArgs -- passthrough', () => {
  const { flags, positional } = parseArgs(['--', '--foo', 'bar'])
  assert.deepEqual(positional, ['--foo', 'bar'])
})

test('parseArgs positionals', () => {
  const { flags, positional } = parseArgs(['open', 'https://x', '--new'])
  assert.equal(flags.new, true)
  assert.deepEqual(positional, ['open', 'https://x'])
})

test('resolveSettings rejects unknown browser', () => {
  const env = { HERDR_BROWSER_HOME: mkdtempSync(join(tmpdir(), 'hb-')) }
  assert.throws(() => resolveSettings({ browser: 'nope' }, env, 'win32'), /unknown browser/)
})

test('resolveSettings respects --no-cursor and config', () => {
  const home = mkdtempSync(join(tmpdir(), 'hb-'))
  const env = { HERDR_BROWSER_HOME: home }
  mkdirSync(join(home, 'profiles'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ browser: 'chrome', cursor: true }))
  const withCursor = resolveSettings({}, env, 'win32')
  assert.equal(withCursor.browser, 'chrome')
  assert.equal(withCursor.cursor, true)
  const noCursor = resolveSettings({ 'no-cursor': true }, env, 'win32')
  assert.equal(noCursor.cursor, false)
  rmSync(home, { recursive: true, force: true })
})

