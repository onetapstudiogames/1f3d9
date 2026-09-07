import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentAttemptConflictError,
  canonicalPaymentRequest,
  findReplayableTargetPaymentAttempt,
  x402NonceKey,
} from '../../src/payment-attempts.ts'
import { NONCE, PAYEE, PAYER, USDC, QueuedDatabase, row } from '../helpers/payment-attempts-fixtures/attempt-records.ts'

export function registerRequestIdentityTests(): void {
  test('canonical payment requests recursively sort keys and have stable hashes', () => {
    const left = canonicalPaymentRequest({ z: [3, { y: true, x: null }], a: { d: 4, c: 'five' } })
    const right = canonicalPaymentRequest({ a: { c: 'five', d: 4 }, z: [3, { x: null, y: true }] })

    assert.equal(left.json, '{"a":{"c":"five","d":4},"z":[3,{"x":null,"y":true}]}')
    assert.equal(left.hash, right.hash)
    assert.match(left.hash, /^[0-9a-f]{64}$/u)
  })

  test('canonical payment requests reject values without an exact JSON representation', () => {
    const sparse = Array<unknown>(1)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const candidate of [
      undefined,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      1n,
      Symbol('not-json'),
      () => undefined,
      { missing: undefined },
      sparse,
      new Date('2026-08-16T00:00:00.000Z'),
      cyclic,
    ]) {
      assert.throws(() => canonicalPaymentRequest(candidate), /canonical JSON/iu)
    }
  })

  test('the x402 nonce key binds network, exact token, payer, and nonce', () => {
    assert.equal(
      x402NonceKey({ network: 'base', token: USDC, payerWallet: PAYER, nonce: NONCE }),
      `base:${USDC}:${PAYER}:${NONCE}`,
    )
    assert.throws(
      () => x402NonceKey({ network: 'base', token: USDC, payerWallet: PAYEE, nonce: '33' }),
      /nonce/iu,
    )
  })

  test('headerless recovery is actor-, target-, and immutable-request-bound', async () => {
    const existing = row({ status: 'completed' })
    const database = new QueuedDatabase([existing], [existing])
    const recovery = {
      actorId: 7,
      counterpartyId: 8,
      operation: 'direct_sale' as const,
      targetKey: 'direct_sale:offer:91:v3',
      offerId: 91,
      assetType: 'thing' as const,
      assetId: 42,
      request: { offer_id: 91, nested: { a: 1, b: 2 } },
    }

    assert.equal(
      (await findReplayableTargetPaymentAttempt(database, recovery))?.publicId,
      existing.publicId,
    )
    assert.deepEqual(database.calls[0]?.params, [7, 'direct_sale', 'direct_sale:offer:91:v3'])
    assert.match(database.calls[0]?.text ?? '', /WITH\s+closed_due_target\s+AS/iu)
    assert.match(
      database.calls[0]?.text ?? '',
      /operation\s+IN\s*\(\s*'frontier'\s*,\s*'kind_invention'\s*,\s*'kind_revision'\s*\)/iu,
    )
    await assert.rejects(
      findReplayableTargetPaymentAttempt(database, {
        ...recovery,
        request: { offer_id: 91, nested: { a: 1, b: 3 } },
      }),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
  })
}
