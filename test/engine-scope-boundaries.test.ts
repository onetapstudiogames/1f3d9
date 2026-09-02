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
    /presence was not found/iu,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, null, dbReturning([{ current_place_id: 2 }])),
    403,
    /^target resident cannot be used because place_id is unset; send place_id and retry$/u,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, 2, dbReturning([{ current_place_id: null }])),
    403,
    /^target resident must be standing in place_id 2; target current place_id is unset$/u,
  )
  await expectEngineError(
    () => requireResidentAtActionPlace(8, 2, dbReturning([{ current_place_id: 3 }])),
    403,
    /^target resident must be standing in place_id 2; target current place_id is 3$/u,
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
    () => requireCallerTargetScope({ type: 'place', id: 9 }, 7, null, dbReturning([])),
    403,
    /^target place_id 9 cannot be used because place_id is unset; send place_id and retry$/u,
  )
  await expectEngineError(
    () => requireCallerTargetScope({ type: 'place', id: 9 }, 7, 2, dbReturning([])),
    403,
    /^target place_id 9 must match place_id 2$/u,
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
      /^thing target was not found; choose a current active thing_id$/u,
    )
  }
  await expectEngineError(
    () => requireCallerTargetScope(
      { type: 'thing', id: 42 },
      7,
      null,
      dbReturning([{ place_id: 3, withdrawn_at: null }]),
    ),
    403,
    /^target thing cannot be used because place_id is unset; send place_id and retry$/u,
  )
  await expectEngineError(
    () => requireCallerTargetScope(
      { type: 'thing', id: 42 },
      7,
      2,
      dbReturning([{ place_id: 3, withdrawn_at: null }]),
    ),
    403,
    /^target thing must be in place_id 2; target current place_id is 3$/u,
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
    /kind target was not found/iu,
  )
  await expectEngineError(
    () => requireCallerTargetScope({ type: 'kind', id: 9 }, 7, 2, dbReturning([{ owner_id: 8 }])),
    403,
    /^target kind is not owned by you; choose a kind you own$/u,
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
