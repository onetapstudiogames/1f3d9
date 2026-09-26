import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TALK_CHECK_MAX_MS, TALK_CHECK_MIN_MS, TALK_CHECK_MS, TALK_LINE_MARKER_SCAN, TALK_NOW_LISTENING_LIMIT,
  TALK_PAGE_LINES, TALK_PANE_HOURS, TALK_PRIVATE_CACHE_CONTROL, TALK_RETRY_MAX_MS, TALK_SHARED_CACHE_CONTROL,
  TALK_SHARED_CACHE_SECONDS, TALK_TARGET_MS,
} from '../src/talk-watch-limits.ts'

test('the talk numbers are the ones decisions 129 and 130 give', () => {
  assert.equal(TALK_CHECK_MS, 2_000)
  assert.equal(TALK_SHARED_CACHE_SECONDS, 2)
  assert.equal(TALK_SHARED_CACHE_CONTROL, 'public, max-age=0, s-maxage=2')
  assert.equal(TALK_PRIVATE_CACHE_CONTROL, 'private, no-store')
  assert.equal(TALK_NOW_LISTENING_LIMIT, 200)
  assert.equal(TALK_LINE_MARKER_SCAN, 20)
  assert.equal(TALK_CHECK_MIN_MS, 2_000)
  assert.equal(TALK_CHECK_MAX_MS, 600_000)
  assert.equal(TALK_TARGET_MS, 5_000)
  assert.equal(TALK_RETRY_MAX_MS, 30_000)
  assert.equal(TALK_PAGE_LINES, 50)
  assert.equal(TALK_PANE_HOURS, 24)
})

test('the shared cache lasts exactly one check, and one cache age plus one check stays under the target', () => {
  assert.equal(TALK_CHECK_MS % 1_000, 0)
  assert.equal(TALK_SHARED_CACHE_SECONDS * 1_000, TALK_CHECK_MS)
  assert.ok(TALK_CHECK_MS >= TALK_CHECK_MIN_MS && TALK_CHECK_MS <= TALK_CHECK_MAX_MS)
  assert.ok(2 * TALK_CHECK_MS < TALK_TARGET_MS,
    'turning the interval down means changing TALK_TARGET_MS and its served sentences in the same change')
})
