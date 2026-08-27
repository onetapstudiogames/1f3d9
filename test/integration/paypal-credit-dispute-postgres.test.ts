import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { deliverPayPalCredit } from '../../src/paypal-credit-delivery.ts'
import {
  applyPayPalCreditDispute,
  readFounderPayPalCreditDisputes,
  type ParsedPayPalDisputeEvent,
} from '../../src/paypal-credit-dispute.ts'
import {
  attachPayPalOrder,
  beginPayPalCreditIntent,
  type PayPalCreditStoreDatabase,
} from '../../src/paypal-credit-store.ts'
import {
  acceptCreditGift,
  redirectCreditGift,
  refuseCreditGift,
} from '../../src/prepaid-credit.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'paypal_dispute_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const disputeMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_paypal_credit_disputes.sql', import.meta.url),
  'utf8',
)
const disputeSchemaMarker = '\n-- PayPal dispute custody (2026-08-27; migration mirror).'
const disputeSchemaOffset = schemaDdl.indexOf(disputeSchemaMarker)
assert.ok(disputeSchemaOffset > 0, 'fresh schema must mark the PayPal dispute migration mirror')
const preDisputeSchemaDdl = schemaDdl.slice(0, disputeSchemaOffset)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
      || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ pool: Pool; containerName: string }> {
  const containerName = `1f3d9-paypal-dispute-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  try {
    const port = Number(runDocker(['port', containerName, '5432/tcp'])
      .match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0)
    const pool = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 6,
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return { pool, containerName }
      } catch {
        await delay(200)
      }
    }
    await pool.end().catch(() => undefined)
    throw new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function database(client: Pool | PoolClient): PayPalCreditStoreDatabase {
  return {
    query: async (text, params = []) => (await client.query(text, [...params])).rows,
  }
}

async function reset(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await pool.query(schemaDdl)
  await pool.query(disputeMigrationDdl)
  await pool.query(disputeMigrationDdl)
  await pool.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'paypal-dispute-test', repeat('1', 64)),
      (2, 'recipient-two', 'paypal-dispute-test', repeat('2', 64)),
      (3, 'recipient-three', 'paypal-dispute-test', repeat('3', 64))
  `)
}

let sequence = 0

async function prepareGift(
  db: PayPalCreditStoreDatabase,
  recipientId = 2,
  requestedCaptureId?: string,
) {
  sequence += 1
  const suffix = String(sequence).padStart(4, '0')
  const amountUnits = 3_000_000n
  const captureId = requestedCaptureId ?? `CAPTURE-DISPUTE-${suffix}`
  const intent = await beginPayPalCreditIntent(db, {
    requestId: `postgres-dispute-gift-${suffix}`,
    intentKind: 'order',
    delivery: 'gift',
    recipientId,
    amountUnits,
    paypalEnvironment: 'sandbox',
  })
  assert.ok(intent.claimToken)
  const attached = await attachPayPalOrder(db, {
    purchaseId: intent.purchaseId,
    orderId: `ORDER-DISPUTE-${suffix}`,
  })
  return Object.freeze({
    deliveryIntent: Object.freeze({
      ...intent, ...attached, remoteOrderId: attached.orderId,
    }),
    captureId,
    claimToken: intent.claimToken,
    amountUnits,
  })
}

type PreparedGift = Awaited<ReturnType<typeof prepareGift>>

async function deliverPreparedGift(
  db: PayPalCreditStoreDatabase,
  prepared: PreparedGift,
) {
  const delivered = await deliverPayPalCredit(db, {
    intent: prepared.deliveryIntent,
    sourceKey: `paypal:capture:${prepared.captureId}`,
    purchaseKind: 'paypal',
    eventId: `api-capture:${prepared.deliveryIntent.purchaseId}`,
    eventKind: 'PAYMENT.CAPTURE.COMPLETED',
    remoteResourceId: prepared.captureId,
  })
  return Object.freeze({
    giftId: String(delivered.gift_id),
    claimToken: prepared.claimToken,
    captureId: prepared.captureId,
    amountUnits: prepared.amountUnits,
    status: String(delivered.status),
  })
}

async function deliveredGift(
  db: PayPalCreditStoreDatabase,
  recipientId = 2,
  captureId?: string,
) {
  return await deliverPreparedGift(db, await prepareGift(db, recipientId, captureId))
}

