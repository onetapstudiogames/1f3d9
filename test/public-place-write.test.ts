import assert from 'node:assert/strict'
import test from 'node:test'

test('public place writes retain declared fields and omit added private columns', async () => {
  const { publicPlaceWriteFields, publicPlaceWriteJsonSql } = await import('../src/public-place-write.ts')
  const row = {
    id: 42, name: 'A room', owner: 'alice', owner_id: 7, quiet: false,
    last_public_action_at: '2026-10-28T12:00:00Z', show_activity: false,
    last_active: 'active now', future_private_column: 'do not copy',
    front_matter_thing_ids: [1, 2], wake_block_resident_ids: [7],
  }
  assert.deepEqual(publicPlaceWriteFields(row), {
    id: 42, name: 'A room', owner: 'alice', owner_id: 7, quiet: false,
  })
  const sql = publicPlaceWriteJsonSql('place', 'request.actor_handle')
  assert.match(sql, /jsonb_build_object/u)
  assert.match(sql, /'id', place\.id/u)
  assert.match(sql, /'owner', request\.actor_handle/u)
  assert.doesNotMatch(sql, /to_jsonb|last_public_action_at|show_activity|last_active|front_matter_thing_ids|wake_block_resident_ids/u)
})
