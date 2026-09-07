import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentAttemptConflictError,
  bindPaymentEvidence,
  completePaymentAttempt,
  findPaymentAttempt,
  type PaymentAttemptRecord,
} from '../../src/payment-attempts.ts'
import { BLOCK_HASH, EXACT_RESPONSE_BODY, FACILITATOR_RESPONSE_HEADER, TX, QueuedDatabase, row } from '../helpers/payment-attempts-fixtures/attempt-records.ts'

export function registerEvidenceAndResponseTests(): void {
  test('transaction and finality evidence bind once under the lease', async () => {
    const pending = row({
      status: 'payment_pending',
      leaseOwner: 'lease_winner',
      txHash: TX,
      finalizedBlockNumber: 22_000_010n,
      finalizedBlockHash: BLOCK_HASH,
      finalizedBlockTime: '2026-08-16T12:00:30.000Z',
      finalizedAt: '2026-08-16T12:01:00.000Z',
    })
    const database = new QueuedDatabase([pending])

    const result = await bindPaymentEvidence(database, {
      publicId: pending.publicId,
      leaseOwner: 'lease_winner',
      txHash: TX,
      finality: {
        blockNumber: 22_000_010n,
        blockHash: BLOCK_HASH,
        blockTime: '2026-08-16T12:00:30.000Z',
        finalizedAt: '2026-08-16T12:01:00.000Z',
      },
    })

    assert.equal(result.txHash, TX)
    assert.match(database.calls[0]?.text ?? '', /tx_hash\s+IS\s+NULL\s+OR\s+tx_hash\s*=\s*\$\d+/iu)
    assert.match(database.calls[0]?.text ?? '', /finalized_block_hash\s+IS\s+NULL\s+OR\s+finalized_block_hash\s*=\s*\$\d+/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*\$\d+/iu)
    assert.match(database.calls[0]?.text ?? '', /recovery_started_at\s*=\s*coalesce\s*\(\s*recovery_started_at/iu)
    assert.match(database.calls[0]?.text ?? '', /interval\s+'2 hours'/iu)
  })

  test('facilitator response bytes survive evidence binding and durable row reload', async () => {
    const pending = {
      ...row({
        status: 'payment_pending',
        leaseOwner: 'lease_winner',
        txHash: TX,
        response: {
          __1f3d9_x402_response_v1: { header: FACILITATOR_RESPONSE_HEADER },
        },
      }),
    }
    const database = new QueuedDatabase([pending])

    const rebound = await bindPaymentEvidence(database, {
      publicId: pending.publicId,
      leaseOwner: 'lease_winner',
      txHash: TX,
      finality: null,
      paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
    })

    assert.equal(database.calls[0]?.params[7], FACILITATOR_RESPONSE_HEADER)
    assert.equal(rebound.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    assert.equal(rebound.response, null)

    const completed = {
      ...pending,
      status: 'completed' as const,
      responseStatus: 201,
      response: {
        __1f3d9_x402_response_v1: {
          header: FACILITATOR_RESPONSE_HEADER,
          body: { ok: true, thing: { id: 42 } },
        },
      },
      responseBody: EXACT_RESPONSE_BODY,
    } as PaymentAttemptRecord
    const reloaded = await findPaymentAttempt(new QueuedDatabase([completed]), {
      actorId: completed.actorId,
      operation: 'direct_sale',
      offerId: completed.offerId!,
    })

    assert.equal(reloaded?.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    assert.deepEqual(reloaded?.response, { ok: true, thing: { id: 42 } })
    assert.equal(reloaded?.responseBody, EXACT_RESPONSE_BODY)
  })

  test('durable response bodies reject malformed, mismatched, and oversized database bytes', async () => {
    const response = {
      __1f3d9_x402_response_v1: {
        header: FACILITATOR_RESPONSE_HEADER,
        body: { ok: true, thing: { id: 42 } },
      },
    }
    for (const responseBody of [
      Buffer.from('not json', 'utf8'),
      Buffer.from('{"ok":false,"thing":{"id":42}}', 'utf8'),
      Buffer.alloc(200_001, 0x20),
    ]) {
      await assert.rejects(
        findPaymentAttempt(new QueuedDatabase([{
          ...row({ status: 'completed', responseStatus: 201, response }),
          responseBody: responseBody as unknown as string,
        } as PaymentAttemptRecord]), {
          actorId: 7,
          operation: 'direct_sale',
          offerId: 91,
        }),
        (error: unknown) => error instanceof TypeError,
      )
    }
  })

  test('legacy completed rows fall back without claiming byte-exact response storage', async () => {
    const legacy = await findPaymentAttempt(new QueuedDatabase([row({
      status: 'completed',
      responseStatus: 200,
      response: { ok: true },
    })]), {
      actorId: 7,
      operation: 'direct_sale',
      offerId: 91,
    })

    assert.deepEqual(legacy?.response, { ok: true })
    assert.equal(legacy?.responseBody, null)
  })

  test('facilitator response persistence rejects malformed or oversized headers before SQL', async () => {
    for (const paymentResponseHeader of ['not base64', 'A'.repeat(87_385)]) {
      const database = new QueuedDatabase()
      await assert.rejects(
        bindPaymentEvidence(database, {
          publicId: row().publicId,
          leaseOwner: 'lease_winner',
          txHash: TX,
          finality: null,
          paymentResponseHeader,
        }),
        (error: unknown) => error instanceof TypeError,
      )
      assert.equal(database.calls.length, 0)
    }
  })

  test('evidence cannot overwrite a different transaction', async () => {
    const different = row({ status: 'payment_pending', leaseOwner: 'lease_winner', txHash: `0x${'77'.repeat(32)}` })
    const database = new QueuedDatabase([], [different])

    await assert.rejects(
      bindPaymentEvidence(database, {
        publicId: different.publicId,
        leaseOwner: 'lease_winner',
        txHash: TX,
        finality: null,
      }),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
  })

  test('completion requires pending finalized evidence and preserves the canonical response', async () => {
    const completed = row({
      status: 'completed',
      leaseOwner: null,
      leaseExpiresAt: null,
      txHash: TX,
      finalizedBlockNumber: 22_000_010n,
      finalizedBlockHash: BLOCK_HASH,
      finalizedAt: '2026-08-16T12:01:00.000Z',
      result: { thing_id: 42 },
      responseStatus: 200,
      response: { ok: true, thing: { id: 42 } },
      completedAt: '2026-08-16T12:01:01.000Z',
    })
    const database = new QueuedDatabase([completed])

    const result = await completePaymentAttempt(database, {
      publicId: completed.publicId,
      leaseOwner: 'lease_winner',
      result: { thing_id: 42 },
      responseStatus: 200,
      response: { ok: true, thing: { id: 42 } },
      responseBody: EXACT_RESPONSE_BODY,
    })

    assert.equal(result.status, 'completed')
    assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'payment_pending'/iu)
    assert.match(database.calls[0]?.text ?? '', /finalized_block_number\s+IS\s+NOT\s+NULL/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
    assert.match(database.calls[0]?.text ?? '', /response_body_bytes\s*=\s*decode\s*\(/iu)
    assert.equal(
      Buffer.from(String(database.calls[0]?.params[5]), 'base64').toString('utf8'),
      EXACT_RESPONSE_BODY,
    )
  })

  test('completion rejects non-object, mismatched, or oversized exact response bodies before SQL', async () => {
    for (const responseBody of [
      '[]',
      '{"ok":false}',
      `{"padding":"${'x'.repeat(200_000)}"}`,
    ]) {
      const database = new QueuedDatabase()
      await assert.rejects(
        completePaymentAttempt(database, {
          publicId: 'pay_existing_0001',
          leaseOwner: 'lease_winner',
          result: { thing_id: 42 },
          responseStatus: 200,
          response: { ok: true },
          responseBody,
        }),
        (error: unknown) => error instanceof TypeError,
      )
      assert.equal(database.calls.length, 0)
    }
  })
}
