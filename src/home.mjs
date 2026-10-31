import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_CONFIG = {
  browser: 'brave',
  profile: 'default',
  cursor: true,
  /** 0 lets the browser pick a free port and write it to DevToolsActivePort. */
  port: 0
}

export function homeDir(env = process.env, plat = platform()) {
  if (env.HERDR_BROWSER_HOME) return env.HERDR_BROWSER_HOME
  if (plat === 'win32') {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(local, 'herdr-browser')
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'herdr-browser')
  }
  const data = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(data, 'herdr-browser')
}

export function paths(env = process.env, plat = platform()) {
  const home = homeDir(env, plat)
  return {
    home,
    profiles: join(home, 'profiles'),
    config: join(home, 'config.json')
  }
}

export function profileName(name) {
  const clean = String(name ?? '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) {
    throw new Error(`invalid profile name "${name}" (use letters, digits, dot, underscore or hyphen)`)
  }
  return clean
}

export function profilePaths(name, env = process.env, plat = platform()) {
  const root = join(paths(env, plat).profiles, profileName(name))
  return {
    root,
    userData: join(root, 'user-data'),
    state: join(root, 'state.json'),
    extensions: join(root, 'extensions.json'),
    logs: join(root, 'logs')
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function loadConfig(env = process.env, plat = platform()) {
  const file = paths(env, plat).config
  const saved = readJson(file, {})
  return { ...DEFAULT_CONFIG, ...saved }
}

export function saveConfig(patch, env = process.env, plat = platform()) {
  const file = paths(env, plat).config
  const next = { ...loadConfig(env, plat), ...patch }
  writeJson(file, next)
  return next
}

export function hasFile(file) {
  return existsSync(file)
}
