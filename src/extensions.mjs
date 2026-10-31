import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { profilePaths, readJson, writeJson } from './home.mjs'

/**
 * Extensions are directories with a manifest.json, loaded as unpacked extensions.
 * Store-installed CRX packages are out of scope for v1; the import command copies
 * the unpacked directories Brave already keeps in its profile.
 */

export function readExtensionEntries(profile = 'default', env = process.env, plat = process.platform) {
  const file = profilePaths(profile, env, plat).extensions
  const data = readJson(file, { extensions: [] })
  return Array.isArray(data.extensions) ? data.extensions : []
}

function describe(dir) {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`not an unpacked extension (missing manifest.json): ${dir}`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`invalid manifest.json in ${dir}: ${error.message}`)
  }
  if (![2, 3].includes(manifest.manifest_version)) {
    throw new Error(`${dir} declares manifest_version ${manifest.manifest_version}; expected 2 or 3`)
  }
  return {
    path: resolve(dir),
    name: manifest.name ?? null,
    version: manifest.version ?? null,
    manifestVersion: manifest.manifest_version
  }
}

export function listExtensions(profile = 'default', env = process.env, plat = process.platform) {
  return readExtensionEntries(profile, env, plat).map((entry) => ({
    ...entry,
    present: existsSync(entry.path)
  }))
}

export function extensionPaths(profile = 'default', env = process.env, plat = process.platform) {
  return readExtensionEntries(profile, env, plat)
    .filter((entry) => existsSync(entry.path))
    .map((entry) => entry.path)
}

export function addExtension(profile, dir, env = process.env, plat = process.platform) {
  const entry = describe(dir)
  const file = profilePaths(profile, env, plat).extensions
  const entries = readExtensionEntries(profile, env, plat)
  if (!entries.some((known) => resolve(known.path) === entry.path)) {
    entries.push(entry)
    writeJson(file, { extensions: entries })
  }
  return entry
}

export function removeExtension(profile, dir, env = process.env, plat = process.platform) {
  const target = resolve(dir)
  const file = profilePaths(profile, env, plat).extensions
  const entries = readExtensionEntries(profile, env, plat)
  const next = entries.filter((entry) => resolve(entry.path) !== target)
  if (next.length === entries.length) return false
  writeJson(file, { extensions: next })
  return true
}

/**
 * Register imported extension directories in bulk, ignoring duplicates.
 * Returns how many were added.
 */
export function registerImportedExtensions(profile, dirs, env = process.env, plat = process.platform) {
  let added = 0
  for (const dir of dirs) {
    try {
      const before = readExtensionEntries(profile, env, plat).length
      addExtension(profile, dir, env, plat)
      if (readExtensionEntries(profile, env, plat).length > before) added += 1
    } catch {
      // A directory with an unreadable manifest is skipped, not fatal for the import.
    }
  }
  return added
}
