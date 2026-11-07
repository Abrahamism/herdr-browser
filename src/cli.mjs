import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  click,
  evalInPage,
  fill,
  navigate,
  preparePage,
  pressKey,
  readPage,
  screenshot,
  scroll,
  snapshot,
  typeText
} from './actions.mjs'
import { BROWSER_NAMES, detectBrowsers, resolveBrowser } from './browsers.mjs'
import { CDP } from './cdp.mjs'
import { addExtension, extensionPaths, listExtensions, removeExtension } from './extensions.mjs'
import { matchesOrigin, parseAllowlist } from './origins.mjs'
import { buildHar, captureNetwork } from './har.mjs'
import { ensureDir, loadConfig, profilePaths, readJson } from './home.mjs'
import { ensureBrowser, launchPlain, probeVersion, waitForProfileRelease } from './launch.mjs'
import { importProfile, profileSummary } from './profile.mjs'
import { renderExtensions, renderSnapshot, renderStatus, renderTabs } from './render.mjs'
import {
  annotateTabs,
  forgetTab,
  hasTab,
  idleTabs,
  listSessions,
  ownedTabs,
  ownersByTarget,
  readSession,
  recordTab,
  removeSession,
  resolveSession,
  setAllowlist,
  touchTab,
  writeSession
} from './sessions.mjs'
import { activateTab, closeTab, listTabs, openTab, resolveTab } from './tabs.mjs'
import { describeCondition, handoff, parseDuration, parseWaitSpec, waitForCondition } from './wait.mjs'

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const BOOLEAN_FLAGS = new Set([
  'json',
  'new',
  'reuse',
  'all',
  'no-cursor',
  'force',
  'help',
  'version',
  'headless',
  'panel'
])

export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    // Only the first "=" separates the flag from its value: --for url=https://x keeps its url.
    const body = arg.slice(2)
    const equals = body.indexOf('=')
    const key = equals === -1 ? body : body.slice(0, equals)
    const inline = equals === -1 ? undefined : body.slice(equals + 1)
    if (inline !== undefined) {
      flags[key] = inline
    } else if (BOOLEAN_FLAGS.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = argv[++index]
    }
  }
  return { flags, positional }
}

export function resolveSettings(flags, env = process.env, plat = process.platform) {
  const config = loadConfig(env, plat)
  const browser = flags.browser ?? config.browser ?? 'brave'
  if (!BROWSER_NAMES.includes(browser)) {
    throw new Error(`unknown browser "${browser}" (expected one of ${BROWSER_NAMES.join(', ')})`)
  }
  return {
    config,
    browser,
    profile: flags.profile ?? config.profile ?? 'default',
    session: resolveSession(flags, env),
    exe: flags.exe ?? config.exe ?? null,
    cursor: flags['no-cursor'] ? false : config.cursor !== false,
    // A challenge the browser clears by itself costs time, not permission: wait by default.
    challengeWait: parseDuration(
      flags['challenge-wait'] ?? env.HERDR_BROWSER_CHALLENGE_WAIT_MS,
      15_000
    ),
    headless: Boolean(flags.headless),
    env,
    plat
  }
}

function pathsFor(settings) {
  return profilePaths(settings.profile, settings.env, settings.plat)
}

async function connectExisting(settings) {
  const paths = pathsFor(settings)
  const state = readJson(paths.state, null)
  if (!state?.port) return null
  const version = await probeVersion(state.port)
  if (!version?.webSocketDebuggerUrl) return null
  const cdp = await CDP.connect(state.port)
  return { cdp, state, paths }
}

async function connectOrLaunch(settings) {
  const existing = await connectExisting(settings)
  if (existing) return existing
  const paths = pathsFor(settings)
  const found = resolveBrowser(settings.browser, {
    exe: settings.exe,
    env: settings.env,
    plat: settings.plat
  })
  const info = await ensureBrowser({
    browser: settings.browser,
    exe: found.exe,
    userData: paths.userData,
    statePath: paths.state,
    port: settings.config.port ?? 0,
    extensions: extensionPaths(settings.profile, settings.env, settings.plat),
    headless: settings.headless
  })
  const cdp = await CDP.connect(info.port)
  return { cdp, state: readJson(paths.state, info), paths }
}

/** activeTargetId written by releases before sessions existed. */
function legacyActiveId(paths) {
  return readJson(paths.state, {})?.activeTargetId ?? null
}

