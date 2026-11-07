import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesOrigin, parseAllowlist } from '../src/origins.mjs'

test('parseAllowlist normalizes a comma or space separated list', () => {
  assert.deepEqual(parseAllowlist('Example.COM, *.Rappi.com sub.example.org'), [
    'example.com',
    '*.rappi.com',
    'sub.example.org'
  ])
  assert.deepEqual(parseAllowlist('example.com.'), ['example.com'], 'a trailing dot is not a different host')
  assert.deepEqual(parseAllowlist(''), [])
  assert.deepEqual(parseAllowlist(null), [])
})

test('parseAllowlist refuses what it cannot understand', () => {
  assert.throws(() => parseAllowlist('http://'), /invalid allowlist entry/)
  assert.throws(() => parseAllowlist('exa/mple.com'), /invalid allowlist entry/)
  assert.throws(() => parseAllowlist('example.com:no'), /invalid allowlist entry/)
})

test('a bare host pins that host only, on any port', () => {
  assert.equal(matchesOrigin('https://example.com/home', ['example.com']), true)
  assert.equal(matchesOrigin('http://example.com:8080/', ['example.com']), true)
  assert.equal(matchesOrigin('https://www.example.com/', ['example.com']), false, 'subdomains are not implied')
  assert.equal(matchesOrigin('https://example.com.evil/', ['example.com']), false)
})

test('a wildcard covers subdomains and never the apex', () => {
  assert.equal(matchesOrigin('https://a.example.com/', ['*.example.com']), true)
  assert.equal(matchesOrigin('https://a.b.example.com/', ['*.example.com']), true)
  assert.equal(matchesOrigin('https://example.com/', ['*.example.com']), false)
  assert.equal(matchesOrigin('https://notexample.com/', ['*.example.com']), false)
})

test('a pattern with a port pins the port', () => {
  assert.equal(matchesOrigin('http://localhost:3000/x', ['localhost:3000']), true)
  assert.equal(matchesOrigin('http://localhost:4000/x', ['localhost:3000']), false)
  assert.equal(matchesOrigin('https://example.com:8443/', ['example.com:8443']), true)
})

test('a full URL pattern pins the scheme', () => {
  assert.equal(matchesOrigin('https://example.com/', ['https://example.com']), true)
  assert.equal(matchesOrigin('https://example.com:443/', ['https://example.com']), true)
  assert.equal(matchesOrigin('http://example.com/', ['https://example.com']), false)
})

test('about:blank is always reachable; other schemes need their own entry', () => {
  assert.equal(matchesOrigin('about:blank', ['example.com']), true)
  assert.equal(matchesOrigin('file:///C:/tmp/x.html', ['example.com']), false)
  assert.equal(matchesOrigin('file:///C:/tmp/x.html', ['file://']), true)
})

test('an unparseable url or an empty list never matches', () => {
  assert.equal(matchesOrigin('not a url', ['example.com']), false)
  assert.equal(matchesOrigin('https://example.com/', []), false)
  assert.equal(matchesOrigin('https://example.com/', undefined), false)
})
