import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJson } from './home.mjs'

/**
 * Per-client session identity and tab ownership.
 *
 * Every CLI invocation belongs to a session (--session <name> or HERDR_BROWSER_SESSION,
 * "default" otherwise). A session owns the tabs it opened, persisted in
 * `<profile>/sessions/<name>.json` next to state.json, so two clients sharing one browser
 * never resolve each other's tabs. Each file is written by its own session only.
 */

export const DEFAULT_SESSION = 'default'

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/

export function sessionName(value) {
  const clean = String(value ?? '').trim()
  if (!NAME_PATTERN.test(clean)) {
    throw new Error(`invalid session name "${value}" (use letters, digits, dot, underscore or hyphen)`)
  }
  return clean
}

export function resolveSession(flags = {}, env = process.env) {
  if (flags.session === true) throw new Error('--session needs a name (for example --session agent-a)')
  const raw = flags.session ?? env.HERDR_BROWSER_SESSION ?? DEFAULT_SESSION
  return sessionName(raw)
}

export function sessionDir(paths) {
  return join(dirname(paths.state), 'sessions')
}

export function sessionFile(paths, name) {
  return join(sessionDir(paths), `${sessionName(name)}.json`)
}

export function emptySession(name) {
  return { session: sessionName(name), activeTargetId: null, tabs: [], updatedAt: null }
}

export function readSession(paths, name) {
  const data = readJson(sessionFile(paths, name), null)
  if (!data || typeof data !== 'object') return emptySession(name)
  return {
    session: sessionName(name),
    activeTargetId: typeof data.activeTargetId === 'string' && data.activeTargetId ? data.activeTargetId : null,
    tabs: Array.isArray(data.tabs)
      ? data.tabs
          .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
          .map((entry) => ({
            id: entry.id,
            title: entry.title ?? null,
            url: entry.url ?? null,
            openedAt: entry.openedAt ?? null
          }))
      : [],
    updatedAt: data.updatedAt ?? null
  }
}

export function writeSession(paths, session) {
  const file = sessionFile(paths, session.session)
  mkdirSync(dirname(file), { recursive: true })
  const next = { ...session, updatedAt: new Date().toISOString() }
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

export function removeSession(paths, name) {
  rmSync(sessionFile(paths, name), { force: true })
}

export function listSessions(paths) {
  let entries = []
  try {
    entries = readdirSync(sessionDir(paths))
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .filter((name) => NAME_PATTERN.test(name))
    .sort()
    .map((name) => readSession(paths, name))
}

export function hasTab(session, targetId) {
  return session.tabs.some((entry) => entry.id === targetId)
}

export function recordTab(session, targetId, meta = {}) {
  const tabs = session.tabs.filter((entry) => entry.id !== targetId)
  tabs.push({
    id: targetId,
    title: meta.title ?? null,
    url: meta.url ?? null,
    openedAt: new Date().toISOString()
  })
  return { ...session, tabs, activeTargetId: targetId }
}

export function forgetTab(session, targetId) {
  const tabs = session.tabs.filter((entry) => entry.id !== targetId)
  const activeTargetId =
    session.activeTargetId === targetId ? (tabs[tabs.length - 1]?.id ?? null) : session.activeTargetId
  return { ...session, tabs, activeTargetId }
}

/** Tabs the session claimed that still exist in the browser (stale ids are ignored, not rewritten). */
export function ownedTabs(session, tabs) {
  const ids = new Set(session.tabs.map((entry) => entry.id))
  return tabs.filter((tab) => ids.has(tab.id))
}

/** targetId -> session name for every live claim. First listing wins; claims are unique in practice. */
export function ownersByTarget(sessions) {
  const owners = new Map()
  for (const session of sessions) {
    for (const entry of session.tabs) {
      if (!owners.has(entry.id)) owners.set(entry.id, session.session)
    }
  }
  return owners
}

export function annotateTabs(tabs, { current, sessions } = {}) {
  const owners = ownersByTarget(sessions ?? [])
  const activeId = (sessions ?? []).find((session) => session.session === current)?.activeTargetId ?? null
  return tabs.map((tab) => {
    const owner = owners.get(tab.id) ?? null
    return { ...tab, session: owner, owned: owner === current, active: tab.id === activeId }
  })
}
