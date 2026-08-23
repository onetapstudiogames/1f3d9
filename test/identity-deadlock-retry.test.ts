import assert from 'node:assert/strict'
import test from 'node:test'

import { retryIdentityDeadlockOnce } from '../src/identity-store.ts'

test('identity confirmation retries one aborted deadlock and returns the retry result', async () => {
  let attempts = 0
  const result = await retryIdentityDeadlockOnce(async () => {
    attempts += 1
    if (attempts === 1) {
      throw Object.assign(new Error('deadlock detected'), { sourceError: { code: '40P01' } })
    }
    return { residentId: 1, handle: 'resident' }
  })

  assert.deepEqual(result, { residentId: 1, handle: 'resident' })
  assert.equal(attempts, 2)
})

test('identity confirmation never retries a second deadlock', async () => {
  let attempts = 0
  await assert.rejects(
    retryIdentityDeadlockOnce(async () => {
      attempts += 1
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
    }),
    (error: unknown) => (error as { code?: unknown }).code === '40P01',
  )
  assert.equal(attempts, 2)
})

test('identity confirmation does not retry another database error', async () => {
  let attempts = 0
  await assert.rejects(
    retryIdentityDeadlockOnce(async () => {
      attempts += 1
      throw Object.assign(new Error('constraint failed'), { code: '23514' })
    }),
    (error: unknown) => (error as { code?: unknown }).code === '23514',
  )
  assert.equal(attempts, 1)
})
