import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profilePaths } from '../src/home.mjs'
import {
  DEFAULT_SESSION,
  annotateTabs,
  emptySession,
  forgetTab,
  hasTab,
  listSessions,
  ownedTabs,
  ownersByTarget,
  readSession,
  recordTab,
  removeSession,
  resolveSession,
  sessionFile,
  sessionName,
  writeSession
} from '../src/sessions.mjs'

function tempProfile() {
  const home = mkdtempSync(join(tmpdir(), 'hb-sessions-'))
  const env = { HERDR_BROWSER_HOME: home }
  return { home, paths: profilePaths('default', env, 'linux') }
}

const live = [
  { index: 0, id: 't1', title: 'One', url: 'http://one/' },
  { index: 1, id: 't2', title: 'Two', url: 'http://two/' }
]

test('session identity: flag, env, default and validation', () => {
  assert.equal(DEFAULT_SESSION, 'default')
  assert.equal(resolveSession({}, {}), 'default')
  assert.equal(resolveSession({ session: 'agent-a' }, {}), 'agent-a')
  assert.equal(resolveSession({}, { HERDR_BROWSER_SESSION: 'agent-b' }), 'agent-b')
  assert.equal(resolveSession({ session: 'agent-a' }, { HERDR_BROWSER_SESSION: 'agent-b' }), 'agent-a')
  assert.throws(() => resolveSession({ session: '../evil' }, {}), /invalid session name/)
  assert.throws(() => resolveSession({ session: true }, {}), /needs a name/)
  assert.equal(sessionName('  padded  '), 'padded')
})

test('session files roundtrip atomically with no temp leftovers', () => {
  const { paths, home } = tempProfile()
  try {
    assert.deepEqual(readSession(paths, 'agent-a'), emptySession('agent-a'))
    assert.equal(sessionFile(paths, 'agent-a'), join(paths.root, 'sessions', 'agent-a.json'))

    const written = writeSession(paths, recordTab(emptySession('agent-a'), 't1', { title: 'One' }))
    assert.equal(written.activeTargetId, 't1')
    assert.ok(written.updatedAt)
    const back = readSession(paths, 'agent-a')
    assert.equal(back.session, 'agent-a')
    assert.equal(back.activeTargetId, 't1')
    assert.deepEqual(back.tabs.map((tab) => tab.id), ['t1'])
    assert.deepEqual(readdirSync(join(paths.root, 'sessions')).filter((f) => f.endsWith('.tmp')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('recordTab claims without duplicating and forgetTab moves the active tab', () => {
  let session = emptySession('agent-a')
  session = recordTab(session, 't1', { title: 'One' })
  session = recordTab(session, 't2', { title: 'Two' })
  assert.deepEqual(session.tabs.map((tab) => tab.id), ['t1', 't2'])
  assert.equal(session.activeTargetId, 't2')

  session = recordTab(session, 't1')
  assert.deepEqual(session.tabs.map((tab) => tab.id), ['t2', 't1'])
  assert.equal(session.activeTargetId, 't1')

  session = forgetTab(session, 't1')
  assert.deepEqual(session.tabs.map((tab) => tab.id), ['t2'])
  assert.equal(session.activeTargetId, 't2')

  session = forgetTab(session, 't2')
  assert.equal(session.activeTargetId, null)
  assert.equal(hasTab(session, 't2'), false)
})

test('ownedTabs and ownersByTarget keep sessions apart', () => {
  const a = recordTab(emptySession('agent-a'), 't1')
  const b = recordTab(emptySession('agent-b'), 't2')
  assert.deepEqual(ownedTabs(a, live).map((tab) => tab.id), ['t1'])
  // A tab that no longer exists is pruned from the owned set.
  assert.deepEqual(ownedTabs(recordTab(emptySession('agent-a'), 'gone'), live), [])

  const owners = ownersByTarget([a, b, emptySession('idle')])
  assert.equal(owners.get('t1'), 'agent-a')
  assert.equal(owners.get('t2'), 'agent-b')
  assert.equal(owners.has('t3'), false)

  const annotated = annotateTabs(live, { current: 'agent-a', sessions: [a, b] })
  assert.deepEqual(
    annotated.map((tab) => [tab.id, tab.session, tab.owned, tab.active]),
    [
      ['t1', 'agent-a', true, true],
      ['t2', 'agent-b', false, false]
    ]
  )
})

test('listSessions reads every session file and removeSession deletes one', () => {
  const { paths, home } = tempProfile()
  try {
    writeSession(paths, recordTab(emptySession('agent-a'), 't1'))
    writeSession(paths, recordTab(emptySession('agent-b'), 't2'))
    assert.deepEqual(listSessions(paths).map((s) => s.session).sort(), ['agent-a', 'agent-b'])
    removeSession(paths, 'agent-a')
    assert.deepEqual(listSessions(paths).map((s) => s.session), ['agent-b'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