function dispute(input: Readonly<{
  eventId: string
  eventKind: ParsedPayPalDisputeEvent['eventKind']
  disputeId: string
  captureId?: string
  captureIds?: readonly string[]
  updateTime: string
  outcomeCode?: ParsedPayPalDisputeEvent['outcomeCode']
}>): ParsedPayPalDisputeEvent {
  return Object.freeze({
    eventId: input.eventId,
    eventKind: input.eventKind,
    disputeId: input.disputeId,
    captureIds: input.captureIds ?? [input.captureId!],
    paypalStatus: input.eventKind === 'CUSTOMER.DISPUTE.RESOLVED'
      ? 'RESOLVED'
      : input.eventKind === 'CUSTOMER.DISPUTE.UPDATED' ? 'UNDER_REVIEW' : 'OPEN',
    outcomeCode: input.outcomeCode ?? null,
    resourceUpdatedAt: input.updateTime,
  })
}

async function withPostgres(
  run: (pool: Pool, db: PayPalCreditStoreDatabase) => Promise<void>,
): Promise<void> {
  const postgres = await startPostgres()
  try {
    await reset(postgres.pool)
    await run(postgres.pool, database(postgres.pool))
  } finally {
    await postgres.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
}

async function giftState(pool: Pool, giftId: string) {
  const result = await pool.query<{
    status: string
    recipient_id: number
    version: number
    refused_at: Date | null
    frozen_at: Date | null
    revoked_at: Date | null
  }>(`
    SELECT status, recipient_id, version, refused_at, frozen_at, revoked_at
    FROM city_credit_gifts WHERE public_id = $1
  `, [giftId])
  assert.equal(result.rows.length, 1)
  return result.rows[0]!
}

async function legacyGiftAction(
  pool: Pool,
  input: Readonly<{
    giftId: string
    residentId: number
    action: 'accept' | 'refuse'
  }>,
): Promise<void> {
  const status = input.action === 'accept' ? 'accepted' : 'refused'
  const entryKind = input.action === 'accept' ? 'gift_accept' : 'gift_refuse'
  const timestampColumn = input.action === 'accept' ? 'accepted_at' : 'refused_at'
  const result = await pool.query(`
    WITH changed AS MATERIALIZED (
      UPDATE city_credit_gifts gift
      SET status = $3::text, ${timestampColumn} = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE gift.public_id = $1::text AND gift.recipient_id = $2::integer
        AND gift.status = 'pending'
      RETURNING gift.*
    ), receipt AS (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, source_key, gift_id
      )
      SELECT changed.recipient_id, $4::text, changed.amount_units,
        'gift:' || changed.public_id || ':${input.action}:' || changed.version::text,
        changed.id
      FROM changed RETURNING id
    )
    SELECT count(*)::integer AS changed FROM changed
  `, [input.giftId, input.residentId, status, entryKind])
  assert.equal(result.rows[0]?.changed, 1)
}

async function captureLock(client: PoolClient, captureId: string): Promise<void> {
  await client.query('BEGIN')
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/dispute-reconciliation', 0
    ))
  `)
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/capture/' || $1::text, 0
    ))
  `, [captureId])
}

async function rawApply(
  pool: Pool,
  input: Readonly<{
    eventId: string
    disputeId: string
    captureIds: readonly string[]
    outcomeCode?: ParsedPayPalDisputeEvent['outcomeCode']
  }>,
) {
  const resolved = input.outcomeCode !== undefined
  return await pool.query(`
    SELECT * FROM apply_paypal_credit_dispute(
      $1::text, $2::text, $3::text, $4::text[],
      $5::text, $6::text, $7::timestamptz
    )
  `, [
    input.eventId,
    resolved ? 'CUSTOMER.DISPUTE.RESOLVED' : 'CUSTOMER.DISPUTE.CREATED',
    input.disputeId,
    input.captureIds,
    resolved ? 'RESOLVED' : 'OPEN',
    input.outcomeCode ?? null,
    '2026-08-27T12:00:00.000Z',
  ])
}

