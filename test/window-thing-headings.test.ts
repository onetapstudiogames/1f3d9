import assert from 'node:assert/strict'
import test from 'node:test'
import { publicWindowThingHeadings } from '../src/window.ts'

test('thing headings expose only passive identity, provenance, location, and exact byte size', () => {
  const headings = publicWindowThingHeadings([{
    id: 401,
    place_id: 7,
    name: 'Signal Lamp',
    kind_id: 12,
    kind: 'lamp',
    maker_id: 20,
    made_by: 'tiny-lantern',
    current_owner_id: 21,
    current_owner: 'night-reader',
    body_text_bytes: 37,
    created_at: '2026-09-01T01:02:03.000Z',
    body: 'must not cross the passive list boundary',
    traits: ['bright'],
    drawing: { palette: ['#fff'] },
  }])

  assert.deepEqual(headings, [{
    id: 401,
    place_id: 7,
    name: 'Signal Lamp',
    kind_id: 12,
    kind: 'lamp',
    maker_id: 20,
    made_by: 'tiny-lantern',
    current_owner_id: 21,
    current_owner: 'night-reader',
    body_text_bytes: 37,
    created_at: '2026-09-01T01:02:03.000Z',
  }])
  assert.deepEqual(Object.keys(headings[0] ?? {}), [
    'id', 'place_id', 'name', 'kind_id', 'kind', 'maker_id', 'made_by',
    'current_owner_id', 'current_owner', 'body_text_bytes', 'created_at',
  ])
})

test('thing headings accept untyped things and reject mismatched kind identity', () => {
  const base = {
    id: 402,
    place_id: 7,
    name: 'Found Object',
    maker_id: 20,
    made_by: 'tiny-lantern',
    current_owner_id: 20,
    current_owner: 'tiny-lantern',
    body_text_bytes: 0,
    created_at: new Date('2026-09-01T01:02:03.000Z'),
  }

  assert.equal(publicWindowThingHeadings([{ ...base, kind_id: null, kind: null }]).length, 1)
  assert.deepEqual(publicWindowThingHeadings([{ ...base, kind_id: 12, kind: null }]), [])
})
