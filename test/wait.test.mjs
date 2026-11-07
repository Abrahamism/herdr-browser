import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServer, runCli } from './fake-cdp.mjs'
import { conditionScript, parseDuration, parseWaitSpec } from '../src/wait.mjs'

async function withFakeCdp(fn) {
  const { server, state } = makeServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const tmp = join(tmpdir(), `hb-wait-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const home = join(tmp, 'home')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'state.json'),
    JSON.stringify({ port, browser: 'brave', exe: 'fake', userData: join(tmp, 'user-data') })
  )
  try {
    return await fn({ home, state, port })
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      server.close()
    } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
}

test('parseWaitSpec accepts the three conditions', () => {
  assert.deepEqual(parseWaitSpec('selector=#login'), { kind: 'selector', value: '#login' })
  assert.deepEqual(parseWaitSpec('text:Sign in'), { kind: 'text', value: 'Sign in' })
  assert.deepEqual(parseWaitSpec('url=https://x/y?a=b'), { kind: 'url', value: 'https://x/y?a=b' })
})

test('parseWaitSpec rejects junk', () => {
  assert.throws(() => parseWaitSpec('nope'), /invalid --for/)
  assert.throws(() => parseWaitSpec(''), /needs a condition/)
  assert.throws(() => parseWaitSpec('selector=   '), /empty value/)
})

test('parseDuration understands bare milliseconds and suffixes', () => {
  assert.equal(parseDuration(undefined, 1234), 1234)
  assert.equal(parseDuration('0', 1234), 0)
  assert.equal(parseDuration('250ms', 0), 250)
  assert.equal(parseDuration('30s', 0), 30_000)
  assert.equal(parseDuration('5m', 0), 300_000)
  assert.equal(parseDuration('2h', 0), 7_200_000)
  assert.throws(() => parseDuration('soon', 0), /invalid duration/)
})

test('conditionScript embeds the value literally and marks its probe', () => {
  const script = conditionScript({ kind: 'selector', value: 'a"b' })
  assert.match(script, /\/\*__hbWait\*\//)
  assert.ok(script.includes('"a\\"b"'), 'the value must be JSON-escaped')
  assert.match(conditionScript({ kind: 'text', value: 'hola' }), /innerText/)
  assert.match(conditionScript({ kind: 'url', value: '/home' }), /location\.href/)
  assert.throws(() => conditionScript({ kind: 'nope', value: 'x' }), /unknown wait condition/)
})

test('wait reports success when the condition holds', async () => {
  await withFakeCdp(async ({ home, state }) => {
    const result = await runCli(home, ['wait', '--for', 'selector=#app', '--timeout', '0'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /wait: ok after \d+ms/)
    assert.match(result.stdout, /url:  http:\/\/fake\//)
    assert.equal(state.waitCalls, 1)
  })
})

test('wait exits non-zero and says what it saw when the budget runs out', async () => {
  await withFakeCdp(async ({ home, state }) => {
    state.waitResult = { ok: false, detail: 'no element matches' }
    const result = await runCli(home, ['wait', '--for', 'selector=#missing', '--timeout', '0'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /wait timed out after 0ms \(selector=#missing: no element matches\)/)
  })
})

test('wait --json keeps the verdict machine-readable on timeout', async () => {
  await withFakeCdp(async ({ home, state }) => {
    state.waitResult = { ok: false, detail: 'the text is not present' }
    const result = await runCli(home, ['wait', '--for', 'text=Bienvenido', '--timeout', '0', '--json'])
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.timedOut, true)
    assert.deepEqual(payload.condition, { kind: 'text', value: 'Bienvenido' })
  })
})

test('handoff blocks until the condition holds and reports the resume', async () => {
  await withFakeCdp(async ({ home }) => {
    const result = await runCli(home, ['handoff', '--message', 'Entra con tu SSO', '--for', 'selector=#inicio', '--timeout', '0'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /human: Entra con tu SSO/)
    assert.match(result.stdout, /waiting: selector=#inicio/)
    assert.match(result.stdout, /resumed after \d+ms/)
  })
})

test('handoff without a condition times out when the page never navigates', async () => {
  await withFakeCdp(async ({ home }) => {
    const result = await runCli(home, ['handoff', '--timeout', '0'])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /human: /)
    assert.match(result.stdout, /waiting: the page to navigate/)
    assert.match(result.stderr, /handoff timed out after 0ms \(the page never navigated\)/)
  })
})
