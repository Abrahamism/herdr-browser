import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServer, runCli } from './fake-cdp.mjs'

/**
 * Two CLI processes driving one browser: the bug in issue #1 was that the second
 * client silently retargeted the first one's commands to tabs[0].
 */

async function setup({ targets } = {}) {
  const { server, state } = makeServer({ targets })
  const home = mkdtempSync(join(tmpdir(), 'hb-sessions-cli-'))
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
      try {
        server.close()
      } catch {}
      rmSync(home, { recursive: true, force: true })
    }
  }
}

test('two sessions never retarget each other', async () => {
  const ctx = await setup()
  const { state, home } = ctx
  try {
    // Each session allocates its own tab instead of reusing tabs[0].
    const a1 = await runCli(home, ['open', 'http://a/', '--session', 'agent-a'])
    assert.equal(a1.status, 0, a1.stderr)
    assert.match(a1.stdout, /session: agent-a/)
    const tabA = /tab:\s+(\S+)/.exec(a1.stdout)?.[1]
    assert.ok(tabA, a1.stdout)

    const b1 = await runCli(home, ['open', 'http://b/', '--session', 'agent-b'])
    assert.equal(b1.status, 0, b1.stderr)
    const tabB = /tab:\s+(\S+)/.exec(b1.stdout)?.[1]
    assert.ok(tabB, b1.stdout)
    assert.notEqual(tabA, tabB, 'the second session must not reuse the first session tab')
    assert.deepEqual(state.created, [tabA, tabB])
    assert.deepEqual(ctx.readSession('agent-a').tabs.map((t) => t.id), [tabA])
    assert.deepEqual(ctx.readSession('agent-b').tabs.map((t) => t.id), [tabB])

    // Commands without --page stay inside the caller's own tab.
    state.attachments.length = 0
    const a2 = await runCli(home, ['snapshot', '--session', 'agent-a'])
    assert.equal(a2.status, 0, a2.stderr)
    assert.equal(state.attachments.at(-1), tabA, 'agent-a must attach to its own tab')
    state.attachments.length = 0
    const b2 = await runCli(home, ['click', 'e1', '--session', 'agent-b'])
    assert.equal(b2.status, 0, b2.stderr)
    assert.equal(state.attachments.at(-1), tabB, 'agent-b must attach to its own tab')

    // tabs --json says whose tab is whose.
    const a3 = await runCli(home, ['tabs', '--json', '--session', 'agent-a'])
    assert.equal(a3.status, 0, a3.stderr)
    const tabsA = JSON.parse(a3.stdout)
    assert.deepEqual(
      [tabsA.find((t) => t.id === tabA).session, tabsA.find((t) => t.id === tabA).owned, tabsA.find((t) => t.id === tabA).active],
      ['agent-a', true, true]
    )
    assert.deepEqual(
      [tabsA.find((t) => t.id === tabB).session, tabsA.find((t) => t.id === tabB).owned],
      ['agent-b', false]
    )
    const human = await runCli(home, ['tabs', '--session', 'agent-b'])
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, /session: agent-b \(mine\)/)

    // An explicit --page still reaches a tab owned by another session.
    state.attachments.length = 0
    const crossed = await runCli(home, ['click', 'e1', '--page', tabB, '--session', 'agent-a'])
    assert.equal(crossed.status, 0, crossed.stderr)
    assert.equal(state.attachments.at(-1), tabB)

    // Reopening inside a session reuses that session's tab, never allocates another.
    const a4 = await runCli(home, ['open', 'http://c/', '--session', 'agent-a'])
    assert.equal(a4.status, 0, a4.stderr)
    assert.match(a4.stdout, new RegExp(`tab:\\s+${tabA}`))
    assert.deepEqual(state.created, [tabA, tabB])

    // Closing and reopening inside a session keeps ownership consistent.
    const closed = await runCli(home, ['close', tabA, '--session', 'agent-a'])
    assert.equal(closed.status, 0, closed.stderr)
    assert.deepEqual(ctx.readSession('agent-a').tabs, [])
    const a5 = await runCli(home, ['open', 'http://d/', '--session', 'agent-a'])
    assert.equal(a5.status, 0, a5.stderr)
    const tabA2 = /tab:\s+(\S+)/.exec(a5.stdout)?.[1]
    assert.notEqual(tabA2, tabA)

    // Session-scoped stop closes only the caller's tabs and leaves the browser up.
    const stopped = await runCli(home, ['stop', '--session', 'agent-a'])
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /session: agent-a stopped/)
    assert.match(stopped.stdout, /browser: running/)
    assert.equal(state.closed.includes(tabA2), true)
    assert.equal(state.browserClosed, false)
    assert.equal(existsSync(ctx.sessionFile('agent-a')), false)
    assert.equal(existsSync(ctx.statePath), true, 'state.json still describes the running browser')

    // The other agent keeps working: nothing of its was retargeted or closed.
    state.attachments.length = 0
    const b3 = await runCli(home, ['snapshot', '--session', 'agent-b'])
    assert.equal(b3.status, 0, b3.stderr)
    assert.equal(state.attachments.at(-1), tabB)
    assert.equal(state.targets.some((t) => t.targetId === tabB), true)
  } finally {
    await ctx.close()
  }
})

