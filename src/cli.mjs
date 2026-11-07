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
import { loadConfig, profilePaths, readJson } from './home.mjs'
import { ensureBrowser, probeVersion } from './launch.mjs'
import { importProfile, profileSummary } from './profile.mjs'
import { renderExtensions, renderSnapshot, renderStatus, renderTabs } from './render.mjs'
import {
  annotateTabs,
  forgetTab,
  hasTab,
  listSessions,
  ownedTabs,
  ownersByTarget,
  readSession,
  recordTab,
  removeSession,
  resolveSession,
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

async function pageHandle(cdp, paths, flags) {
  const tab = await resolveTarget(cdp, paths, flags, readSession(paths, flags.__session))
  const sessionId = await preparePage(cdp, tab.id, { cursor: flags.__cursor })
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
  herdr-browser open [url] [--new | --reuse] [--browser brave|chrome|edge|chromium] [--profile name]
  herdr-browser tabs [--json]
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

Session:
  Every invocation belongs to a session: --session <name> or HERDR_BROWSER_SESSION,
  "default" otherwise. A session owns the tabs it opens, and a command without --page
  only ever addresses its own tabs: two agents sharing one profile use
  --session agent-a / --session agent-b and never retarget each other. Tabs nobody
  claimed (opened by hand or by an older release) are still usable.
  stop closes only the caller's tabs; --all closes the shared browser.

Global flags:
  --browser <name>   engine to launch (default: brave)
  --profile <name>   dedicated profile (default: default)
  --session <name>   client identity for tab ownership (default: default)
  --page <id>        address a tab explicitly, even one another session opened
  --exe <path>       explicit browser executable
  --no-cursor        do not draw the agent cursor inside the page
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
        const { cdp, paths } = await connectOrLaunch(settings)
        try {
          const session = readSession(paths, settings.session)
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
          if (url) await navigate(cdp, sessionId, url)
          await activateTab(cdp, targetId)
          const [tab] = (await listTabs(cdp)).filter((item) => item.id === targetId)
          writeSession(paths, recordTab(session, targetId, { title: tab?.title, url: tab?.url }))
          if (flags.json) {
            write(
              JSON.stringify({
                id: targetId,
                url: tab?.url ?? url ?? 'about:blank',
                title: tab?.title,
                session: session.session
              })
            )
          } else {
            write(`open: ${tab?.title ?? ''}`)
            write(`url:  ${tab?.url ?? url ?? 'about:blank'}`)
            write(`tab:  ${targetId}`)
            write(`session: ${session.session}`)
          }
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'tabs': {
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
