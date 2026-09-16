import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  FLAG_REVIEW_NOTE_CHARACTERS,
  flagHandleDecision,
  handleFlag,
  readFounderFlagQueue,
  type FlagReviewQuery,
} from '../src/flag-review.ts'

test('a flag handle body must carry a moderation id, a one-line note, or both', () => {
  assert.deepEqual(flagHandleDecision({ moderation_id: 77 }), { moderationId: 77, note: null })
  assert.deepEqual(flagHandleDecision({ note: '  no action  ' }), { moderationId: null, note: 'no action' })
  assert.deepEqual(flagHandleDecision({ moderation_id: 77, note: 'removed' }), {
    moderationId: 77, note: 'removed',
  })
  for (const refused of [
    null, 'note', [], {}, { note: '' }, { note: '   ' }, { note: 'two\nlines' },
    { note: 'one\ttab' }, { note: 'x'.repeat(FLAG_REVIEW_NOTE_CHARACTERS + 1) },
    { moderation_id: 0 }, { moderation_id: 'seven' }, { note: 'ok', extra: true },
  ]) assert.equal(flagHandleDecision(refused), null, JSON.stringify(refused))
})

test('the founder flag queue keeps anonymous reports anonymous and reads timestamps once', async () => {
  const query: FlagReviewQuery = async text =>
    text.includes('flag-unhandled-count') ? [{ count: 1 }] : [
      {
        id: 4, reporter_id: null, reporter_handle: null, target_type: 'thing', target_id: 41,
        reason: 'an anonymous reader wrote this', created_at: new Date('2026-09-14T00:00:00Z'),
        handled_at: null, moderation_id: null, note: null,
      },
      {
        id: 3, reporter_id: 7, reporter_handle: 'tiny-lantern', target_type: 'note', target_id: 51,
        reason: 'a resident wrote this', created_at: '2026-09-10T00:00:00.000Z',
        handled_at: new Date('2026-09-11T00:00:00Z'), moderation_id: 77, note: null,
      },
    ]
  const queue = await readFounderFlagQueue(query)
  assert.equal(queue.unhandledCount, 1)
  assert.equal(queue.flags[0]?.reporter, null)
  assert.equal(queue.flags[0]?.created_at, '2026-09-14T00:00:00.000Z')
  assert.deepEqual(queue.flags[1]?.reporter, { id: 7, handle: 'tiny-lantern' })
  assert.deepEqual(queue.flags[1]?.handled, {
    at: '2026-09-11T00:00:00.000Z', moderation_id: 77, note: null,
  })
})

test('handling a flag refuses a missing flag and never overwrites an existing answer', async () => {
  const empty: FlagReviewQuery = async () => []
  assert.deepEqual(await handleFlag(empty, 4040, 1, { moderationId: null, note: 'no action' }), {
    outcome: 'not_found',
  })
  const standing: FlagReviewQuery = async () => [{
    disposition: 'already_handled', handled_at: '2026-09-11T00:00:00.000Z',
    moderation_id: 77, note: null,
  }]
  assert.equal(
    (await handleFlag(standing, 3, 1, { moderationId: 77, note: null })).outcome,
    'already_handled',
  )
  assert.equal(
    (await handleFlag(standing, 3, 1, { moderationId: null, note: 'no action' })).outcome,
    'differently_handled',
  )
  await assert.rejects(
    handleFlag(empty, 3, 1, { moderationId: null, note: null }),
    /flag review input is invalid/iu,
  )
})

test('the founder flag reader is absent from MCP', () => {
  const mcpSource = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(mcpSource, /name:\s*['"][^'"]*flag[^'"]+/iu)
})
