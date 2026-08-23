import test from 'node:test'
import assert from 'node:assert/strict'

import { readThogPublicActionOutcome } from '../scripts/check-thog-public-actions.ts'

test('the public-action check rejects HTTP and JSON transport failures', async () => {
  await assert.rejects(
    () => readThogPublicActionOutcome({
      fetcher: async () => new Response('unavailable', { status: 503 }),
    }),
    /HTTP 503/iu,
  )
  await assert.rejects(
    () => readThogPublicActionOutcome({
      fetcher: async () => new Response('{not json}', {
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /invalid/iu,
  )
})

test('the public-action check rejects mismatched counts and malformed latest events', async () => {
  const invalid = [
    [],
    { events: [{ id: 1 }, { id: 2 }], total_items: 2, returned_items: 2 },
    { events: [], total_items: 0, returned_items: 1 },
    { events: [{ id: 1, kind: 'action', actor: 'thog' }], total_items: 0, returned_items: 1 },
    { events: [{ id: 0, kind: 'action', actor: 'thog' }], total_items: 1, returned_items: 1 },
    { events: [{ id: '1', kind: 'action', actor: 'thog' }], total_items: 1, returned_items: 1 },
  ]
  for (const payload of invalid) {
    await assert.rejects(
      () => readThogPublicActionOutcome({ fetcher: async () => Response.json(payload) }),
      /invalid/iu,
    )
  }
})

test('default fetch and clock remain anonymous and produce a current capture', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    events: [],
    total_items: 0,
    returned_items: 0,
  }))

  const before = Date.now()
  const result = await readThogPublicActionOutcome()
  const after = Date.now()
  const captured = Date.parse(result.captured_at)
  assert.equal(captured >= before && captured <= after, true)
})