/** Tabs no session claims: opened by the user, by the mod, or by an older release. */
function unownedTabs(paths, tabs) {
  const owners = ownersByTarget(listSessions(paths))
  return tabs.filter((tab) => !owners.has(tab.id))
}

/**
 * The tab a command acts on. An explicitly named `--page` is honoured even across sessions;
 * without it resolution never leaves the caller's own tabs, and only falls back to a tab
 * nobody owns when the caller has none. It never silently retargets another client's tab.
 */
async function resolveTarget(cdp, paths, flags, session) {
  const tabs = await listTabs(cdp)
  if (flags.page) return resolveTab(tabs, flags.page)

  const mine = ownedTabs(session, tabs)
  if (mine.length) {
    const active = mine.find((tab) => tab.id === session.activeTargetId)
    if (active) return active
    if (mine.length === 1) return mine[0]
    const list = mine.map((tab) => `${tab.index} (${tab.id.slice(0, 8)})`).join(', ')
    throw new Error(
      `session "${session.session}" has ${mine.length} tabs and none is active; pass --page with one of: ${list}`
    )
  }

  const free = unownedTabs(paths, tabs)
  if (free.length) {
    const legacy = legacyActiveId(paths)
    return free.find((tab) => tab.id === legacy) ?? free[0]
  }

  const held = tabs.length
    ? `; ${tabs.length} tab${tabs.length === 1 ? ' belongs' : 's belong'} to another session, address one with --page <id>`
    : ''
  throw new Error(`session "${session.session}" owns no tabs; run \`herdr-browser open <url>\` first${held}`)
}

/**
 * The allowlist applies to every navigation this CLI performs, not just to `open`:
 * `network --url` is a navigation too, and a second entry point that forgets the check
 * is the same as having no check.
 */
function assertAllowedUrl(paths, sessionName, url) {
  if (!url) return
  const allowed = readSession(paths, sessionName).allowedOrigins ?? []
  if (allowed.length && !matchesOrigin(url, allowed)) {
    throw new Error(`blocked: ${url} is outside the session allowlist (run \`herdr-browser allow list\`)`)
  }
}

async function pageHandle(cdp, paths, flags) {
  const session = readSession(paths, flags.__session)
  const tab = await resolveTarget(cdp, paths, flags, session)
  const allowed = session.allowedOrigins ?? []
  if (allowed.length && !matchesOrigin(tab.url ?? '', allowed)) {
    throw new Error(`blocked: ${tab.url} is outside the session allowlist`)
  }
  const sessionId = await preparePage(cdp, tab.id, { cursor: flags.__cursor })
  const touched = touchTab(session, tab.id)
  if (touched !== session) writeSession(paths, touched)
  return { tab, sessionId }
}

/** Close the shared browser and forget every session: `stop --all`. */
async function closeBrowserEverywhere(paths) {
  const state = readJson(paths.state, null)
  if (state?.port) {
    try {
      const cdp = await CDP.connect(state.port)
      try {
        await cdp.send('Browser.close', {}, { timeoutMs: 5000 })
      } finally {
        cdp.close()
      }
    } catch {
      // Already gone, or it closed the socket before replying.
    }
  }
  rmSync(paths.state, { force: true })
  for (const session of listSessions(paths)) removeSession(paths, session.session)
}

