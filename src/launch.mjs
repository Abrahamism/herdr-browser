import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureDir, readJson, writeJson } from './home.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function normalizeDir(dir, plat) {
  const absolute = resolve(dir)
  return plat === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Whether a remembered state.json speaks for this profile. Chromium recycles ports, so two
 * profiles can be remembered on the same one: adopting that state would attach the command
 * to the other profile's window and its cookies.
 */
export function stateOwnsProfile(state, userData, plat = process.platform) {
  if (!state?.port) return false
  // States written before the root was recorded prove nothing; the port stays the only hint.
  if (!state.userData) return true
  return normalizeDir(state.userData, plat) === normalizeDir(userData, plat)
}

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

/**
 * Args for a browser the human uses: no debugging port, so nothing can attach to it.
 * A session established here is written to the profile and survives, which is the only
 * way past a bot challenge that refuses a CDP-driven launch.
 */
export function plainArgs({ userDataDir, url }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]
  if (url) args.push(url)
  return args
}

export function launchPlain({ exe, userData, url, spawnImpl = spawn }) {
  ensureDir(userData)
  return spawnImpl(exe, plainArgs({ userDataDir: userData, url }), { stdio: 'ignore' })
}

/** Chromium's profile lock: `lockfile` on Windows, `SingletonLock` elsewhere. */
export function profileLockFile(userData) {
  for (const name of ['lockfile', 'SingletonLock']) {
    const file = join(userData, name)
    if (existsSync(file)) return file
  }
  return null
}

/**
 * Wait for the human to close the window. The lock is the signal, not the child
 * process: a browser can hand its window to another process and still hold the profile.
 */
export async function waitForProfileRelease(
  userData,
  { timeoutMs = 900_000, appearedMs = 20_000, intervalMs = 500 } = {}
) {
  const started = Date.now()
  let appeared = false
  for (;;) {
    const elapsed = Date.now() - started
    if (profileLockFile(userData)) {
      appeared = true
    } else if (appeared) {
      return { released: true, waitedMs: elapsed }
    } else if (elapsed >= appearedMs) {
      // It started and finished without ever locking: treat it as closed.
      return { released: true, waitedMs: elapsed }
    }
    if (elapsed >= timeoutMs) return { released: false, waitedMs: elapsed }
    await sleep(intervalMs)
  }
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
  log = () => {},
  plat = process.platform
}) {
  ensureDir(userData)
  const state = readJson(statePath, null)

  if (stateOwnsProfile(state, userData, plat)) {
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
