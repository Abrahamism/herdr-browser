import { existsSync, rmSync, writeFileSync } from 'node:fs'
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
import { loadConfig, profilePaths, readJson, writeJson } from './home.mjs'
import { ensureBrowser, probeVersion } from './launch.mjs'
import { importProfile, profileSummary } from './profile.mjs'
import { renderExtensions, renderSnapshot, renderStatus, renderTabs } from './render.mjs'
import { activateTab, closeTab, listTabs, openTab, resolveTab } from './tabs.mjs'

const BOOLEAN_FLAGS = new Set([
  'json',
  'new',
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
    const [rawKey, inline] = arg.slice(2).split('=')
    const key = rawKey
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

function saveActive(paths, targetId) {
  const state = readJson(paths.state, {})
  writeJson(paths.state, { ...state, activeTargetId: targetId })
}

async function activeTab(cdp, paths, flags) {
  const tabs = await listTabs(cdp)
  if (flags.page) return resolveTab(tabs, flags.page)
  const state = readJson(paths.state, {})
  if (state?.activeTargetId && tabs.some((tab) => tab.id === state.activeTargetId)) {
    return tabs.find((tab) => tab.id === state.activeTargetId)
  }
  return resolveTab(tabs)
}

async function pageHandle(cdp, paths, flags) {
  const tab = await activeTab(cdp, paths, flags)
  const sessionId = await preparePage(cdp, tab.id, { cursor: flags.__cursor })
  return { tab, sessionId }
}

const HELP = `herdr-browser — a real Chromium browser (Brave by default) with CDP control and Chrome extensions.

Usage:
  herdr-browser browsers
  herdr-browser open [url] [--new] [--browser brave|chrome|edge|chromium] [--profile name]
  herdr-browser tabs [--json]
  herdr-browser activate <id|index>
  herdr-browser close <id|index>
  herdr-browser status [--json]
  herdr-browser stop

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

Extensions and profile:
  herdr-browser extensions [list|add <dir>|remove <dir>]
  herdr-browser profile [path]
  herdr-browser profile import [--from brave|chrome|edge|chromium] [--force]

Global flags:
  --browser <name>   engine to launch (default: brave)
  --profile <name>   dedicated profile (default: default)
  --exe <path>       explicit browser executable
  --no-cursor        do not draw the agent cursor inside the page
  --json             machine-readable output where supported
  --headless         launch headless (useful for tests)
`

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (text) => stdout.write(`${text}\n`)
  const { flags, positional } = parseArgs(argv)
  const command = positional.shift()

  if (flags.help || command === 'help' || command === undefined) {
    stdout.write(HELP)
    return 0
  }
  if (flags.version || command === '--version') {
    write('herdr-browser 0.1.0')
    return 0
  }

  const settings = resolveSettings(flags)
  flags.__cursor = settings.cursor

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
          const tabs = await listTabs(cdp)
          let targetId
          if (!tabs.length || flags.new || !url) {
            targetId = tabs.length && !flags.new ? tabs[0].id : await openTab(cdp, 'about:blank')
          } else {
            targetId = tabs[0].id
          }
          const sessionId = await preparePage(cdp, targetId, { cursor: settings.cursor })
          if (url) await navigate(cdp, sessionId, url)
          await activateTab(cdp, targetId)
          saveActive(paths, targetId)
          const [tab] = (await listTabs(cdp)).filter((item) => item.id === targetId)
          if (flags.json) {
            write(JSON.stringify({ id: targetId, url: tab?.url ?? url ?? 'about:blank', title: tab?.title }))
          } else {
            write(`open: ${tab?.title ?? ''}`)
            write(`url:  ${tab?.url ?? url ?? 'about:blank'}`)
            write(`tab:  ${targetId}`)
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
          const tabs = await listTabs(cdp)
          const state = readJson(paths.state, {})
          if (flags.json) write(JSON.stringify(tabs, null, 2))
          else write(renderTabs(tabs, { activeId: state.activeTargetId }))
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
          saveActive(paths, tab.id)
          write(`activated: ${tab.title}\n${tab.url}`)
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
          const state = readJson(paths.state, {})
          if (state.activeTargetId === tab.id) saveActive(paths, '')
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
          const tabs = await listTabs(cdp)
          if (flags.json) write(JSON.stringify({ running: true, version, state, tabs }, null, 2))
          else write(renderStatus({ state, version, tabs }))
        } finally {
          cdp.close()
        }
        return 0
      }

      case 'stop': {
        const connection = await connectExisting(settings)
        const paths = pathsFor(settings)
        if (connection) {
          try {
            await connection.cdp.send('Browser.close', {}, { timeoutMs: 5000 })
          } catch {
            // The browser may close the socket before replying.
          }
          connection.cdp.close()
        }
        rmSync(paths.state, { force: true })
        write('browser: stopped')
        return 0
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
