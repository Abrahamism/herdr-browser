import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServer, runCli } from './fake-cdp.mjs'

test('a bare --profile fails as a usage error, not as a crash', async () => {
  const home = join(tmpdir(), 'hb-bare-' + Date.now())
  const result = await runCli(home, ['open', 'https://x', '--profile'])
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'herdr-browser: --profile requires a value')
  rmSync(home, { recursive: true, force: true })
})

test('a state left by another profile is not adopted', async () => {
  const { server } = makeServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const tmp = join(tmpdir(), 'hb-foreign-' + Date.now())
  const home = join(tmp, 'home')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  // The port answers, but it is the cf-login browser: adopting that state would drive a
  // window whose cookies are not this profile's.
  writeFileSync(
    join(profileDir, 'state.json'),
    JSON.stringify({
      port,
      browser: 'brave',
      exe: 'fake',
      userData: join(home, 'profiles', 'cf-login', 'user-data')
    })
  )

  try {
    const status = await runCli(home, ['status'])
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /browser: not running/)

    // And no other command may attach to it either.
    const tabs = await runCli(home, ['tabs'])
    assert.notEqual(tabs.status, 0)
    assert.match(tabs.stderr, /browser is not running/)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      server.close()
    } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})