test('a session with no tabs fails loudly instead of stealing tabs[0]', async () => {
  const ctx = await setup()
  const { state, home } = ctx
  try {
    const opened = await runCli(home, ['open', 'http://a/', '--session', 'agent-a'])
    assert.equal(opened.status, 0, opened.stderr)
    const tabA = /tab:\s+(\S+)/.exec(opened.stdout)?.[1]
    // Remove the legacy tabs so the only page left belongs to agent-a.
    for (const id of ['t1', 't2']) {
      const closed = await runCli(home, ['close', id, '--session', 'agent-a'])
      assert.equal(closed.status, 0, closed.stderr)
    }
    assert.deepEqual(state.targets.map((t) => t.targetId), [tabA])

    state.attachments.length = 0
    const ghost = await runCli(home, ['snapshot', '--session', 'ghost'])
    assert.equal(ghost.status, 1)
    assert.match(ghost.stderr, /session "ghost" owns no tabs/)
    assert.match(ghost.stderr, /--page/)
    assert.deepEqual(state.attachments, [], 'a failed resolution must not attach to any tab')

    // --page rescues the caller without pretending the tab is its own.
    const rescued = await runCli(home, ['snapshot', '--session', 'ghost', '--page', tabA])
    assert.equal(rescued.status, 0, rescued.stderr)
    assert.equal(state.attachments.at(-1), tabA)
    assert.equal(existsSync(ctx.sessionFile('ghost')), false)
  } finally {
    await ctx.close()
  }
})

test('open --reuse adopts a tab nobody owns, and stops short of touching owned ones', async () => {
  const ctx = await setup()
  const { state, home } = ctx
  try {
    // No session owns t1/t2 (legacy or human-opened): --reuse adopts the first one.
    const reused = await runCli(home, ['open', 'http://a/', '--reuse', '--session', 'agent-a'])
    assert.equal(reused.status, 0, reused.stderr)
    assert.match(reused.stdout, /tab:\s+t1/)
    assert.deepEqual(state.created, [], 'reuse must not allocate a tab')
    assert.deepEqual(ctx.readSession('agent-a').tabs.map((t) => t.id), ['t1'])

    // Reusing again stays on the caller's own tab.
    const again = await runCli(home, ['open', 'http://b/', '--reuse', '--session', 'agent-a'])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /tab:\s+t1/)

    // A session that owns nothing refuses --reuse once every tab has an owner.
    await runCli(home, ['close', 't2', '--session', 'agent-a'])
    const refused = await runCli(home, ['open', 'http://c/', '--reuse', '--session', 'agent-b'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /has no tab to reuse/)
    assert.deepEqual(state.created, [])
  } finally {
    await ctx.close()
  }
})

test('HERDR_BROWSER_SESSION names the session and stop --all closes everything', async () => {
  const ctx = await setup({ targets: [] })
  const { state, home } = ctx
  try {
    const opened = await runCli(home, ['open', 'http://a/'], { HERDR_BROWSER_SESSION: 'agent-env' })
    assert.equal(opened.status, 0, opened.stderr)
    assert.match(opened.stdout, /session: agent-env/)
    assert.ok(existsSync(ctx.sessionFile('agent-env')))

    const second = await runCli(home, ['open', 'http://b/', '--session', 'agent-b'])
    assert.equal(second.status, 0, second.stderr)

    const all = await runCli(home, ['stop', '--all', '--session', 'agent-env'])
    assert.equal(all.status, 0, all.stderr)
    assert.match(all.stdout, /browser: stopped/)
    assert.equal(state.browserClosed, true)
    assert.equal(existsSync(ctx.statePath), false)
    assert.deepEqual(readdirSync(join(home, 'profiles', 'default', 'sessions')), [])
  } finally {
    await ctx.close()
  }
})

test('stopping the last session closes the browser exactly like before', async () => {
  const ctx = await setup({ targets: [] })
  const { state, home } = ctx
  try {
    const opened = await runCli(home, ['open', 'http://a/', '--session', 'solo'])
    assert.equal(opened.status, 0, opened.stderr)
    const stopped = await runCli(home, ['stop', '--session', 'solo'])
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /browser: stopped/)
    assert.equal(state.browserClosed, true)
    assert.equal(existsSync(ctx.statePath), false)
  } finally {
    await ctx.close()
  }
})
