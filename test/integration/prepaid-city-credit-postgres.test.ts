import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  beginCityCreditSpend,
  cityCreditAttentionLines,
  readCityCreditAttention,
  readCityCreditPreflight,
  returnCityCreditSpend,
} from '../../src/city-credit.ts'
import { deliverPayPalCredit } from '../../src/paypal-credit-delivery.ts'
import {
  attachPayPalOrder,
  attachPayPalSubscription,
  beginPayPalCreditIntent,
  type PayPalCreditStoreDatabase,
  type StoredPayPalIntent,
} from '../../src/paypal-credit-store.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'prepaid_city_credit_integration'
const PREPAID_MODULE_URL = new URL('../../src/prepaid-credit.ts', import.meta.url)
const MIGRATION_URL = new URL('../../db/migrations/20260826_prepaid_city_credit.sql', import.meta.url)
const AWARENESS_MIGRATION_URL = new URL('../../db/migrations/20260901_resident_awareness.sql', import.meta.url)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const awarenessMigrationDdl = await readFile(AWARENESS_MIGRATION_URL, 'utf8')

type QueryRow = Record<string, unknown>

type CreditDatabase = Readonly<{
  query(text: string, params?: readonly unknown[] | unknown[]): Promise<readonly QueryRow[]>
}>

type GiftResult = Readonly<{
  gift_id: string
  status: 'pending' | 'accepted' | 'refused'
}>

type PrepaidCreditModule = Readonly<{
  parseCreditDollars(value: unknown): bigint
  parseGiftClaimToken(value: unknown): string
  acceptCreditGift(database: CreditDatabase, input: Readonly<{
    residentId: number
    giftId: string
  }>): Promise<GiftResult>
  refuseCreditGift(database: CreditDatabase, input: Readonly<{
    residentId: number
    giftId: string
  }>): Promise<GiftResult>
  redirectCreditGift(database: CreditDatabase, input: Readonly<{
    giftId: string
    claimToken: string
    residentId: number
    requestId: string
  }>): Promise<GiftResult>
  readPendingCreditGifts(database: CreditDatabase, residentId: number, options: Readonly<{
    beforeId: string | null
    limit: number
  }>): Promise<Readonly<{
    items: readonly (Readonly<Record<string, unknown>> & GiftResult)[]
    page: Readonly<{ has_more: boolean; next_before_gift_id: string | null }>
  }>>
}>

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-prepaid-credit-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function database(client: Pool): CreditDatabase {
  return {
    query: async (text, params = []) => (await client.query(text, [...params])).rows,
  }
}

