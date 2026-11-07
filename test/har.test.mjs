import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHar, captureNetwork, redactHeaders, redactPostData } from '../src/har.mjs'

test('redactHeaders redacts sensitive headers', () => {
  const out = redactHeaders([
    { name: 'Authorization', value: 'Bearer secret' },
    { name: 'cookie', value: 'a=b' },
    { name: 'X-Api-Key', value: 'k' },
    { name: 'Content-Type', value: 'application/json' }
  ])
  assert.equal(out[0].value, '<redacted>')
  assert.equal(out[1].value, '<redacted>')
  assert.equal(out[2].value, '<redacted>')
  assert.equal(out[3].value, 'application/json')
  // new array
  assert.notEqual(out, [{ name: 'x', value: 'y' }])
})

test('redactPostData handles JSON', () => {
  assert.equal(redactPostData('{"password":"s","token":"t","x":1}'), '{"password":"<redacted>","token":"<redacted>","x":1}')
})

test('redactPostData handles form', () => {
  assert.equal(redactPostData('a=1&password=x'), 'a=1&password=<redacted>')
})

test('redactPostData unchanged when unparseable', () => {
  assert.equal(redactPostData('hello world'), 'hello world')
})

test('buildHar produces HAR 1.2', () => {
  const har = buildHar([{ startedDateTime: '2020-01-01T00:00:00.000Z', time: 5, request: { method: 'GET', url: 'https://example.com/?q=1', headers: [{ name: 'Authorization', value: 'x' }] }, response: { status: 200, statusText: 'OK', headers: [], content: { mimeType: 'text/html', size: 10 } } }], { version: '1.0.5' })
  assert.equal(har.log.version, '1.2')
  assert.equal(har.log.creator.name, 'herdr-browser')
  assert.equal(har.log.entries[0].request.headers[0].value, '<redacted>')
  assert.equal(har.log.entries[0].response.content.mimeType, 'text/html')
  assert.deepEqual(har.log.entries[0].cache, {})
})

test('captureNetwork captures and redacts', async () => {
  const events = {}
  const cdp = {
    on(method, handler, { sessionId }) {
      events[`${sessionId}|${method}`] = events[`${sessionId}|${method}`] || []
      events[`${sessionId}|${method}`].push(handler)
      return () => {}
    },
    async send(method, params, opts) {
      if (method === 'Network.enable') {
        setTimeout(() => {
          for (const h of events['S1|Network.requestWillBeSent'] || []) h({ requestId: 'r1', request: { url: 'https://example.com/', method: 'GET', headers: { Cookie: 'secret' } }, timestamp: 1, wallTime: 1 })
          for (const h of events['S1|Network.responseReceived'] || []) h({ requestId: 'r1', response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html', protocol: 'http/1.1' }, timestamp: 2 })
          for (const h of events['S1|Network.loadingFinished'] || []) h({ requestId: 'r1', encodedDataLength: 5, timestamp: 2 })
        }, 0)
      }
      return {}
    }
  }
  const res = await captureNetwork(cdp, 'S1', { idleMs: 50, timeoutMs: 1000 })
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].response.status, 200)
  const har = buildHar(res.entries, { version: '1.0.5' })
  assert.ok(!JSON.stringify(har).includes('secret'))
})

test('redaction proof secret never appears', () => {
  const har = buildHar([{ startedDateTime: 'x', time: 0, request: { method: 'GET', url: 'https://example.com/', headers: [{ name: 'Cookie', value: 'SECRET123' }, { name: 'Authorization', value: 'Bearer SECRET123' }] }, response: { status: 200, statusText: 'OK', headers: [{ name: 'Set-Cookie', value: 'SECRET123' }], content: { mimeType: 'text/html', size: 0 } } }], { version: '1.0.5' })
  const s = JSON.stringify(har)
  assert.ok(!s.includes('SECRET123'))
  assert.ok(s.includes('<redacted>'))
})
