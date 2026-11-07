import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchPlain, plainArgs, profileLockFile, waitForProfileRelease } from '../src/launch.mjs'
import { runCli } from './fake-cdp.mjs'

function tempDir() {
  const dir = join(tmpdir(), `hb-login-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('the plain launch has no debugging port at all', () => {
  const args = plainArgs({ userDataDir: '/tmp/p', url: 'https://x.example' })
  assert.ok(args.includes('--user-data-dir=/tmp/p'))
  assert.equal(args.at(-1), 'https://x.example')
  assert.ok(
    !args.some((arg) => arg.startsWith('--remote-debugging')),
    'a port is what makes the challenge refusable in the first place'
  )
  assert.ok(!plainArgs({ userDataDir: '/tmp/p' }).includes(undefined))
})

test('launchPlain spawns the browser with those args and no stdio', () => {
  const calls = []
  const dir = tempDir()
  try {
    launchPlain({
      exe: 'brave',
      userData: dir,
      url: 'https://x.example',
      spawnImpl: (exe, args, options) => {
        calls.push({ exe, args, options })
        return { pid: 1 }
      }
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].exe, 'brave')
    assert.equal(calls[0].options.stdio, 'ignore')
    assert.ok(calls[0].args.includes('https://x.example'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the profile lock is found under either name', () => {
  const dir = tempDir()
  try {
    assert.equal(profileLockFile(dir), null)
    writeFileSync(join(dir, 'lockfile'), '')
    assert.equal(profileLockFile(dir), join(dir, 'lockfile'))
    rmSync(join(dir, 'lockfile'))
    writeFileSync(join(dir, 'SingletonLock'), '')
    assert.equal(profileLockFile(dir), join(dir, 'SingletonLock'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('it waits until the human closes the window', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'lockfile'), '')
    setTimeout(() => rmSync(join(dir, 'lockfile'), { force: true }), 200)
    const result = await waitForProfileRelease(dir, { timeoutMs: 5000, intervalMs: 40 })
    assert.equal(result.released, true)
    assert.ok(result.waitedMs >= 150, `waited ${result.waitedMs}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a window that never locks is not waited for forever', async () => {
  const dir = tempDir()
  try {
    const result = await waitForProfileRelease(dir, { timeoutMs: 5000, appearedMs: 120, intervalMs: 30 })
    assert.equal(result.released, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an open window eventually reports that it is still open', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'lockfile'), '')
    const result = await waitForProfileRelease(dir, { timeoutMs: 300, intervalMs: 40 })
    assert.equal(result.released, false)
    assert.equal(existsSync(join(dir, 'lockfile')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('login without a url refuses instead of launching a browser', async () => {
  const result = await runCli(tempDir(), ['login'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /usage: herdr-browser login <url>/)
})