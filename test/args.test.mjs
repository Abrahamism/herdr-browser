import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('parseArgs keeps "=" inside the value', () => {
  const { flags } = parseArgs(['--for', 'url=https://x/y?a=b'])
  assert.equal(flags.for, 'url=https://x/y?a=b')
  const inline = parseArgs(['--for=selector=#app'])
  assert.equal(inline.flags.for, 'selector=#app')
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

test('parseArgs refuses a value flag that has no value', () => {
  // A bare --profile used to become the string "true", which created a profile by that name.
  assert.throws(() => parseArgs(['open', 'https://x', '--profile']), /--profile requires a value/)
  assert.throws(() => parseArgs(['--profile', '--json']), /--profile requires a value/)
})

test('a profile passed once is remembered by the next command', () => {
  const home = mkdtempSync(join(tmpdir(), 'hb-'))
  const env = { HERDR_BROWSER_HOME: home }
  try {
    assert.equal(resolveSettings({}, env, 'win32').profile, 'default')
    assert.equal(resolveSettings({ profile: 'cf-login' }, env, 'win32').profile, 'cf-login')
    assert.equal(resolveSettings({}, env, 'win32').profile, 'cf-login')
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).profile, 'cf-login')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
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

