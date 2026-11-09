import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { applyPlayPurchase, createPlayOrder } from '../../src/play-credit-store.ts'
import { redirectCreditGift } from '../../src/prepaid-credit.ts'

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return result.stdout.trim()
}

test('retirement removes private customer/contact links and preserves receipts and verified refunds', { timeout: 120_000 }, async () => {
  const name = `city-retirement-private-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  docker(['run', '--detach', '--rm', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17'])
  const port = Number(docker(['port', name, '5432/tcp']).match(/:(\d+)$/u)?.[1])
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' })
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await pool.query('SELECT 1'); break } catch (error) { if (attempt > 100) throw error; await delay(100) }
    }
    await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../db/migrations/20261109_resident_retirement.sql', import.meta.url), 'utf8'))
    const migration = new URL('../../db/migrations/20261109_resident_retirement_private_data.sql', import.meta.url)
    // Before implementation this fails at the missing scrub function, not an absent fixture.
    try { await pool.query(await readFile(migration, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await pool.query(`INSERT INTO residents(id,handle,model,secret_hash) VALUES
      (1,'founder','test',repeat('1',64)),(2,'retiring-test','test',repeat('2',64)),(3,'active-test','test',repeat('3',64))`)
    const db = { query: async (text: string, params: readonly unknown[] = []) => (await pool.query(text, [...params])).rows }
    const order = await createPlayOrder(db, { requestId: 'synthetic-private-order', recipientId: 2,
      productId: 'fee_credit_5_v1', appUserId: 'synthetic-person@example.invalid', environment: 'production' })
    const pending = await createPlayOrder(db, { requestId: 'synthetic-open-order', recipientId: 2,
      productId: 'fee_credit_1_v1', appUserId: 'synthetic-person@example.invalid', environment: 'production' })
    const evidence = { orderId: order.order.public_id, eventId: 'synthetic-delivery', eventType: 'NON_RENEWING_PURCHASE' as const,
      transactionId: 'GPA.synthetic-retirement', productId: 'fee_credit_5_v1' as const, environment: 'production' as const,
      configuredEnvironment: 'production' as const, purchasedAt: new Date(order.order.created_at).getTime() + 5_000,
      appUserIds: ['synthetic-person@example.invalid'] }
    assert.equal(await applyPlayPurchase(db, evidence), 'delivered')
    await pool.query(`INSERT INTO community_tool_submissions(title,url,operator_name,description,resident_id,category,tags,submitter_ip_hash)
      VALUES ('Synthetic','https://example.invalid/contact','Synthetic contact','Synthetic description',2,'Browse',ARRAY['synthetic'],repeat('a',64)),
      ('Other','https://example.invalid/other','Other contact','Other description',3,'Browse',ARRAY['synthetic'],repeat('b',64))`)
    await pool.query(`INSERT INTO paypal_credit_intents(public_id,request_id,intent_kind,delivery,recipient_id,amount_units,paypal_environment,status)
      VALUES ('synthetic_paypal_retirement','synthetic-paypal-request','order','self',2,1000000,'sandbox','created')`)
    await pool.query(`UPDATE paypal_credit_intents SET remote_order_id='SYNTHETIC-RECEIPT',status='approval_pending'
      WHERE public_id='synthetic_paypal_retirement'`)
    await assert.rejects(pool.query('SELECT scrub_resident_private_payment_data(2)'), /30 days|does not exist/u)
    await pool.query(`UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp()-interval '31 days' WHERE id=2`)
    assert.equal(await applyPlayPurchase(db, { ...evidence, orderId: pending.order.public_id, productId: 'fee_credit_1_v1',
      eventId: 'synthetic-inflight-settlement', transactionId: 'GPA.synthetic-inflight' }), 'delivered')
    const receiptCount = (await pool.query('SELECT count(*) FROM city_credit_entries')).rows[0].count
    await pool.query('SELECT complete_resident_retirement(1,2)')
    const scrubbed = (await pool.query('SELECT * FROM play_credit_orders WHERE public_id=$1', [order.order.public_id])).rows[0]
    assert.equal(scrubbed.rc_app_user_id, `retired:${order.order.public_id}`)
    assert.equal(scrubbed.transaction_id, evidence.transactionId)
    assert.equal(scrubbed.claim_token_hash, (await pool.query('SELECT claim_token_hash FROM city_credit_gifts WHERE id=$1', [scrubbed.gift_id])).rows[0].claim_token_hash)
    assert.deepEqual((await pool.query('SELECT resident_id FROM community_tool_submissions')).rows, [{ resident_id: 3 }])
    assert.equal((await pool.query('SELECT remote_order_id FROM paypal_credit_intents')).rows[0].remote_order_id, 'SYNTHETIC-RECEIPT')
    assert.equal(await applyPlayPurchase(db, evidence), 'delivered') // Exact receipt replay changes nothing.
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'synthetic-repeat-delivery' }), 'unmatched')
    assert.equal(await applyPlayPurchase(db, { ...evidence, orderId: pending.order.public_id, productId: 'fee_credit_1_v1',
      eventId: 'synthetic-late-delivery', transactionId: 'GPA.synthetic-late' }), 'unmatched')
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'wrong-product', eventType: 'CANCELLATION', productId: 'fee_credit_1_v1' }), 'unmatched')
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'wrong-environment', eventType: 'CANCELLATION', environment: 'sandbox', configuredEnvironment: 'sandbox' }), 'unmatched')
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'synthetic-refund', eventType: 'CANCELLATION' }), 'revoked')
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_entries')).rows[0].count, receiptCount)
    assert.equal((await pool.query('SELECT status FROM city_credit_gifts WHERE id=$1', [scrubbed.gift_id])).rows[0].status, 'revoked')
    await assert.rejects(pool.query('UPDATE play_credit_orders SET rc_app_user_id=$1 WHERE public_id=$2', ['other-private-id', order.order.public_id]), /immutable/u)
    await assert.rejects(pool.query('UPDATE play_credit_orders SET amount_units=1000000 WHERE public_id=$1', [order.order.public_id]), /immutable/u)
    await pool.query(await readFile(migration, 'utf8'))
    await pool.query(await readFile(migration, 'utf8'))
    await pool.query('SELECT complete_resident_retirement(1,2)')
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_entries')).rows[0].count, receiptCount)
    await assert.rejects(pool.query(`INSERT INTO city_credit_entries(entry_kind,resident_id,amount_units,founder_id,source_key,reason)
      VALUES ('founder_issue',2,1000000,1,'synthetic-retired-issue','Synthetic new funding')`), /retired/u)
    // The approval preceded retirement; a provider can settle after the state changes.
    // Keep the exact receipt once, while the resident remains unable to spend it.
    const settlePriorPayPal = () => pool.query(`SELECT * FROM deliver_paypal_credit(
      'synthetic_paypal_retirement','self',2,1000000,NULL,'sandbox','SYNTHETIC-RECEIPT',
      'paypal:capture:SYNTHETIC-CAPTURE','paypal','SYNTHETIC-EVENT','PAYMENT.CAPTURE.COMPLETED','SYNTHETIC-CAPTURE',NULL)`)
    assert.equal((await settlePriorPayPal()).rows[0].created, true)
    assert.equal((await settlePriorPayPal()).rows[0].created, false)
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_entries')).rows[0].count, String(Number(receiptCount)+1))
    await pool.query(`INSERT INTO city_credit_entries(entry_kind,resident_id,amount_units,founder_id,source_key,reason)
      VALUES ('admin_credit',2,1000000,1,'synthetic-retired-correction','Synthetic receipt correction')`)
    await pool.query(`INSERT INTO city_credit_entries(entry_kind,resident_id,amount_units,founder_id,source_key,reason)
      VALUES ('admin_debit',2,1000000,1,'synthetic-retired-reversal','Synthetic receipt reversal')`)
    assert.equal((await pool.query('SELECT balance_units FROM city_credit_accounts WHERE resident_id=2')).rows[0].balance_units, '1000000')
    await redirectCreditGift(db, { claimToken: pending.claimToken!, residentId: 3, requestId: 'synthetic-move-away' })
    await assert.rejects(redirectCreditGift(db, { claimToken: pending.claimToken!, residentId: 2, requestId: 'synthetic-move-back' }), /retired/u)
  } finally {
    await pool.end()
    docker(['stop', '--time', '0', name])
  }
})
