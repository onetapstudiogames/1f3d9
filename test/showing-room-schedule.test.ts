import assert from 'node:assert/strict'
import test from 'node:test'
import { latestShowingRoomSlot, parseShowingRoomSlot, showingRoomSchedule } from '../src/showing-room-schedule.ts'

test('the first November opening fixes Saturday and Monday at 15:00 UTC', () => {
  assert.deepEqual(showingRoomSchedule('2026-11-02T15:00:00.000Z'), {
    slot: '2026-11-02T15:00:00.000Z',
    entries_close_at: '2026-11-07T15:00:00.000Z',
    votes_close_at: '2026-11-09T15:00:00.000Z',
    gazette_cutoff_at: '2026-11-02T16:00:00.000Z',
  })
})

test('UTC dates cross daylight-saving changes without changing the hour', () => {
  assert.equal(showingRoomSchedule('2026-10-26T15:00:00.000Z')?.votes_close_at,
    '2026-11-02T15:00:00.000Z')
  assert.equal(showingRoomSchedule('2027-03-08T15:00:00.000Z')?.votes_close_at,
    '2027-03-15T15:00:00.000Z')
})

test('only a real Monday 15:00 UTC instant can be a scheduled opening', () => {
  for (const invalid of ['no date', '2026-11-03T15:00:00.000Z', '2026-11-02T15:00:00.001Z',
    '2026-11-02T15:10:00.000Z', '2026-02-30T15:00:00.000Z', '2026-13-02T15:00:00.000Z']) {
    assert.equal(showingRoomSchedule(invalid), null)
  }
})

test('late invocations use the latest due Monday without moving its deadlines', () => {
  assert.equal(latestShowingRoomSlot('2026-11-02T14:59:59.999Z'), '2026-10-26T15:00:00.000Z')
  assert.equal(latestShowingRoomSlot('2026-11-02T15:00:00.000Z'), '2026-11-02T15:00:00.000Z')
  assert.equal(latestShowingRoomSlot('2026-11-08T23:59:59.999Z'), '2026-11-02T15:00:00.000Z')
  assert.equal(latestShowingRoomSlot('no date'), null)
})

test('expanded years and derived closes outside four-digit years are refused without throwing', () => {
  for (const instant of ['+010000-01-03T15:00:00.000Z', '+275760-09-08T15:00:00.000Z',
    '9999-12-27T15:00:00.000Z']) {
    assert.equal(showingRoomSchedule(instant), null)
  }
  assert.equal(latestShowingRoomSlot('+010000-01-03T15:00:00.000Z'), null)
  assert.equal(showingRoomSchedule('9999-12-20T15:00:00.000Z')?.votes_close_at,
    '9999-12-27T15:00:00.000Z')
  assert.equal(parseShowingRoomSlot('9999-12-27T15:00:00Z'), '9999-12-27T15:00:00.000Z')
  assert.equal(parseShowingRoomSlot('+010000-01-03T15:00:00.000Z'), null)
})

test('four-digit years below 0100 keep their real calendar year in the due-slot calculation', () => {
  assert.equal(latestShowingRoomSlot('0099-12-28T15:00:00.000Z'), '0099-12-28T15:00:00.000Z')
  assert.equal(latestShowingRoomSlot('0000-01-01T00:00:00.000Z'), null)
})
