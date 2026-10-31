import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshot, renderTabs, renderStatus } from '../src/render.mjs'

test('renderSnapshot link/input/checkbox', () => {
  const snap = {
    url: 'http://x/',
    title: 'T',
    items: [
      { ref: 'e1', role: 'link', name: 'Home', url: '/' },
      { ref: 'e2', role: 'input', name: 'Q', type: 'text', value: 'hi' },
      { ref: 'e3', role: 'checkbox', name: 'Agree', checked: false }
    ]
  }
  const out = renderSnapshot(snap)
  assert.match(out, /\[e1\] link "Home"/)
  assert.match(out, /\[e2\] input "Q" type=text value="hi"/)
  assert.match(out, /\[e3\] checkbox "Agree" checked=false/)
})

test('renderSnapshot empty', () => {
  const out = renderSnapshot({ url: 'http://x/', title: 'T', items: [] })
  assert.match(out, /\(no interactive elements found\)/)
})

test('renderTabs marks active', () => {
  const tabs = [
    { id: 'a', index: 0, title: 'A', url: 'http://a/' },
    { id: 'b', index: 1, title: 'B', url: 'http://b/' }
  ]
  const out = renderTabs(tabs, { activeId: 'b' })
  assert.match(out, /\* \[1\] B/)
  assert.match(out, /  \[0\] A/)
})

test('renderStatus not-running and running', () => {
  assert.equal(renderStatus({ state: null }), 'browser: not running')
  const state = { browser: 'brave', exe: 'fake', port: 1234, pid: 9, userData: '/ud' }
  const out = renderStatus({ state, version: { Browser: 'Brave/1' }, tabs: [{}] })
  assert.match(out, /port: 1234/)
  assert.match(out, /tabs: 1/)
})
