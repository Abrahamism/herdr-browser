import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServer, runCli } from './fake-cdp.mjs'

async function setup({ targets } = {}) {
  const { server, state } = makeServer({ targets })
  const home = mkdtempSync(join(tmpdir(), 'hb-cleanup-cli-'))
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  const statePath = join(profileDir, 'state.json')
  const sessionDir = join(profileDir, 'sessions')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  writeFileSync(statePath, JSON.stringify({ port, browser: 'brave', exe: 'fake', userData: join(profileDir, 'user-data') }))
  return {
    server,
    state,
    home,
    statePath,
    sessionFile: (name) => join(sessionDir, `${name}.json`),
    readSession: (name) => JSON.parse(readFileSync(join(sessionDir, `${name}.json`), 'utf8')),
    async close() {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try { server.close() } catch {}
      rmSync(home, { recursive: true, force: true })
    }
  }
}

function ageTab(ctx, session, tabId, msAgo = 60_000) {
  const data = ctx.readSession(session)
  for (const tab of data.tabs) {
    if (tab.id === tabId) tab.lastUsedAt = new Date(Date.now() - msAgo).toISOString()
  }
  writeFileSync(ctx.sessionFile(session), JSON.stringify(data, null, 2) + '\n')
}

test('cleanup closes aged tabs but keeps fresh ones', async () => {
  const ctx = await setup()
  const { state, home } = ctx
  try {
    const o1 = await runCli(home, ['open', 'http://a/', '--session', 'agent-a'])
    assert.equal(o1.status, 0, o1.stderr)
    const tabA = /tab:\s+(\S+)/.exec(o1.stdout)?.[1]
    const o2 = await runCli(home, ['open', 'http://b/', '--new', '--session', 'agent-a'])
    assert.equal(o2.status, 0, o2.stderr)
    const tabB = /tab:\s+(\S+)/.exec(o2.stdout)?.[1]
    assert.notEqual(tabA, tabB)

    ageTab(ctx, 'agent-a', tabA, 60_000)

    const dry = await runCli(home, ['tabs', 'cleanup', '--idle', '1s', '--dry-run', '--session', 'agent-a'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /would close/)
    assert.equal(state.closed.includes(tabA), false, 'dry-run must not close')

    const run = await runCli(home, ['tabs', 'cleanup', '--idle', '1s', '--session', 'agent-a'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /closed: 1 tab\(s\)/)
    assert.equal(state.closed.includes(tabA), true)
    assert.equal(state.closed.includes(tabB), false)
    const session = ctx.readSession('agent-a')
    assert.deepEqual(session.tabs.map((t) => t.id), [tabB])
  } finally {
    await ctx.close()
  }
})

test('cleanup --all reaches another session aged tab', async () => {
  const ctx = await setup()
  const { state, home } = ctx
  try {
    const a = await runCli(home, ['open', 'http://a/', '--session', 'agent-a'])
    const tabA = /tab:\s+(\S+)/.exec(a.stdout)?.[1]
    const b = await runCli(home, ['open', 'http://b/', '--session', 'agent-b'])
    const tabB = /tab:\s+(\S+)/.exec(b.stdout)?.[1]
    ageTab(ctx, 'agent-b', tabB, 60_000)

    const run = await runCli(home, ['tabs', 'cleanup', '--idle', '1s', '--all', '--session', 'agent-a'])
    assert.equal(run.status, 0, run.stderr)
    assert.equal(state.closed.includes(tabB), true)
    const sb = ctx.readSession('agent-b')
    assert.deepEqual(sb.tabs.map((t) => t.id), [])
  } finally {
    await ctx.close()
  }
})

test('cleanup never closes an unowned tab', async () => {
  const ctx = await setup()
  const { state, home } = ctx
  try {
    const run = await runCli(home, ['tabs', 'cleanup', '--idle', '1s', '--all', '--session', 'agent-a'])
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(state.closed, [])
  } finally {
    await ctx.close()
  }
})

test('--idle below 1000 is refused', async () => {
  const ctx = await setup()
  const { home } = ctx
  try {
    const run = await runCli(home, ['tabs', 'cleanup', '--idle', '500', '--session', 'agent-a'])
    assert.equal(run.status, 1)
    assert.match(run.stderr, /at least 1000/)
  } finally {
    await ctx.close()
  }
})

test('cleanup --json reports closed and kept', async () => {
  const ctx = await setup()
  const { home } = ctx
  try {
    const o = await runCli(home, ['open', 'http://a/', '--session', 'agent-a'])
    const tabA = /tab:\s+(\S+)/.exec(o.stdout)?.[1]
    ageTab(ctx, 'agent-a', tabA, 60_000)
    const run = await runCli(home, ['tabs', 'cleanup', '--idle', '1s', '--json', '--session', 'agent-a'])
    assert.equal(run.status, 0, run.stderr)
    const out = JSON.parse(run.stdout)
    assert.equal(out.closed.length, 1)
    assert.equal(out.closed[0].id, tabA)
    assert.equal(typeof out.kept, 'number')
  } finally {
    await ctx.close()
  }
})