const HELP = `herdr-browser — a real Chromium browser (Brave by default) with CDP control and Chrome extensions.

Usage:
  herdr-browser browsers
  herdr-browser open [url] [--new | --reuse] [--browser brave|chrome|edge|chromium] [--profile name] [--allow-origin <patterns>]
  herdr-browser allow [list|add <patterns>|remove <patterns>|clear]
  herdr-browser tabs [--json]
  herdr-browser tabs cleanup [--idle <ms|s|m>] [--all] [--dry-run] [--json]
  herdr-browser activate <id|index>
  herdr-browser close <id|index>
  herdr-browser status [--json]
  herdr-browser stop [--all]

Page control (agent):
  herdr-browser snapshot [--page id] [--json]
  herdr-browser click <ref> [--page id]
  herdr-browser fill <ref> <text> [--page id]
  herdr-browser type <text> [--page id]
  herdr-browser key <combo>            e.g. Enter, Tab, Control+A
  herdr-browser scroll <up|down> [px]
  herdr-browser get [--what url|title|text|html]
  herdr-browser eval <expression>
  herdr-browser shot [file.png]
  herdr-browser wait --for <selector|text|url>=<value> [--timeout <ms|s|m>] [--page id] [--json]
  herdr-browser handoff [--message <text>] [--for <condition>] [--timeout <ms|s|m>] [--json]
  herdr-browser network [--url <url>] [--idle <ms>] [--timeout <ms>] [--file <out.har>] [--json]

Challenges:
  After a navigation, open reports Cloudflare, Akamai, DataDome, PerimeterX, Imperva,
  AWS WAF and CAPTCHA interstitials, and waits --challenge-wait (15s by default,
  HERDR_BROWSER_CHALLENGE_WAIT_MS) for the browser to clear them. It never solves one:
  a surviving challenge is reported and left to a person.

Waiting and handoff:
  wait polls the page and prints "wait: ok after <ms>" when the condition holds; a
  selector only counts when the element is rendered. A timeout exits with code 1, so a
  caller can never mistake an unmet condition for success.
  handoff prints a message for the person and blocks until the page navigates or the
  --for condition holds: it is how a login, a 2FA prompt or a CAPTCHA is resolved in the
  dedicated profile. No card, no extension, no daemon - the same process keeps waiting.

Extensions and profile:
  herdr-browser extensions [list|add <dir>|remove <dir>]
  herdr-browser profile [path]
  herdr-browser profile import [--from brave|chrome|edge|chromium] [--force]
  herdr-browser login <url> [--profile name] [--timeout <ms|s|m>]

Login (portals that refuse an automated launch):
  login opens the profile's browser WITHOUT a debugging port so a person can sign in.
  The session lands in the profile; close the window and every later command on that
  profile starts authenticated. Use it when a site challenges the CDP-driven launch
  even after the human solves the visual step.

Session:
  Every invocation belongs to a session: --session <name> or HERDR_BROWSER_SESSION,
  "default" otherwise. A session owns the tabs it opens, and a command without --page
  only ever addresses its own tabs: two agents sharing one profile use
  --session agent-a / --session agent-b and never retarget each other. Tabs nobody
  claimed (opened by hand or by an older release) are still usable.
  stop closes only the caller's tabs; --all closes the shared browser.

  Tab TTL: tabs cleanup closes idle tabs (default 10m) for the caller; --all reaches
  every session. A tab nobody owns is never closed: it belongs to the human. Any command
  that resolves a tab resets its timer, so a tab in active use is never swept.

Global flags:
  --browser <name>   engine to launch (default: brave)
  --profile <name>   dedicated profile (default: default)
  --session <name>   client identity for tab ownership (default: default)
  --page <id>        address a tab explicitly, even one another session opened
  --exe <path>       explicit browser executable
  --no-cursor        do not draw the agent cursor inside the page
  --challenge-wait <ms|s|m>  how long to wait out a bot challenge after navigating (default: 15s)
  --allow-origin <patterns>  comma/space separated origins pinned to this session
  --json             machine-readable output where supported
  --headless         launch headless (useful for tests)
`

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (text) => stdout.write(`${text}\n`)
  const { flags, positional } = parseArgs(argv)
  const command = positional.shift()

  // --version wins over the help text: without this order it never printed a version.
  if (flags.version || command === '--version') {
    write(`herdr-browser ${PACKAGE_VERSION}`)
    return 0
  }
  if (flags.help || command === 'help' || command === undefined) {
    stdout.write(HELP)
    return 0
  }

  const settings = resolveSettings(flags)
  flags.__cursor = settings.cursor
  flags.__session = settings.session

  try {
    switch (command) {
      case 'browsers': {
        const found = detectBrowsers({ env: settings.env, plat: settings.plat })
        if (!found.length) {
          write('no Chromium browser found (brave, chrome, edge, chromium)')
          return 0
        }
        for (const item of found) write(`${item.name}\t${item.exe}`)
        return 0
      }

      case 'open': {
        const url = positional[0]
        const allowOriginFlag = flags['allow-origin']
        const parsedAllow = allowOriginFlag ? parseAllowlist(allowOriginFlag) : []
        const { cdp, paths } = await connectOrLaunch(settings)
        try {
          const session = readSession(paths, settings.session)
          const effectiveAllow = parsedAllow.length
            ? setAllowlist(session, [...(session.allowedOrigins ?? []), ...parsedAllow]).allowedOrigins
            : (session.allowedOrigins ?? [])
          // Refuse before touching the browser: a denied open must not leave a tab behind.
          assertAllowedUrl(paths, settings.session, url)
          const tabs = await listTabs(cdp)
          const mine = ownedTabs(session, tabs)
          let targetId
          if (flags.new) {
            targetId = await openTab(cdp, 'about:blank')
          } else if (mine.length) {
            // Reuse this session's own tab. Never another client's.
            const active = mine.find((tab) => tab.id === session.activeTargetId)
            targetId = (active ?? mine[0]).id
          } else if (flags.reuse) {
            const legacy = legacyActiveId(paths)
            const free = unownedTabs(paths, tabs)
            const chosen = free.find((tab) => tab.id === legacy) ?? free[0]
            if (!chosen) {
              throw new Error(`session "${session.session}" has no tab to reuse; drop --reuse to open a new one`)
            }
            targetId = chosen.id
          } else {
            targetId = await openTab(cdp, 'about:blank')
          }
          const sessionId = await preparePage(cdp, targetId, { cursor: settings.cursor })
          let navigation = { challenge: null, cleared: false, waitedMs: 0 }
          if (url) {
            navigation = await navigate(cdp, sessionId, url, { challengeWaitMs: settings.challengeWait })
          }
          if (url && effectiveAllow.length) {
            // A redirect is a navigation too: leaving the list is refused, not noted for later.
            const landed = (await listTabs(cdp)).find((item) => item.id === targetId)?.url ?? ''
            if (!matchesOrigin(landed, effectiveAllow)) {
              await navigate(cdp, sessionId, 'about:blank', { challengeWaitMs: null })
              throw new Error(`blocked: ${landed} is outside the session allowlist (redirected out of it)`)
            }
          }
          await activateTab(cdp, targetId)
          const [tab] = (await listTabs(cdp)).filter((item) => item.id === targetId)
          writeSession(paths, setAllowlist(recordTab(session, targetId, { title: tab?.title, url: tab?.url }), effectiveAllow))
          const challenge = navigation.challenge
            ? {
                kind: navigation.challenge.kind,
                signal: navigation.challenge.signal,
                cleared: navigation.cleared,
                waitedMs: navigation.waitedMs
              }
            : null
          if (flags.json) {
            write(
              JSON.stringify({
                id: targetId,
                url: tab?.url ?? url ?? 'about:blank',
                title: tab?.title,
                session: session.session,
                challenge
              })
            )
          } else {
            write(`open: ${tab?.title ?? ''}`)
            write(`url:  ${tab?.url ?? url ?? 'about:blank'}`)
            write(`tab:  ${targetId}`)
            write(`session: ${session.session}`)
            if (challenge) {
              const state = navigation.cleared
                ? `cleared after ${navigation.waitedMs}ms`
                : navigation.waitedMs === 0
                  ? 'reported without waiting'
                  : `still there after ${navigation.waitedMs}ms; run \`herdr-browser handoff\` or solve it by hand`
              write(`challenge: ${challenge.kind} (${challenge.signal}) — ${state}`)
            }
          }
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'tabs': {
        if (positional[0] === 'cleanup') {
          const idleMs = parseDuration(flags.idle, 10 * 60 * 1000)
          if (idleMs < 1000) throw new Error('--idle must be at least 1000ms (a zero budget would close everything)')
          const dryRun = !!flags['dry-run']
          const json = !!flags.json
          const all = !!flags.all
          const connection = await connectExisting(settings)
          if (!connection) throw new Error('browser is not running; run `herdr-browser open <url>` first')
          const { cdp, paths } = connection
          try {
            const liveTabs = await listTabs(cdp)
            const sessions = all ? listSessions(paths) : [readSession(paths, settings.session)]
            const now = Date.now()
            const closedIds = new Set()
            const closed = []
            const pendingWrites = []
            for (const session of sessions) {
              const eligible = idleTabs(session, liveTabs, { idleMs, now })
                .map((tab) => tab.id)
                .filter((id) => !closedIds.has(id))
              if (!eligible.length) continue
              // prune from this session file
              let next = session
              for (const id of eligible) {
                const live = liveTabs.find((tab) => tab.id === id)
                closedIds.add(id)
                closed.push({ id, url: live?.url ?? null, session: session.session, idleMs })
                next = forgetTab(next, id)
              }
              pendingWrites.push(next)
            }
            // Close first, then forget. Pruning before closing leaves an orphan nobody owns,
            // and an unowned tab is never swept again by design.
            if (!dryRun) {
              for (const entry of closed) {
                try {
                  await closeTab(cdp, entry.id)
                } catch {
                  // Already gone: forgetting it is still the right outcome.
                }
              }
              for (const next of pendingWrites) writeSession(paths, next)
            }
            const kept = dryRun ? liveTabs.length - closed.length : (await listTabs(cdp)).length
            if (json) {
              write(JSON.stringify({ closed, kept }))
            } else if (dryRun) {
              if (closed.length === 0) write('would close: 0 tab(s)')
              else {
                write(`would close: ${closed.length} tab(s)`)
                for (const entry of closed) write(`would close: ${entry.id}	${entry.url ?? ''}`)
              }
            } else {
              write(`closed: ${closed.length} tab(s)`)
            }
          } finally {
            cdp.close()
          }
          return 0
        }
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running; run `herdr-browser open <url>` first')
        const { cdp, paths } = connection
        try {
          const sessions = listSessions(paths)
          const tabs = annotateTabs(await listTabs(cdp), { current: settings.session, sessions })
          if (flags.json) write(JSON.stringify(tabs, null, 2))
          else write(renderTabs(tabs, { current: settings.session }))
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'activate': {
        const selector = positional[0]
        if (!selector) throw new Error('usage: herdr-browser activate <id|index>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const tab = resolveTab(await listTabs(cdp), selector)
          await activateTab(cdp, tab.id)
          const owner = ownersByTarget(listSessions(paths)).get(tab.id)
          if (!owner || owner === settings.session) {
            writeSession(paths, recordTab(readSession(paths, settings.session), tab.id, { title: tab.title, url: tab.url }))
          }
          write(`activated: ${tab.title}\n${tab.url}`)
          if (owner && owner !== settings.session) write(`session: ${owner}`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'close': {
        const selector = positional[0]
        if (!selector) throw new Error('usage: herdr-browser close <id|index>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const tab = resolveTab(await listTabs(cdp), selector)
          await closeTab(cdp, tab.id)
          const session = readSession(paths, settings.session)
          if (hasTab(session, tab.id)) writeSession(paths, forgetTab(session, tab.id))
          write(`closed: ${tab.title}`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'status': {
        const paths = pathsFor(settings)
        const state = readJson(paths.state, null)
        if (!state) {
          write(flags.json ? JSON.stringify({ running: false }) : 'browser: not running')
          return 0
        }
        const version = await probeVersion(state.port)
        if (!version) {
          write(flags.json ? JSON.stringify({ running: false, state }) : 'browser: not running')
          return 0
        }
        const cdp = await CDP.connect(state.port)
        try {
          const sessions = listSessions(paths)
          const tabs = annotateTabs(await listTabs(cdp), { current: settings.session, sessions })
          if (flags.json) {
            write(
              JSON.stringify({ running: true, version, state, session: settings.session, sessions, tabs }, null, 2)
            )
          } else {
            write(renderStatus({ state, version, tabs, sessions, session: settings.session }))
          }
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'stop': {
        const paths = pathsFor(settings)
        const name = settings.session
        if (flags.all) {
          await closeBrowserEverywhere(paths)
          write('browser: stopped')
          return 0
        }

        const connection = await connectExisting(settings)
        if (!connection) {
          removeSession(paths, name)
          write(`session: ${name} stopped`)
          write('closed: 0 tabs')
          write('browser: not running')
          return 0
        }

        const { cdp } = connection
        let closed = 0
        let remaining = []
        try {
          for (const tab of ownedTabs(readSession(paths, name), await listTabs(cdp))) {
            await closeTab(cdp, tab.id)
            closed += 1
          }
          try {
            remaining = await listTabs(cdp)
          } catch {
            // The browser went away with its last page.
            remaining = []
          }
          removeSession(paths, name)
          if (!remaining.length) {
            // Nothing is open in this profile any more: the pre-session contract applies.
            await closeBrowserEverywhere(paths)
            write('browser: stopped')
            return 0
          }
        } finally {
          cdp.close()
        }
        write(`session: ${name} stopped`)
        write(`closed: ${closed} tab${closed === 1 ? '' : 's'}`)
        write(`browser: running (${remaining.length} tab${remaining.length === 1 ? '' : 's'} left)`)
        return 0
      }

      case 'wait': {
        const condition = parseWaitSpec(flags.for ?? positional[0])
        const timeoutMs = parseDuration(flags.timeout, 30_000)
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          const result = await waitForCondition(cdp, sessionId, condition, {
            timeoutMs,
            evaluate: (expression) => evalInPage(cdp, sessionId, expression)
          })
          if (flags.json) {
            write(JSON.stringify(result))
          } else if (result.ok) {
            write(`wait: ok after ${result.waitedMs}ms`)
            write(`url:  ${result.url ?? ''}`)
          } else {
            stderr.write(
              `herdr-browser: wait timed out after ${timeoutMs}ms (${describeCondition(condition)}: ${result.detail ?? 'no answer'})\n`
            )
          }
          return result.ok ? 0 : 1
        } finally {
          cdp.close()
        }
      }

      case 'handoff': {
        const condition = flags.for ? parseWaitSpec(flags.for) : null
        const timeoutMs = parseDuration(flags.timeout, 300_000)
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { tab, sessionId } = await pageHandle(cdp, paths, flags)
          const message =
            typeof flags.message === 'string'
              ? flags.message
              : 'do the human step in the browser (login, 2FA, confirmation)'
          if (!flags.json) {
            write(`human: ${message}`)
            write(`waiting: ${describeCondition(condition)}`)
            write(`timeout: ${Math.round(timeoutMs / 1000)}s`)
          }
          const result = await handoff(cdp, sessionId, {
            condition,
            message,
            timeoutMs,
            evaluate: (expression) => evalInPage(cdp, sessionId, expression)
          })
          if (flags.json) {
            write(JSON.stringify({ tab, ...result }))
          } else if (result.ok) {
            write(`resumed after ${result.waitedMs}ms`)
            write(`url:  ${result.url ?? ''}`)
          } else {
            stderr.write(
              `herdr-browser: handoff timed out after ${timeoutMs}ms (${result.detail ?? 'no answer'})\n`
            )
          }
          return result.ok ? 0 : 1
        } finally {
          cdp.close()
        }
      }

      case 'snapshot': {
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { tab, sessionId } = await pageHandle(cdp, paths, flags)
          const data = await snapshot(cdp, sessionId, tab.id)
          if (flags.json) write(JSON.stringify({ tab, ...data }, null, 2))
          else write(renderSnapshot(data))
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'click': {
        const ref = positional[0]
        if (!ref) throw new Error('usage: herdr-browser click <ref>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { tab, sessionId } = await pageHandle(cdp, paths, flags)
          const point = await click(cdp, sessionId, tab.id, ref)
          write(`clicked ${ref} at ${Math.round(point.x)},${Math.round(point.y)}`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'fill': {
        const [ref, ...rest] = positional
        if (!ref || !rest.length) throw new Error('usage: herdr-browser fill <ref> <text>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { tab, sessionId } = await pageHandle(cdp, paths, flags)
          const value = await fill(cdp, sessionId, tab.id, ref, rest.join(' '))
          write(`filled ${ref}: ${JSON.stringify(value)}`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'type': {
        const text = positional.join(' ')
        if (!text) throw new Error('usage: herdr-browser type <text>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          await typeText(cdp, sessionId, text)
          write(`typed ${text.length} characters`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'key': {
        const combo = positional.join('+')
        if (!combo) throw new Error('usage: herdr-browser key <combo>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          await pressKey(cdp, sessionId, combo)
          write(`key: ${combo}`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'scroll': {
        const direction = positional[0] ?? 'down'
        if (!['up', 'down'].includes(direction)) throw new Error('usage: herdr-browser scroll <up|down> [px]')
        const amount = Number.parseInt(positional[1] ?? '600', 10)
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('scroll amount must be a positive number')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          await scroll(cdp, sessionId, direction === 'down' ? amount : -amount)
          write(`scrolled ${direction} ${amount}px`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'get': {
        const what = flags.what ?? 'text'
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          const value = await readPage(cdp, sessionId, what)
          write(typeof value === 'string' ? value : JSON.stringify(value))
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'eval': {
        const expression = positional.join(' ')
        if (!expression) throw new Error('usage: herdr-browser eval <expression>')
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          const value = await evalInPage(cdp, sessionId, expression)
          write(typeof value === 'string' ? value : JSON.stringify(value))
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'shot': {
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { sessionId } = await pageHandle(cdp, paths, flags)
          const buffer = await screenshot(cdp, sessionId)
          const file = resolve(positional[0] ?? `herdr-browser-shot-${Date.now()}.png`)
          writeFileSync(file, buffer)
          write(`saved: ${file}`)
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'network': {
        const connection = await connectExisting(settings)
        if (!connection) throw new Error('browser is not running')
        const { cdp, paths } = connection
        try {
          const { tab, sessionId } = await pageHandle(cdp, paths, flags)
          assertAllowedUrl(paths, settings.session, flags.url)
          const idleMs = parseDuration(flags.idle, 800)
          const timeoutMs = parseDuration(flags.timeout, 30_000)
          if (idleMs <= 0) throw new Error('--idle must be greater than zero')
          if (timeoutMs <= 0) throw new Error('--timeout must be greater than zero')
          const url = flags.url
          const navigateFn = url ? (u) => navigate(cdp, sessionId, u, { challengeWaitMs: null }) : undefined
          const result = await captureNetwork(cdp, sessionId, {
            navigate: navigateFn,
            url,
            idleMs,
            timeoutMs
          })
          if (result.entries.length === 0) {
            stderr.write('herdr-browser: no network requests captured\n')
            return 1
          }
          const har = buildHar(result.entries, { version: PACKAGE_VERSION })
          const outFile = resolve(flags.file ?? `herdr-browser-network-${Date.now()}.har`)
          writeFileSync(outFile, JSON.stringify(har, null, 2))
          const redacted = har.log.entries.flatMap((e) => [...e.request.headers, ...e.response.headers]).filter((h) => h.value === '<redacted>').length
          const outputUrl = url ?? tab?.url ?? ''
          if (flags.json) {
            write(JSON.stringify({ file: outFile, entries: result.entries.length, redacted, idle: result.idle, waitedMs: result.waitedMs, url: outputUrl }))
          } else {
            write(`har: ${outFile}`)
            write(`entries: ${result.entries.length}`)
            write(`redacted: ${redacted} headers`)
          }
          return 0
        } finally {
          cdp.close()
        }
      }

      case 'login': {
        const url = positional[0]
        if (!url) throw new Error('usage: herdr-browser login <url> [--profile name] [--timeout <ms|s|m>]')
        const paths = pathsFor(settings)
        const found = resolveBrowser(settings.browser, {
          exe: settings.exe,
          env: settings.env,
          plat: settings.plat
        })
        ensureDir(paths.userData)
        launchPlain({ exe: found.exe, userData: paths.userData, url })
        write(`browser: ${settings.browser} (no debugging port)`)
        write(`profile: ${paths.root}`)
        write('human: sign in in that window; close it when you are done and this command continues')
        if (!listExtensions(settings.profile, settings.env, settings.plat).length) {
          // A fresh profile has nothing of the user's: say it before they hunt for a password
          // manager that is not installed.
          write('tip: this profile has no extensions or cookies of yours yet')
          write('     profile import --from brave  (your browser must be closed) or extensions add <dir>')
        }
        const timeoutMs = parseDuration(flags.timeout, 900_000)
        const result = await waitForProfileRelease(paths.userData, { timeoutMs })
        if (!result.released) {
          throw new Error(`the window is still open after ${Math.round(result.waitedMs / 1000)}s; close it to keep the session`)
        }
        write('session: saved')
        write(`next: herdr-browser --profile ${settings.profile} open <url>`)
        return 0
      }

      case 'extensions': {
        const action = positional[0] ?? 'list'
        if (action === 'list') {
          const entries = listExtensions(settings.profile, settings.env, settings.plat)
          if (flags.json) write(JSON.stringify(entries, null, 2))
          else write(renderExtensions(entries))
          return 0
        }
        if (action === 'add') {
          const dir = positional[1]
          if (!dir) throw new Error('usage: herdr-browser extensions add <dir>')
          const entry = addExtension(settings.profile, dir, settings.env, settings.plat)
          write(`added: ${entry.name ?? entry.path}`)
          const connection = await connectExisting(settings)
          if (connection) {
            try {
              await connection.cdp.send('Extensions.loadUnpacked', { path: entry.path }, { timeoutMs: 10_000 })
              write('loaded into the running browser')
            } catch (error) {
              write(`registered; restart the browser to load it (${error.message})`)
            } finally {
              connection.cdp.close()
            }
          } else {
            write('registered; it will load on the next launch')
          }
          return 0
        }
        if (action === 'remove') {
          const dir = positional[1]
          if (!dir) throw new Error('usage: herdr-browser extensions remove <dir>')
          const removed = removeExtension(settings.profile, dir, settings.env, settings.plat)
          write(removed ? 'removed' : 'not registered')
          return 0
        }
        throw new Error(`unknown extensions action "${action}" (use list, add or remove)`)
      }

      case 'profile': {
        const action = positional[0]
        if (!action || action === 'path') {
          const summary = profileSummary(settings.profile, settings.env, settings.plat)
          if (flags.json) write(JSON.stringify(summary, null, 2))
          else {
            write(`profile: ${summary.profile}`)
            write(`user data: ${summary.userData}`)
            write(`exists: ${summary.exists}`)
          }
          return 0
        }
        if (action === 'import') {
          const from = flags.from ?? 'brave'
          const result = importProfile({
            from,
            profile: settings.profile,
            force: Boolean(flags.force),
            env: settings.env,
            plat: settings.plat
          })
          if (flags.json) {
            write(JSON.stringify(result, null, 2))
          } else {
            write(`imported from: ${result.source}`)
            write(`into: ${result.target}`)
            write(`copied: ${result.copied.join(', ') || 'nothing'}`)
            write(`extensions: ${result.extensions.registered}/${result.extensions.found} registered`)
          }
          return 0
        }
        throw new Error(`unknown profile action "${action}" (use path or import)`)
      }

      case 'check': {
        const paths = pathsFor(settings)
        const found = resolveBrowser(settings.browser, {
          exe: settings.exe,
          env: settings.env,
          plat: settings.plat
        })
        const connection = await connectExisting(settings)
        write(`browser: ${settings.browser}`)
        write(`exe: ${found.exe}`)
        write(`profile: ${paths.root}`)
        write(`running: ${connection ? 'yes' : 'no'}`)
        write(`extensions: ${extensionPaths(settings.profile, settings.env, settings.plat).length}`)
        if (connection) connection.cdp.close()
        return 0
      }

      case 'allow': {
        const action = positional[0] ?? 'list'
        const paths = pathsFor(settings)
        if (action === 'list') {
          const session = readSession(paths, settings.session)
          const list = session.allowedOrigins ?? []
          if (!list.length) {
            write('allowlist: none (no restriction)')
          } else {
            write(`allowlist: ${list.join(', ')}`)
          }
          return 0
        }
        if (action === 'add') {
          const patterns = parseAllowlist(positional.slice(1).join(' '))
          if (!patterns.length) throw new Error('usage: herdr-browser allow add <patterns>')
          const session = readSession(paths, settings.session)
          const merged = setAllowlist(session, [...(session.allowedOrigins ?? []), ...patterns]).allowedOrigins
          writeSession(paths, setAllowlist(session, merged))
          write(`allowlist: ${merged.join(', ')}`)
          return 0
        }
        if (action === 'remove') {
          const patterns = parseAllowlist(positional.slice(1).join(' '))
          if (!patterns.length) throw new Error('usage: herdr-browser allow remove <patterns>')
          const session = readSession(paths, settings.session)
          const current = session.allowedOrigins ?? []
          const removeSet = new Set(patterns)
          const next = current.filter((p) => !removeSet.has(p))
          writeSession(paths, setAllowlist(session, next))
          if (!next.length) write('allowlist: none (no restriction)')
          else write(`allowlist: ${next.join(', ')}`)
          return 0
        }
        if (action === 'clear') {
          const session = readSession(paths, settings.session)
          writeSession(paths, setAllowlist(session, []))
          write('allowlist: none (no restriction)')
          return 0
        }
        throw new Error(`unknown allow action "${action}" (use list, add, remove or clear)`)
      }

      default:
        stderr.write(`herdr-browser: unknown command "${command}"\n\n`)
        stdout.write(HELP)
        return 1
    }
  } catch (error) {
    stderr.write(`herdr-browser: ${error.message}\n`)
    return 1
  }
}

export function hasBrowserFiles(profile, env = process.env, plat = process.platform) {
  const paths = profilePaths(profile, env, plat)
  return existsSync(paths.state)
}
