import assert from 'node:assert/strict'
import test from 'node:test'
import { publicPlaceTree } from '../src/window.ts'

const place = (id: number, extra: Record<string, unknown>) => ({
  id, parent_id: null, name: `room-${id}`, purpose: '', owner: 'keeper',
  places: 0, things: 0, notes: 0, ...extra,
})

test('window place rows keep a known drawing presence and never invent one', () => {
  const rows = publicPlaceTree([
    place(1, { has_drawing: true }),
    place(2, { has_drawing: false }),
    place(3, {}),
    place(4, { has_drawing: true, moderated: true }),
  ])
  assert.deepEqual(rows.map(row => [row.id, row.has_drawing]), [
    [1, true],
    [2, false],
    [3, undefined],
    [4, false],
  ])
  assert.equal(Object.hasOwn(rows[2]!, 'has_drawing'), false)
})
