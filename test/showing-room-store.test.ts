import assert from 'node:assert/strict'
import test from 'node:test'

test('private list returns independently paged questions and run summaries', async () => {
  const { listShowingRoom } = await import('../src/showing-room-store.ts')
  const calls: unknown[][] = []
  const query = async (text: string, params: readonly unknown[] = []) => {
    calls.push([...params])
    return text.includes('showing:list-contests')
      ? [{ id: '9', title: 'Synthetic', prompt: 'Private synthetic', state: 'queued', revision: 1 }, { id: '8' }]
      : [{ id: '7', slot_at: '2026-11-02T15:00:00.000Z', completed_at: '2026-11-02T15:01:00.000Z', result: { count_note_id: 42 }, late: false, skipped: false }, { id: '6' }]
  }
  const result = await listShowingRoom({ query, transaction: async work => work({ query }) }, { before_id: 10, before_run_id: 8, limit: 1 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const value = result.value as Record<string, any>
  assert.equal(value.contests[0].id, 9)
  assert.equal(value.runs[0].id, 7)
  assert.equal(value.next_before_id, 9)
  assert.equal(value.next_before_run_id, 7)
  assert.deepEqual(calls, [[10, 2], [8, 2]])
})

test('queued text reserves the longest allowed question heading before accepting it', async () => {
  const { addShowingRoomContest } = await import('../src/showing-room-store.ts')
  const { renderShowingRules, showingQuestionHeading } = await import('../src/showing-room-copy.ts')
  const base = { title: 'A', prompt: 'B', entryClosesAt: '2026-11-07T15:00:00.000Z', voteClosesAt: '2026-11-09T15:00:00.000Z' }
  const shorter = renderShowingRules({ ...base, questionNumber: 2_147_483_647 })
  const prompt = 'x'.repeat(4001 - shorter.length)
  assert.throws(() => renderShowingRules({ ...base, prompt, questionNumber: 1_777_777_777 }), /4000/u)
  const longest = showingQuestionHeading(1_777_777_777).length
  for (let group = 1; group < 1000; group++) {
    for (const number of [1_000_777_777 + group * 1_000_000, 1_777_000_777 + group * 1000, 1_777_777_000 + group]) {
      assert.ok(showingQuestionHeading(number).length <= longest)
    }
  }
  const query = async (text: string) => text.includes('FOR UPDATE')
    ? [{ ready: true, now: '2026-11-02T15:00:00.000Z', management_window_start: null, management_writes: 0, control_requests: {} }]
    : text.includes('INSERT INTO') ? [{ id: 1, revision: 1 }] : []
  const result = await addShowingRoomContest({ query, transaction: async work => work({ query }) }, { request_id: 'heading-bound', title: 'A', prompt })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 400)
})