test('the guarded migration upgrades populated gift custody and reapplies exactly', {
  timeout: 120_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await postgres.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await postgres.pool.query(preDisputeSchemaDdl)
    await postgres.pool.query(`
      INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'founder', 'paypal-dispute-upgrade', repeat('1', 64)),
        (2, 'recipient-two', 'paypal-dispute-upgrade', repeat('2', 64)),
        (3, 'recipient-three', 'paypal-dispute-upgrade', repeat('3', 64))
    `)
    const db = database(postgres.pool)
    const pending = await deliveredGift(db, 2)
    const accepted = await deliveredGift(db, 2)
    const refused = await deliveredGift(db, 3)
    await legacyGiftAction(postgres.pool, {
      residentId: 2, giftId: accepted.giftId, action: 'accept',
    })
    await legacyGiftAction(postgres.pool, {
      residentId: 3, giftId: refused.giftId, action: 'refuse',
    })

    await postgres.pool.query(disputeMigrationDdl)
    await postgres.pool.query(disputeMigrationDdl)
    const upgraded = await postgres.pool.query<{
      public_id: string
      status: string
      frozen_at: Date | null
      revoked_at: Date | null
    }>(`
      SELECT public_id, status, frozen_at, revoked_at
      FROM city_credit_gifts WHERE public_id = ANY($1::text[])
    `, [[pending.giftId, accepted.giftId, refused.giftId]])
    const stateByGift = new Map(upgraded.rows.map(row => [row.public_id, row]))
    assert.deepEqual(
      [pending.giftId, accepted.giftId, refused.giftId]
        .map(giftId => stateByGift.get(giftId)?.status),
      ['pending', 'accepted', 'refused'],
    )
    assert.ok(upgraded.rows.every(row => row.frozen_at === null && row.revoked_at === null))

    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-DISPUTE-UPGRADE-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-UPGRADE-0001',
      captureId: pending.captureId,
      updateTime: '2026-08-27T17:00:00.000Z',
    }))
    assert.equal((await giftState(postgres.pool, pending.giftId)).status, 'frozen')
    assert.equal((await giftState(postgres.pool, accepted.giftId)).status, 'accepted')
    assert.equal((await giftState(postgres.pool, refused.giftId)).status, 'refused')
  } finally {
    await postgres.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('multi-capture disputes stage unknown captures and produce the full event-purchase receipt matrix', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    const first = await deliveredGift(db, 2)
    const second = await deliveredGift(db, 3)
    const late = await prepareGift(db, 2, 'CAPTURE-DISPUTE-LATE-MATRIX')
    const captureIds = [first.captureId, second.captureId, late.captureId].sort()
    const created = dispute({
      eventId: 'WH-DISPUTE-MATRIX-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-MATRIX-0001',
      captureIds,
      updateTime: '2026-08-27T18:00:00.000Z',
    })
    const firstApply = await applyPayPalCreditDispute(db, created)
    assert.equal(firstApply.applicationOutcome,
      'dispute_partially_applied_awaiting_capture_receipt')
    assert.equal(firstApply.transactionCount, 3)
    assert.equal(firstApply.localPurchaseCount, 2)
    assert.equal(firstApply.receiptsCreated, 2)
    assert.equal((await giftState(pool, first.giftId)).status, 'frozen')
    assert.equal((await giftState(pool, second.giftId)).status, 'frozen')
    assert.equal((await applyPayPalCreditDispute(db, created)).disposition, 'existing')

    const lateDelivery = await deliverPreparedGift(db, late)
    assert.equal(lateDelivery.status, 'frozen')
    const reconciledReplay = await applyPayPalCreditDispute(db, created)
    assert.equal(reconciledReplay.applicationOutcome, 'dispute_open_gifts_frozen')
    assert.equal(reconciledReplay.localPurchaseCount, 3)
    assert.equal(reconciledReplay.receiptsCreated, 0)

    const updated = dispute({
      eventId: 'WH-DISPUTE-MATRIX-UPDATED',
      eventKind: 'CUSTOMER.DISPUTE.UPDATED',
      disputeId: created.disputeId,
      captureIds,
      updateTime: '2026-08-27T19:00:00.000Z',
    })
    const updateApply = await applyPayPalCreditDispute(db, updated)
    assert.equal(updateApply.applicationOutcome, 'dispute_open_gifts_frozen')
    assert.equal(updateApply.receiptsCreated, 3)

    const evidence = await pool.query<{
      disputes: string
      events: string
      receipts: string
      notes: string
      capture_ids: string[]
    }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_disputes)::text AS disputes,
        (SELECT count(*) FROM paypal_credit_dispute_events)::text AS events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $1)::text AS receipts,
        (SELECT count(*) FROM founder_city_credit_notes
          WHERE dispute_id = $1)::text AS notes,
        (SELECT transaction_capture_ids FROM paypal_credit_dispute_events
          WHERE paypal_event_id = $2) AS capture_ids
    `, [created.disputeId, created.eventId])
    assert.deepEqual(evidence.rows[0], {
      disputes: '1', events: '2', receipts: '6', notes: '1', capture_ids: captureIds,
    })
    const note = await pool.query<{ body: string }>(`
      SELECT body FROM founder_city_credit_notes WHERE dispute_id = $1
    `, [created.disputeId])
    assert.match(note.rows[0]?.body ?? '', /Verified PayPal dispute PP-D-MATRIX-0001/iu)
    assert.doesNotMatch(note.rows[0]?.body ?? '', /capture|resident|buyer|payer|amount/iu)
    const inspection = await readFounderPayPalCreditDisputes(db, 2)
    assert.equal(inspection.filter(item => item.dispute_id === created.disputeId).length, 2)
    assert.ok(inspection.every(item => item.internal_note === note.rows[0]?.body))
  })
})

test('evolving dispute capture sets reconcile every durable capture through resolution', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    const sellerFirst = await deliveredGift(db, 2)
    const sellerSecond = await deliveredGift(db, 3)
    const sellerDisputeId = 'PP-D-EVOLVING-SELLER'
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-EVOLVING-SELLER-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: sellerDisputeId,
      captureId: sellerFirst.captureId,
      updateTime: '2026-08-27T18:00:00.000Z',
    }))
    assert.equal((await giftState(pool, sellerFirst.giftId)).status, 'frozen')
    assert.equal((await giftState(pool, sellerSecond.giftId)).status, 'pending')
    const sellerResolved = dispute({
      eventId: 'WH-EVOLVING-SELLER-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: sellerDisputeId,
      captureId: sellerSecond.captureId,
      updateTime: '2026-08-27T19:00:00.000Z',
      outcomeCode: 'RESOLVED_SELLER_FAVOUR',
    })
    assert.equal((await applyPayPalCreditDispute(db, sellerResolved)).applicationOutcome,
      'dispute_resolved_gift_pending')
    assert.equal((await giftState(pool, sellerFirst.giftId)).status, 'pending')
    assert.equal((await giftState(pool, sellerSecond.giftId)).status, 'pending')

    const adverseFirst = await deliveredGift(db, 2)
    const adverseSecond = await deliveredGift(db, 3)
    const adverseDisputeId = 'PP-D-EVOLVING-ADVERSE'
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-EVOLVING-ADVERSE-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: adverseDisputeId,
      captureId: adverseFirst.captureId,
      updateTime: '2026-08-27T20:00:00.000Z',
    }))
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-EVOLVING-ADVERSE-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: adverseDisputeId,
      captureId: adverseSecond.captureId,
      updateTime: '2026-08-27T21:00:00.000Z',
      outcomeCode: 'RESOLVED_BUYER_FAVOUR',
    }))
    assert.equal((await giftState(pool, adverseFirst.giftId)).status, 'revoked')
    assert.equal((await giftState(pool, adverseSecond.giftId)).status, 'revoked')

    const latePrepared = await prepareGift(db, 2, 'CAPTURE-EVOLVING-LATE')
    const lateKnown = await deliveredGift(db, 3)
    const lateDisputeId = 'PP-D-EVOLVING-LATE'
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-EVOLVING-LATE-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: lateDisputeId,
      captureId: latePrepared.captureId,
      updateTime: '2026-08-27T22:00:00.000Z',
    }))
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-EVOLVING-LATE-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: lateDisputeId,
      captureId: lateKnown.captureId,
      updateTime: '2026-08-27T23:00:00.000Z',
      outcomeCode: 'ACCEPTED',
    }))
    assert.equal((await giftState(pool, lateKnown.giftId)).status, 'revoked')
    const deliveredLate = await deliverPreparedGift(db, latePrepared)
    assert.equal(deliveredLate.status, 'revoked')

    const receiptMatrices = await pool.query<{ dispute_id: string; receipts: string }>(`
      SELECT paypal_dispute_id AS dispute_id, count(*)::text AS receipts
      FROM city_credit_entries
      WHERE paypal_dispute_id = ANY($1::text[])
      GROUP BY paypal_dispute_id ORDER BY paypal_dispute_id
    `, [[adverseDisputeId, lateDisputeId, sellerDisputeId]])
    assert.deepEqual(receiptMatrices.rows, [
      { dispute_id: adverseDisputeId, receipts: '4' },
      { dispute_id: lateDisputeId, receipts: '4' },
      { dispute_id: sellerDisputeId, receipts: '4' },
    ])
  })
})

test('disputes reconcile before capture, honor latest time, and classify every official outcome', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    const late = await prepareGift(db, 2, 'CAPTURE-DISPUTE-BEFORE-DELIVERY')
    const opened = dispute({
      eventId: 'WH-DISPUTE-EARLY-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-EARLY-0001',
      captureId: late.captureId,
      updateTime: '2026-08-27T20:00:00.000Z',
    })
    const staged = await applyPayPalCreditDispute(db, opened)
    assert.equal(staged.applicationOutcome, 'dispute_awaiting_capture_receipt')
    assert.equal(staged.localPurchaseCount, 0)
    assert.equal(staged.receiptsCreated, 0)
    assert.equal(await pool.query(`SELECT count(*)::text AS count
      FROM founder_city_credit_notes WHERE dispute_id = $1`, [opened.disputeId])
      .then(result => result.rows[0]?.count), '1')
    const unmatchedInspection = await readFounderPayPalCreditDisputes(db, 1)
    assert.equal(unmatchedInspection.length, 1)
    assert.equal(unmatchedInspection[0]?.dispute_id, opened.disputeId)
    assert.equal(unmatchedInspection[0]?.capture_id, late.captureId)
    assert.equal(unmatchedInspection[0]?.gift_id, null)
    assert.equal(unmatchedInspection[0]?.amount_units, null)
    assert.match(unmatchedInspection[0]?.internal_note ?? '', /Verified PayPal dispute/iu)
    assert.deepEqual(await readFounderPayPalCreditDisputes(db, 2), [])

    const delivered = await deliverPreparedGift(db, late)
    assert.equal(delivered.status, 'frozen')
    assert.equal((await applyPayPalCreditDispute(db, opened)).applicationOutcome,
      'dispute_open_gift_frozen')

    const sellerResolved = dispute({
      eventId: 'WH-DISPUTE-EARLY-SELLER',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: opened.disputeId,
      captureIds: opened.captureIds,
      updateTime: '2026-08-27T23:00:00.000Z',
      outcomeCode: 'RESOLVED_SELLER_FAVOUR',
    })
    assert.equal((await applyPayPalCreditDispute(db, sellerResolved)).applicationOutcome,
      'dispute_resolved_gift_pending')
    assert.equal((await giftState(pool, delivered.giftId)).status, 'pending')

    const stale = dispute({
      eventId: 'WH-DISPUTE-EARLY-STALE',
      eventKind: 'CUSTOMER.DISPUTE.UPDATED',
      disputeId: opened.disputeId,
      captureIds: opened.captureIds,
      updateTime: '2026-08-27T22:00:00.000Z',
    })
    const staleApplied = await applyPayPalCreditDispute(db, stale)
    assert.equal(staleApplied.state, 'resolved_seller')
    assert.equal(staleApplied.applicationOutcome, 'dispute_stale_event_ignored')
    assert.equal((await giftState(pool, delivered.giftId)).status, 'pending')

    const newerOpen = dispute({
      eventId: 'WH-DISPUTE-EARLY-NEWER-OPEN',
      eventKind: 'CUSTOMER.DISPUTE.UPDATED',
      disputeId: opened.disputeId,
      captureIds: opened.captureIds,
      updateTime: '2026-08-28T01:00:00.000Z',
    })
    assert.equal((await applyPayPalCreditDispute(db, newerOpen)).state, 'open')
    assert.equal((await giftState(pool, delivered.giftId)).status, 'frozen')

    const resolvedFirstGift = await deliveredGift(db, 3)
    const resolvedFirst = dispute({
      eventId: 'WH-DISPUTE-RESOLVED-BEFORE-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-RESOLVED-BEFORE-CREATED',
      captureId: resolvedFirstGift.captureId,
      updateTime: '2026-08-28T03:00:00.000Z',
      outcomeCode: 'CANCELED_BY_BUYER',
    })
    assert.equal((await applyPayPalCreditDispute(db, resolvedFirst)).state,
      'resolved_seller')
    const olderCreated = dispute({
      eventId: 'WH-DISPUTE-CREATED-AFTER-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: resolvedFirst.disputeId,
      captureIds: resolvedFirst.captureIds,
      updateTime: '2026-08-28T02:00:00.000Z',
    })
    assert.equal((await applyPayPalCreditDispute(db, olderCreated)).applicationOutcome,
      'dispute_stale_event_ignored')
    assert.equal((await giftState(pool, resolvedFirstGift.giftId)).status, 'pending')

    const classifications = [
      ['RESOLVED_SELLER_FAVOUR', 'resolved_seller'],
      ['CANCELED_BY_BUYER', 'resolved_seller'],
      ['DENIED', 'resolved_seller'],
      ['RESOLVED_BUYER_FAVOUR', 'resolved_against_seller'],
      ['ACCEPTED', 'resolved_against_seller'],
      ['RESOLVED_WITH_PAYOUT', 'resolution_review'],
      ['NONE', 'resolution_review'],
    ] as const
    for (const [outcomeCode, expectedState] of classifications) {
      const suffix = outcomeCode.replaceAll('_', '-')
      const result = await rawApply(pool, {
        eventId: `WH-OUTCOME-${suffix}`,
        disputeId: `PP-D-OUTCOME-${suffix}`,
        captureIds: [`CAPTURE-OUTCOME-${suffix}`],
        outcomeCode,
      })
      assert.equal(result.rows[0]?.state, expectedState)
      assert.equal(result.rows[0]?.application_outcome,
        'dispute_awaiting_capture_receipt')
    }
  })
})

test('refused gifts keep their refusal while open disputes block redirect in both row-lock orderings', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    const refused = await deliveredGift(db, 2)
    await refuseCreditGift(db, { residentId: 2, giftId: refused.giftId })
    const beforeOpen = await giftState(pool, refused.giftId)
    const opened = dispute({
      eventId: 'WH-DISPUTE-REFUSED-OPEN',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-REFUSED-0001',
      captureId: refused.captureId,
      updateTime: '2026-08-27T18:00:00.000Z',
    })
    assert.equal((await applyPayPalCreditDispute(db, opened)).applicationOutcome,
      'dispute_open_refused_gift_blocked')
    const blocked = await giftState(pool, refused.giftId)
    assert.equal(blocked.status, 'refused')
    assert.equal(blocked.version, beforeOpen.version)
    assert.equal(blocked.refused_at?.toISOString(), beforeOpen.refused_at?.toISOString())
    assert.ok(blocked.frozen_at)
    await assert.rejects(redirectCreditGift(db, {
      giftId: refused.giftId,
      claimToken: refused.claimToken,
      residentId: 3,
      requestId: 'postgres-refused-blocked-redirect',
    }), /payment dispute is open.*purchase that funded/iu)
    assert.equal((await refuseCreditGift(db, {
      residentId: 2, giftId: refused.giftId,
    })).status, 'refused')

    const sellerResolved = dispute({
      eventId: 'WH-DISPUTE-REFUSED-SELLER',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: opened.disputeId,
      captureIds: opened.captureIds,
      updateTime: '2026-08-27T19:00:00.000Z',
      outcomeCode: 'DENIED',
    })
    assert.equal((await applyPayPalCreditDispute(db, sellerResolved)).applicationOutcome,
      'dispute_resolved_refused_gift')
    const unblocked = await giftState(pool, refused.giftId)
    assert.equal(unblocked.status, 'refused')
    assert.equal(unblocked.frozen_at, null)
    assert.equal((await redirectCreditGift(db, {
      giftId: refused.giftId,
      claimToken: refused.claimToken,
      residentId: 3,
      requestId: 'postgres-refused-unblocked-redirect',
    })).status, 'pending')

    const adverse = await deliveredGift(db, 2)
    await refuseCreditGift(db, { residentId: 2, giftId: adverse.giftId })
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-DISPUTE-REFUSED-ADVERSE',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-REFUSED-ADVERSE',
      captureId: adverse.captureId,
      updateTime: '2026-08-27T20:00:00.000Z',
      outcomeCode: 'ACCEPTED',
    }))
    assert.equal((await giftState(pool, adverse.giftId)).status, 'revoked')

    const frozenThenRefused = await deliveredGift(db, 2)
    await applyPayPalCreditDispute(db, dispute({
      eventId: 'WH-DISPUTE-FROZEN-REFUSAL',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-FROZEN-REFUSAL',
      captureId: frozenThenRefused.captureId,
      updateTime: '2026-08-27T20:30:00.000Z',
    }))
    await assert.rejects(acceptCreditGift(db, {
      residentId: 2, giftId: frozenThenRefused.giftId,
    }), /payment dispute is open/iu)
    assert.equal((await refuseCreditGift(db, {
      residentId: 2, giftId: frozenThenRefused.giftId,
    })).status, 'refused')
    const refusedWhileOpen = await giftState(pool, frozenThenRefused.giftId)
    assert.equal(refusedWhileOpen.status, 'refused')
    assert.ok(refusedWhileOpen.frozen_at)

    const disputeWins = await deliveredGift(db, 2)
    await refuseCreditGift(db, { residentId: 2, giftId: disputeWins.giftId })
    const disputeConnection = await pool.connect()
    const redirectConnection = await pool.connect()
    try {
      await disputeConnection.query('BEGIN')
      await disputeConnection.query(
        'SELECT id FROM city_credit_gifts WHERE public_id = $1 FOR UPDATE',
        [disputeWins.giftId],
      )
      const redirectRejected = assert.rejects(redirectCreditGift(
        database(redirectConnection), {
          giftId: disputeWins.giftId,
          claimToken: disputeWins.claimToken,
          residentId: 3,
          requestId: 'postgres-refused-race-dispute-wins',
        }), /payment dispute is open.*purchase that funded/iu)
      await delay(100)
      await applyPayPalCreditDispute(database(disputeConnection), dispute({
        eventId: 'WH-DISPUTE-REFUSED-RACE-WINS',
        eventKind: 'CUSTOMER.DISPUTE.CREATED',
        disputeId: 'PP-D-REFUSED-RACE-WINS',
        captureId: disputeWins.captureId,
        updateTime: '2026-08-27T21:00:00.000Z',
      }))
      await disputeConnection.query('COMMIT')
      await redirectRejected
    } finally {
      await disputeConnection.query('ROLLBACK').catch(() => undefined)
      disputeConnection.release()
      redirectConnection.release()
    }

    const redirectWins = await deliveredGift(db, 2)
    await refuseCreditGift(db, { residentId: 2, giftId: redirectWins.giftId })
    const redirectLock = await pool.connect()
    const waitingDispute = await pool.connect()
    try {
      await redirectLock.query('BEGIN')
      await redirectLock.query(
        'SELECT id FROM city_credit_gifts WHERE public_id = $1 FOR UPDATE',
        [redirectWins.giftId],
      )
      const disputePromise = applyPayPalCreditDispute(database(waitingDispute), dispute({
        eventId: 'WH-DISPUTE-REFUSED-RACE-REDIRECT',
        eventKind: 'CUSTOMER.DISPUTE.CREATED',
        disputeId: 'PP-D-REFUSED-RACE-REDIRECT',
        captureId: redirectWins.captureId,
        updateTime: '2026-08-27T22:00:00.000Z',
      }))
      await delay(100)
      assert.equal((await redirectCreditGift(database(redirectLock), {
        giftId: redirectWins.giftId,
        claimToken: redirectWins.claimToken,
        residentId: 3,
        requestId: 'postgres-refused-race-redirect-wins',
      })).status, 'pending')
      await redirectLock.query('COMMIT')
      assert.equal((await disputePromise).applicationOutcome,
        'dispute_open_gift_frozen')
      const protectedTarget = await giftState(pool, redirectWins.giftId)
      assert.equal(protectedTarget.recipient_id, 3)
      assert.equal(protectedTarget.status, 'frozen')
    } finally {
      await redirectLock.query('ROLLBACK').catch(() => undefined)
      redirectLock.release()
      waitingDispute.release()
    }
  })
})

test('exact replay and dispute-versus-capture races converge across real connections', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    const replayGift = await deliveredGift(db, 2)
    const replayed = dispute({
      eventId: 'WH-DISPUTE-CONCURRENT-REPLAY',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-CONCURRENT-REPLAY',
      captureId: replayGift.captureId,
      updateTime: '2026-08-27T18:00:00.000Z',
    })
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      const results = await Promise.all([
        applyPayPalCreditDispute(database(first), replayed),
        applyPayPalCreditDispute(database(second), replayed),
      ])
      assert.deepEqual(results.map(result => result.disposition).sort(),
        ['created', 'existing'])
      assert.ok(results.every(result =>
        result.applicationOutcome === 'dispute_open_gift_frozen'))
    } finally {
      first.release()
      second.release()
    }
    const replayEvidence = await pool.query<{
      events: string
      receipts: string
      notes: string
    }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_dispute_events
          WHERE dispute_id = $1)::text AS events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $1)::text AS receipts,
        (SELECT count(*) FROM founder_city_credit_notes
          WHERE dispute_id = $1)::text AS notes
    `, [replayed.disputeId])
    assert.deepEqual(replayEvidence.rows[0], {
      events: '1', receipts: '1', notes: '1',
    })

    const disputeFirst = await prepareGift(db, 2, 'CAPTURE-RACE-DISPUTE-FIRST')
    const disputeLock = await pool.connect()
    const delayedDelivery = await pool.connect()
    try {
      await captureLock(disputeLock, disputeFirst.captureId)
      const deliveryPromise = deliverPreparedGift(database(delayedDelivery), disputeFirst)
      await delay(100)
      const staged = await applyPayPalCreditDispute(database(disputeLock), dispute({
        eventId: 'WH-DISPUTE-RACE-DISPUTE-FIRST',
        eventKind: 'CUSTOMER.DISPUTE.CREATED',
        disputeId: 'PP-D-RACE-DISPUTE-FIRST',
        captureId: disputeFirst.captureId,
        updateTime: '2026-08-27T19:00:00.000Z',
      }))
      assert.equal(staged.applicationOutcome, 'dispute_awaiting_capture_receipt')
      await disputeLock.query('COMMIT')
      const delivered = await deliveryPromise
      assert.equal(delivered.status, 'frozen')
    } finally {
      await disputeLock.query('ROLLBACK').catch(() => undefined)
      disputeLock.release()
      delayedDelivery.release()
    }

    const captureFirst = await prepareGift(db, 3, 'CAPTURE-RACE-CAPTURE-FIRST')
    const captureFirstLock = await pool.connect()
    const delayedDispute = await pool.connect()
    try {
      await captureLock(captureFirstLock, captureFirst.captureId)
      const disputePromise = applyPayPalCreditDispute(database(delayedDispute), dispute({
        eventId: 'WH-DISPUTE-RACE-CAPTURE-FIRST',
        eventKind: 'CUSTOMER.DISPUTE.CREATED',
        disputeId: 'PP-D-RACE-CAPTURE-FIRST',
        captureId: captureFirst.captureId,
        updateTime: '2026-08-27T20:00:00.000Z',
      }))
      await delay(100)
      const delivered = await deliverPreparedGift(database(captureFirstLock), captureFirst)
      assert.equal(delivered.status, 'pending')
      await captureFirstLock.query('COMMIT')
      assert.equal((await disputePromise).applicationOutcome,
        'dispute_open_gift_frozen')
      assert.equal((await giftState(pool, delivered.giftId)).status, 'frozen')
    } finally {
      await captureFirstLock.query('ROLLBACK').catch(() => undefined)
      captureFirstLock.release()
      delayedDispute.release()
    }

    const raceEvidence = await pool.query<{ bad: string }>(`
      SELECT count(*)::text AS bad FROM (
        SELECT event.dispute_id, count(receipt.id) AS receipts
        FROM paypal_credit_dispute_events event
        JOIN city_credit_entries receipt
          ON receipt.paypal_event_id = event.paypal_event_id
        WHERE event.dispute_id IN (
          'PP-D-RACE-DISPUTE-FIRST', 'PP-D-RACE-CAPTURE-FIRST'
        )
        GROUP BY event.dispute_id
        HAVING count(receipt.id) <> 1
      ) invalid
    `)
    assert.equal(raceEvidence.rows[0]?.bad, '0')
  })
})

