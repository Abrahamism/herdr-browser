const REDACTED = '<redacted>'
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token'
])
const SENSITIVE_FIELD = /password|passwd|secret|token|otp/i

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function redactHeaders(headers) {
  const list = Array.isArray(headers)
    ? headers
    : Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
  return list.map((header) => {
    const name = String(header?.name ?? '')
    const value = header?.value
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      return { name, value: REDACTED }
    }
    return { name, value }
  })
}

function normalizeHeaders(headers) {
  if (Array.isArray(headers)) return headers.map((h) => ({ name: h.name, value: h.value }))
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
}

export function redactPostData(text) {
  if (typeof text !== 'string') return text
  const trimmed = text.trim()
  // JSON body
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const redacted = redactJson(parsed)
      return JSON.stringify(redacted)
    } catch {
      // fall through to form handling
    }
  }
  // form-encoded body
  if (trimmed.includes('=')) {
    const parts = trimmed.split('&')
    if (parts.every((part) => part === '' || part.includes('='))) {
      return parts
        .map((part) => {
          if (part === '') return part
          const idx = part.indexOf('=')
          const key = part.slice(0, idx)
          const value = part.slice(idx + 1)
          let decodedKey = key
          try {
            decodedKey = decodeURIComponent(key)
          } catch {
            decodedKey = key
          }
          if (SENSITIVE_FIELD.test(decodedKey)) {
            return `${key}=${REDACTED}`
          }
          // keep original value encoding untouched for non-sensitive
          return `${key}=${value}`
        })
        .join('&')
    }
  }
  return text
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_FIELD.test(key)) {
        out[key] = REDACTED
      } else {
        out[key] = redactJson(val)
      }
    }
    return out
  }
  return value
}

function parseQueryString(url) {
  try {
    const u = new URL(url)
    const out = []
    for (const [name, value] of u.searchParams.entries()) {
      out.push({ name, value })
    }
    return out
  } catch {
    return []
  }
}

export function buildHar(entries, { version } = {}) {
  const mapped = (entries ?? []).map((entry) => {
    const req = entry?.request ?? {}
    const res = entry?.response ?? {}
    const url = req.url ?? ''
    const reqHeaders = redactHeaders(Array.isArray(req.headers) ? req.headers : normalizeHeaders(req.headers))
    const resHeaders = redactHeaders(Array.isArray(res.headers) ? res.headers : normalizeHeaders(res.headers))
    const content = res.content ?? { mimeType: res.mimeType ?? '', size: res.size ?? 0 }
    const harEntry = {
      startedDateTime: entry?.startedDateTime ?? new Date().toISOString(),
      time: entry?.time ?? 0,
      request: {
        method: req.method ?? 'GET',
        url,
        httpVersion: req.httpVersion ?? 'HTTP/1.1',
        headers: reqHeaders,
        queryString: parseQueryString(url)
      },
      response: {
        status: res.status ?? 0,
        statusText: res.statusText ?? (res.status === 0 ? '(no response)' : ''),
        httpVersion: res.httpVersion ?? 'HTTP/1.1',
        headers: resHeaders,
        content: {
          mimeType: content.mimeType ?? res.mimeType ?? '',
          size: content.size ?? res.size ?? 0
        }
      },
      cache: {},
      timings: { wait: entry?.timings?.wait ?? 0 }
    }
    if (req.postData != null && req.postData !== undefined) {
      const raw = typeof req.postData === 'string' ? req.postData : JSON.stringify(req.postData)
      harEntry.request.postData = {
        mimeType: req.postDataMimeType ?? '',
        text: redactPostData(raw)
      }
    }
    // A failed request is the interesting half of a capture; do not drop it in the mapping.
    if (entry?._error) harEntry._error = entry._error
    return harEntry
  })
  return {
    log: {
      version: '1.2',
      creator: { name: 'herdr-browser', version },
      entries: mapped
    }
  }
}

