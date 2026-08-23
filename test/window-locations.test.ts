import assert from 'node:assert/strict'
import test from 'node:test'

import { windowPlaceLabel } from '../src/window-client.ts'

test('windowPlaceLabel keeps the loaded place path', () => {
  assert.equal(
    windowPlaceLabel(12, { path: 'world / loaded_square' }),
    'world / loaded_square',
  )
})

test('windowPlaceLabel names an unloaded place without pretending it is absent', () => {
  assert.equal(
    windowPlaceLabel(123, null),
    'Place #123 · not currently loaded',
  )
})

test('windowPlaceLabel leaves genuinely locationless records unlabeled', () => {
  assert.equal(windowPlaceLabel(null, null), null)
})
