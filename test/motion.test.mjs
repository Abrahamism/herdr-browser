import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveSteps } from '../src/actions.mjs'

test('moveSteps ends exactly on the target', () => {
  const path = moveSteps({ x: 0, y: 0 }, { x: 100, y: 50 }, 10)
  assert.equal(path.length, 10)
  assert.deepEqual(path.at(-1), { x: 100, y: 50 })
})

test('moveSteps interpolates monotonically', () => {
  const path = moveSteps({ x: 10, y: 20 }, { x: 210, y: 120 }, 8)
  for (let index = 1; index < path.length; index += 1) {
    assert.ok(path[index].x > path[index - 1].x)
    assert.ok(path[index].y > path[index - 1].y)
  }
  assert.equal(path.length, 8)
})

test('moveSteps handles a zero-length move', () => {
  const path = moveSteps({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)
  assert.equal(path.length, 4)
  for (const point of path) assert.deepEqual(point, { x: 5, y: 5 })
})
