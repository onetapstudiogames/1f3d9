import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentAttemptConflictError,
  createOrReadPaymentAttempt,
  type PaymentAttemptInput,
} from '../../src/payment-attempts.ts'
import { NONCE, PAYER, USDC, QueuedDatabase, input, row } from '../helpers/payment-attempts-fixtures/attempt-records.ts'

export function registerCreationAndReplayTests(): void {
  test('create-or-read returns an exact live attempt without another insert', async () => {
    const existing = row()
    const database = new QueuedDatabase([existing])

    const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

    assert.equal(result.disposition, 'existing')
    assert.equal(result.attempt.publicId, existing.publicId)
    assert.equal(database.calls.length, 1)
    assert.match(database.calls[0]?.text ?? '', /WITH\s+closed_due_target\s+AS/iu)
    assert.match(database.calls[0]?.text ?? '', /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
    assert.match(
      database.calls[0]?.text ?? '',
      /operation\s+IN\s*\(\s*'frontier'\s*,\s*'kind_invention'\s*,\s*'kind_revision'\s*\)/iu,
    )
    assert.match(database.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*,\s*'completed'/iu)
  })

  test('create-or-read accepts the legacy bare query function shape used by paid routes', async () => {
    const existing = row()
    const calls: { text: string; params: readonly unknown[] }[] = []
    const query = async (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params: [...params] })
      return [existing]
    }

    const result = await createOrReadPaymentAttempt(query, input(), () => 'pay_new_0000000001')

    assert.equal(result.disposition, 'existing')
    assert.equal(result.attempt.publicId, existing.publicId)
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.text ?? '', /payment_attempts/iu)
  })

  test('create-or-read inserts a new attempt with canonical request data and no signature', async () => {
    const created = row({ publicId: 'pay_new_0000000001' })
    const database = new QueuedDatabase([], [created])

    const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

    assert.equal(result.disposition, 'created')
    assert.equal(result.attempt.publicId, 'pay_new_0000000001')
    assert.equal(database.calls.length, 2)
    assert.match(database.calls[1]?.text ?? '', /INSERT\s+INTO\s+payment_attempts/iu)
    assert.match(database.calls[1]?.text ?? '', /ON\s+CONFLICT\s+DO\s+NOTHING/iu)
    assert.ok(database.calls[1]?.params.includes('{"nested":{"a":1,"b":2},"offer_id":91}'))
    assert.ok(!database.calls[1]?.params.some(value => typeof value === 'string' && value.includes('signature')))
  })

  test('create-or-read rejects changed immutable terms for a live target', async () => {
    const changes: Partial<PaymentAttemptInput>[] = [
      { actorId: 9 },
      { operation: 'world_sale' },
      { assetId: 43 },
      { payeeWallet: PAYER },
      { amountUnits: 2_000_001n },
      { request: { offer_id: 91, nested: { a: 1, b: 3 } } },
    ]

    for (const change of changes) {
      const database = new QueuedDatabase([row()])
      await assert.rejects(
        createOrReadPaymentAttempt(database, input(change), () => 'pay_new_0000000001'),
        (error: unknown) => error instanceof PaymentAttemptConflictError,
      )
    }
  })

  test('a completed nonce replays across a server-derived target change but not a changed request', async () => {
    const completed = row({
      status: 'completed',
      responseStatus: 200,
      response: { ok: true },
      responseBody: '{"ok":true}',
    })
    const replay = await createOrReadPaymentAttempt(
      new QueuedDatabase([completed]),
      input({ targetKey: 'direct-sale:91:state-after-completion' }),
      () => 'pay_new_0000000001',
    )

    assert.equal(replay.disposition, 'existing')
    assert.equal(replay.attempt.publicId, completed.publicId)

    await assert.rejects(
      createOrReadPaymentAttempt(
        new QueuedDatabase([completed]),
        input({
          targetKey: 'direct-sale:91:state-after-completion',
          request: { offer_id: 91, nested: { a: 1, b: 999 } },
        }),
        () => 'pay_new_0000000001',
      ),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
  })

  test('a concurrent insert conflict is re-read by target or exact x402 nonce', async () => {
    const concurrent = row()
    const database = new QueuedDatabase([], [], [concurrent])

    const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

    assert.equal(result.disposition, 'existing')
    assert.equal(database.calls.length, 3)
    assert.match(database.calls[2]?.text ?? '', /x402_nonce/iu)
    for (const value of ['base', USDC, PAYER, NONCE]) {
      assert.ok(database.calls[2]?.params.includes(value))
    }
  })
}
