const DEFAULT_PORTS = { http: '80', ws: '80', https: '443', wss: '443', ftp: '21' }

function defaultPort(scheme) {
  return DEFAULT_PORTS[String(scheme || '').toLowerCase()] ?? ''
}

function normPort(scheme, port) {
  const p = String(port ?? '').trim()
  return p === '' ? defaultPort(scheme) : p
}

function isValidHost(host) {
  if (!host || typeof host !== 'string') return false
  if (/\s/.test(host)) return false
  if (host.includes('/') || host.includes('\\')) return false
  return /^[A-Za-z0-9._-]+$/.test(host)
}

function stripTrailingDot(host) {
  return String(host ?? '').replace(/\.$/, '')
}

function splitHostPort(value) {
  const v = String(value).trim()
  const idx = v.lastIndexOf(':')
  if (idx > -1 && /^\d+$/.test(v.slice(idx + 1))) {
    return { host: v.slice(0, idx), port: v.slice(idx + 1) }
  }
  return { host: v, port: '' }
}

function parseUrlInfo(url) {
  let u
  try {
    u = new URL(String(url).trim())
  } catch {
    return null
  }
  const scheme = String(u.protocol || '').replace(/:$/, '').toLowerCase()
  const host = stripTrailingDot(String(u.hostname || '').toLowerCase())
  const port = String(u.port || '')
  return { scheme, host, port }
}

function normalizePattern(raw) {
  let p = String(raw ?? '').trim().toLowerCase()
  if (!p) return null

  if (p === 'file://') return 'file://'

  if (p.includes('://')) {
    let u
    try {
      u = new URL(p)
    } catch {
      return null
    }
    const scheme = String(u.protocol || '').replace(/:$/, '').toLowerCase()
    if (!scheme) return null
    const host = stripTrailingDot(String(u.hostname || '').toLowerCase())
    if (scheme === 'file') return 'file://'
    if (!host) return null
    const port = String(u.port || '')
    return port ? scheme + '://' + host + ':' + port : scheme + '://' + host
  }

  const { host: hostRaw, port } = splitHostPort(p)
  const host = stripTrailingDot(hostRaw)
  if (host.startsWith('*.')) {
    const base = stripTrailingDot(host.slice(2))
    if (!isValidHost(base)) return null
    if (port && !/^\d+$/.test(port)) return null
    return port ? '*.' + base + ':' + port : '*.' + base
  }
  if (!isValidHost(host)) return null
  if (port && !/^\d+$/.test(port)) return null
  return port ? host + ':' + port : host
}

export function parseAllowlist(value) {
  if (value == null) return []
  const tokens = String(value).split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
  const result = []
  for (const token of tokens) {
    const normalized = normalizePattern(token)
    if (normalized === null) throw new Error('invalid allowlist entry "' + token + '"')
    result.push(normalized)
  }
  return result
}

export function matchesOrigin(url, patterns) {
  if (url === 'about:blank') return true
  const info = parseUrlInfo(url)
  if (!info) return false
  if (!Array.isArray(patterns)) return false

  for (const raw of patterns) {
    const pat = String(raw ?? '').trim().toLowerCase()
    if (!pat) continue

    if (pat === 'file://') {
      if (info.scheme === 'file') return true
      continue
    }

    if (pat.includes('://')) {
      let u
      try {
        u = new URL(pat)
      } catch {
        continue
      }
      const pScheme = String(u.protocol || '').replace(/:$/, '').toLowerCase()
      const pHost = stripTrailingDot(String(u.hostname || '').toLowerCase())
      const pPort = String(u.port || '')
      if (pScheme === 'file') {
        if (info.scheme === 'file') return true
        continue
      }
      if (pScheme !== info.scheme) continue
      if (pHost !== info.host) continue
      if (normPort(pScheme, pPort) !== normPort(info.scheme, info.port)) continue
      return true
    }

    const { host: hostRaw, port: patPort } = splitHostPort(pat)
    const host = stripTrailingDot(hostRaw)

    if (host.startsWith('*.')) {
      const base = stripTrailingDot(host.slice(2))
      if (info.host === base) continue
      if (!info.host.endsWith('.' + base)) continue
      if (patPort) {
        if (normPort(info.scheme, patPort) !== normPort(info.scheme, info.port)) continue
      }
      return true
    }

    if (info.host !== host) continue
    if (patPort) {
      if (normPort(info.scheme, patPort) !== normPort(info.scheme, info.port)) continue
    }
    return true
  }

  return false
}
