import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PUBLIC_SEARCH_RATE_CAPACITY,
  PUBLIC_SEARCH_TOKEN_REFILL_MS,
  takePublicSearchToken,
} from '../src/public-search-rate-limit.ts'

test('public search has a bounded ephemeral per-caller token bucket', () => {
  const caller = `test-${Date.now()}-${Math.random()}`
  const startedAt = 10_000

  for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
    assert.deepEqual(takePublicSearchToken(caller, startedAt), {
      allowed: true,
      retryAfterSeconds: 0,
    })
  }
  assert.deepEqual(takePublicSearchToken(caller, startedAt), {
    allowed: false,
    retryAfterSeconds: Math.ceil(PUBLIC_SEARCH_TOKEN_REFILL_MS / 1_000),
  })
  assert.deepEqual(takePublicSearchToken(caller, startedAt + PUBLIC_SEARCH_TOKEN_REFILL_MS), {
    allowed: true,
    retryAfterSeconds: 0,
  })
  assert.deepEqual(takePublicSearchToken(`${caller}-other`, startedAt), {
    allowed: true,
    retryAfterSeconds: 0,
  })
})
