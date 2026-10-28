import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('stored activity uses the existing row and stops before the off timestamp', async () => {
  const { publicActivitySql, publicActivityFields } = await import('../src/public-activity.ts')
  const resident = publicActivitySql('resident', true)
  assert.match(resident, /CASE\s+WHEN NOT resident\.show_activity THEN NULL/u)
  assert.match(resident, /WHEN resident\.last_public_action_at IS NULL THEN NULL/u)
  assert.match(resident, /WHEN resident\.last_public_action_at > statement_timestamp\(\) THEN NULL/u)
  assert.equal(/\b(?:SELECT|JOIN|events|resident_settings)\b/u.test(resident), false)
  const room = publicActivitySql('p', false)
  assert.equal(room.includes('show_activity'), false)
  for (const band of ['active now', 'today', 'this week', 'longer']) {
    assert.deepEqual(publicActivityFields(band), { last_active: band })
  }
  for (const absent of [undefined, null, false, 'off', 'unavailable', '', 'tomorrow']) {
    assert.deepEqual(publicActivityFields(absent), {})
  }
})

test('main public reads calculate bands in their existing SQL without an activity query', async () => {
  const residents = await readFile(new URL('../src/public-residents.ts', import.meta.url), 'utf8')
  const places = await readFile(new URL('../src/public-records.ts', import.meta.url), 'utf8')
  const window = await readFile(new URL('../src/window.ts', import.meta.url), 'utf8')
  assert.equal((residents.match(/publicActivitySql\('resident', true\)/gu) ?? []).length, 3)
  assert.match(places, /includeActivity/u)
  assert.match(places, /publicActivitySql\('p', false\)/u)
  assert.equal(/readPublicResidentActivity|readPublicRoomActivity|public-activity-rooms/u.test(residents + places), false)
  assert.match(residents, /filter\(kind => kind !== 'wake_try_applied'\)/u)
  assert.match(window, /kind = ANY\(\$\{PUBLIC_RESIDENT_ASLEEP_EVENT_KINDS\}/u)
})
