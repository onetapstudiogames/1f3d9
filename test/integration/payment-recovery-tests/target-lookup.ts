import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  createOrReadPaymentAttempt,
  findReplayableTargetPaymentAttempt,
} from '../../../src/payment-attempts.ts'
import {
  PAYEE,
  PAYER,
  USDC,
  insertAttempt,
} from '../../helpers/payment-recovery-postgres-fixtures/payment-attempts.ts'

export async function registerTargetLookupTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('a new target request synchronously closes a due live x402 attempt', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_due_target', targetKey: 'frontier:root:reusable',
      status: 'payment_pending', leaseOwner: 'abandoned-lease', recovery: 'due',
    })
    const request = { name: 'reusable', parent_id: null }
    const created = await createOrReadPaymentAttempt({
      query: async (text, params = []) => (await database.query(text, [...params])).rows,
    }, {
      actorId: 2,
      operation: 'frontier',
      targetKey: 'frontier:root:reusable',
      request,
      method: 'x402',
      network: 'base',
      token: USDC,
      payerWallet: PAYER,
      payeeWallet: PAYEE,
      amountUnits: 1_000_000n,
      x402Nonce: `0x${randomBytes(32).toString('hex')}`,
      x402PayloadDigest: randomBytes(32).toString('hex'),
      x402ValidAfter: 1_787_000_000n,
      x402ValidBefore: 1_787_000_900n,
      startBlock: 50_000_002n,
      startTime: new Date(Date.now() - 30_000).toISOString(),
      endTime: new Date(Date.now() + 15 * 60_000).toISOString(),
    }, () => 'pay_recovery_replacement')

    assert.equal(created.disposition, 'created')
    const history = await database.query<{ public_id: string; status: string; lease_owner: string | null }>(`
      SELECT public_id, status, lease_owner FROM payment_attempts
      WHERE target_key = 'frontier:root:reusable' ORDER BY created_at, public_id
    `)
    assert.deepEqual(history.rows, [
      { public_id: 'pay_recovery_due_target', status: 'expired', lease_owner: null },
      { public_id: 'pay_recovery_replacement', status: 'settling', lease_owner: null },
    ])
  })

  await t.test('a headerless treasury retry closes its exact-deadline target before lookup', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_due_headerless', targetKey: 'frontier:root:headerless',
      status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const replay = await findReplayableTargetPaymentAttempt(paymentDatabase, {
      actorId: 2,
      operation: 'frontier',
      targetKey: 'frontier:root:headerless',
      request: { name: 'headerless', parent_id: null },
    })
    assert.equal(replay, null)

    await insertAttempt(database, {
      publicId: 'pay_recovery_after_headerless', targetKey: 'frontier:root:headerless',
      status: 'settling', leaseOwner: null, txHash: null, recovery: 'none',
    })
    const history = await database.query<{ public_id: string; status: string }>(`
      SELECT public_id, status FROM payment_attempts
      WHERE target_key = 'frontier:root:headerless' ORDER BY created_at, public_id
    `)
    assert.deepEqual(history.rows, [
      { public_id: 'pay_recovery_due_headerless', status: 'expired' },
      { public_id: 'pay_recovery_after_headerless', status: 'settling' },
    ])
  })

  await t.test('generic target lookup leaves due sales for their sale-specific terminalizer', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_due_world_sale', targetKey: 'world-sale:901',
      operation: 'world_sale', status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const replay = await findReplayableTargetPaymentAttempt({
      query: async (text, params = []) => (await database.query(text, [...params])).rows,
    }, {
      actorId: 2,
      operation: 'world_sale',
      targetKey: 'world-sale:901',
      request: { name: '901', parent_id: null },
    })
    assert.equal(replay?.status, 'payment_pending')
    const stored = await database.query<{ status: string }>(`
      SELECT status FROM payment_attempts WHERE public_id = 'pay_recovery_due_world_sale'
    `)
    assert.deepEqual(stored.rows, [{ status: 'payment_pending' }])
  })

}
