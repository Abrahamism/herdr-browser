import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseKeyCombo } from '../src/actions.mjs'

test('parseKeyCombo Enter', () => {
  const r = parseKeyCombo('Enter')
  assert.equal(r.key, 'Enter')
  assert.equal(r.modifiers, 0)
})

test('parseKeyCombo Control+A', () => {
  const r = parseKeyCombo('Control+A')
  assert.equal(r.modifiers, 2)
  assert.equal(r.key, 'A')
})

test('parseKeyCombo Shift+Tab modifier bitmask 8', () => {
  const r = parseKeyCombo('Shift+Tab')
  assert.equal(r.modifiers, 8)
  assert.equal(r.key, 'Tab')
})

test('parseKeyCombo unknown modifier', () => {
  assert.throws(() => parseKeyCombo('Foo+Enter'), /unknown modifier/)
})

test('parseKeyCombo unknown key', () => {
  assert.throws(() => parseKeyCombo('NopeKey'), /unsupported key/)
})
