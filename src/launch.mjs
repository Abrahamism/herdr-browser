import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, readJson, writeJson } from './home.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Browser launch arguments. `port: 0` makes Chromium pick a free port and write it
 * to `<user-data-dir>/DevToolsActivePort`.
 */
export function launchArgs({ userDataDir, port = 0, extensions = [], headless = false }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    // Required by the CDP Extensions domain on Chromium 136+; ignored elsewhere.
    '--enable-unsafe-extension-debugging'
  ]
  if (headless) args.push('--headless=new')
  if (extensions.length) {
    // Branded Chrome disabled this switch in 137; the feature flag keeps older
    // builds working and is ignored on builds that removed the switch entirely.
    args.push('--disable-features=DisableLoadExtensionCommandLineSwitch')
    args.push(`--load-extension=${extensions.join(',')}`)
  }
  return args
}

export function parseDevToolsActivePort(contents) {
  const [portLine, wsPath = ''] = String(contents).trim().split(/\r?\n/)
  const port = Number.parseInt(portLine, 10)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid DevToolsActivePort contents: ${JSON.stringify(contents)}`)
  }
  return { port, wsPath: wsPath.trim() }
}

export function readDevToolsActivePort(userDataDir) {
  try {
    return parseDevToolsActivePort(readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export async function probeVersion(port, { timeoutMs = 2000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function waitForBrowser(port, { timeoutMs, fetchImpl }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const version = await probeVersion(port, { fetchImpl })
    if (version?.webSocketDebuggerUrl) return version
    await sleep(150)
  }
  return null
}

/**
 * Reuse the running browser for this profile, or launch it.
 * Returns `{ browser, exe, port, wsUrl, pid, reused }`.
 */
export async function ensureBrowser({
  browser,
  exe,
  userData,
  statePath,
  port: requestedPort = 0,
  extensions = [],
  headless = false,
  timeoutMs = 30_000,
  fetchImpl = fetch,
  spawnImpl = spawn,
  log = () => {}
}) {
  ensureDir(userData)
  const state = readJson(statePath, null)

  if (state?.port) {
    const version = await probeVersion(state.port, { fetchImpl })
    if (version?.webSocketDebuggerUrl) {
      return {
        browser: state.browser ?? browser,
        exe: state.exe ?? exe,
        port: state.port,
        wsUrl: version.webSocketDebuggerUrl,
        pid: state.pid ?? null,
        reused: true
      }
    }
  }

  const args = launchArgs({ userDataDir: userData, port: requestedPort, extensions, headless })
  log(`launching ${exe} ${args.join(' ')}`)
  const child = spawnImpl(exe, args, { detached: true, stdio: 'ignore' })
  let exit = null
  child.once('exit', (code, signal) => {
    exit = { code, signal }
  })
  child.unref()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(
        `${browser} exited while starting (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'null'}). ` +
          `Is another ${browser} already using ${userData}?`
      )
    }
    const active = readDevToolsActivePort(userData)
    if (active) {
      const version = await waitForBrowser(active.port, { timeoutMs: 3000, fetchImpl })
      if (version?.webSocketDebuggerUrl) {
        const next = {
          browser,
          exe,
          pid: child.pid ?? null,
          port: active.port,
          wsUrl: version.webSocketDebuggerUrl,
          userData,
          startedAt: new Date().toISOString()
        }
        writeJson(statePath, next)
        return { ...next, reused: false }
      }
    }
    await sleep(150)
  }

  try {
    if (child.pid) process.kill(child.pid, 'SIGTERM')
  } catch {
    // The process may already be gone; nothing to clean up.
  }
  throw new Error(
    `${browser} did not expose a DevTools endpoint within ${Math.round(timeoutMs / 1000)}s. ` +
      `Check whether the profile at ${userData} is locked by another window.`
  )
}
