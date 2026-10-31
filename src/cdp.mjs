import { WsClient } from './ws.mjs'

/**
 * Minimal Chrome DevTools Protocol client.
 * Transport: in-tree WebSocket client (src/ws.mjs), so the CLI exits promptly
 * and does not depend on a global WebSocket implementation.
 */

const DEFAULT_TIMEOUT_MS = 30_000

export async function fetchVersion(port, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`)
  if (!response.ok) throw new Error(`DevTools endpoint returned HTTP ${response.status}`)
  return response.json()
}

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.sessions = new Map()
    this.client = new WsClient(wsUrl)
    this.closed = false
    this.opened = this.client.connect()
    this.client.onMessage((text) => this.#onMessage(text))
    this.client.onClose(() => {
      this.closed = true
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('CDP connection closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(port, options = {}) {
    const version = await fetchVersion(port, options)
    const client = new CDP(version.webSocketDebuggerUrl)
    await client.opened
    return client
  }

  #onMessage(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const suffix = message.error.data ? `: ${message.error.data}` : ''
        pending.reject(new Error(`${message.error.message}${suffix}`))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (message.method) {
      const key = message.sessionId ? `${message.sessionId}|${message.method}` : `*|${message.method}`
      for (const handler of this.listeners.get(key) ?? []) handler(message.params ?? {})
      for (const handler of this.listeners.get(`*|${message.method}`) ?? []) {
        handler(message.params ?? {}, message.sessionId ?? null)
      }
    }
  }

  send(method, params = {}, { sessionId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.client.send(JSON.stringify(payload))
    })
  }

  on(method, handler, { sessionId } = {}) {
    const key = sessionId ? `${sessionId}|${method}` : `*|${method}`
    const set = this.listeners.get(key) ?? new Set()
    set.add(handler)
    this.listeners.set(key, set)
    return () => set.delete(handler)
  }

  async attach(targetId) {
    const known = this.sessions.get(targetId)
    if (known) return known
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessions.set(targetId, sessionId)
    return sessionId
  }

  close() {
    this.closed = true
    this.client.close()
  }
}