test('database boundaries reject noncanonical arrays and accept 255-character capture and dispute ids', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    const invalidCases = [
      { eventId: 'WH-INVALID-EMPTY', disputeId: 'PP-D-INVALID-EMPTY', captureIds: [] },
      {
        eventId: 'WH-INVALID-DUPLICATE', disputeId: 'PP-D-INVALID-DUPLICATE',
        captureIds: ['CAPTURE-DUPLICATE', 'CAPTURE-DUPLICATE'],
      },
      {
        eventId: 'WH-INVALID-UNSORTED', disputeId: 'PP-D-INVALID-UNSORTED',
        captureIds: ['CAPTURE-Z', 'CAPTURE-A'],
      },
      {
        eventId: 'WH-INVALID-TOO-MANY', disputeId: 'PP-D-INVALID-TOO-MANY',
        captureIds: Array.from({ length: 1_001 }, (_, index) => (
          `CAPTURE-${String(index).padStart(4, '0')}`
        )),
      },
    ]
    for (const invalid of invalidCases) {
      await assert.rejects(rawApply(pool, invalid), /PayPal dispute event input is invalid/iu)
    }
    await assert.rejects(rawApply(pool, {
      eventId: `W${'H'.repeat(128)}`,
      disputeId: 'PP-D-INVALID-EVENT-LENGTH',
      captureIds: ['CAPTURE-VALID'],
    }), /PayPal dispute event input is invalid/iu)

    const maxCaptureId = `C${'X'.repeat(254)}`
    const maxDisputeId = `D${'Y'.repeat(254)}`
    const prepared = await prepareGift(db, 2, maxCaptureId)
    const staged = await rawApply(pool, {
      eventId: 'WH-MAXIMUM-ID-BOUNDARY',
      disputeId: maxDisputeId,
      captureIds: [maxCaptureId],
    })
    assert.equal(staged.rows[0]?.application_outcome,
      'dispute_awaiting_capture_receipt')
    const delivered = await deliverPreparedGift(db, prepared)
    assert.equal(delivered.status, 'frozen')
    const stored = await pool.query<{
      dispute_length: number
      capture_length: number
      source_length: number
      receipts: string
    }>(`
      SELECT octet_length(dispute.dispute_id) AS dispute_length,
        octet_length(event.transaction_capture_ids[1]) AS capture_length,
        octet_length(purchase.source_key) AS source_length,
        (SELECT count(*) FROM city_credit_entries receipt
          WHERE receipt.paypal_dispute_id = dispute.dispute_id)::text AS receipts
      FROM paypal_credit_disputes dispute
      JOIN paypal_credit_dispute_events event
        ON event.dispute_id = dispute.dispute_id
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = event.transaction_capture_ids[1]
      JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      WHERE dispute.dispute_id = $1
    `, [maxDisputeId])
    assert.deepEqual(stored.rows[0], {
      dispute_length: 255,
      capture_length: 255,
      source_length: 270,
      receipts: '1',
    })
  })
})
