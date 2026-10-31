import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// We'll implement raw socket server manually.

import { createServer as createNetServer } from 'node:net'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(PROJECT, 'bin', 'herdr-browser.mjs')

function makeServer() {
  const dispatchCalls = []
  const server = createServer((req, res) => {
    if (req.url === '/json/version') {
      const addr = server.address()
      const port = addr.port
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
          // close
          const frame = Buffer.from([0x88, 0x00])
          try { socket.write(frame) } catch {}
          return
        }
        if (opcode === 0x9) {
          // ping -> pong
          const out = Buffer.alloc(2 + payload.length)
          out[0] = 0x8a
          out[1] = payload.length
          payload.copy(out, 2)
          socket.write(out)
          continue
        }
        if (opcode !== 0x1) continue
        let msg
        try { msg = JSON.parse(payload.toString('utf8')) } catch { continue }
        handleMsg(msg, socket, dispatchCalls)
      }
    })
  })

  return { server, dispatchCalls }
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

function handleMsg(msg, socket, dispatchCalls) {
  const { id, method, params } = msg
  let result = {}
  switch (method) {
    case 'Target.getTargets':
      result = {
        targetInfos: [
          { targetId: 't1', type: 'page', title: 'Tab One', url: 'http://one/', attached: false },
          { targetId: 't2', type: 'page', title: 'Tab Two', url: 'http://two/', attached: false }
        ]
      }
      break
    case 'Target.attachToTarget':
      result = { sessionId: 'S1' }
      break
    case 'Runtime.evaluate': {
      const expr = params?.expression ?? ''
      if (expr.includes('__hbPos')) {
        result = { result: { value: { x: 0, y: 0 } } }
      } else if (expr.includes('rect.left + rect.width / 2')) {
        result = { result: { value: { ok: true, x: 10, y: 20 } } }
      } else if (expr.includes('MAX_ITEMS') || expr.includes('data-herdr-browser-ref')) {
        result = { result: { value: { title: 'Fake', url: 'http://fake/', items: [{ ref: 'e1', role: 'button', name: 'Go' }] } } }
      } else if (expr.includes('location.href')) {
        result = { result: { value: 'http://fake/' } }
      } else {
        result = { result: { value: null } }
      }
      break
    }
    case 'Input.dispatchMouseEvent':
      dispatchCalls.push({ type: params.type, x: params.x, y: params.y })
      result = {}
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
      result = {}
      break
    default:
      result = {}
  }
  sendText(socket, { id, result })
}

function runCli(home, args) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, HERDR_BROWSER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolve({ status: code ?? 0, stdout, stderr }))
  })
}

test('CLI against fake CDP server', async () => {
  const { server, dispatchCalls } = makeServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const tmp = join(tmpdir(), 'hb-cli-' + Date.now())
  const home = join(tmp, 'home')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  const statePath = join(profileDir, 'state.json')
  writeFileSync(statePath, JSON.stringify({ port, browser: 'brave', exe: 'fake', userData: join(tmp, 'user-data') }))

  try {
    // tabs --json
    const r1 = await runCli(home, ['tabs', '--json'])
    assert.equal(r1.status, 0, r1.stderr)
    assert.equal(r1.stderr, '')
    const tabs = JSON.parse(r1.stdout)
    assert.equal(tabs.length, 2)

    // snapshot
    const r2 = await runCli(home, ['snapshot'])
    assert.equal(r2.status, 0, r2.stderr)
    assert.equal(r2.stderr, '')
    assert.match(r2.stdout, /\[e1\] button "Go"/)

    // click e1
    dispatchCalls.length = 0
    const r3 = await runCli(home, ['click', 'e1'])
    assert.equal(r3.status, 0, r3.stderr)
    assert.equal(r3.stderr, '')
    const types = dispatchCalls.map((c) => c.type)
    assert.equal(types[0], 'mouseMoved')
    assert.equal(types[types.length - 2], 'mousePressed')
    assert.equal(types[types.length - 1], 'mouseReleased')
    const lastMove = dispatchCalls.filter((c) => c.type === 'mouseMoved').at(-1)
    assert.equal(lastMove.x, 10)
    assert.equal(lastMove.y, 20)
    assert.ok(types.length > 3, 'the pointer should move in several steps')
    const press = dispatchCalls.find((c) => c.type === 'mousePressed')
    const release = dispatchCalls.find((c) => c.type === 'mouseReleased')
    assert.equal(press.x, 10)
    assert.equal(press.y, 20)
    assert.equal(release.x, 10)
    assert.equal(release.y, 20)

    // status
    const r4 = await runCli(home, ['status'])
    assert.equal(r4.status, 0, r4.stderr)
    assert.equal(r4.stderr, '')
    assert.match(r4.stdout, new RegExp(`port: ${port}`))

    // stop removes state.json
    const r5 = await runCli(home, ['stop'])
    assert.equal(r5.status, 0, r5.stderr)
    assert.equal(r5.stderr, '')
    assert.match(r5.stdout, /browser: stopped/)
    assert.equal(existsSync(statePath), false)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try { server.close() } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})
