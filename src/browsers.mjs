import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'

export const BROWSER_NAMES = ['brave', 'chrome', 'edge', 'chromium']

const WINDOWS = {
  brave: [
    ['LOCALAPPDATA', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['PROGRAMFILES', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['PROGRAMFILES(X86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']
  ],
  chrome: [
    ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe']
  ],
  edge: [
    ['PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe']
  ],
  chromium: [
    ['PROGRAMFILES', 'Chromium', 'Application', 'chrome.exe'],
    ['LOCALAPPDATA', 'Chromium', 'Application', 'chrome.exe']
  ]
}

const MACOS = {
  brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium']
}

const LINUX = {
  brave: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave', '/snap/bin/brave'],
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
  chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
}

/**
 * Absolute candidate paths for a browser, most preferred first.
 * Kept pure so tests can assert it without a filesystem.
 */
export function candidates(name, { env = process.env, plat = platform() } = {}) {
  if (!BROWSER_NAMES.includes(name)) {
    throw new Error(`unknown browser "${name}" (expected one of ${BROWSER_NAMES.join(', ')})`)
  }
  if (plat === 'win32') {
    return WINDOWS[name]
      .map((parts) => {
        const [root, ...rest] = parts
        const base = env[root]
        return base ? join(base, ...rest) : null
      })
      .filter(Boolean)
  }
  if (plat === 'darwin') return MACOS[name]
  return LINUX[name]
}

export function findBrowser(name, { env = process.env, plat = platform(), exists = existsSync } = {}) {
  const tried = candidates(name, { env, plat })
  const exe = tried.find((candidate) => exists(candidate))
  return exe ? { name, exe } : null
}

export function detectBrowsers(options = {}) {
  return BROWSER_NAMES.map((name) => findBrowser(name, options)).filter(Boolean)
}

/**
 * Resolve the executable from an explicit path, a configured path, or auto-detection.
 * The error names every path tried so a failed launch is actionable.
 */
export function resolveBrowser(name, { exe, env = process.env, plat = platform(), exists = existsSync } = {}) {
  if (exe) {
    if (!exists(exe)) throw new Error(`browser executable not found: ${exe}`)
    return { name, exe }
  }
  const found = findBrowser(name, { env, plat, exists })
  if (found) return found
  const tried = candidates(name, { env, plat })
  throw new Error(
    `could not find ${name}. Tried:\n${tried.map((path) => `  - ${path}`).join('\n')}\n` +
      `Pass --exe <path> or set "exe" in the config to point at it.`
  )
}
