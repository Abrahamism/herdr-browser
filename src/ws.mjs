import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeFrame(opcode, payload, { mask = true } = {}) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  if (!mask) return Buffer.concat([header, payload])
  header[1] |= 0x80
  const key = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ key[index % 4]
  }
  return Buffer.concat([header, key, masked])
}

/**
 * Minimal RFC 6455 client for localhost CDP endpoints. Text frames only.
 * Kept in-tree so the CLI does not depend on the runtime's WebSocket lifecycle,
 * which keeps the process alive for seconds after a close on Windows.
 */
export class WsClient {
  constructor(url) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:') throw new Error(`unsupported WebSocket protocol ${parsed.protocol}`)
    this.host = parsed.hostname
    this.port = Number(parsed.port || 80)
    this.path = `${parsed.pathname}${parsed.search}`
    this.messageHandlers = new Set()
    this.closeHandlers = new Set()
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.handshaken = false
    this.closed = false
  }

  connect({ timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64')
      const expected = createHash('sha1').update(key + GUID).digest('base64')
      const socket = connect({ host: this.host, port: this.port })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`WebSocket handshake timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()

      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('connect', () => {
        socket.write(
          `GET ${this.path} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        )
      })
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        if (!this.handshaken) {
          const end = this.buffer.indexOf('\r\n\r\n')
          if (end === -1) return
          const head = this.buffer.subarray(0, end).toString('latin1')
          this.buffer = this.buffer.subarray(end + 4)
          const status = head.split('\r\n')[0] ?? ''
          if (!status.includes('101')) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error(`WebSocket upgrade failed: ${status}`))
            return
          }
          const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
          if (accept !== expected) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('WebSocket handshake returned a mismatched accept key'))
            return
          }
          this.handshaken = true
          clearTimeout(timer)
          resolve()
        }
        this.#drainFrames()
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        this.closed = true
        for (const handler of this.closeHandlers) handler()
      })
    })
  }

  #drainFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      let mask = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      let payload = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      if (mask) {
        const copy = Buffer.alloc(length)
        for (let index = 0; index < length; index += 1) copy[index] = payload[index] ^ mask[index % 4]
        payload = copy
      }
      if (opcode === 0x8) {
        this.close()
        return
      }
      if (opcode === 0x9) {
        this.#write(encodeFrame(0xa, payload))
        continue
      }
      if (opcode === 0xa) continue
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload)
        if (!fin) continue
        const text = Buffer.concat(this.fragments).toString('utf8')
        this.fragments = []
        for (const handler of this.messageHandlers) handler(text)
      }
    }
  }

  #write(buffer) {
    if (this.closed || !this.socket) return
    try {
      this.socket.write(buffer)
    } catch {
      // The peer may have closed first; the close event handles cleanup.
    }
  }

  send(text) {
    this.#write(encodeFrame(0x1, Buffer.from(text, 'utf8')))
  }

  onMessage(handler) {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler) {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.#write(encodeFrame(0x8, Buffer.alloc(0)))
    try {
      this.socket?.end()
    } catch {
      // Already ended.
    }
    setTimeout(() => this.socket?.destroy(), 50).unref?.()
  }
}