export async function captureNetwork(cdp, sessionId, options = {}) {
  const { navigate, url, idleMs = 800, timeoutMs = 30000 } = options
  const unsubs = []
  const on = (method, handler) => {
    const unsub = cdp.on(method, handler, { sessionId })
    unsubs.push(unsub)
  }

  const entriesByRequestId = new Map()
  const order = []
  let inFlight = 0
  let lastActivity = Date.now()

  const bump = () => {
    lastActivity = Date.now()
  }

  on('Network.requestWillBeSent', (params) => {
    const req = params?.request ?? {}
    const entry = {
      requestId: params?.requestId,
      startedDateTime: params?.wallTime
        ? new Date(params.wallTime * 1000).toISOString()
        : new Date().toISOString(),
      time: 0,
      request: {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        httpVersion: 'HTTP/1.1',
        headers: normalizeHeaders(req.headers),
        postData: req.postData ?? null,
        postDataMimeType: req.postDataMimeType ?? ''
      },
      response: null,
      cache: {},
      timings: { wait: 0 },
      _requestTimestamp: params?.timestamp
    }
    entriesByRequestId.set(params?.requestId, entry)
    order.push(params?.requestId)
    inFlight += 1
    bump()
  })

  on('Network.responseReceived', (params) => {
    const entry = entriesByRequestId.get(params?.requestId)
    if (!entry) return
    const res = params?.response ?? {}
    entry.response = {
      status: res.status ?? 0,
      statusText: res.statusText ?? '',
      httpVersion: res.protocol ?? 'HTTP/1.1',
      headers: normalizeHeaders(res.headers),
      mimeType: res.mimeType ?? '',
      content: undefined
    }
    if (params?.timestamp != null && entry._requestTimestamp != null) {
      // store for time calc on finish; response time not final
    }
    bump()
  })

  on('Network.loadingFinished', (params) => {
    const entry = entriesByRequestId.get(params?.requestId)
    if (!entry) return
    if (params?.timestamp != null && entry._requestTimestamp != null) {
      entry.time = Math.max(0, (params.timestamp - entry._requestTimestamp) * 1000)
    }
    if (entry.response) {
      entry.response.content = {
        mimeType: entry.response.mimeType ?? '',
        size: params?.encodedDataLength ?? 0
      }
    }
    inFlight = Math.max(0, inFlight - 1)
    bump()
  })

  on('Network.loadingFailed', (params) => {
    const entry = entriesByRequestId.get(params?.requestId)
    if (!entry) return
    entry._error = params?.errorText ?? 'failed'
    if (!entry.response) {
      entry.response = {
        status: 0,
        statusText: '(no response)',
        httpVersion: 'HTTP/1.1',
        headers: [],
        mimeType: '',
        content: { mimeType: '', size: 0 }
      }
    } else if (!entry.response.content) {
      entry.response.content = { mimeType: entry.response.mimeType ?? '', size: 0 }
    }
    inFlight = Math.max(0, inFlight - 1)
    bump()
  })

  await cdp.send('Network.enable', {}, { sessionId })

  if (url && typeof navigate === 'function') {
    await navigate(url)
  }

  const start = Date.now()
  let idle = false
  while (Date.now() - start < timeoutMs) {
    if (inFlight === 0 && Date.now() - lastActivity >= idleMs) {
      idle = true
      break
    }
    await sleep(50)
  }
  if (!idle && inFlight === 0 && Date.now() - lastActivity >= idleMs) {
    idle = true
  }

  for (const unsub of unsubs) {
    try {
      unsub()
    } catch {}
  }

  const entries = order.map((id) => {
    const entry = entriesByRequestId.get(id)
    if (!entry.response) {
      entry.response = {
        status: 0,
        statusText: '(no response)',
        httpVersion: 'HTTP/1.1',
        headers: [],
        mimeType: '',
        content: { mimeType: '', size: 0 }
      }
    } else {
      if (!entry.response.content) {
        entry.response.content = { mimeType: entry.response.mimeType ?? '', size: 0 }
      }
      if (entry.response.status === 0 && !entry.response.statusText) {
        entry.response.statusText = '(no response)'
      }
    }
    return entry
  })

  return { entries, idle, waitedMs: Date.now() - start }
}
