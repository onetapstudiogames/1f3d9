import assert from 'node:assert/strict'
import test from 'node:test'

function database(overrides: Readonly<Record<string, unknown>> = {}) {
  return { query: async () => [{
    now: '2026-11-09T15:10:00.000Z', enabled: true, paused: false,
    first_slot_at: '2026-11-02T15:00:00.000Z', queue_count: 2,
    last_slot_at: '2026-11-02T15:00:00.000Z', last_count_note_id: 300,
    last_skipped: false, failure_code: null, due_contest_at: '2026-11-09T15:00:00.000Z',
    ...overrides,
  }] }
}

test('a missed cron produces overdue attention without a failure write', async () => {
  const { readShowingRoomAttention } = await import('../src/showing-room-attention.ts')
  const result = await readShowingRoomAttention(database())
  assert.equal(result.queue_count, 2)
  assert.equal(result.last_count_note_id, 300)
  assert.equal(result.notice_code, 'overdue')
  assert.equal(JSON.stringify(result).includes('prompt'), false)
})

test('empty-week and failed-run notices persist across repeated passive reads', async () => {
  const { readShowingRoomAttention } = await import('../src/showing-room-attention.ts')
  for (const [changes, expected] of [
    [{ now: '2026-11-02T15:10:00.000Z', queue_count: 4, last_skipped: true, due_contest_at: null }, 'empty_backlog'],
    [{ failure_code: 'database_unavailable' }, 'failed'],
  ] as const) {
    const db = database(changes)
    const first = await readShowingRoomAttention(db)
    assert.equal(first.notice_code, expected)
    assert.deepEqual(await readShowingRoomAttention(db), first)
  }
})

test('attention failures never pretend that the queue is empty', async () => {
  const { readShowingRoomAttention } = await import('../src/showing-room-attention.ts')
  const result = await readShowingRoomAttention({ query: async () => { throw new Error('private prompt canary') } })
  assert.equal(result.queue_count, null)
  assert.equal(result.notice_code, 'unavailable')
  assert.equal(JSON.stringify(result).includes('private prompt canary'), false)
})

test('a late recovery that skips opening is never described as an empty backlog', async () => {
  const { readShowingRoomAttention } = await import('../src/showing-room-attention.ts')
  const result = await readShowingRoomAttention(database({ now: '2026-11-02T17:00:00.000Z',
    due_contest_at: null, last_skipped: true, last_late: true, last_recovery_run_id: 1 }))
  assert.equal(result.notice_code, 'late_recovery')
  assert.equal(result.notice, 'The showing room completed a late slot. No new question opened. The backlog resumes at the next Monday slot.')
})
