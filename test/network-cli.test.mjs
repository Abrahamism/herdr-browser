import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from './fake-cdp.mjs'
import { withFakeCdp } from './harness.mjs'

test('network writes a HAR with credentials redacted and the failure recorded', async () => {
  await withFakeCdp(async ({ home }) => {
    const file = join(home, 'capture.har')
    const result = await runCli(home, [
      'network',
      '--idle',
      '50',
      '--timeout',
      '5s',
      '--file',
      file,
      '--json'
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')

    const payload = JSON.parse(result.stdout)
    assert.equal(payload.file, file)
    assert.equal(payload.entries, 2)
    assert.ok(payload.redacted >= 3, `expected at least 3 redacted headers, got ${payload.redacted}`)

    const text = readFileSync(file, 'utf8')
    for (const secret of ['secret-cookie', 'secret-token', 'session=secret', 's3cret', '"abc"']) {
      assert.ok(!text.includes(secret), `the HAR leaked ${secret}`)
    }

    const har = JSON.parse(text)
    assert.equal(har.log.version, '1.2')
    assert.equal(har.log.creator.name, 'herdr-browser')

    const first = har.log.entries[0]
    assert.equal(first.request.url, 'https://example.com/')
    assert.equal(first.request.queryString.length, 0)
    for (const header of first.request.headers) {
      if (['cookie', 'authorization'].includes(header.name.toLowerCase())) {
        assert.equal(header.value, '<redacted>')
      }
    }

    const failed = har.log.entries.find((entry) => entry.request.url.endsWith('/api'))
    assert.equal(failed.response.status, 0)
    assert.equal(failed.response.statusText, '(no response)')
    assert.equal(failed._error, 'net::ERR_FAILED')
    assert.ok(!failed.request.postData.text.includes('s3cret'))
  })
})

test('network exits non-zero when the capture saw nothing', async () => {
  await withFakeCdp(async ({ home, state }) => {
    state.networkPlan = []
    const result = await runCli(home, ['network', '--idle', '50', '--timeout', '2s', '--file', join(home, 'x.har')])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no network requests captured/)
  })
})

test('network rejects a zero idle budget instead of capturing nothing', async () => {
  await withFakeCdp(async ({ home }) => {
    const result = await runCli(home, ['network', '--idle', '0', '--file', join(home, 'x.har')])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--idle must be greater than zero/)
  })
})
