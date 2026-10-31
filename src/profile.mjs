import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { registerImportedExtensions } from './extensions.mjs'
import { ensureDir, profilePaths } from './home.mjs'

const USER_DATA_ROOTS = {
  win32: {
    brave: (env) => join(env.LOCALAPPDATA ?? '', 'BraveSoftware', 'Brave-Browser', 'User Data'),
    chrome: (env) => join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data'),
    edge: (env) => join(env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data'),
    chromium: (env) => join(env.LOCALAPPDATA ?? '', 'Chromium', 'User Data')
  },
  darwin: {
    brave: () => join(homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    chrome: () => join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    edge: () => join(homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
    chromium: () => join(homedir(), 'Library', 'Application Support', 'Chromium')
  },
  linux: {
    brave: (env) => join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'BraveSoftware', 'Brave-Browser'),
    chrome: (env) => join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'google-chrome'),
    edge: (env) => join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'microsoft-edge'),
    chromium: (env) => join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'chromium')
  }
}

export function sourceUserData(name, { env = process.env, plat = platform() } = {}) {
  const roots = USER_DATA_ROOTS[plat]?.[name]
  if (!roots) throw new Error(`unsupported source browser "${name}" on ${plat}`)
  return roots(env)
}

const DEFAULT_PROFILE_FILES = [
  'Cookies',
  'Network/Cookies',
  'Login Data',
  'Web Data',
  'Local Storage',
  'Extensions'
]

const IMAGE_NAMES = {
  brave: 'brave.exe',
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  chromium: 'chromium.exe'
}

export function isBrowserRunning(name, { exec = execFileSync, plat = platform() } = {}) {
  try {
    if (plat === 'win32') {
      const out = exec('tasklist', ['/FI', `IMAGENAME eq ${IMAGE_NAMES[name]}`], { encoding: 'utf8' })
      return out.toLowerCase().includes(IMAGE_NAMES[name].toLowerCase())
    }
    exec('pgrep', ['-f', name], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

function findExtensionDirs(userData) {
  const root = join(userData, 'Default', 'Extensions')
  if (!existsSync(root)) return []
  const dirs = []
  for (const id of readdirSync(root, { withFileTypes: true })) {
    if (!id.isDirectory()) continue
    const versions = readdirSync(join(root, id.name), { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    )
    for (const version of versions) {
      const dir = join(root, id.name, version.name)
      if (existsSync(join(dir, 'manifest.json'))) dirs.push(dir)
    }
  }
  return dirs
}

/**
 * Copy cookies, saved logins and unpacked extensions from a real browser profile
 * into the dedicated profile used for CDP.
 */
export function importProfile({
  from = 'brave',
  profile = 'default',
  force = false,
  env = process.env,
  plat = platform(),
  running = isBrowserRunning
}) {
  const source = sourceUserData(from, { env, plat })
  if (!existsSync(source)) {
    throw new Error(`source profile not found: ${source}`)
  }
  if (running(from, { plat }) && !force) {
    throw new Error(
      `${from} is running. Close it so cookies and logins are copied consistently, or pass --force to copy anyway.`
    )
  }

  const target = profilePaths(profile, env, plat).userData
  ensureDir(target)
  const copied = []

  const localState = join(source, 'Local State')
  if (existsSync(localState)) {
    cpSync(localState, join(target, 'Local State'))
    copied.push('Local State')
  }

  for (const relative of DEFAULT_PROFILE_FILES) {
    const sourcePath = join(source, 'Default', relative)
    if (!existsSync(sourcePath)) continue
    const targetPath = join(target, 'Default', relative)
    ensureDir(join(targetPath, '..'))
    cpSync(sourcePath, targetPath, { recursive: true, force: true })
    copied.push(relative)
  }

  const extensionDirs = findExtensionDirs(source)
  const added = registerImportedExtensions(profile, extensionDirs, env, plat)

  return {
    source,
    target,
    copied,
    extensions: { found: extensionDirs.length, registered: added }
  }
}

export function profileSummary(profile = 'default', env = process.env, plat = platform()) {
  const paths = profilePaths(profile, env, plat)
  return {
    profile,
    ...paths,
    exists: existsSync(paths.userData)
  }
}

export function ensureProfileDirs(profile = 'default', env = process.env, plat = platform()) {
  const paths = profilePaths(profile, env, plat)
  mkdirSync(paths.userData, { recursive: true })
  return paths
}
