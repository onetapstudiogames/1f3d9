import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { mountPlayCreditRoutes } from '../../src/play-credit-routes.ts'
import { applyPlayPurchase, createPlayOrder } from '../../src/play-credit-store.ts'
import { acceptCreditGift, refuseCreditGift, redirectCreditGift } from '../../src/prepaid-credit.ts'
import { readCityCreditAccount } from '../../src/city-credit.ts'

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

test('Play fixed packs, concurrent webhook/claim, refunds, replay, and refusal invariants in PostgreSQL 17', { timeout: 120_000 }, async () => {
  const name = `city-play-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  docker(['run', '--detach', '--rm', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17'])
  const port = Number(docker(['port', name, '5432/tcp']).match(/:(\d+)$/u)?.[1])
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 5 })
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await pool.query('SELECT 1'); break } catch (error) { if (attempt > 100) throw error; await delay(100) }
    }
    await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../../db/migrations/20261108_play_credit.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    await pool.query(migration)
    await pool.query(`INSERT INTO residents (id,handle,model,secret_hash) VALUES
      (1,'founder','play-test',repeat('1',64)),(2,'recipient-two','play-test',repeat('2',64)),(3,'recipient-three','play-test',repeat('3',64))`)
    const db = { query: async (text: string, params: readonly unknown[] = []) => (await pool.query(text, [...params])).rows }
    const env = { REVENUECAT_SECRET_KEY: 'test-key', REVENUECAT_PROJECT_ID: 'proj_test', REVENUECAT_WEBHOOK_AUTH: 'test-auth',
      PLAY_CREDIT_CALLER_HASH_SECRET: 'test-caller-hash', PLAY_CREDIT_ENVIRONMENT: 'production' }
    const purchases = new Map<string, Record<string, unknown>>()
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/products/')) return Response.json({ id: 'prod_test', store_identifier: 'fee_credit_5_v1', type: 'one_time', one_time: { is_consumable: true } })
      const user = decodeURIComponent(parsed.pathname.split('/').at(-2)!)
      return Response.json({ items: purchases.has(user) ? [purchases.get(user)] : [], next_page: null })
    }) as typeof fetch
    const app = new Hono()
    mountPlayCreditRoutes(app, { database: db, environment: env, fetcher })
    const request = (path: string, value: unknown, auth = 'test-auth') => app.request(`/api/city-credit/play${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(value),
    })
    const order = await createPlayOrder(db, { requestId: 'play-test-order-1', recipientId: 2, productId: 'fee_credit_5_v1', appUserId: 'test-buyer-1', environment: 'production' })
    assert.ok(order.claimToken)
    assert.equal((await createPlayOrder(db, { requestId: 'play-test-order-1', recipientId: 2, productId: 'fee_credit_5_v1', appUserId: 'test-buyer-1', environment: 'production' })).claimToken, null)
    const purchase = { product_id: 'prod_test', store_purchase_identifier: 'GPA.test-1', store: 'play_store', environment: 'production', status: 'owned', purchased_at: new Date(order.order.created_at).getTime() + 5_000, quantity: 100, revenue_in_usd: { gross: -1 } }
    purchases.set('test-buyer-1', purchase)
    const event = { type: 'NON_RENEWING_PURCHASE', id: 'event-test-1', product_id: 'fee_credit_5_v1', app_user_id: 'test-buyer-1', aliases: [], environment: 'PRODUCTION', store: 'PLAY_STORE', transaction_id: 'GPA.test-1', price: null, quantity: 77 }
    const responses = await Promise.all([
      request('/webhook', { event }), request('/webhook', { event: { ...event, id: 'event-test-2', price: -1 } }),
      request(`/orders/${order.order.public_id}/claim`, { transaction_id: 'GPA.test-1' }),
    ])
    for (const response of responses) assert.equal(response.status, 200, `${await response.text()} ${JSON.stringify((await pool.query('SELECT public_id,status,created_at,transaction_id FROM play_credit_orders')).rows)} purchased_at=${purchase.purchased_at}`)
    const gift = (await pool.query('SELECT * FROM city_credit_gifts')).rows[0]
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_gifts')).rows[0].count, '1')
    assert.equal(gift.amount_units, '5000000')
    assert.equal((await pool.query('SELECT balance_units FROM city_credit_accounts WHERE resident_id=2')).rows[0].balance_units, '0')

    // No event/order/rate-limit write for unknown products or unauthenticated webhooks.
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM play_credit_events) AS events,
      (SELECT count(*) FROM play_credit_orders) AS orders,(SELECT sum(used) FROM credit_purchase_rate_limits) AS attempts`)).rows[0]
    const before = await counts()
    assert.equal((await request('/webhook', { event }, 'wrong')).status, 401)
    assert.equal((await request('/webhook', { event: { ...event, id: 'unknown', product_id: 'unknown' } })).status, 400)
    assert.equal((await request('/orders', { request_id: 'unknown-pack', resident_number: 2, resident_handle: 'recipient-two', product_id: 'unknown', rc_app_user_id: 'test-buyer' })).status, 400)
    assert.deepEqual(await counts(), before)
    await assert.rejects(pool.query(`INSERT INTO play_credit_orders
      (public_id,request_id,recipient_id,product_id,amount_units,claim_token_hash,rc_app_user_id,environment)
      VALUES ('city_play_' || repeat('b',32),'unknown-db-product',2,'unknown',0,repeat('b',64),'test-buyer','production')`), /check constraint/u)
    assert.equal((await request('/webhook', { event: { ...event, id: 'sandbox-test', transaction_id: 'GPA.sandbox-test', environment: 'SANDBOX' } })).status, 200)
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_gifts')).rows[0].count, '1')

    // Refuse and redirect before refund: revoke the same gift at its current recipient.
    await refuseCreditGift(db, { residentId: 2, giftId: gift.public_id })
    await redirectCreditGift(db, { giftId: gift.public_id, claimToken: order.claimToken!, requestId: 'play-redirect-test', residentId: 3 })
    purchases.set('test-buyer-1', { ...purchase, status: 'refunded' })
    assert.equal((await request('/webhook', { event })).status, 200)
    assert.equal((await request('/webhook', { event })).status, 200)
    assert.equal((await request('/webhook', { event: { ...event, id: 'refund-test-1', type: 'CANCELLATION' } })).status, 200)
    assert.equal((await pool.query('SELECT status FROM city_credit_gifts WHERE id=$1', [gift.id])).rows[0].status, 'revoked')

    const next = await createPlayOrder(db, { requestId: 'play-test-order-2', recipientId: 2, productId: 'fee_credit_5_v1', appUserId: 'test-buyer-2', environment: 'production' })
    const evidence = { orderId: next.order.public_id, eventId: 'accepted-delivery', eventType: 'NON_RENEWING_PURCHASE' as const, transactionId: 'GPA.test-2', productId: 'fee_credit_5_v1' as const, environment: 'production' as const, configuredEnvironment: 'production' as const, purchasedAt: new Date(next.order.created_at).getTime() + 5_000, appUserIds: ['test-buyer-2'] }
    assert.equal(await applyPlayPurchase(db, evidence), 'delivered')
    const nextGift = (await pool.query('SELECT public_id FROM city_credit_gifts WHERE source_key=$1', ['play:txn:GPA.test-2'])).rows[0].public_id
    await acceptCreditGift(db, { residentId: 2, giftId: nextGift })
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'accepted-refund', eventType: 'CANCELLATION' }), 'accepted_kept')
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'accepted-refund', eventType: 'CANCELLATION' }), 'accepted_kept')
    assert.equal(await applyPlayPurchase(db, { ...evidence, eventId: 'accepted-refund-another-event', eventType: 'CANCELLATION' }), 'duplicate')
    assert.equal((await pool.query("SELECT count(*) FROM play_credit_events WHERE transaction_id='GPA.test-2' AND outcome='accepted_kept'")).rows[0].count, '1')
    assert.equal((await pool.query('SELECT balance_units FROM city_credit_accounts WHERE resident_id=2')).rows[0].balance_units, '5000000')
    const account = await readCityCreditAccount(db, 2)
    assert.ok(account.history.some(entry => entry.purchase_kind === 'play'))

    const late = await createPlayOrder(db, { requestId: 'play-test-order-3', recipientId: 2, productId: 'fee_credit_5_v1', appUserId: 'test-buyer-3', environment: 'production' })
    const lateEvidence = { ...evidence, orderId: late.order.public_id, eventId: 'early-refund', transactionId: 'GPA.test-3', appUserIds: ['test-buyer-3'], purchasedAt: new Date(late.order.created_at).getTime() + 5_000 }
    assert.equal(await applyPlayPurchase(db, { ...lateEvidence, orderId: null, eventType: 'CANCELLATION' }), 'refunded_before_delivery')
    await delay(10)
    assert.equal(await applyPlayPurchase(db, { ...lateEvidence, eventId: 'late-delivery' }), 'refunded_before_delivery')
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_gifts')).rows[0].count, '2')

    // A transaction cannot fund a second order, and a wrong product never changes the gift count.
    assert.equal(await applyPlayPurchase(db, { ...evidence, orderId: late.order.public_id, eventId: 'reuse-order' }), 'unmatched')
    assert.equal(await applyPlayPurchase(db, { ...lateEvidence, eventId: 'wrong-product', productId: 'fee_credit_1_v1' }), 'unmatched')
    await assert.rejects(pool.query(`SELECT * FROM record_city_credit_purchase(2,1000000,'play:txn:GPA.forged','play',repeat('a',64),'city_gift_' || repeat('a',32))`), /exact verified event/u)
    assert.equal((await pool.query('SELECT count(*) FROM city_credit_gifts')).rows[0].count, '2')

    for (const [count, refused] of [[1, false], [10, true]] as const) {
      const small = await createPlayOrder(db, { requestId: `play-fixed-${count}`, recipientId: 3, productId: `fee_credit_${count}_v1`, appUserId: `test-fixed-${count}`, environment: 'production' })
      const fixed = { ...evidence, orderId: small.order.public_id, eventId: `fixed-${count}`, transactionId: `GPA.fixed-${count}`,
        productId: `fee_credit_${count}_v1` as const, appUserIds: [`test-fixed-${count}`], purchasedAt: new Date(small.order.created_at).getTime() + 5000 }
      assert.equal(await applyPlayPurchase(db, fixed), 'delivered')
      const fixedGift = (await pool.query('SELECT * FROM city_credit_gifts WHERE source_key=$1', [`play:txn:GPA.fixed-${count}`])).rows[0]
      assert.equal(fixedGift.amount_units, String(count * 1_000_000))
      if (refused) await refuseCreditGift(db, { residentId: 3, giftId: fixedGift.public_id })
      assert.equal(await applyPlayPurchase(db, { ...fixed, eventId: `refund-fixed-${count}`, eventType: 'CANCELLATION' }), 'revoked')
    }
    const racing = await createPlayOrder(db, { requestId: 'play-racing-refund', recipientId: 3, productId: 'fee_credit_5_v1', appUserId: 'test-racing', environment: 'production' })
    const racingEvidence = { ...evidence, orderId: racing.order.public_id, eventId: 'racing-delivery', transactionId: 'GPA.racing', appUserIds: ['test-racing'], purchasedAt: new Date(racing.order.created_at).getTime() + 5000 }
    await applyPlayPurchase(db, racingEvidence)
    const racingGift = (await pool.query("SELECT public_id FROM city_credit_gifts WHERE source_key='play:txn:GPA.racing'")).rows[0].public_id
    const [accepted, refunded] = await Promise.allSettled([acceptCreditGift(db, { residentId: 3, giftId: racingGift }), applyPlayPurchase(db, { ...racingEvidence, eventId: 'racing-refund', eventType: 'CANCELLATION' })])
    const raceResult = (await pool.query('SELECT status FROM city_credit_gifts WHERE public_id=$1', [racingGift])).rows[0].status
    assert.ok(['accepted', 'revoked'].includes(raceResult))
    assert.equal(refunded.status, 'fulfilled')
    if (refunded.status === 'fulfilled') assert.equal(refunded.value, raceResult === 'accepted' ? 'accepted_kept' : 'revoked')
    assert.equal(accepted.status, raceResult === 'accepted' ? 'fulfilled' : 'rejected')
    if (accepted.status === 'rejected') assert.match(String(accepted.reason), /revoked/u)
    assert.equal((await readCityCreditAccount(db, 3)).balance_units, raceResult === 'accepted' ? '5000000' : '0')

    const ambiguous = await Promise.all(['one', 'two'].map(suffix => createPlayOrder(db, {
      requestId: `play-ambiguous-${suffix}`, recipientId: 2, productId: 'fee_credit_5_v1', appUserId: 'test-ambiguous', environment: 'production',
    })))
    const ambiguousEvidence = { ...evidence, orderId: null, eventId: 'ambiguous-webhook', transactionId: 'GPA.ambiguous',
      appUserIds: ['test-ambiguous'], purchasedAt: Math.max(...ambiguous.map(item => new Date(item.order.created_at).getTime())) + 5000 }
    assert.equal(await applyPlayPurchase(db, ambiguousEvidence), 'unmatched')
    assert.equal(await applyPlayPurchase(db, { ...ambiguousEvidence, orderId: ambiguous[0]!.order.public_id,
      eventId: 'ambiguous-explicit-claim' }), 'delivered')
    assert.equal(await applyPlayPurchase(db, { ...ambiguousEvidence, orderId: ambiguous[1]!.order.public_id,
      eventId: 'purchase-before-order', transactionId: 'GPA.before-order', purchasedAt: new Date(ambiguous[1]!.order.created_at).getTime() - 1000 }), 'unmatched')
  } finally {
    await pool.end()
    docker(['stop', '--time', '0', name])
  }
})
