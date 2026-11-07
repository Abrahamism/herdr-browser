import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from './fake-cdp.mjs'
import { withFakeCdp } from './harness.mjs'
import { challengeProbeScript, detectChallenge } from '../src/challenge.mjs'

const CLOUDFLARE = {
  title: 'Just a moment...',
  text: 'Checking your browser before accessing example.com',
  markers: {}
}

test('detectChallenge recognises the hard interstitials', () => {
  assert.deepEqual(detectChallenge(CLOUDFLARE), { kind: 'cloudflare', signal: 'title and text' })
  assert.equal(detectChallenge({ title: 'Access Denied', text: 'Reference #18.abc123.1234' }).kind, 'akamai')
  assert.equal(
    detectChallenge({ title: 'Blocked', text: 'Please enable JS and disable any ad blocker' }).kind,
    'datadome'
  )
  assert.equal(
    detectChallenge({ title: 'Access to this page has been denied', text: 'please verify you are a human' }).kind,
    'perimeterx'
  )
  assert.equal(
    detectChallenge({ title: 'Request unsuccessful. Incapsula incident ID: 1', text: 'Incapsula incident ID' }).kind,
    'imperva'
  )
  assert.equal(detectChallenge({ title: 'Human verification', text: 'Verify that you are a human' }).kind, 'awswaf')
  assert.equal(
    detectChallenge({ title: '403 Forbidden', text: "You don't have permission to access this resource" }).kind,
    'access-denied'
  )
})

test('a challenge needs two signals, so prose about Cloudflare is not a challenge', () => {
  assert.equal(
    detectChallenge({ title: 'How Cloudflare works', text: 'Cloudflare protects sites with ray id headers.' }),
    null
  )
  assert.equal(detectChallenge({ title: 'Just a moment...', text: 'A song by the band' }), null)
})

test('a mounted CAPTCHA widget is a challenge on its own', () => {
  assert.deepEqual(
    detectChallenge({ title: 'Iniciar sesión', text: 'Ingresá tu usuario', markers: { recaptcha: true } }),
    { kind: 'captcha', signal: 'reCAPTCHA widget' }
  )
  assert.deepEqual(detectChallenge({ title: 'x', text: 'y', markers: { turnstile: true } }), {
    kind: 'captcha',
    signal: 'Cloudflare Turnstile widget'
  })
})

test('a clean page is not a challenge', () => {
  assert.equal(
    detectChallenge({ title: 'Example Domain', text: 'This domain is for use in examples.', markers: { recaptcha: false } }),
    null
  )
  assert.equal(detectChallenge(undefined), null)
})

test('the probe script is marked and bounded', () => {
  const script = challengeProbeScript()
  assert.match(script, /\/\*__hbChallenge\*\//)
  assert.match(script, /slice\(0, 4000\)/)
  assert.match(script, /markers/)
})

test('open reports a challenge it did not wait for', async () => {
  await withFakeCdp(async ({ home, state }) => {
    state.challengeResult = CLOUDFLARE
    const result = await runCli(home, ['open', 'https://protected.example', '--challenge-wait', '0'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /challenge: cloudflare \(title and text\) — reported without waiting/)
  })
})

test('open --json exposes the challenge verdict', async () => {
  await withFakeCdp(async ({ home, state }) => {
    state.challengeResult = CLOUDFLARE
    const result = await runCli(home, ['open', 'https://protected.example', '--challenge-wait', '0', '--json'])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.challenge, {
      kind: 'cloudflare',
      signal: 'title and text',
      cleared: false,
      waitedMs: 0
    })
  })
})

test('open stays quiet when the page is the real thing', async () => {
  await withFakeCdp(async ({ home }) => {
    const result = await runCli(home, ['open', 'https://ok.example', '--challenge-wait', '0'])
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /challenge:/)
  })
})
