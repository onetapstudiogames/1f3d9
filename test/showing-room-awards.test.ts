import assert from 'node:assert/strict'
import test from 'node:test'
import { countShowingRoom } from '../src/showing-room-count.ts'
import { showingRoomSchedule } from '../src/showing-room-schedule.ts'

test('the last supported opening can finish its valid closing week without needing another opening', async () => {
  const { issueShowingRoomAwards } = await import('../src/showing-room-awards.ts')
  const schedule = showingRoomSchedule('9999-12-20T15:00:00.000Z')
  assert.ok(schedule)
  assert.equal(schedule.votes_close_at, '9999-12-27T15:00:00.000Z')
  const count = countShowingRoom({
    rule_version: 'showing-room-v1', rules_note_id: 100, opens_at: schedule.slot,
    entries_close_at: schedule.entries_close_at, votes_close_at: schedule.votes_close_at,
  }, [])
  const receipts = await issueShowingRoomAwards({ query: async () => {
    assert.fail('a contest with no entries must not write a credit')
  } }, { state: 'open', question_number: 11, vote_closes_at: schedule.votes_close_at }, count)
  assert.deepEqual(receipts, [])
})
