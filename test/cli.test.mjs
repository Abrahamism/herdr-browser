import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServer, runCli } from './fake-cdp.mjs'

test('--version prints the package version instead of the help text', async () => {
  const home = join(tmpdir(), 'hb-version-' + Date.now())
  const result = await runCli(home, ['--version'])
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim(), `herdr-browser ${version}`)
  assert.equal(existsSync(home), false, '--version must not touch the profile home')
})

test('CLI against fake CDP server', async () => {
  const { server, state } = makeServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const tmp = join(tmpdir(), 'hb-cli-' + Date.now())
  const home = join(tmp, 'home')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  const statePath = join(profileDir, 'state.json')
  writeFileSync(statePath, JSON.stringify({ port, browser: 'brave', exe: 'fake', userData: join(profileDir, 'user-data') }))

  try {
    // tabs --json
    const r1 = await runCli(home, ['tabs', '--json'])
    assert.equal(r1.status, 0, r1.stderr)
    assert.equal(r1.stderr, '')
    const tabs = JSON.parse(r1.stdout)
    assert.equal(tabs.length, 2)

    // snapshot
    const r2 = await runCli(home, ['snapshot'])
    assert.equal(r2.status, 0, r2.stderr)
    assert.equal(r2.stderr, '')
    assert.match(r2.stdout, /\[e1\] button "Go"/)

    // click e1
    state.dispatches.length = 0
    const r3 = await runCli(home, ['click', 'e1'])
    assert.equal(r3.status, 0, r3.stderr)
    assert.equal(r3.stderr, '')
    const types = state.dispatches.map((c) => c.type)
    assert.equal(types[0], 'mouseMoved')
    assert.equal(types[types.length - 2], 'mousePressed')
    assert.equal(types[types.length - 1], 'mouseReleased')
    const lastMove = state.dispatches.filter((c) => c.type === 'mouseMoved').at(-1)
    assert.equal(lastMove.x, 10)
    assert.equal(lastMove.y, 20)
    assert.ok(types.length > 3, 'the pointer should move in several steps')
    const press = state.dispatches.find((c) => c.type === 'mousePressed')
    const release = state.dispatches.find((c) => c.type === 'mouseReleased')
    assert.equal(press.x, 10)
    assert.equal(press.y, 20)
    assert.equal(release.x, 10)
    assert.equal(release.y, 20)

    // status
    const r4 = await runCli(home, ['status'])
    assert.equal(r4.status, 0, r4.stderr)
    assert.equal(r4.stderr, '')
    assert.match(r4.stdout, new RegExp(`port: ${port}`))

    // stop is session scoped: it does not tear down a browser other tabs still use
    const r5 = await runCli(home, ['stop'])
    assert.equal(r5.status, 0, r5.stderr)
    assert.equal(r5.stderr, '')
    assert.match(r5.stdout, /session: default stopped/)
    assert.match(r5.stdout, /browser: running \(2 tabs left\)/)
    assert.equal(state.browserClosed, false)
    assert.equal(existsSync(statePath), true)

    // stop --all keeps the pre-session contract: the shared browser goes away
    const r6 = await runCli(home, ['stop', '--all'])
    assert.equal(r6.status, 0, r6.stderr)
    assert.equal(r6.stderr, '')
    assert.match(r6.stdout, /browser: stopped/)
    assert.equal(state.browserClosed, true)
    assert.equal(existsSync(statePath), false)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      server.close()
    } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})
