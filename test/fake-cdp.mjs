import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
export const CLI = join(PROJECT, 'bin', 'herdr-browser.mjs')

/**
 * A fake Chrome DevTools endpoint: HTTP /json/version plus a hand-rolled WebSocket
 * that answers the CDP methods the CLI uses. The target list is stateful so tests can
 * create, close and address tabs the way a real browser does.
 *
 * Everything a test needs to assert lives in the returned `state`: which target each
 * command attached to (`attachments`), which targets were created/closed/activated, and
 * the mouse events the actions dispatched.
 */

export const DEFAULT_TARGETS = [
  { targetId: 't1', type: 'page', title: 'Tab One', url: 'http://one/' },
  { targetId: 't2', type: 'page', title: 'Tab Two', url: 'http://two/' }
]

export function makeServer({ targets = DEFAULT_TARGETS } = {}) {
  const state = {
    targets: targets.map((target) => ({ ...target })),
    dispatches: [],
    attachments: [],
    created: [],
    closed: [],
    activated: [],
    navigations: [],
    browserClosed: false,
    nextId: targets.length + 1
  }

  const server = createServer((req, res) => {
    if (req.url === '/json/version') {
      const { port } = server.address()
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }))
      return
    }
    res.statusCode = 404
    res.end()
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )

    let buf = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (buf.length < 2) return
        const b0 = buf[0]
        const b1 = buf[1]
        const opcode = b0 & 0x0f
        const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f
        let offset = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          offset = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          offset = 10
        }
        let mask = null
        if (masked) {
          if (buf.length < offset + 4) return
          mask = buf.slice(offset, offset + 4)
          offset += 4
        }
        if (buf.length < offset + len) return
        let payload = buf.slice(offset, offset + len)
        if (masked && mask) {
          const unmasked = Buffer.alloc(len)
          for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4]
          payload = unmasked
        }
        buf = buf.slice(offset + len)

        if (opcode === 0x8) {
          const frame = Buffer.from([0x88, 0x00])
          try {
            socket.write(frame)
          } catch {}
          return
        }
        if (opcode === 0x9) {
          const out = Buffer.alloc(2 + payload.length)
          out[0] = 0x8a
          out[1] = payload.length
          payload.copy(out, 2)
          socket.write(out)
          continue
        }
        if (opcode !== 0x1) continue
        let msg
        try {
          msg = JSON.parse(payload.toString('utf8'))
        } catch {
          continue
        }
        handleMsg(msg, socket, state)
      }
    })
  })

  return { server, state }
}

function sendText(socket, obj) {
  const data = Buffer.from(JSON.stringify(obj))
  let header
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  socket.write(Buffer.concat([header, data]))
}

function handleMsg(msg, socket, state) {
  const { id, method, params } = msg
  let result = {}
  switch (method) {
    case 'Target.getTargets':
      result = { targetInfos: state.targets.map((target) => ({ ...target, attached: false })) }
      break
    case 'Target.createTarget': {
      const targetId = `t${state.nextId++}`
      state.targets.push({
        targetId,
        type: 'page',
        title: 'New Tab',
        url: params?.url === 'about:blank' ? 'about:blank' : (params?.url ?? 'about:blank')
      })
      state.created.push(targetId)
      result = { targetId }
      break
    }
    case 'Target.closeTarget':
      state.targets = state.targets.filter((target) => target.targetId !== params?.targetId)
      state.closed.push(params?.targetId)
      result = { success: true }
      break
    case 'Target.activateTarget':
      state.activated.push(params?.targetId)
      result = {}
      break
    case 'Target.attachToTarget':
      state.attachments.push(params?.targetId)
      result = { sessionId: 'S1' }
      break
    case 'Runtime.evaluate': {
      const expr = params?.expression ?? ''
      if (expr.includes('__hbChallenge')) {
        state.challengeCalls = (state.challengeCalls ?? 0) + 1
        const answer = state.challengeResult ?? { title: 'Fake', text: '', markers: {} }
        result = { result: { value: { url: 'http://fake/', ...answer } } }
      } else if (expr.includes('__hbWait')) {
        state.waitCalls = (state.waitCalls ?? 0) + 1
        const answer = state.waitResult ?? { ok: true, detail: 'the condition holds' }
        result = { result: { value: { url: 'http://fake/', title: 'Fake', ...answer } } }
      } else if (expr.includes('data-hb-c')) {
        result = { result: { value: { x: 0, y: 0 } } }
      } else if (expr.includes('rect.left + rect.width / 2')) {
        result = { result: { value: { ok: true, x: 10, y: 20 } } }
      } else if (expr.includes('MAX_ITEMS')) {
        result = { result: { value: { title: 'Fake', url: 'http://fake/', items: [{ ref: 'e1', role: 'button', name: 'Go' }] } } }
      } else if (expr.includes('document.readyState')) {
        result = { result: { value: 'complete' } }
      } else if (expr.includes('location.href')) {
        result = { result: { value: 'http://fake/' } }
      } else {
        result = { result: { value: null } }
      }
      break
    }
    case 'Input.dispatchMouseEvent':
      state.dispatches.push({ type: params.type, x: params.x, y: params.y })
      result = {}
      break
    case 'Page.navigate':
      state.navigations.push(params?.url ?? '')
      result = { frameId: 'F0' }
      break
    case 'Page.enable':
    case 'Runtime.enable':
    case 'Page.addScriptToEvaluateOnNewDocument':
      result = {}
      break
    case 'Page.getFrameTree':
      result = { frameTree: { frame: { id: 'F0', url: 'http://fake/' } } }
      break
    case 'Page.createIsolatedWorld':
      result = { executionContextId: 1 }
      break
    case 'Page.captureScreenshot':
      result = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+XcQAAAAASUVORK5CYII=' }
      break
    case 'Browser.close':
      state.browserClosed = true
      result = {}
      break
    default:
      result = {}
  }
  sendText(socket, { id, result })
}

export function runCli(home, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, HERDR_BROWSER_HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.on('close', (code) => resolve({ status: code ?? 0, stdout, stderr }))
  })
}
