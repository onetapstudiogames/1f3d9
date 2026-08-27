import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { deliverPayPalCredit } from '../../src/paypal-credit-delivery.ts'
import { acceptCreditGift } from '../../src/prepaid-credit.ts'
import {
  attachPayPalOrder,
  attachPayPalSubscription,
  beginPayPalCreditIntent,
  readDeliveredPayPalOrderCredit,
  storePayPalCatalogPlan,
  storePayPalCatalogProduct,
  takePayPalCreditRateLimit,
  type PayPalCreditStoreDatabase,
} from '../../src/paypal-credit-store.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'paypal_credit_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260826_prepaid_city_credit.sql', import.meta.url),
  'utf8',
)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-paypal-credit-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0)
    const client = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 4,
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch {
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function database(client: Pool): PayPalCreditStoreDatabase {
  return {
    query: async (text, params = []) => (await client.query(text, [...params])).rows,
  }
}

function postgresCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return String((error as { code?: unknown }).code ?? '')
}

async function expectDeferredReceiptRejection(
  client: Pool,
  mutate: (connection: PoolClient) => Promise<void>,
): Promise<void> {
  const connection = await client.connect()
  try {
    await connection.query('BEGIN')
    await mutate(connection)
    await assert.rejects(
      connection.query('SET CONSTRAINTS ALL IMMEDIATE'),
      error => postgresCode(error) === '23514',
    )
  } finally {
    await connection.query('ROLLBACK').catch(() => undefined)
    connection.release()
  }
}

