import test from 'node:test'
import assert from 'node:assert/strict'

import {
  readingCostMeter,
  safeReadingCostMeter,
  type ReadingCostMeter,
} from '../src/reading-cost.ts'

const successfulMeter: ReadingCostMeter = Object.freeze({
  available: true,
  size_unit: 'utf8_bytes',
  counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
  new_item_text_bytes: 4,
  room_stored_text_bytes: 10,
  current_first_read_text_bytes: 5,
})

test('reading-cost response deadlines reject every unsafe boundary', async () => {
  for (const timeoutMs of [NaN, 1.5, 1, 60_001]) {
    await assert.rejects(
      () => safeReadingCostMeter(2, 'text', { timeoutMs }),
      /integer from 2 to 60000/iu,
    )
  }
  for (const statementTimeoutMs of [NaN, 0, 60_001]) {
    await assert.rejects(
      () => readingCostMeter(2, 'text', {
        signal: AbortSignal.timeout(50),
        statementTimeoutMs,
      }),
      /database timeout must be an integer from 1 to 60000/iu,
    )
  }
})

test('reading-cost loader receives a shorter database deadline and can succeed', async () => {
  const result = await safeReadingCostMeter(2, 'text', {
    timeoutMs: 400,
    load: async (placeId, text, controls) => {
      assert.equal(placeId, 2)
      assert.equal(text, 'text')
      assert.equal(controls.statementTimeoutMs, 300)
      assert.equal(controls.signal.aborted, false)
      return successfulMeter
    },
  })
  assert.equal(result, successfulMeter)

  await safeReadingCostMeter(2, 'text', {
    timeoutMs: 2,
    load: async (_placeId, _text, controls) => {
      assert.equal(controls.statementTimeoutMs, 1)
      return successfulMeter
    },
  })
})

test('database cancellation is reported as a timeout even through wrapped errors', async () => {
  const result = await safeReadingCostMeter(2, 'four', {
    timeoutMs: 50,
    load: async () => {
      throw { sourceError: { sourceError: { code: '57014' } } }
    },
  })

  assert.deepEqual(result, {
    available: false,
    reason: 'measurement_timeout',
    measurement_timeout_ms: 50,
    size_unit: 'utf8_bytes',
    counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
    new_item_text_bytes: 4,
    room_stored_text_bytes: null,
    current_first_read_text_bytes: null,
    note: 'the write succeeded; the reading-cost measurement timed out and its database query has a bounded deadline; do not retry',
  })
})

test('generic and over-deep database errors fail only the informational meter', async t => {
  const messages: unknown[][] = []
  t.mock.method(console, 'error', (...values: unknown[]) => { messages.push(values) })

  const tooDeep: Record<string, unknown> = {}
  let nested = tooDeep
  for (let index = 0; index < 6; index += 1) {
    nested.sourceError = {}
    nested = nested.sourceError as Record<string, unknown>
  }
  nested.code = '57014'

  for (const error of [new Error('measurement failed'), tooDeep, null, 'plain failure']) {
    const result = await safeReadingCostMeter(2, '🏙', {
      timeoutMs: 50,
      load: async () => { throw error },
    })
    assert.equal(result.available, false)
    if (!result.available) {
      assert.equal(result.reason, 'measurement_failed')
      assert.equal(result.new_item_text_bytes, 4)
    }
  }
  assert.equal(messages.length, 4)
})

test('the response timer aborts a loader that never settles', async () => {
  let observedSignal: AbortSignal | undefined
  const result = await safeReadingCostMeter(2, 'text', {
    timeoutMs: 2,
    load: async (_placeId, _text, controls) => {
      observedSignal = controls.signal
      return await new Promise<ReadingCostMeter>(() => {})
    },
  })

  assert.equal(result.available, false)
  if (!result.available) assert.equal(result.reason, 'measurement_timeout')
  assert.equal(observedSignal?.aborted, true)
})
