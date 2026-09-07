import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalPaymentRequest,
  findPaymentAttempt,
  getPaymentAttempt,
  getPaymentAttemptRecord,
  toPrivatePaymentAttempt,
  toPublicPaymentAttempt,
  type PaymentAttemptRecord,
} from '../../src/payment-attempts.ts'
import { FACILITATOR_RESPONSE_HEADER, PAYEE, PAYER, TX, USDC, QueuedDatabase, row } from '../helpers/payment-attempts-fixtures/attempt-records.ts'

export function registerViewsAndLookupsTests(): void {
  test('public pending/completed views say not to pay again and omit payment secrets', () => {
    const secretRow = {
      ...row({
        status: 'completed',
        txHash: TX,
        result: { thing_id: 42 },
        responseStatus: 200,
        response: { ok: true },
      }),
      paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
      request_json: { authorization: { signature: 'secret' } },
      x402_payload_digest: '66'.repeat(32),
    }
    const publicView = toPublicPaymentAttempt(secretRow)
    const encoded = JSON.stringify(publicView)

    assert.deepEqual(publicView, {
      id: 'pay_existing_0001',
      state: 'completed',
      do_not_pay_again: true,
      transaction: TX,
      response_status: 200,
      response: { ok: true },
    })
    assert.doesNotMatch(encoded, /authorization|signature|payload_digest|nonce/iu)
    assert.equal(encoded.includes(FACILITATOR_RESPONSE_HEADER), false)

    assert.equal(toPublicPaymentAttempt(row({ status: 'payment_pending' })).do_not_pay_again, true)
    assert.equal(toPublicPaymentAttempt(row({ status: 'expired' })).do_not_pay_again, false)
    assert.equal(toPublicPaymentAttempt(row({
      status: 'expired',
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    })).do_not_pay_again, true)
  })

  test('expired recovered x402 custody says not to repay and remains explicitly recheckable without a hash', () => {
    const recovered = toPrivatePaymentAttempt(row({
      status: 'expired',
      txHash: null,
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    }))
    assert.equal(recovered.do_not_pay_again, true)
    assert.equal(recovered.next_action, 'recheck_for_late_finality')

    const legacyUnused = toPrivatePaymentAttempt(row({
      status: 'expired',
      method: 'x402',
      txHash: null,
      recoveryStartedAt: null,
      recoveryDeadlineAt: null,
    }))
    assert.equal(legacyUnused.do_not_pay_again, false)
    assert.equal(legacyUnused.next_action, 'closed')
  })

  test('every stored payment state advertises one exact next action', () => {
    const recovery = {
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    }
    const cases: Array<{
      name: string
      attempt: PaymentAttemptRecord
      nextAction: ReturnType<typeof toPrivatePaymentAttempt>['next_action']
    }> = [
      { name: 'settling', attempt: row({ status: 'settling' }), nextAction: 'wait_or_recheck' },
      { name: 'payment pending', attempt: row({ status: 'payment_pending' }), nextAction: 'wait_or_recheck' },
      { name: 'needs review', attempt: row({ status: 'needs_review' }), nextAction: 'wait_or_recheck' },
      {
        name: 'expired recoverable x402',
        attempt: row({ status: 'expired', ...recovery }),
        nextAction: 'recheck_for_late_finality',
      },
      { name: 'founder review', attempt: row({ status: 'founder_review' }), nextAction: 'await_founder_review' },
      { name: 'completed', attempt: row({ status: 'completed' }), nextAction: 'complete' },
      { name: 'legacy completed', attempt: row({ status: 'legacy_completed' }), nextAction: 'complete' },
      {
        name: 'credit returned',
        attempt: row({ status: 'credit_returned', method: 'credit', network: null }),
        nextAction: 'credit_returned',
      },
      { name: 'invalid', attempt: row({ status: 'invalid' }), nextAction: 'closed' },
      { name: 'expired x402 without recovery', attempt: row({ status: 'expired' }), nextAction: 'closed' },
      {
        name: 'expired credit',
        attempt: row({ status: 'expired', method: 'credit', network: null, ...recovery }),
        nextAction: 'closed',
      },
      {
        name: 'expired legacy claim',
        attempt: row({ status: 'expired', method: 'claim', network: null }),
        nextAction: 'closed',
      },
    ]

    for (const current of cases) {
      assert.equal(toPrivatePaymentAttempt(current.attempt).next_action, current.nextAction, current.name)
    }
  })

  test('private attempt serialization exposes only allowlisted recovery and bound-request facts', () => {
    const storedRequest = {
      offer_id: 91,
      buyer_wallet: PAYER,
      seller_wallet: PAYEE,
      price_usdc: 2,
      asset_type: 'thing',
      asset_id: 42,
      authorization: { signature: 'secret' },
    }
    const secretRow = {
      ...row({
        status: 'payment_pending',
        request: storedRequest,
        requestHash: canonicalPaymentRequest(storedRequest).hash,
        txHash: TX,
        recoveryStartedAt: '2026-08-16T12:00:00.000Z',
        recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
      }),
      request_json: { authorization: { signature: 'secret' } },
      paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
      x402_payload_digest: '66'.repeat(32),
      lease_owner: 'resident-data-that-must-not-leak',
    }

    const privateView = toPrivatePaymentAttempt(secretRow)
    assert.deepEqual(privateView, {
      id: 'pay_existing_0001',
      state: 'payment_pending',
      operation: 'direct_sale',
      method: 'x402',
      target: 'direct_sale:offer:91:v3',
      request: {
        offer_id: 91,
        buyer_wallet: PAYER,
        seller_wallet: PAYEE,
        price_usdc: 2,
        asset_type: 'thing',
        asset_id: 42,
      },
      result: null,
      transaction: TX,
      recovery_started_at: '2026-08-16T12:00:00.000Z',
      recovery_deadline_at: '2026-08-16T14:00:00.000Z',
      do_not_pay_again: true,
      network: 'base',
      token: USDC,
      recipient: PAYEE,
      amount_units: '2000000',
      next_action: 'wait_or_recheck',
    })
    assert.doesNotMatch(
      JSON.stringify(privateView),
      /authorization|signature|payload_digest|nonce|facilitator|lease_owner|resident-data/iu,
    )
  })

  test('result retrieval is actor-bound and returns the durable public representation', async () => {
    const completed = row({
      status: 'completed',
      responseStatus: 201,
      response: { ok: true },
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    })
    const database = new QueuedDatabase([completed])

    const result = await getPaymentAttempt(database, {
      publicId: completed.publicId,
      actorId: completed.actorId,
    })

    assert.equal(result?.id, completed.publicId)
    assert.equal(result?.state, 'completed')
    assert.equal(result?.next_action, 'complete')
    assert.match(database.calls[0]?.text ?? '', /public_id\s*=\s*\$1[\s\S]*actor_id\s*=\s*\$2/iu)
    assert.deepEqual(database.calls[0]?.params, [completed.publicId, completed.actorId])
  })

  test('owner-bound record lookup returns strict stored request and timing facts', async () => {
    const pending = row({
      status: 'payment_pending',
      txHash: TX,
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    })
    const database = new QueuedDatabase([pending])

    const result = await getPaymentAttemptRecord(database, {
      publicId: pending.publicId,
      actorId: pending.actorId,
    })

    assert.deepEqual(result?.request, { offer_id: 91, nested: { a: 1, b: 2 } })
    assert.equal(result?.recoveryStartedAt, '2026-08-16T12:00:00.000Z')
    assert.equal(result?.recoveryDeadlineAt, '2026-08-16T14:00:00.000Z')
    assert.match(database.calls[0]?.text ?? '', /public_id\s*=\s*\$1[\s\S]*actor_id\s*=\s*\$2/iu)

    await assert.rejects(
      getPaymentAttemptRecord(new QueuedDatabase([{
        ...pending,
        recoveryDeadlineAt: '2026-08-16T14:00:00.001Z',
      }]), {
        publicId: pending.publicId,
        actorId: pending.actorId,
      }),
      /recovery window/iu,
    )
  })

  test('operation recovery finds only the actor-bound attempt for one offer', async () => {
    const pending = row({ status: 'payment_pending', txHash: TX })
    const database = new QueuedDatabase([pending])

    const result = await findPaymentAttempt(database, {
      actorId: 7,
      operation: 'direct_sale',
      offerId: 91,
    })

    assert.equal(result?.publicId, pending.publicId)
    assert.match(database.calls[0]?.text ?? '', /actor_id\s*=\s*\$1/iu)
    assert.match(database.calls[0]?.text ?? '', /operation\s*=\s*\$2/iu)
    assert.match(database.calls[0]?.text ?? '', /offer_id\s*=\s*\$3/iu)
    assert.deepEqual(database.calls[0]?.params, [7, 'direct_sale', 91])
  })
}
