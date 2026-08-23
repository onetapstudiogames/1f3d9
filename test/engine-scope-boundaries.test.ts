import test from 'node:test'
import assert from 'node:assert/strict'

import { EngineError, type RuntimeTarget, type TaggedSql } from '../src/engine.ts'
import {
  requireCallerTargetScope,
  requireResidentAtActionPlace,
} from '../src/engine-target-scope.ts'

const dbReturning = (value: unknown): TaggedSql => (async () => value) as TaggedSql

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

test('resident scope rejects missing, malformed, absent, and remote presence', async () => {
  await expectEngineError(
    () => requireResidentAtActionPlace(8, 2, dbReturning({})),
    500,
    /invalid result/iu,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, 2, dbReturning([])),
    404,
    /presence not found/iu,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, null, dbReturning([{ current_place_id: 2 }])),
    403,
    /not in the action place/iu,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, 2, dbReturning([{ current_place_id: 'bad' }])),
    500,
    /current place id/iu,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, 2, dbReturning([{ current_place_id: 0 }])),
    500,
    /current place id/iu,
  )

  await requireResidentAtActionPlace(8, 2, dbReturning([{ current_place_id: '2' }]))
})

test('caller target scope directly checks every target type and database boundary', async () => {
  await expectEngineError(
    () => requireCallerTargetScope({ type: 'place', id: 9 }, 7, 2, dbReturning([])),
    403,
    /not the action place/iu,
  )
  await requireCallerTargetScope({ type: 'place', id: 2 }, 7, 2, dbReturning([]))

  for (const row of [undefined, { place_id: 2, withdrawn_at: 'now' }]) {
    await expectEngineError(
      () => requireCallerTargetScope(
        { type: 'thing', id: 42 },
        7,
        2,
        dbReturning(row === undefined ? [] : [row]),
      ),
      404,
      /thing target not found/iu,
    )
  }
  await expectEngineError(
    () => requireCallerTargetScope(
      { type: 'thing', id: 42 },
      7,
      2,
      dbReturning([{ place_id: 3, withdrawn_at: null }]),
    ),
    403,
    /not in the action place/iu,
  )
  await requireCallerTargetScope(
    { type: 'thing', id: 42 },
    7,
    2,
    dbReturning([{ place_id: '2', withdrawn_at: null }]),
  )

  await expectEngineError(
    () => requireCallerTargetScope({ type: 'kind', id: 9 }, 7, 2, dbReturning([])),
    404,
    /kind target not found/iu,
  )
  await expectEngineError(
    () => requireCallerTargetScope({ type: 'kind', id: 9 }, 7, 2, dbReturning([{ owner_id: 8 }])),
    403,
    /not owned/iu,
  )
  await expectEngineError(
    () => requireCallerTargetScope({ type: 'kind', id: 9 }, 7, 2, dbReturning([{ owner_id: 1.5 }])),
    500,
    /kind owner id/iu,
  )
  await requireCallerTargetScope(
    { type: 'kind', id: 9 } as RuntimeTarget,
    7,
    2,
    dbReturning([{ owner_id: '7' }]),
  )
})
