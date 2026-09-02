import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPublicPlaceRecord, type PublicPlaceRecordQuery } from '../src/public-records.ts'

test('direct place records expose current, founding, derived name spans, and retirement status', async () => {
  let queryText = ''
  const query: PublicPlaceRecordQuery = async (text, params) => {
    queryText = text
    assert.deepEqual(params, [42])
    return [{
      id: 42, parent_id: 1, name: 'Quiet porch', founding_name: 'test porch',
      description: '', purpose: '', owner_id: 7, owner: 'tiny-lantern',
      open_to_building: false, open_to_things: true, open_to_notes: true,
      created_at: '2026-08-01T00:00:00.000Z', retired_at: null, status: 'active',
      name_history: [
        { name: 'test porch', started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-03T00:00:00.000Z' },
        { name: 'Quiet porch', started_at: '2026-08-03T00:00:00.000Z', ended_at: null },
      ],
    }]
  }

  const place = await loadPublicPlaceRecord(42, query, async rows => rows)
  assert.match(queryText, /lead\s*\(\s*history\.started_at/iu)
  assert.doesNotMatch(queryText, /history\.ended_at/iu)
  assert.equal(place?.name, 'Quiet porch')
  assert.equal(place?.founding_name, 'test porch')
  assert.equal(place?.status, 'active')
  assert.deepEqual(place?.name_history, [
    { name: 'test porch', started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-03T00:00:00.000Z' },
    { name: 'Quiet porch', started_at: '2026-08-03T00:00:00.000Z', ended_at: null },
  ])
})

test('a retired direct record stays readable as a tombstone fact', async () => {
  const retiredAt = '2026-09-01T00:00:00.000Z'
  const place = await loadPublicPlaceRecord(42, async () => [{
    id: 42, parent_id: 1, name: 'Quiet porch', founding_name: 'test porch',
    description: '', purpose: '', owner_id: 7, owner: 'tiny-lantern',
    open_to_building: false, open_to_things: true, open_to_notes: true,
    created_at: '2026-08-01T00:00:00.000Z', retired_at: retiredAt, status: 'retired',
    name_history: [{ name: 'Quiet porch', started_at: '2026-08-01T00:00:00.000Z', ended_at: null }],
  }], async rows => rows)
  assert.equal(place?.retired_at, retiredAt)
  assert.equal(place?.status, 'retired')
})
