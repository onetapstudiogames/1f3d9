import test from 'node:test'
import assert from 'node:assert/strict'

import { EngineError, type TaggedSql } from '../src/engine.ts'
import {
  insertPendingEffect,
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
  type PendingEffectInsert,
} from '../src/engine-timer-store.ts'

const input: PendingEffectInsert = Object.freeze({
  actionId: 1,
  parentEffectId: null,
  placeId: 2,
  actorId: 3,
  sourceTraitId: 4,
  sourceThingId: null,
  targetType: 'place',
  targetId: 2,
  destinationPlaceId: null,
  recipientId: null,
  payloadJson: '{}',
  logicalDueAt: '2026-08-23T12:34:56.000Z',
  generation: 0,
})

function timerDb(options: Readonly<{
  counts?: unknown
  insert?: unknown
  invalidLock?: boolean
}> = {}): TaggedSql {
  return (async (strings: TemplateStringsArray) => {
    const text = strings.join(' ')
    if (/pg_advisory_xact_lock/u.test(text)) return options.invalidLock ? {} : []
    if (/place_pending/u.test(text)) return options.counts ?? [{ place_pending: 0, actor_pending: 0 }]
    if (/WITH scheduled/u.test(text)) return options.insert ?? [{ id: 1 }]
    return []
  }) as TaggedSql
}

async function expectEngineError(
  operation: () => Promise<unknown>,
  status: number,
  message: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => (
    error instanceof EngineError
    && error.status === status
    && message.test(error.message)
  ))
}

test('pending-effect queues reject invalid database shapes and counts', async () => {
  await expectEngineError(
    () => insertPendingEffect(input, timerDb({ invalidLock: true })),
    500,
    /invalid result/iu,
  )
  await expectEngineError(
    () => insertPendingEffect(input, timerDb({ counts: [] })),
    500,
    /counts are unavailable/iu,
  )
  for (const [field, counts] of [
    ['place', [{ place_pending: 'bad', actor_pending: 0 }]],
    ['actor', [{ place_pending: 0, actor_pending: -1 }]],
    ['place', [{ place_pending: 1.5, actor_pending: 0 }]],
  ] as const) {
    await expectEngineError(
      () => insertPendingEffect(input, timerDb({ counts })),
      500,
      new RegExp(`${field} pending count`, 'iu'),
    )
  }
})

test('pending-effect queue ceilings are enforced independently', async () => {
  await expectEngineError(
    () => insertPendingEffect(input, timerDb({
      counts: [{ place_pending: MAX_PENDING_EFFECTS_PER_PLACE, actor_pending: 0 }],
    })),
    429,
    /limit reached for place/iu,
  )
  await expectEngineError(
    () => insertPendingEffect(input, timerDb({
      counts: [{ place_pending: 0, actor_pending: MAX_PENDING_EFFECTS_PER_ACTOR }],
    })),
    429,
    /pending effect limit/iu,
  )
})

test('pending-effect insertion accepts numeric strings and detects a lost write', async () => {
  await insertPendingEffect(input, timerDb({
    counts: [{ place_pending: '511', actor_pending: '1023' }],
  }))
  await expectEngineError(
    () => insertPendingEffect(input, timerDb({ insert: [] })),
    500,
    /could not be scheduled/iu,
  )
})
