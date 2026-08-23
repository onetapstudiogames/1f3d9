import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseThogPublicActionArguments,
  readThogPublicActionOutcome,
} from '../scripts/check-thog-public-actions.ts'

test('the Thog outcome check makes one anonymous public-action read and keeps only the total', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return Response.json({
      events: [{
        id: 45848,
        at: '2026-08-23T03:10:54.008Z',
        kind: 'action',
        actor: 'thog',
        detail: { body: 'must not enter the outcome record' },
      }],
      total_items: 1064,
      total_text_bytes: 42,
      returned_items: 1,
      returned_text_bytes: 42,
      has_more: true,
      next_before_id: 45848,
    })
  }

  const outcome = await readThogPublicActionOutcome({
    fetcher,
    now: () => new Date('2026-08-23T03:27:18.488Z'),
  })

  assert.equal(calls.length, 1)
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin, 'https://1f3d9.com')
  assert.equal(url.pathname, '/api/events')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    actor: 'thog',
    kind: 'action',
    limit: '1',
  })
  assert.deepEqual(calls[0]!.init, {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  })
  assert.deepEqual(outcome, {
    captured_at: '2026-08-23T03:27:18.488Z',
    source: 'https://1f3d9.com/api/events?actor=thog&kind=action&limit=1',
    resident: 'thog',
    public_action_total: 1064,
    comparison_note:
      'A later increase proves only that more public actions appeared. No change is inconclusive and is not a release gate.',
  })
  assert.equal(JSON.stringify(outcome).includes('must not enter'), false)
  assert.equal(JSON.stringify(outcome).includes('45848'), false)
  assert.equal(JSON.stringify(outcome).includes('03:10:54'), false)
})

test('the Thog outcome check handles no actions without inventing activity', async () => {
  const outcome = await readThogPublicActionOutcome({
    fetcher: async () => Response.json({
      events: [],
      total_items: 0,
      total_text_bytes: 0,
      returned_items: 0,
      returned_text_bytes: 0,
      has_more: false,
      next_before_id: null,
    }),
    now: () => new Date('2026-08-23T04:00:00.000Z'),
  })

  assert.equal(outcome.public_action_total, 0)
  assert.equal('latest_public_action' in outcome, false)
})

test('the Thog outcome check rejects malformed public data', async () => {
  for (const payload of [
    {},
    { events: [], total_items: -1, returned_items: 0 },
    { events: [], total_items: 1, returned_items: 0 },
    {
      events: [{ id: 1, kind: 'note', actor: 'thog' }],
      total_items: 1,
      returned_items: 1,
    },
    {
      events: [{ id: 1, kind: 'action', actor: 'someone-else' }],
      total_items: 1,
      returned_items: 1,
    },
  ]) {
    await assert.rejects(
      readThogPublicActionOutcome({ fetcher: async () => Response.json(payload) }),
      /public action response/iu,
    )
  }
})

test('the Thog outcome CLI accepts no resident selector', () => {
  assert.deepEqual(parseThogPublicActionArguments([]), {})
  for (const args of [['thog'], ['--handle', 'thog'], ['--resident', 'someone-else']]) {
    assert.throws(() => parseThogPublicActionArguments(args), /takes no arguments/iu)
  }
})
