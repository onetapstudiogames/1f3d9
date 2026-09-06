import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CommitOutcomeUnknownError,
  UNCONFIRMED_ACTION_ERROR,
  runAction,
  setEngineTransactionRunnerForTests,
  type ActionInput,
} from '../../src/engine.ts'
import { COLLISION_CONFLICT_MESSAGE } from '../../src/core.ts'
import { fakeSql, type Call } from './context.ts'

export function registerCommitOutcomeTests(): void {
  function uncertainCommitResponder(
    resolutionRows: () => Record<string, unknown>[],
  ): (call: Call) => unknown[] {
    return ({ text }) => {
      if (/SELECT status, detail FROM action_resolutions/.test(text)) return resolutionRows()
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 240 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 340 }]
      return []
    }
  }

  const UNCERTAIN_COMMIT_ACTION: ActionInput = {
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
  }

  function failedResolutionWrites(calls: Call[]): Call[] {
    return calls.filter(call =>
      /INSERT INTO action_resolutions/.test(call.text) && call.values[1] === 'failed')
  }

  test('an uncertain commit resolves to the recorded outcome instead of a failure', async () => {
    const { db, calls } = fakeSql(uncertainCommitResponder(
      () => [{ status: 'applied', detail: { effects_applied: 2 } }],
    ))
    setEngineTransactionRunnerForTests(async (database, work) => {
      await work(database, true)
      throw new CommitOutcomeUnknownError(new Error('connection closed before the commit reply'))
    })
    try {
      const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
      assert.equal(result.status, 'applied')
      assert.equal(result.httpStatus, 200)
      assert.equal(result.error, null)
      assert.equal(result.effectsApplied, 2)
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
    assert.equal(failedResolutionWrites(calls).length, 0)
  })

  test('an uncertain commit whose failure record wins is a plain retryable conflict', async () => {
    const { db, calls } = fakeSql(uncertainCommitResponder(() => []))
    setEngineTransactionRunnerForTests(async (database, work) => {
      await work(database, true)
      throw new CommitOutcomeUnknownError(
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      )
    })
    try {
      const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
      assert.equal(result.status, 'failed')
      assert.equal(result.httpStatus, 409)
      assert.equal(result.error, COLLISION_CONFLICT_MESSAGE)
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
    assert.equal(failedResolutionWrites(calls).length, 1)
  })

  test('an uncertain commit that lands after the readback still answers with the committed outcome', async () => {
    let resolutionReads = 0
    const { db, calls } = fakeSql(({ text }) => {
      if (/SELECT status, detail FROM action_resolutions/.test(text)) {
        resolutionReads += 1
        // Invisible on the first read; the in-doubt commit lands while the
        // failure insert waits on the unique index and loses the conflict.
        return resolutionReads === 1 ? [] : [{ status: 'applied', detail: { effects_applied: 1 } }]
      }
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 240 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/INSERT INTO action_resolutions/.test(text)) return []
      return []
    })
    setEngineTransactionRunnerForTests(async (database, work) => {
      await work(database, true)
      throw new CommitOutcomeUnknownError(new Error('connection closed before the commit reply'))
    })
    try {
      const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
      assert.equal(result.status, 'applied')
      assert.equal(result.httpStatus, 200)
      assert.equal(result.error, null)
      assert.equal(result.effectsApplied, 1)
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
    assert.equal(resolutionReads, 2)
    assert.ok(calls.some(call =>
      /INSERT INTO action_resolutions/.test(call.text) && call.values[1] === 'failed'))
  })

  test('an unreadable outcome record never claims failure or invites a retry', async () => {
    const { db, calls } = fakeSql(uncertainCommitResponder(() => {
      throw Object.assign(new Error('the record read failed too'), { code: '57P01' })
    }))
    setEngineTransactionRunnerForTests(async (database, work) => {
      await work(database, true)
      throw new CommitOutcomeUnknownError(new Error('connection closed before the commit reply'))
    })
    try {
      const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
      assert.equal(result.status, 'unconfirmed')
      assert.equal(result.httpStatus, 500)
      assert.equal(result.error, UNCONFIRMED_ACTION_ERROR)
      assert.doesNotMatch(result.error ?? '', /retry/)
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
    assert.equal(failedResolutionWrites(calls).length, 0)
  })

  test('a raw serialization collision inside an action answers as a retryable conflict', async () => {
    const { db } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 243 }]
      if (/FROM active_blocks/.test(text)) {
        throw Object.assign(
          new Error('could not serialize access due to concurrent update'),
          { code: '40001' },
        )
      }
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 343 }]
      return []
    })
    const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 409)
    assert.equal(result.error, COLLISION_CONFLICT_MESSAGE)
    assert.doesNotMatch(result.error ?? '', /serialize/)
  })
}
