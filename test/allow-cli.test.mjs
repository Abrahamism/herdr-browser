import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from './fake-cdp.mjs'
import { withFakeCdp } from './harness.mjs'

test('open pins the session to the origins it was allowed to touch', async () => {
  await withFakeCdp(async ({ home, state }) => {
    const open = await runCli(home, ['open', 'https://allowed.example/a', '--allow-origin', 'allowed.example'])
    assert.equal(open.status, 0, open.stderr)

    const list = await runCli(home, ['allow', 'list'])
    assert.equal(list.status, 0, list.stderr)
    assert.match(list.stdout, /allowlist: allowed\.example/)

    const blocked = await runCli(home, ['open', 'https://blocked.example/b'])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /blocked: https:\/\/blocked\.example\/b is outside the session allowlist/)
    assert.ok(
      !state.navigations.includes('https://blocked.example/b'),
      'a refused open must never reach the browser'
    )
  })
})

test('a session with no list says so and lets anything through', async () => {
  await withFakeCdp(async ({ home }) => {
    const list = await runCli(home, ['allow', 'list'])
    assert.match(list.stdout, /allowlist: none \(no restriction\)/)
    const open = await runCli(home, ['open', 'https://anything.example/'])
    assert.equal(open.status, 0, open.stderr)
  })
})

test('allow add is idempotent and clear removes the restriction', async () => {
  await withFakeCdp(async ({ home }) => {
    await runCli(home, ['allow', 'add', 'a.example, *.b.example'])
    const first = await runCli(home, ['allow', 'list'])
    assert.match(first.stdout, /allowlist: a\.example, \*\.b\.example/)

    const again = await runCli(home, ['allow', 'add', 'a.example'])
    assert.match(again.stdout, /allowlist: a\.example, \*\.b\.example/)

    const cleared = await runCli(home, ['allow', 'clear'])
    assert.match(cleared.stdout, /none \(no restriction\)/)
  })
})

test('page commands refuse a tab that sits outside the list', async () => {
  await withFakeCdp(async ({ home, state }) => {
    state.targets[0].url = 'https://elsewhere.example/'
    mkdirSync(join(home, 'profiles', 'default', 'sessions'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'default', 'sessions', 'default.json'),
      JSON.stringify({
        session: 'default',
        activeTargetId: 't1',
        tabs: [{ id: 't1' }],
        allowedOrigins: ['allowed.example']
      })
    )
    const result = await runCli(home, ['snapshot', '--page', 't1'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /blocked: https:\/\/elsewhere\.example\/ is outside the session allowlist/)
  })
})

test('about:blank stays reachable even when a list is pinned', async () => {
  await withFakeCdp(async ({ home }) => {
    const result = await runCli(home, ['open', 'about:blank', '--allow-origin', 'allowed.example'])
    assert.equal(result.status, 0, result.stderr)
  })
})
