import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { findPaymentAttempt } from '../../src/payment-attempts.ts'
import {
  resumeDurableX402,
  runDurableX402,
  type PaymentFlowDependencies,
} from '../../src/payment-flow.ts'
import { parkWorldSalePayment } from '../../src/payment-sale-operations.ts'
import { parseX402Payment } from '../../src/pay.ts'
import { mountWorldMarketRoutes, type WorldMarketDependencies } from '../../src/world-market.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'world_offer_timestamps_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

const MARKET = 'https://1f3ea.com'
const SELLER_WALLET = `0x${'11'.repeat(20)}`
const BUYER_WALLET = `0x${'22'.repeat(20)}`
const TX_HASH = `0x${'33'.repeat(32)}`
const NONCE = `0x${'44'.repeat(32)}`
const BUYER_SECRET = 'Bearer postgres-buyer-secret'

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ database: Pool; containerName: string }> {
  const containerName = `1f3d9-world-timestamps-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const database = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 4,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await database.query('SELECT 1')
        return { database, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await database.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function paymentHeader(reservedAt: Date, reservedUntil: Date): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: `0x${'55'.repeat(65)}`,
      authorization: {
        from: BUYER_WALLET,
        to: SELLER_WALLET,
        value: '2000000',
        validAfter: String(Math.floor(reservedAt.getTime() / 1_000) - 60),
        validBefore: String(Math.floor(reservedUntil.getTime() / 1_000) + 60),
        nonce: NONCE,
      },
    },
  }), 'utf8').toString('base64')
}

async function waitPastDatabaseTime(database: Pool, boundary: Date): Promise<Date> {
  const startedAt = Date.now()
  for (;;) {
    const result = await database.query<{ observed_at: Date; passed: boolean }>(`
      SELECT clock_timestamp() AS observed_at,
        clock_timestamp() > $1::timestamptz + interval '1 millisecond' AS passed
    `, [boundary.toISOString()])
    const row = result.rows[0]!
    if (row.passed) {
      assert.ok(Date.now() - startedAt >= 1_500, 'the test must cross the real reservation window')
      return row.observed_at
    }
    await delay(25)
  }
}

test('world offer PostgreSQL Date milliseconds reach the parked payment attempt', async () => {
  const postgres = await startPostgres()
  try {
    const database = postgres.database
    await database.query(schemaDdl)
    await database.query(`
      INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'seller', 'integration-test', repeat('1', 64)),
        (2, 'buyer', 'integration-test', repeat('2', 64))
    `)
    const place = await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, owner_id)
      SELECT id, 'continent', 'timestamp test place', 1
      FROM places WHERE place_kind = 'world'
      RETURNING id
    `)
    await database.query(`
      INSERT INTO things (id, place_id, name, owner_id, maker_id)
      VALUES (2741, $1, 'timestamp test thing', 1, 1)
    `, [place.rows[0]!.id])
    const seeded = await database.query<{
      id: number
      reserved_at: Date
      reserved_until: Date
    }>(`
      WITH reservation AS MATERIALIZED (
        SELECT date_trunc('second', clock_timestamp())
          - interval '4 minutes 55 seconds' + interval '106 milliseconds' AS reserved_at
      )
      INSERT INTO transfer_offers (
        channel, asset_type, asset_id, seller_id, buyer_id,
        price_usdc, seller_wallet, buyer_wallet,
        market_draft_id, market_listing_id, market_checkout_id, market_buyer,
        status, reserved_by, reserved_at, reserved_until
      )
      SELECT
        'world', 'thing', 2741, 1, 2,
        2, $1, $2,
        71, 91, 81, 'market-buyer',
        'open', 2, reserved_at, reserved_at + interval '5 minutes'
      FROM reservation
      RETURNING id, reserved_at, reserved_until
    `, [SELLER_WALLET, BUYER_WALLET])
    const offer = seeded.rows[0]!
    assert.equal(offer.reserved_at.getUTCMilliseconds(), 106)
    assert.equal(offer.reserved_until.getUTCMilliseconds(), 106)
    await database.query('UPDATE things SET active_offer_id = $1 WHERE id = 2741', [offer.id])

    let finalizedAt: Date | null = null
    const paymentDependencies: Partial<PaymentFlowDependencies> = {
      custodyReady: async () => true,
      currentBlock: async () => 22_000_000n,
      verify: async (header, accepted) => {
        const parsed = parseX402Payment(header, accepted)
        assert.ok(!('error' in parsed))
        return { ...parsed, state: 'verified', verificationPayer: BUYER_WALLET }
      },
      settle: async () => ({
        state: 'settled',
        transaction: TX_HASH,
        payer: BUYER_WALLET,
        response: { success: true, transaction: TX_HASH, payer: BUYER_WALLET, network: 'base' },
      }),
      classify: async () => finalizedAt == null
        ? { state: 'pending' }
        : {
            state: 'matched',
            from: BUYER_WALLET,
            to: SELLER_WALLET,
            amount: 2_000_000n,
            blockTime: new Date(Math.ceil(offer.reserved_at.getTime() / 1_000) * 1_000),
            blockNumber: 22_000_001n,
            blockHash: `0x${'66'.repeat(32)}`,
            finalizedAt,
          },
    }
    const query: WorldMarketDependencies['query'] = async (text, params) =>
      (await database.query(text, [...params])).rows
    const dependencies: WorldMarketDependencies = {
      query,
      authenticate: async c => c.req.header('authorization') === BUYER_SECRET
        ? { id: 2, handle: 'buyer' }
        : null,
      now: () => new Date(),
      marketOrigin: MARKET,
      marketGet: async path => { throw new Error(`unexpected market read: ${path}`) },
      findPayment: findPaymentAttempt,
      runPayment: input => runDurableX402(input, paymentDependencies),
      resumePayment: input => resumeDurableX402(input, paymentDependencies),
    }
    const app = new Hono()
    app.onError(error => { throw error })
    mountWorldMarketRoutes(app, dependencies)

    const publicResponse = await app.request(`/api/world/offer/${offer.id}`)
    assert.equal(publicResponse.status, 200)
    const publicRecord = (await publicResponse.json() as {
      offer: { reserved_at: string; reserved_until: string; created_at: string }
    }).offer
    assert.equal(publicRecord.reserved_at, offer.reserved_at.toISOString())
    assert.equal(publicRecord.reserved_until, offer.reserved_until.toISOString())
    assert.match(publicRecord.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)

    const response = await app.request(`/api/world/offer/${offer.id}/claim`, {
      method: 'POST',
      headers: {
        authorization: BUYER_SECRET,
        'content-type': 'application/json',
        'x-payment': paymentHeader(offer.reserved_at, offer.reserved_until),
      },
      body: '{}',
    })
    assert.equal(response.status, 202, await response.clone().text())

    const attempt = await database.query<{
      public_id: string
      start_time: Date
      end_time: Date
    }>(`
      SELECT public_id, start_time, end_time
      FROM payment_attempts
      WHERE operation = 'world_sale' AND offer_id = $1
    `, [offer.id])
    assert.equal(
      attempt.rows[0]!.start_time.toISOString(),
      new Date(Math.ceil(offer.reserved_at.getTime() / 1_000) * 1_000).toISOString(),
    )
    const parkedOffer = await database.query<{
      pending_payment_attempt_id: string
      x402_evidence_state: string
    }>(`
      SELECT pending_payment_attempt_id, x402_evidence_state
      FROM transfer_offers WHERE id = $1
    `, [offer.id])
    assert.deepEqual(parkedOffer.rows, [{
      pending_payment_attempt_id: attempt.rows[0]!.public_id,
      x402_evidence_state: 'pending',
    }])
    const parked = await parkWorldSalePayment({ query }, { attemptId: attempt.rows[0]!.public_id })
    assert.equal(parked.state, 'parked')

    finalizedAt = await waitPastDatabaseTime(database, offer.reserved_until)
    assert.ok(finalizedAt > attempt.rows[0]!.end_time)
    const resumed = await app.request(`/api/world/offer/${offer.id}/claim`, {
      method: 'POST',
      headers: { authorization: BUYER_SECRET, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(resumed.status, 200, await resumed.clone().text())
    const completed = await database.query<{
      offer_status: string
      attempt_status: string
      owner_id: number
      finalized_at: Date
    }>(`
      SELECT offer.status AS offer_status, attempt.status AS attempt_status,
        thing.owner_id, attempt.finalized_at
      FROM transfer_offers offer
      JOIN payment_attempts attempt ON attempt.public_id = offer.pending_payment_attempt_id
      JOIN things thing ON thing.id = offer.asset_id
      WHERE offer.id = $1
    `, [offer.id])
    assert.equal(completed.rows[0]!.offer_status, 'claimed')
    assert.equal(completed.rows[0]!.attempt_status, 'completed')
    assert.equal(completed.rows[0]!.owner_id, 2)
    assert.ok(completed.rows[0]!.finalized_at > attempt.rows[0]!.end_time)
  } finally {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