async function resetFresh(client: Pool, migrationDdl: string): Promise<void> {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(migrationDdl)
  await client.query(migrationDdl)
  await client.query(awarenessMigrationDdl)
  await client.query(awarenessMigrationDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'prepaid-credit-test', repeat('1', 64)),
      (2, 'resident-two', 'prepaid-credit-test', repeat('2', 64)),
      (3, 'resident-three', 'prepaid-credit-test', repeat('3', 64)),
      (5, 'resident-five', 'prepaid-credit-test', repeat('5', 64))
  `)
}

async function balance(client: Pool, residentId: number): Promise<string> {
  const result = await client.query<{ balance_units: string }>(`
    SELECT COALESCE((
      SELECT balance_units FROM city_credit_accounts WHERE resident_id = $1
    ), 0)::text AS balance_units
  `, [residentId])
  return result.rows[0]!.balance_units
}

async function receiptKinds(client: Pool, residentId: number): Promise<string[]> {
  const result = await client.query<{ entry_kind: string }>(`
    SELECT entry_kind FROM city_credit_entries
    WHERE resident_id = $1
    ORDER BY id
  `, [residentId])
  return result.rows.map(row => row.entry_kind)
}

async function deliverTestPurchase(
  db: PayPalCreditStoreDatabase,
  input: Readonly<{
    delivery: 'self' | 'gift'
    residentId: number
    amountUnits: bigint
    purchaseKind: 'paypal' | 'allowance'
    remoteResourceId: string
  }>,
): Promise<Readonly<{
  purchase: Readonly<Record<string, unknown>> & Partial<GiftResult>
  claimToken: string | null
  intent: StoredPayPalIntent
  replay(): Promise<Readonly<Record<string, unknown>> & Partial<GiftResult>>
}>> {
  const intentKind = input.purchaseKind === 'paypal' ? 'order' : 'allowance'
  const intent = await beginPayPalCreditIntent(db, {
    requestId: `prepaid-pg-${input.remoteResourceId.toLowerCase()}`,
    intentKind,
    delivery: input.delivery,
    recipientId: input.residentId,
    amountUnits: input.amountUnits,
    paypalEnvironment: 'sandbox',
  })
  let attached: StoredPayPalIntent
  if (intentKind === 'order') {
    const order = await attachPayPalOrder(db, {
      purchaseId: intent.purchaseId,
      orderId: `ORDER-${input.remoteResourceId}`,
    })
    attached = Object.freeze({
      ...intent,
      remoteOrderId: order.orderId,
      status: order.status,
    })
  } else {
    const subscription = await attachPayPalSubscription(db, {
      purchaseId: intent.purchaseId,
      subscriptionId: `SUB-${input.remoteResourceId}`,
    })
    attached = Object.freeze({
      ...intent,
      remoteSubscriptionId: subscription.subscriptionId,
      status: subscription.status,
    })
  }
  const deliveryInput = Object.freeze({
    intent: attached,
    sourceKey: input.purchaseKind === 'paypal'
      ? `paypal:capture:${input.remoteResourceId}`
      : `paypal:sale:${input.remoteResourceId}`,
    purchaseKind: input.purchaseKind,
    eventId: `fixture:${input.remoteResourceId}`,
    eventKind: input.purchaseKind === 'paypal'
      ? 'PAYMENT.CAPTURE.COMPLETED' as const
      : 'PAYMENT.SALE.COMPLETED' as const,
    remoteResourceId: input.remoteResourceId,
  })
  const purchase = await deliverPayPalCredit(db, deliveryInput)
  return Object.freeze({
    purchase,
    claimToken: intent.claimToken,
    intent: attached,
    replay: async () => await deliverPayPalCredit(db, deliveryInput),
  })
}

function postgresCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return String((error as { code?: unknown }).code ?? '')
}

test('prepaid credit transitions stay exact, private, nonnegative, and nonexpiring in PostgreSQL', {
  timeout: 120_000,
}, async t => {
  assert.equal(existsSync(PREPAID_MODULE_URL), true, 'add src/prepaid-credit.ts')
  assert.equal(existsSync(MIGRATION_URL), true, 'add the prepaid city-credit migration')
  const moduleSpecifier = PREPAID_MODULE_URL.href
  const prepaid = await import(moduleSpecifier) as PrepaidCreditModule
  const migrationDdl = await readFile(MIGRATION_URL, 'utf8')
  const postgres = await startPostgres()

  try {
    await t.test('a variable self purchase and weekly allowance each mint once by source key', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)

      const selfPurchase = await deliverTestPurchase(db, {
        delivery: 'self',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('3'),
        purchaseKind: 'paypal',
        remoteResourceId: 'SELF0001',
      })
      await selfPurchase.replay()
      await deliverTestPurchase(db, {
        delivery: 'self',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('2'),
        purchaseKind: 'allowance',
        remoteResourceId: 'ALLOWANCE0001',
      })
      const secondAllowance = await deliverTestPurchase(db, {
        delivery: 'self',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('2'),
        purchaseKind: 'allowance',
        remoteResourceId: 'ALLOWANCE0002',
      })
      await secondAllowance.replay()

      assert.equal(await balance(postgres.client, 2), '7000000')
      assert.deepEqual(await receiptKinds(postgres.client, 2), [
        'purchase', 'purchase', 'purchase',
      ])
      const receiptCountBeforePreflight = (await receiptKinds(postgres.client, 2)).length
      const preflight = await readCityCreditPreflight(db, 2)
      assert.equal(preflight.fee_cost_units, '1000000')
      assert.equal(preflight.balance_before_units, '7000000')
      assert.equal(preflight.balance_after_units, '6000000')
      assert.equal(preflight.can_confirm, true)
      assert.equal((await receiptKinds(postgres.client, 2)).length, receiptCountBeforePreflight)
      const purchaseRows = await postgres.client.query<{
        amount_units: string
        source_key: string
      }>(`
        SELECT amount_units::text, source_key
        FROM city_credit_entries
        WHERE resident_id = 2 AND entry_kind = 'purchase'
        ORDER BY id
      `)
      assert.deepEqual(purchaseRows.rows, [
        { amount_units: '3000000', source_key: 'paypal:capture:SELF0001' },
        { amount_units: '2000000', source_key: 'paypal:sale:ALLOWANCE0001' },
        { amount_units: '2000000', source_key: 'paypal:sale:ALLOWANCE0002' },
      ])

      await assert.rejects(
        deliverPayPalCredit(db, {
          intent: { ...selfPurchase.intent, amountUnits: prepaid.parseCreditDollars('4') },
          sourceKey: 'paypal:capture:SELF0001',
          purchaseKind: 'paypal',
          eventId: 'fixture:SELF0001',
          eventKind: 'PAYMENT.CAPTURE.COMPLETED',
          remoteResourceId: 'SELF0001',
        }),
        /conflict|changed|source|immutable intent terms/iu,
      )
      assert.equal(await balance(postgres.client, 2), '7000000')

      await assert.rejects(
        deliverPayPalCredit(db, {
          intent: { ...selfPurchase.intent, amountUnits: 1_500_000n },
          sourceKey: 'paypal-capture-fractional-0001',
          purchaseKind: 'paypal',
          eventId: 'fixture:FRACTIONAL0001',
          eventKind: 'PAYMENT.CAPTURE.COMPLETED',
          remoteResourceId: 'FRACTIONAL0001',
        }),
        /whole|dollar|exact|amount/iu,
      )
      assert.equal(await balance(postgres.client, 2), '7000000')

      await assert.rejects(
        postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units, founder_id, source_key, reason
          ) VALUES (3, 'founder_issue', 2000000, 1, 'fixed-founder-proof-0001', 'fixed proof')
        `),
        error => postgresCode(error) === '23514',
      )

      await assert.rejects(
        postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units, founder_id, source_key, reason
          ) VALUES (3, 'admin_debit', 1000000, 1, 'negative-proof-0001', 'negative proof')
        `),
        error => postgresCode(error) === '23514',
      )
      assert.equal(await balance(postgres.client, 2), '7000000')
      assert.equal(await balance(postgres.client, 3), '0')
    })

    await t.test('a variable purchase funds every one-credit fee and an exact failed spend returns once', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)
      await deliverTestPurchase(db, {
        delivery: 'self',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('3'),
        purchaseKind: 'paypal',
        remoteResourceId: 'VARIABLESPENDS0001',
      })

      const spends = [
        {
          operation: 'frontier' as const,
          targetKey: 'frontier:variable-credit-proof',
          requestId: 'variable-credit-frontier-0001',
          request: { name: 'Variable Credit Frontier' },
        },
        {
          operation: 'kind_invention' as const,
          targetKey: 'kind:variable-credit-proof',
          requestId: 'variable-credit-kind-0000001',
          request: { name: 'variable-credit-kind' },
        },
        {
          operation: 'kind_revision' as const,
          targetKey: 'kind-revision:991',
          requestId: 'variable-credit-revision-0001',
          request: { kind_id: 991, description: 'changed terms' },
          assetType: 'kind' as const,
          assetId: 991,
        },
      ]

      const readySpends = []
      for (const [index, spend] of spends.entries()) {
        const result = await beginCityCreditSpend(db, { actorId: 2, ...spend })
        assert.equal(result.state, 'ready')
        if (result.state !== 'ready') assert.fail('expected an exact city-credit spend')
        readySpends.push(result)
        assert.equal(await balance(postgres.client, 2), String((2 - index) * 1_000_000))
      }

      await assert.rejects(
        beginCityCreditSpend(db, {
          actorId: 2,
          operation: 'frontier',
          targetKey: 'frontier:negative-balance-proof',
          requestId: 'variable-credit-negative-0001',
          request: { name: 'Must Not Spend' },
        }),
        error => postgresCode(error) === '23514',
      )
      assert.equal(await balance(postgres.client, 2), '0')

      const failed = readySpends[2]!
      const returnInput = {
        actorId: 2,
        attemptId: failed.attempt_id,
        leaseOwner: failed.lease_owner,
        reason: 'kind revision target changed before completion',
        responseStatus: 409,
        response: { error: 'kind revision target changed; credit returned' },
      }
      const returned = await returnCityCreditSpend(db, returnInput)
      assert.equal(returned.disposition, 'created')
      const replay = await returnCityCreditSpend(db, returnInput)
      assert.equal(replay.disposition, 'existing')
      assert.equal(replay.return_entry_id, returned.return_entry_id)
      assert.equal(await balance(postgres.client, 2), '1000000')
      assert.deepEqual(await receiptKinds(postgres.client, 2), [
        'purchase', 'spend', 'spend', 'spend', 'return',
      ])
    })

    await t.test('a pending gift confers nothing until its recipient accepts exactly once', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)
      const delivered = await deliverTestPurchase(db, {
        delivery: 'gift',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('4'),
        purchaseKind: 'paypal',
        remoteResourceId: 'GIFTACCEPT0001',
      })
      const claimToken = prepaid.parseGiftClaimToken(delivered.claimToken)
      const claimTokenHash = createHash('sha256').update(claimToken, 'utf8').digest('hex')
      const purchase = delivered.purchase
      assert.equal(purchase.status, 'pending')
      assert.match(String(purchase.gift_id ?? ''), /^city_gift_[0-9a-f]{32}$/u)
      const purchaseReplay = await delivered.replay()
      assert.equal(purchaseReplay.gift_id, purchase.gift_id)
      assert.equal(purchaseReplay.status, 'pending')

      assert.equal(await balance(postgres.client, 2), '0')
      assert.deepEqual(await receiptKinds(postgres.client, 2), ['purchase', 'gift_pending'])
      const giftBefore = await postgres.client.query<{
        recipient_id: number
        amount_units: string
        status: string
        claim_token_hash: string
      }>(`
        SELECT recipient_id, amount_units::text, status, claim_token_hash
        FROM city_credit_gifts WHERE public_id = $1
      `, [purchase.gift_id])
      assert.deepEqual(giftBefore.rows, [{
        recipient_id: 2,
        amount_units: '4000000',
        status: 'pending',
        claim_token_hash: claimTokenHash,
      }])

      await assert.rejects(
        prepaid.acceptCreditGift(db, { residentId: 3, giftId: purchase.gift_id! }),
        /recipient|gift|not found|forbidden/iu,
      )
      assert.equal(await balance(postgres.client, 2), '0')

      const accepted = await prepaid.acceptCreditGift(db, {
        residentId: 2,
        giftId: purchase.gift_id!,
      })
      assert.equal(accepted.status, 'accepted')
      const replay = await prepaid.acceptCreditGift(db, {
        residentId: 2,
        giftId: purchase.gift_id!,
      })
      assert.equal(replay.status, 'accepted')
      assert.equal(await balance(postgres.client, 2), '4000000')
      assert.deepEqual(
        await receiptKinds(postgres.client, 2),
        ['purchase', 'gift_pending', 'gift_accept'],
      )
    })

    await t.test('me attention moves from pending gift to one dated balance change, then clears', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)

      const baseline = await readCityCreditAttention(db, 2)
      assert.deepEqual(cityCreditAttentionLines(baseline), [])

      const delivered = await deliverTestPurchase(db, {
        delivery: 'gift',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('4'),
        purchaseKind: 'paypal',
        remoteResourceId: 'AWARENESS0001',
      })
      const giftId = delivered.purchase.gift_id!
      assert.equal(await balance(postgres.client, 2), '0')

      const pending = await readCityCreditAttention(db, 2)
      assert.deepEqual(cityCreditAttentionLines(pending), [
        'You have 1 pending 1F3D9 fee-credit gift awaiting accept or refuse; see city_fee_credit.pending_gifts.',
      ])
      const preflight = await readCityCreditPreflight(db, 2)
      assert.equal(preflight.pending_gifts_count, 1)

      await prepaid.acceptCreditGift(db, { residentId: 2, giftId })
      const acceptedAt = await postgres.client.query<{ created_at: Date }>(`
        SELECT created_at FROM city_credit_entries
        WHERE resident_id = 2 AND entry_kind = 'gift_accept'
        ORDER BY id DESC LIMIT 1
      `)
      const acceptedAtIso = acceptedAt.rows[0]!.created_at.toISOString()
      const accepted = await readCityCreditAttention(db, 2)
      assert.deepEqual(cityCreditAttentionLines(accepted), [
        `Your 1F3D9 fee-credit balance changed by 4.000000 since your previous me read; the latest change was on ${acceptedAtIso}.`,
      ])
      assert.equal(await balance(postgres.client, 2), '4000000')

      const cleared = await readCityCreditAttention(db, 2)
      assert.deepEqual(cityCreditAttentionLines(cleared), [])

      const secondDelivered = await deliverTestPurchase(db, {
        delivery: 'gift',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('1'),
        purchaseKind: 'paypal',
        remoteResourceId: 'AWARENESS0003',
      })
      assert.ok(secondDelivered.purchase.gift_id)
      const secondPending = await readCityCreditAttention(db, 2)
      assert.deepEqual(cityCreditAttentionLines(secondPending), [
        'You have 1 pending 1F3D9 fee-credit gift awaiting accept or refuse; see city_fee_credit.pending_gifts.',
      ])

      const marker = await postgres.client.query<{ last_credit_entry_id: string }>(`
        SELECT last_credit_entry_id::text FROM city_credit_last_me_reads
        WHERE resident_id = 2
      `)
      const latest = await postgres.client.query<{ id: string }>(`
        SELECT max(id)::text AS id FROM city_credit_entries WHERE resident_id = 2
      `)
      assert.equal(marker.rows[0]!.last_credit_entry_id, latest.rows[0]!.id)
    })

    await t.test('simultaneous me reads report one balance change only once', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)
      await readCityCreditAttention(db, 2)
      await deliverTestPurchase(db, {
        delivery: 'self',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('2'),
        purchaseKind: 'paypal',
        remoteResourceId: 'AWARENESS0002',
      })

      const results = await Promise.all([
        readCityCreditAttention(db, 2),
        readCityCreditAttention(db, 2),
      ])
      const changeLines = results.flatMap(cityCreditAttentionLines)
        .filter(line => line.includes('balance changed'))
      assert.equal(changeLines.length, 1)
      assert.match(changeLines[0]!, /changed by 2\.000000/u)
    })

    await t.test('every pending gift remains reachable after the first private page', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)
      const expected = new Set<string>()
      for (let index = 1; index <= 51; index += 1) {
        const delivered = await deliverTestPurchase(db, {
          delivery: 'gift',
          residentId: 2,
          amountUnits: prepaid.parseCreditDollars('1'),
          purchaseKind: 'paypal',
          remoteResourceId: `PENDINGPAGE${index.toString().padStart(4, '0')}`,
        })
        expected.add(delivered.purchase.gift_id!)
      }

      const first = await prepaid.readPendingCreditGifts(db, 2, {
        beforeId: null,
        limit: 50,
      })
      assert.equal(first.items.length, 50)
      for (const gift of first.items) {
        assert.deepEqual(gift.next_actions, {
          accept: `POST /api/city-credit/gifts/${gift.gift_id}/accept`,
          refuse: `POST /api/city-credit/gifts/${gift.gift_id}/refuse`,
        })
        assert.doesNotMatch(JSON.stringify(gift.next_actions), /:gift_id/u)
      }
      assert.deepEqual(first.page, {
        has_more: true,
        next_before_gift_id: first.page.next_before_gift_id,
      })
      assert.match(first.page.next_before_gift_id ?? '', /^[1-9][0-9]*$/u)
      const second = await prepaid.readPendingCreditGifts(db, 2, {
        beforeId: first.page.next_before_gift_id,
        limit: 50,
      })
      assert.equal(second.items.length, 1)
      assert.deepEqual(second.page, { has_more: false, next_before_gift_id: null })
      const reached = new Set([...first.items, ...second.items].map(gift => gift.gift_id))
      assert.deepEqual(reached, expected)
    })

    await t.test('a refused gift stays closed-loop and its private token can redirect it', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)
      const delivered = await deliverTestPurchase(db, {
        delivery: 'gift',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('2'),
        purchaseKind: 'paypal',
        remoteResourceId: 'GIFTREDIRECT0001',
      })
      const claimToken = prepaid.parseGiftClaimToken(delivered.claimToken)
      const purchase = delivered.purchase
      const giftId = purchase.gift_id!

      const refused = await prepaid.refuseCreditGift(db, { residentId: 2, giftId })
      assert.equal(refused.status, 'refused')
      const refuseReplay = await prepaid.refuseCreditGift(db, { residentId: 2, giftId })
      assert.equal(refuseReplay.status, 'refused')
      assert.equal(refuseReplay.gift_id, giftId)
      assert.equal(await balance(postgres.client, 2), '0')
      assert.deepEqual(
        await receiptKinds(postgres.client, 2),
        ['purchase', 'gift_pending', 'gift_refuse'],
      )

      await assert.rejects(
        prepaid.redirectCreditGift(db, {
          giftId,
          claimToken: `gift_claim_${'ef'.repeat(32)}`,
          residentId: 3,
          requestId: 'gift-redirect-refused-0001',
        }),
        /claim|token|gift|forbidden/iu,
      )
      const redirected = await prepaid.redirectCreditGift(db, {
        giftId,
        claimToken,
        residentId: 3,
        requestId: 'gift-redirect-refused-0001',
      })
      assert.equal(redirected.status, 'pending')
      assert.match(String(redirected.gift_id), /^city_gift_[0-9a-f]{32}$/u)
      const redirectedGiftId = redirected.gift_id
      const redirectReplay = await prepaid.redirectCreditGift(db, {
        giftId,
        claimToken,
        residentId: 3,
        requestId: 'gift-redirect-refused-0001',
      })
      assert.equal(redirectReplay.gift_id, redirectedGiftId)
      assert.equal(redirectReplay.status, 'pending')
      await assert.rejects(
        prepaid.redirectCreditGift(db, {
          giftId,
          claimToken,
          residentId: 2,
          requestId: 'gift-redirect-refused-0001',
        }),
        /changed|conflict|redirect|recipient|gift/iu,
      )

      await assert.rejects(
        prepaid.acceptCreditGift(db, { residentId: 2, giftId }),
        /recipient|gift|not found|forbidden/iu,
      )
      const secondRefusal = await prepaid.refuseCreditGift(db, {
        residentId: 3,
        giftId: redirectedGiftId,
      })
      assert.equal(secondRefusal.status, 'refused')
      const secondRedirect = await prepaid.redirectCreditGift(db, {
        giftId: redirectedGiftId,
        claimToken,
        residentId: 5,
        requestId: 'gift-redirect-refused-0002',
      })
      const accepted = await prepaid.acceptCreditGift(db, {
        residentId: 5,
        giftId: secondRedirect.gift_id,
      })
      assert.equal(accepted.status, 'accepted')
      await assert.rejects(
        prepaid.redirectCreditGift(db, {
          giftId,
          claimToken,
          residentId: 3,
          requestId: 'gift-redirect-refused-0001',
        }),
        /changed|conflict|redirect|recipient|gift/iu,
        'an old redirect must not claim the gift is still pending at an earlier recipient',
      )
      await assert.rejects(
        prepaid.redirectCreditGift(db, {
          giftId,
          claimToken,
          residentId: 5,
          requestId: 'gift-redirect-refused-0002',
        }),
        /changed|conflict|redirect|recipient|gift/iu,
        'an accepted gift must not replay a historical redirect as pending',
      )
      assert.equal(await balance(postgres.client, 2), '0')
      assert.equal(await balance(postgres.client, 3), '0')
      assert.equal(await balance(postgres.client, 5), '2000000')
      assert.deepEqual(await receiptKinds(postgres.client, 2), [
        'purchase', 'gift_pending', 'gift_refuse', 'gift_redirect',
      ])
      assert.deepEqual(await receiptKinds(postgres.client, 3), [
        'gift_pending', 'gift_refuse', 'gift_redirect',
      ])
      assert.deepEqual(await receiptKinds(postgres.client, 5), [
        'gift_pending', 'gift_accept',
      ])

      const giftColumns = await postgres.client.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'city_credit_gifts'
        ORDER BY ordinal_position
      `)
      const columnNames = giftColumns.rows.map(row => row.column_name)
      assert.equal(columnNames.some(name => /expir|deadline/iu.test(name)), false)
      assert.equal(columnNames.some(name => /buyer|payer/iu.test(name)), false)
      assert.equal(columnNames.includes('claim_token'), false)
      assert.equal(columnNames.includes('claim_token_hash'), true)

      const rawTokenLeak = await postgres.client.query<{ leaked: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM city_credit_gifts
          WHERE to_jsonb(city_credit_gifts)::text LIKE '%' || $1 || '%'
        ) AS leaked
      `, [claimToken])
      assert.equal(rawTokenLeak.rows[0]!.leaked, false)
    })

    await t.test('the buyer token can redirect an unaccepted gift without waiting or refunding', async () => {
      await resetFresh(postgres.client, migrationDdl)
      const db = database(postgres.client)
      const delivered = await deliverTestPurchase(db, {
        delivery: 'gift',
        residentId: 2,
        amountUnits: prepaid.parseCreditDollars('5'),
        purchaseKind: 'paypal',
        remoteResourceId: 'PENDINGREDIRECT0001',
      })
      const claimToken = prepaid.parseGiftClaimToken(delivered.claimToken)
      const purchase = delivered.purchase
      const originalGiftId = purchase.gift_id!

      const redirected = await prepaid.redirectCreditGift(db, {
        giftId: originalGiftId,
        claimToken,
        residentId: 3,
        requestId: 'gift-redirect-pending-0001',
      })
      assert.equal(redirected.status, 'pending')
      assert.equal(await balance(postgres.client, 2), '0')
      assert.equal(await balance(postgres.client, 3), '0')
      assert.deepEqual(await receiptKinds(postgres.client, 2), [
        'purchase', 'gift_pending', 'gift_redirect',
      ])
      assert.deepEqual(await receiptKinds(postgres.client, 3), ['gift_pending'])

      await prepaid.acceptCreditGift(db, {
        residentId: 3,
        giftId: redirected.gift_id,
      })
      assert.equal(await balance(postgres.client, 3), '5000000')
      assert.deepEqual(await receiptKinds(postgres.client, 3), [
        'gift_pending', 'gift_accept',
      ])
    })
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