async function reset(client: Pool): Promise<void> {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(migrationDdl)
  await client.query(migrationDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'paypal-credit-test', repeat('1', 64)),
      (2, 'recipient-two', 'paypal-credit-test', repeat('2', 64))
  `)
}

test('PayPal intent, capture, event, catalog, allowance, and limit replays stay exact in PostgreSQL', {
  timeout: 120_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await reset(postgres.client)
    const db = database(postgres.client)

    const firstGift = await beginPayPalCreditIntent(db, {
      requestId: 'postgres-paypal-gift-0001',
      intentKind: 'order',
      delivery: 'gift',
      recipientId: 2,
      amountUnits: 3_000_000n,
      paypalEnvironment: 'sandbox',
    })
    assert.equal(firstGift.disposition, 'created')
    assert.match(firstGift.claimToken ?? '', /^gift_claim_[0-9a-f]{64}$/u)

    const replayGift = await beginPayPalCreditIntent(db, {
      requestId: 'postgres-paypal-gift-0001',
      intentKind: 'order',
      delivery: 'gift',
      recipientId: 2,
      amountUnits: 3_000_000n,
      paypalEnvironment: 'sandbox',
    })
    assert.equal(replayGift.purchaseId, firstGift.purchaseId)
    assert.equal(replayGift.claimToken, null)

    const attachedGift = await attachPayPalOrder(db, {
      purchaseId: firstGift.purchaseId,
      orderId: '5O190127TN364715T',
    })
    await attachPayPalOrder(db, {
      purchaseId: firstGift.purchaseId,
      orderId: '5O190127TN364715T',
    })
    const sourceKey = 'paypal:capture:3C679366HH908993F'
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await deliverPayPalCredit(db, {
        intent: { ...firstGift, ...attachedGift, remoteOrderId: attachedGift.orderId },
        sourceKey,
        purchaseKind: 'paypal',
        eventId: delivery === 0
          ? 'api-capture:3C679366HH908993F'
          : 'WH-POSTGRES-CAPTURE-1',
        eventKind: 'PAYMENT.CAPTURE.COMPLETED',
        remoteResourceId: '3C679366HH908993F',
      })
    }
    const localCaptureReplay = await readDeliveredPayPalOrderCredit(
      db,
      firstGift.purchaseId,
    )
    assert.equal(localCaptureReplay?.disposition, 'existing')
    assert.match(String(localCaptureReplay?.receipt_id), /^[1-9][0-9]*$/u)
    assert.match(String(localCaptureReplay?.gift_id), /^city_gift_[0-9a-f]{32}$/u)

    const allowance = await beginPayPalCreditIntent(db, {
      requestId: 'postgres-paypal-allowance-0001',
      intentKind: 'allowance',
      delivery: 'self',
      recipientId: 2,
      amountUnits: 4_000_000n,
      paypalEnvironment: 'sandbox',
    })
    await storePayPalCatalogProduct(db, {
      paypalEnvironment: 'sandbox', productId: 'PROD-6XB24663H4094933M',
    })
    await storePayPalCatalogPlan(db, {
      paypalEnvironment: 'sandbox', planId: 'P-5ML4271244454362WXNWU5NQ',
    })
    const attachedAllowance = await attachPayPalSubscription(db, {
      purchaseId: allowance.purchaseId, subscriptionId: 'I-BW452GLLEP1G',
    })
    await attachPayPalSubscription(db, {
      purchaseId: allowance.purchaseId, subscriptionId: 'I-BW452GLLEP1G',
    })
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await deliverPayPalCredit(db, {
        intent: {
          ...allowance,
          ...attachedAllowance,
          remoteSubscriptionId: attachedAllowance.subscriptionId,
        },
        sourceKey: 'paypal:sale:8MC585209K746392H',
        purchaseKind: 'allowance',
        eventId: 'WH-POSTGRES-RENEWAL-1',
        eventKind: 'PAYMENT.SALE.COMPLETED',
        remoteResourceId: '8MC585209K746392H',
      })
    }

    const counts = await postgres.client.query<{
      intents: string; gifts: string; purchases: string; events: string; balance: string
    }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_intents)::text AS intents,
        (SELECT count(*) FROM city_credit_gifts)::text AS gifts,
        (SELECT count(*) FROM city_credit_entries WHERE entry_kind = 'purchase')::text AS purchases,
        (SELECT count(*) FROM paypal_credit_events)::text AS events,
        coalesce((SELECT balance_units FROM city_credit_accounts WHERE resident_id = 2), 0)::text AS balance
    `)
    assert.deepEqual(counts.rows[0], {
      intents: '2', gifts: '1', purchases: '2', events: '2', balance: '4000000',
    })

    const bindings = await postgres.client.query<{
      event_id: string
      intent_public_id: string
      purchase_entry_id: string
      source_key: string
      entry_source_key: string
    }>(`
      SELECT event.event_id, event.intent_public_id,
        event.purchase_entry_id::text, event.source_key,
        entry.source_key AS entry_source_key
      FROM paypal_credit_events event
      JOIN city_credit_entries entry ON entry.id = event.purchase_entry_id
      WHERE event.outcome = 'credited'
      ORDER BY event.event_id
    `)
    assert.deepEqual(bindings.rows.map(row => ({
      intent: row.intent_public_id,
      sameSource: row.source_key === row.entry_source_key,
    })), [
      { intent: firstGift.purchaseId, sameSource: true },
      { intent: allowance.purchaseId, sameSource: true },
    ])

    for (const mutation of [
      `UPDATE paypal_credit_events SET outcome = 'ignored'
        WHERE event_id = 'api-capture:3C679366HH908993F'`,
      `DELETE FROM paypal_credit_events
        WHERE event_id = 'api-capture:3C679366HH908993F'`,
    ]) {
      await assert.rejects(
        postgres.client.query(mutation),
        error => postgresCode(error) === '55000',
      )
    }

    for (const [kind, attackSource] of [
      ['paypal', 'paypal:capture:PAYMENTLESS-DIRECT-0001'],
      ['allowance', 'paypal:sale:PAYMENTLESS-DIRECT-0002'],
    ] as const) {
      await assert.rejects(
        postgres.client.query(`
          SELECT * FROM record_city_credit_purchase(
            2, 1000000, $1::text, $2::text, NULL, NULL
          )
        `, [attackSource, kind]),
        error => postgresCode(error) === '23514',
      )
    }

    const rollbackIntent = await beginPayPalCreditIntent(db, {
      requestId: 'postgres-paypal-atomic-rollback-0001',
      intentKind: 'order',
      delivery: 'self',
      recipientId: 2,
      amountUnits: 2_000_000n,
      paypalEnvironment: 'sandbox',
    })
    const attachedRollback = await attachPayPalOrder(db, {
      purchaseId: rollbackIntent.purchaseId,
      orderId: '5O190127TN364716R',
    })
    await postgres.client.query(`
      CREATE OR REPLACE FUNCTION reject_test_paypal_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced event failure for atomic rollback proof';
      END
      $$;
      CREATE TRIGGER paypal_credit_events_force_test_failure
        BEFORE INSERT ON paypal_credit_events
        FOR EACH ROW
        WHEN (NEW.event_id = 'api-capture:ROLLBACK-CAPTURE-0001')
        EXECUTE FUNCTION reject_test_paypal_event();
    `)
    try {
      await assert.rejects(
        deliverPayPalCredit(db, {
          intent: {
            ...rollbackIntent,
            ...attachedRollback,
            remoteOrderId: attachedRollback.orderId,
          },
          sourceKey: 'paypal:capture:ROLLBACK-CAPTURE-0001',
          purchaseKind: 'paypal',
          eventId: 'api-capture:ROLLBACK-CAPTURE-0001',
          eventKind: 'PAYMENT.CAPTURE.COMPLETED',
          remoteResourceId: 'ROLLBACK-CAPTURE-0001',
        }),
        /forced event failure/iu,
      )
    } finally {
      await postgres.client.query(`
        DROP TRIGGER IF EXISTS paypal_credit_events_force_test_failure
          ON paypal_credit_events;
        DROP FUNCTION IF EXISTS reject_test_paypal_event();
      `)
    }
    const rolledBack = await postgres.client.query<{
      purchases: string
      events: string
      status: string
      balance: string
    }>(`
      SELECT
        (SELECT count(*) FROM city_credit_entries
          WHERE source_key = 'paypal:capture:ROLLBACK-CAPTURE-0001')::text AS purchases,
        (SELECT count(*) FROM paypal_credit_events
          WHERE source_key = 'paypal:capture:ROLLBACK-CAPTURE-0001')::text AS events,
        (SELECT status FROM paypal_credit_intents
          WHERE public_id = $1::text) AS status,
        (SELECT balance_units::text FROM city_credit_accounts
          WHERE resident_id = 2) AS balance
    `, [rollbackIntent.purchaseId])
    assert.deepEqual(rolledBack.rows[0], {
      purchases: '0', events: '0', status: 'approval_pending', balance: '4000000',
    })

    const stored = await postgres.client.query('SELECT * FROM paypal_credit_intents ORDER BY public_id')
    const serialized = JSON.stringify(stored.rows)
    assert.doesNotMatch(serialized, /gift_claim_|buyer|payer|email/iu)
    assert.equal(serialized.includes(firstGift.claimToken!), false)

    for (const attack of [
      `UPDATE paypal_credit_intents SET amount_units = amount_units + 1000000
        WHERE public_id = $1`,
      `UPDATE paypal_credit_intents SET recipient_id = 1 WHERE public_id = $1`,
      `UPDATE paypal_credit_intents SET paypal_environment = 'live' WHERE public_id = $1`,
      `UPDATE paypal_credit_intents SET remote_order_id = '5O190127TN364715X'
        WHERE public_id = $1`,
      `UPDATE paypal_credit_intents SET status = 'approval_pending' WHERE public_id = $1`,
    ]) {
      await assert.rejects(
        postgres.client.query(attack, [firstGift.purchaseId]),
        error => postgresCode(error) === '55000',
      )
    }
    for (const forbiddenStatus of ['approval_pending', 'canceled']) {
      await assert.rejects(
        postgres.client.query(
          `UPDATE paypal_credit_intents SET status = $2::text WHERE public_id = $1`,
          [allowance.purchaseId, forbiddenStatus],
        ),
        error => postgresCode(error) === '55000',
      )
    }
    await assert.rejects(
      postgres.client.query(
        'DELETE FROM paypal_credit_intents WHERE public_id = $1',
        [firstGift.purchaseId],
      ),
      error => postgresCode(error) === '55000',
    )

    const transitionAttack = await postgres.client.connect()
    try {
      await transitionAttack.query('BEGIN')
      await transitionAttack.query(`
        INSERT INTO paypal_credit_intents (
          public_id, request_id, intent_kind, delivery, recipient_id,
          amount_units, paypal_environment, status
        ) VALUES (
          'city_paypal_attack0000000000000001', 'postgres-paypal-attack-0001',
          'order', 'self', 2, 1000000, 'sandbox', 'created'
        )
      `)
      await assert.rejects(
        transitionAttack.query(`
          UPDATE paypal_credit_intents
          SET remote_order_id = '5O190127TN364715Y', status = 'captured'
          WHERE public_id = 'city_paypal_attack0000000000000001'
        `),
        error => postgresCode(error) === '55000',
      )
    } finally {
      await transitionAttack.query('ROLLBACK').catch(() => undefined)
      transitionAttack.release()
    }

    await assert.rejects(
      postgres.client.query(`
        INSERT INTO paypal_credit_intents (
          public_id, request_id, intent_kind, delivery, recipient_id,
          amount_units, paypal_environment, remote_order_id, status
        ) VALUES (
          'city_paypal_attack0000000000000002', 'postgres-paypal-attack-0002',
          'order', 'self', 2, 1000000, 'sandbox', '5O190127TN364715Z', 'captured'
        )
      `),
      error => postgresCode(error) === '55000',
    )
    await assert.rejects(
      postgres.client.query(`
        INSERT INTO paypal_credit_intents (
          public_id, request_id, intent_kind, delivery, recipient_id,
          amount_units, claim_token_hash, paypal_environment, status
        ) VALUES (
          'city_paypal_attack0000000000000003', 'postgres-paypal-attack-0003',
          'allowance', 'gift', 2, 1000000, $1::text, 'sandbox', 'created'
        )
      `, ['ef'.repeat(32)]),
      error => postgresCode(error) === '23514',
    )

    const gift = await postgres.client.query<{
      id: string
      public_id: string
      version: number
    }>(`
      SELECT id::text, public_id, version FROM city_credit_gifts
      WHERE source_key = $1
    `, [sourceKey])
    const pendingGift = gift.rows[0]!

    const allowanceGiftAttack = await postgres.client.connect()
    try {
      await allowanceGiftAttack.query('BEGIN')
      const attackGift = await allowanceGiftAttack.query<{ id: string }>(`
        INSERT INTO city_credit_gifts (
          public_id, recipient_id, amount_units, source_key,
          claim_token_hash, status
        ) VALUES (
          'city_gift_3456789abcdef0123456789abcdef012',
          2, 3000000, 'paypal-allowance-gift-ledger-attack-0001',
          $1::text, 'pending'
        ) RETURNING id::text
      `, ['34'.repeat(32)])
      await assert.rejects(
        allowanceGiftAttack.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units, source_key,
            purchase_kind, gift_id
          ) VALUES (
            2, 'purchase', 3000000,
            'paypal-allowance-gift-ledger-attack-0001',
            'allowance', $1::bigint
          )
        `, [attackGift.rows[0]!.id]),
        error => postgresCode(error) === '23514',
      )
    } finally {
      await allowanceGiftAttack.query('ROLLBACK').catch(() => undefined)
      allowanceGiftAttack.release()
    }

    for (const source of [
      'gift-accept-direct-mint-attack-0001',
      'gift-accept-direct-mint-attack-0002',
    ]) {
      await assert.rejects(
        postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units, source_key, gift_id
          ) VALUES (2, 'gift_accept', 3000000, $1::text, $2::bigint)
        `, [source, pendingGift.id]),
        error => postgresCode(error) === '23514',
      )
    }
    await assert.rejects(
      postgres.client.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, gift_id
        ) VALUES (2, 'gift_refuse', 3000000,
          'gift-refuse-direct-attack-0001', $1::bigint)
      `, [pendingGift.id]),
      error => postgresCode(error) === '23514',
    )
    await assert.rejects(
      postgres.client.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, gift_id
        ) VALUES (2, 'gift_pending', 3000000,
          'gift-pending-direct-attack-0001', $1::bigint)
      `, [pendingGift.id]),
      error => postgresCode(error) === '23514',
    )
    await assert.rejects(
      postgres.client.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, gift_id,
          counterparty_id, request_id
        ) VALUES (1, 'gift_redirect', 3000000,
          'gift-redirect-direct-attack-0001', $1::bigint,
          2, 'postgres-gift-direct-attack-0001')
      `, [pendingGift.id]),
      error => postgresCode(error) === '23514',
    )
    assert.equal(await postgres.client.query<{ balance_units: string }>(`
      SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = 2
    `).then(result => result.rows[0]!.balance_units), '4000000')

    const wrongAcceptance = await postgres.client.connect()
    try {
      await wrongAcceptance.query('BEGIN')
      await wrongAcceptance.query(`
        UPDATE city_credit_gifts
        SET status = 'accepted', accepted_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = $1::bigint
      `, [pendingGift.id])
      await assert.rejects(
        wrongAcceptance.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units, source_key, gift_id
          ) VALUES (2, 'gift_accept', 3000000,
            'gift-accept-wrong-version-attack-0001', $1::bigint)
        `, [pendingGift.id]),
        error => postgresCode(error) === '23514',
      )
    } finally {
      await wrongAcceptance.query('ROLLBACK').catch(() => undefined)
      wrongAcceptance.release()
    }

    await expectDeferredReceiptRejection(postgres.client, async connection => {
      await connection.query(`
        UPDATE city_credit_gifts
        SET status = 'accepted', accepted_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = $1::bigint
      `, [pendingGift.id])
    })
    await expectDeferredReceiptRejection(postgres.client, async connection => {
      await connection.query(`
        UPDATE city_credit_gifts
        SET status = 'refused', refused_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = $1::bigint
      `, [pendingGift.id])
    })
    await expectDeferredReceiptRejection(postgres.client, async connection => {
      await connection.query(`
        UPDATE city_credit_gifts
        SET recipient_id = 1, version = version + 1,
          updated_at = clock_timestamp()
        WHERE id = $1::bigint
      `, [pendingGift.id])
      await connection.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, gift_id,
          counterparty_id, request_id
        ) SELECT 2, 'gift_redirect', amount_units,
          'gift:' || public_id || ':redirect:' || version::text,
          id, recipient_id, 'postgres-gift-redirect-attack-0001'
        FROM city_credit_gifts WHERE id = $1::bigint
      `, [pendingGift.id])
    })

    const acceptedGift = await acceptCreditGift(db, {
      residentId: 2,
      giftId: pendingGift.public_id,
    })
    assert.equal(acceptedGift.status, 'accepted')
    const receiptAfterAcceptance = await readDeliveredPayPalOrderCredit(
      db,
      firstGift.purchaseId,
    )
    assert.equal(receiptAfterAcceptance?.receipt_id, localCaptureReplay?.receipt_id)
    assert.equal(receiptAfterAcceptance?.gift_id, pendingGift.public_id)
    assert.equal(receiptAfterAcceptance?.status, 'pending')
    const acceptanceEvidence = await postgres.client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM city_credit_entries
      WHERE gift_id = $1::bigint AND entry_kind = 'gift_accept'
        AND source_key = 'gift:' || $2::text || ':accept:' || $3::integer::text
    `, [pendingGift.id, pendingGift.public_id, pendingGift.version])
    assert.equal(acceptanceEvidence.rows[0]!.count, '1')
    await assert.rejects(
      postgres.client.query(`
        UPDATE city_credit_gifts
        SET status = 'pending', accepted_at = NULL, updated_at = clock_timestamp()
        WHERE id = $1::bigint
      `, [pendingGift.id]),
      error => postgresCode(error) === '55000',
    )

    const concurrentIntent = await beginPayPalCreditIntent(db, {
      requestId: 'postgres-paypal-concurrent-alias-0001',
      intentKind: 'order',
      delivery: 'self',
      recipientId: 1,
      amountUnits: 1_000_000n,
      paypalEnvironment: 'sandbox',
    })
    const concurrentAttachment = await attachPayPalOrder(db, {
      purchaseId: concurrentIntent.purchaseId,
      orderId: '5O190127TN364717C',
    })
    const concurrentStoredIntent = {
      ...concurrentIntent,
      ...concurrentAttachment,
      remoteOrderId: concurrentAttachment.orderId,
    }
    await Promise.all([
      deliverPayPalCredit(db, {
        intent: concurrentStoredIntent,
        sourceKey: 'paypal:capture:CONCURRENT-CAPTURE-0001',
        purchaseKind: 'paypal',
        eventId: 'api-capture:CONCURRENT-CAPTURE-0001',
        eventKind: 'PAYMENT.CAPTURE.COMPLETED',
        remoteResourceId: 'CONCURRENT-CAPTURE-0001',
      }),
      deliverPayPalCredit(db, {
        intent: concurrentStoredIntent,
        sourceKey: 'paypal:capture:CONCURRENT-CAPTURE-0001',
        purchaseKind: 'paypal',
        eventId: 'WH-CONCURRENT-CAPTURE-0001',
        eventKind: 'PAYMENT.CAPTURE.COMPLETED',
        remoteResourceId: 'CONCURRENT-CAPTURE-0001',
      }),
    ])
    const concurrentEvidence = await postgres.client.query<{
      purchases: string
      events: string
      balance: string
    }>(`
      SELECT
        (SELECT count(*) FROM city_credit_entries
          WHERE source_key = 'paypal:capture:CONCURRENT-CAPTURE-0001')::text AS purchases,
        (SELECT count(*) FROM paypal_credit_events
          WHERE source_key = 'paypal:capture:CONCURRENT-CAPTURE-0001')::text AS events,
        (SELECT balance_units::text FROM city_credit_accounts
          WHERE resident_id = 1) AS balance
    `)
    assert.deepEqual(concurrentEvidence.rows[0], {
      purchases: '1', events: '1', balance: '1000000',
    })

    const callerHash = 'ab'.repeat(32)
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      assert.equal(await takePayPalCreditRateLimit(db, callerHash), true)
    }
    assert.equal(await takePayPalCreditRateLimit(db, callerHash), false)

    const webhookCallerHash = 'cd'.repeat(32)
    for (let attempt = 1; attempt <= 300; attempt += 1) {
      assert.equal(await takePayPalCreditRateLimit(db, webhookCallerHash, 300), true)
    }
    assert.equal(await takePayPalCreditRateLimit(db, webhookCallerHash, 300), false)
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
