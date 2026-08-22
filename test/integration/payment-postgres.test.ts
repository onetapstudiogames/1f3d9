import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  bindPaymentEvidence,
  canonicalPaymentRequest,
  findPaymentAttempt,
  findReplayableTargetPaymentAttempt,
} from '../../src/payment-attempts.ts'
import {
  closeSalePaymentTarget,
  completeDirectSalePayment,
  completeWorldSalePayment,
  invalidateSalePaymentTarget,
  parkWorldSalePayment,
  type PaymentSaleDatabase,
} from '../../src/payment-sale-operations.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'payment_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260816_payment_attempts.sql', import.meta.url),
  'utf8',
)
const replayMigrationDdl = await readFile(
  new URL('../../db/migrations/20260816_payment_response_replay.sql', import.meta.url),
  'utf8',
)
const responseBodyMigrationDdl = await readFile(
  new URL('../../db/migrations/20260817_payment_response_body_replay.sql', import.meta.url),
  'utf8',
)
const responseBodyRolloutMigrationDdl = await readFile(
  new URL('../../db/migrations/20260818_payment_response_body_rollout.sql', import.meta.url),
  'utf8',
)
const responseBodyValidationMigrationDdl = await readFile(
  new URL('../../db/migrations/20260818_payment_response_body_validate.sql', import.meta.url),
  'utf8',
)

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const SELLER_WALLET = `0x${'1'.repeat(40)}`
const BUYER_WALLET = `0x${'2'.repeat(40)}`
const OTHER_WALLET = `0x${'3'.repeat(40)}`
const FACILITATOR_RESPONSE_HEADER = Buffer.from(JSON.stringify({
  success: true,
  transaction: hash('4'),
  payer: BUYER_WALLET,
  network: 'base',
  facilitator: 'https://facilitator.example.test',
})).toString('base64')

function hash(digit: string): string {
  return `0x${digit.repeat(64)}`
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-payment-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
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

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

async function rejectsWithCode(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, error => postgresCode(error) === expected)
}

async function resetFresh(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'seller', 'integration-test', repeat('1', 64)),
      (2, 'buyer', 'integration-test', repeat('2', 64)),
      (3, 'other', 'integration-test', repeat('3', 64))
  `)
}

async function resetLegacy(database: Pool): Promise<void> {
  await resetFresh(database)
  await database.query(`
    DROP TRIGGER IF EXISTS payment_uses_match_attempt ON payment_uses;
    DROP TRIGGER IF EXISTS fees_match_payment_attempt ON fees;
    DROP TRIGGER IF EXISTS sale_payments_match_attempt ON sale_payments;
    DROP TRIGGER IF EXISTS payment_attempts_keep_history ON payment_attempts;
    DROP TRIGGER IF EXISTS transfer_offers_keep_pending_attempt ON transfer_offers;
    DROP TRIGGER IF EXISTS payment_attempts_validate_response_body ON payment_attempts;
    DROP FUNCTION IF EXISTS complete_payment_attempt(TEXT, TEXT, JSONB, SMALLINT, JSONB, BYTEA);
    DROP FUNCTION IF EXISTS complete_payment_attempt(TEXT, TEXT, JSONB, SMALLINT, JSONB);
    DROP FUNCTION IF EXISTS validate_payment_response_body();
    DROP FUNCTION IF EXISTS protect_pending_payment_attempt_link();
    DROP FUNCTION IF EXISTS complete_city_credit_attempt(TEXT, TEXT, JSONB, SMALLINT, JSONB, BYTEA);
    DROP FUNCTION IF EXISTS return_city_credit_spend(TEXT, TEXT, TEXT, SMALLINT, JSONB, BYTEA);
    DROP TABLE IF EXISTS city_credit_entries;
    DROP TABLE IF EXISTS city_credit_accounts;
    DROP FUNCTION IF EXISTS validate_city_credit_entry();
    DROP FUNCTION IF EXISTS apply_city_credit_entry();
    DROP FUNCTION IF EXISTS protect_city_credit_account();
    DROP FUNCTION IF EXISTS protect_payment_attempt_history();
    ALTER TABLE payment_uses DROP CONSTRAINT IF EXISTS payment_uses_exact_attempt;
    ALTER TABLE transfer_offers DROP CONSTRAINT IF EXISTS transfer_offers_pending_attempt_owner;
    ALTER TABLE transfer_offers DROP CONSTRAINT IF EXISTS transfer_offers_pending_attempt_state;
    DROP INDEX IF EXISTS transfer_offers_pending_payment_attempt;
    ALTER TABLE transfer_offers DROP COLUMN IF EXISTS pending_payment_attempt_id;
    ALTER TABLE payment_uses DROP COLUMN IF EXISTS payment_attempt_id;
    DROP TABLE payment_attempts;
  `)
}

interface AttemptInput {
  publicId: string
  actorId?: number
  counterpartyId?: number | null
  operation: 'frontier' | 'kind_invention' | 'kind_revision' | 'direct_sale' | 'world_sale'
  targetKey?: string | null
  status?: 'settling' | 'payment_pending' | 'completed' | 'invalid' | 'expired'
  payerWallet?: string | null
  nonce?: string | null
  txHash?: string | null
  requestHash?: string | null
  request?: Record<string, unknown> | null
  createdAt?: string | null
}

async function insertAttempt(database: Pool, input: AttemptInput): Promise<void> {
  const x402 = input.nonce != null
  const completedAt = input.status === 'completed'
    ? new Date(Date.now() + 60_000).toISOString()
    : null
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, counterparty_id, operation, target_key,
      request_hash, request_json, method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, status, tx_hash,
      finalized_block_number, finalized_block_hash, finalized_block_time,
      finalized_at, result_json, response_status, response_json, completed_at,
      created_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $25::jsonb, $7, $8, $9, $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18, $19, $20::jsonb, $21, $22::jsonb, $23,
      COALESCE($24::timestamptz, now())
    )
  `, [
    input.publicId,
    input.actorId ?? 1,
    input.counterpartyId ?? null,
    input.operation,
    input.targetKey ?? null,
    input.requestHash ?? null,
    x402 ? 'x402' : null,
    x402 ? 'base' : null,
    x402 ? BASE_USDC : null,
    input.payerWallet ?? null,
    x402 ? SELLER_WALLET : null,
    x402 ? 1_000_000 : null,
    input.nonce ?? null,
    input.status ?? 'settling',
    input.txHash ?? null,
    input.status === 'completed' ? 22_000_010 : null,
    input.status === 'completed' ? hash('8') : null,
    input.status === 'completed' ? '2026-08-16T12:00:30Z' : null,
    completedAt,
    input.status === 'completed' ? JSON.stringify({ test: true }) : null,
    input.status === 'completed' ? 200 : null,
    input.status === 'completed' ? JSON.stringify({ ok: true }) : null,
    completedAt,
    input.createdAt ?? null,
    input.request == null ? null : JSON.stringify(input.request),
  ])
}

async function seedDirectLegacyPayment(database: Pool, txHash: string): Promise<number> {
  const offer = await database.query<{ id: number }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, buyer_id,
      price_usdc, seller_wallet, status, claimed_at
    ) VALUES (
      'direct', 'thing', 101, 1, 2,
      3, $1, 'claimed', '2026-08-16T12:03:00Z'
    )
    RETURNING id
  `, [SELLER_WALLET])
  const offerId = offer.rows[0]!.id
  await database.query(`
    INSERT INTO payment_uses (
      tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc, created_at
    ) VALUES ($1, 2, 'sale', $2, $3, 3, '2026-08-16T12:03:00Z')
  `, [txHash, BUYER_WALLET, SELLER_WALLET])
  await database.query(`
    INSERT INTO sale_payments (
      offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
      tx_hash, verified_via, block_time
    ) VALUES ($1, 2, $2, $3, 3, $4, 'claim', '2026-08-16T12:02:00Z')
  `, [offerId, BUYER_WALLET, SELLER_WALLET, txHash])
  return offerId
}

async function seedPendingWorldPayment(database: Pool, txHash: string): Promise<number> {
  const offer = await database.query<{ id: number }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, buyer_id,
      price_usdc, seller_wallet, buyer_wallet,
      market_draft_id, market_listing_id, market_checkout_id, market_buyer,
      pending_x402_tx_hash, pending_x402_payer, pending_x402_at,
      x402_evidence_state, status, reserved_by, reserved_at, reserved_until
    ) VALUES (
      'world', 'thing', 202, 1, 2,
      2, $1, $2,
      71, 91, 81, 'market-buyer',
      $3, $2, '2026-08-16T12:02:00Z',
      'pending', 'open', 2, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z'
    )
    RETURNING id
  `, [SELLER_WALLET, BUYER_WALLET, txHash])
  return offer.rows[0]!.id
}

interface RecoverableSaleSeed {
  attemptId: string
  assetId: number
  leaseOwner: string
  offerId: number
  txHash: string
}

function saleDatabase(database: Pool): PaymentSaleDatabase {
  return {
    query: async (text, params = []) => (await database.query(text, [...params])).rows,
  }
}

async function seedRecoverableSale(
  database: Pool,
  operation: 'direct_sale' | 'world_sale',
  digit: string,
  options: Readonly<{
    activeReservation?: boolean
    ambiguousNoTx?: boolean
  }> = {},
): Promise<RecoverableSaleSeed> {
  const activeReservation = options.activeReservation === true
  const ambiguousNoTx = options.ambiguousNoTx === true
  const assetId = operation === 'direct_sale' ? 401 : 402
  const txHash = hash(digit)
  const attemptId = `attempt_${operation}_${digit.repeat(16)}`
  const leaseOwner = `sale-worker-${digit.repeat(12)}`
  const place = await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    SELECT id, 'continent', 'sale integration', 1
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `)
  await database.query(`
    INSERT INTO things (id, place_id, name, owner_id, maker_id)
    VALUES ($1, $2, $3, 1, 1)
  `, [assetId, place.rows[0]!.id, operation === 'direct_sale' ? 'direct lantern' : 'world lantern'])
  const offer = await database.query<{
    id: number
    reserved_at: Date
    reserved_until: Date
  }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, buyer_id,
      price_usdc, seller_wallet, buyer_wallet,
      market_draft_id, market_listing_id, market_checkout_id, market_buyer,
      status, reserved_by, reserved_at, reserved_until
    ) VALUES (
      $1, 'thing', $2, 1, 2,
      2, $3, $4,
      CASE WHEN $1 = 'world' THEN 71 ELSE NULL END,
      CASE WHEN $1 = 'world' THEN 91 ELSE NULL END,
      CASE WHEN $1 = 'world' THEN 81 ELSE NULL END,
      CASE WHEN $1 = 'world' THEN 'market-buyer' ELSE NULL END,
      'open', 2,
      statement_timestamp() - CASE WHEN $5::boolean
        THEN interval '4 minutes' ELSE interval '15 minutes' END,
      statement_timestamp() + CASE WHEN $5::boolean
        THEN interval '1 minute' ELSE interval '-10 minutes' END
    )
    RETURNING id, reserved_at, reserved_until
  `, [
    operation === 'direct_sale' ? 'direct' : 'world',
    assetId,
    SELLER_WALLET,
    BUYER_WALLET,
    activeReservation,
  ])
  const createdOffer = offer.rows[0]!
  await database.query(`UPDATE things SET active_offer_id = $1 WHERE id = $2`, [createdOffer.id, assetId])
  const request = operation === 'direct_sale'
    ? {
        offer_id: createdOffer.id,
        buyer_wallet: BUYER_WALLET,
        seller_wallet: SELLER_WALLET,
        price_usdc: 2,
        asset_type: 'thing',
        asset_id: assetId,
      }
    : {
        offer_id: createdOffer.id,
        market_checkout_id: 81,
        market_listing_id: 91,
        market_draft_id: 71,
        market_buyer: 'market-buyer',
        buyer_wallet: BUYER_WALLET,
        seller_wallet: SELLER_WALLET,
        price_usdc: 2,
        asset_id: assetId,
      }
  const canonical = canonicalPaymentRequest(request)
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, counterparty_id, operation, target_key,
      offer_id, asset_type, asset_id, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
      start_block, start_time, end_time, status, lease_owner, lease_expires_at,
      tx_hash, finalized_block_number, finalized_block_hash,
      finalized_block_time, finalized_at, response_json,
      recovery_started_at, recovery_deadline_at, created_at, updated_at
    ) VALUES (
      $1, 2, 1, $2, $3,
      $4, 'thing', $5, $6, $7::jsonb,
      'x402', 'base', $8, $9, $10, 2000000,
      $11, $12, 1, 4102444800,
      100,
      date_trunc('second', $13::timestamptz)
        + CASE WHEN $13::timestamptz > date_trunc('second', $13::timestamptz)
          THEN interval '1 second' ELSE interval '0 seconds' END,
      date_trunc('second', $14::timestamptz),
      $19, $15,
      clock_timestamp() + interval '30 seconds',
      $16,
      CASE WHEN $19 = 'payment_pending' THEN 123 ELSE NULL END,
      CASE WHEN $19 = 'payment_pending' THEN $17 ELSE NULL END,
      CASE WHEN $19 = 'payment_pending'
        THEN date_trunc('second', $13::timestamptz) + interval '2 minutes 1 second'
        ELSE NULL END,
      CASE WHEN $19 = 'payment_pending' THEN clock_timestamp() ELSE NULL END,
      CASE WHEN $18::text IS NULL THEN NULL ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1', jsonb_build_object('header', $18::text)
      ) END,
      statement_timestamp() - CASE WHEN $19 = 'needs_review'
        THEN interval '121 minutes' ELSE interval '15 minutes' END,
      statement_timestamp() + CASE WHEN $19 = 'needs_review'
        THEN interval '-1 minute' ELSE interval '105 minutes' END,
      statement_timestamp() - CASE WHEN $19 = 'needs_review'
        THEN interval '121 minutes' ELSE interval '15 minutes' END,
      statement_timestamp()
    )
  `, [
    attemptId,
    operation,
    `${operation === 'direct_sale' ? 'direct-sale' : 'world-sale'}:${createdOffer.id}`,
    createdOffer.id,
    assetId,
    canonical.hash,
    canonical.json,
    BASE_USDC,
    BUYER_WALLET,
    SELLER_WALLET,
    hash('a'),
    'b'.repeat(64),
    createdOffer.reserved_at.toISOString(),
    createdOffer.reserved_until.toISOString(),
    leaseOwner,
    ambiguousNoTx ? null : txHash,
    ambiguousNoTx ? null : hash('c'),
    ambiguousNoTx ? null : FACILITATOR_RESPONSE_HEADER,
    ambiguousNoTx ? 'needs_review' : 'payment_pending',
  ])
  return { attemptId, assetId, leaseOwner, offerId: createdOffer.id, txHash }
}

test('payment custody invariants hold in PostgreSQL', async t => {
  const postgres = await startPostgres()
  try {
    await t.test('fresh schema installs the durable attempt table', async () => {
      await resetFresh(postgres.client)
      const table = await postgres.client.query<{ table_name: string | null }>(
        `SELECT to_regclass('public.payment_attempts')::text AS table_name`,
      )
      assert.deepEqual(table.rows, [{ table_name: 'payment_attempts' }])
    })

    await t.test('duplicate direct-sale workers complete once after fifteen minutes and replay exact bytes', async () => {
      await resetFresh(postgres.client)
      const seed = await seedRecoverableSale(postgres.client, 'direct_sale', '5')
      const database = saleDatabase(postgres.client)

      const results = await Promise.all([
        completeDirectSalePayment(database, {
          attemptId: seed.attemptId,
          leaseOwner: seed.leaseOwner,
        }),
        completeDirectSalePayment(database, {
          attemptId: seed.attemptId,
          leaseOwner: seed.leaseOwner,
        }),
      ])

      assert.ok(results.every(result => result.state === 'completed'))
      const completed = results.filter(result => result.state === 'completed')
      assert.equal(completed[0]!.responseBody, completed[1]!.responseBody)
      assert.equal(completed[0]!.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
      const facts = await postgres.client.query(`
        SELECT attempt.status, offer.status AS offer_status, thing.owner_id,
          thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM sale_payments WHERE offer_id = $2) AS payments,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers,
          (SELECT count(*)::int FROM events WHERE kind = 'sale'
            AND detail->>'offer_id' = $2::text) AS events
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
      assert.deepEqual(facts.rows, [{
        status: 'completed',
        offer_status: 'claimed',
        owner_id: 2,
        active_offer_id: null,
        uses: 1,
        payments: 1,
        transfers: 1,
        events: 1,
      }])
    })

    await t.test('founder review atomically closes an active direct reservation and releases its asset', async () => {
      await resetFresh(postgres.client)
      const seed = await seedRecoverableSale(
        postgres.client,
        'direct_sale',
        '4',
        { activeReservation: true },
      )

      const closed = await closeSalePaymentTarget(saleDatabase(postgres.client), {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
        reason: 'automatic completion found changed direct sale facts',
        state: 'founder_review',
      })

      assert.deepEqual(closed, {
        state: 'founder_review',
        attemptId: seed.attemptId,
        actorId: 2,
        operation: 'direct_sale',
        method: 'x402',
        targetReleased: true,
      })
      const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.invalid_reason, attempt.lease_owner,
          offer.status AS offer_status, offer.canceled_at IS NOT NULL AS canceled,
          thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM sale_payments WHERE offer_id = $2) AS payments,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
      assert.deepEqual(facts.rows, [{
        status: 'founder_review',
        invalid_reason: 'automatic completion found changed direct sale facts',
        lease_owner: null,
        offer_status: 'canceled',
        canceled: true,
        owner_id: 1,
        active_offer_id: null,
        uses: 0,
        payments: 0,
        transfers: 0,
      }])
    })

    await t.test('world-sale recovery attaches stored evidence and completes once with maker and owner output', async () => {
      await resetFresh(postgres.client)
      const seed = await seedRecoverableSale(postgres.client, 'world_sale', '6')
      const database = saleDatabase(postgres.client)

      const completed = await completeWorldSalePayment(database, {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
      })

      assert.equal(completed.state, 'completed')
      if (completed.state !== 'completed') return
      const response = completed.response as {
        offer?: { maker_id?: number; made_by?: string; current_owner_id?: number; current_owner?: string }
      }
      assert.deepEqual(response.offer && {
        maker_id: response.offer.maker_id,
        made_by: response.offer.made_by,
        current_owner_id: response.offer.current_owner_id,
        current_owner: response.offer.current_owner,
      }, {
        maker_id: 1,
        made_by: 'seller',
        current_owner_id: 2,
        current_owner: 'buyer',
      })
      assert.equal(completed.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
      const facts = await postgres.client.query(`
        SELECT attempt.status, offer.status AS offer_status,
          offer.pending_payment_attempt_id, offer.pending_x402_tx_hash,
          offer.x402_evidence_state, thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
      assert.deepEqual(facts.rows, [{
        status: 'completed',
        offer_status: 'claimed',
        pending_payment_attempt_id: seed.attemptId,
        pending_x402_tx_hash: seed.txHash,
        x402_evidence_state: 'pending',
        owner_id: 2,
        active_offer_id: null,
        uses: 1,
        transfers: 1,
      }])
    })

    await t.test('interruption after atomic invalidation cannot strand a pending world receipt', async () => {
      await resetFresh(postgres.client)
      const seed = await seedRecoverableSale(postgres.client, 'world_sale', '9')
      const database = saleDatabase(postgres.client)
      const parked = await parkWorldSalePayment(database, { attemptId: seed.attemptId })
      assert.equal(parked.state, 'parked')
      const interrupted: PaymentSaleDatabase = {
        query: async (text, params = []) => {
          const rows = (await postgres.client.query(text, [...params])).rows
          if (text.includes('payment-sale-operations:invalidate-target')) {
            throw new Error('connection lost after atomic invalidation committed')
          }
          return rows
        },
      }

      await assert.rejects(
        invalidateSalePaymentTarget(interrupted, {
          attemptId: seed.attemptId,
          leaseOwner: seed.leaseOwner,
          reason: 'confirmed_mismatch',
        }),
        /connection lost after atomic invalidation committed/,
      )

      const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.invalid_reason, attempt.lease_owner,
          offer.status AS offer_status, offer.x402_evidence_state,
          offer.x402_invalid_reason, offer.pending_payment_attempt_id,
          thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
      assert.deepEqual(facts.rows, [{
        status: 'invalid',
        invalid_reason: 'confirmed_mismatch',
        lease_owner: null,
        offer_status: 'open',
        x402_evidence_state: 'invalid',
        x402_invalid_reason: 'confirmed_mismatch',
        pending_payment_attempt_id: seed.attemptId,
        owner_id: 1,
        active_offer_id: seed.offerId,
        uses: 0,
        transfers: 0,
      }])
    })

    await t.test('founder review creates no sale and keeps a world target locked against late reuse', async () => {
      await resetFresh(postgres.client)
      const seed = await seedRecoverableSale(postgres.client, 'world_sale', '7')
      const database = saleDatabase(postgres.client)

      const closed = await closeSalePaymentTarget(database, {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
        reason: 'automatic completion found changed world sale facts',
        state: 'founder_review',
      })
      const late = await completeWorldSalePayment(database, {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
      })

      assert.deepEqual(closed, {
        state: 'founder_review',
        attemptId: seed.attemptId,
        actorId: 2,
        operation: 'world_sale',
        method: 'x402',
        targetReleased: false,
      })
      assert.equal(late.state, 'target_changed')
      const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.lease_owner,
          offer.status AS offer_status, offer.x402_evidence_state,
          offer.pending_payment_attempt_id, thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM sale_payments WHERE offer_id = $2) AS payments,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
      assert.deepEqual(facts.rows, [{
        status: 'founder_review',
        lease_owner: null,
        offer_status: 'open',
        x402_evidence_state: 'founder_review',
        pending_payment_attempt_id: seed.attemptId,
        owner_id: 1,
        active_offer_id: seed.offerId,
        uses: 0,
        payments: 0,
        transfers: 0,
      }])
    })

    await t.test('deadline closes an ambiguous no-hash world attempt without inventing offer evidence', async () => {
      await resetFresh(postgres.client)
      const seed = await seedRecoverableSale(
        postgres.client,
        'world_sale',
        '8',
        { ambiguousNoTx: true },
      )

      const closed = await closeSalePaymentTarget(saleDatabase(postgres.client), {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
        reason: 'automatic recovery deadline passed without transaction evidence',
        state: 'expired',
      })

      assert.equal(closed.state, 'expired')
      assert.equal(closed.targetReleased, false)
      const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.tx_hash, attempt.lease_owner,
          offer.status AS offer_status, offer.x402_evidence_state,
          offer.pending_payment_attempt_id, offer.pending_x402_tx_hash,
          offer.pending_x402_payer, offer.pending_x402_at,
          thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
      assert.deepEqual(facts.rows, [{
        status: 'expired',
        tx_hash: null,
        lease_owner: null,
        offer_status: 'open',
        x402_evidence_state: 'none',
        pending_payment_attempt_id: null,
        pending_x402_tx_hash: null,
        pending_x402_payer: null,
        pending_x402_at: null,
        owner_id: 1,
        active_offer_id: seed.offerId,
        uses: 0,
        transfers: 0,
      }])
    })

    await t.test('headerless replay deterministically selects the higher public id on equal timestamps', async () => {
      await resetFresh(postgres.client)
      const request = { purchase: 'same-target' }
      const requestHash = canonicalPaymentRequest(request).hash
      const targetKey = 'direct_sale:offer:91:v3'
      const createdAt = '2026-08-16T12:00:01Z'
      await insertAttempt(postgres.client, {
        publicId: 'pay_replay_tie_0001',
        actorId: 2,
        counterpartyId: 1,
        operation: 'direct_sale',
        targetKey,
        status: 'completed',
        payerWallet: BUYER_WALLET,
        nonce: hash('a'),
        txHash: hash('b'),
        requestHash,
        request,
        createdAt,
      })
      await insertAttempt(postgres.client, {
        publicId: 'pay_replay_tie_0002',
        actorId: 2,
        counterpartyId: 1,
        operation: 'direct_sale',
        targetKey,
        status: 'completed',
        payerWallet: BUYER_WALLET,
        nonce: hash('c'),
        txHash: hash('d'),
        requestHash,
        request,
        createdAt,
      })

      const found = await findReplayableTargetPaymentAttempt(
        async (text, params = []) => (await postgres.client.query(text, [...params])).rows,
        {
          actorId: 2,
          counterpartyId: 1,
          operation: 'direct_sale',
          targetKey,
          request,
        },
      )

      assert.equal(found?.publicId, 'pay_replay_tie_0002')
    })

    await t.test('response-body validation commits in a separate idempotent phase', async () => {
      await resetFresh(postgres.client)
      await postgres.client.query(`
        ALTER TABLE payment_attempts
          DROP CONSTRAINT payment_attempts_response_body_bytes_valid
      `)
      await postgres.client.query(responseBodyRolloutMigrationDdl)
      await postgres.client.query(responseBodyRolloutMigrationDdl)
      const phaseA = await postgres.client.query<{ convalidated: boolean }>(`
        SELECT convalidated
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'payment_attempts'::regclass
          AND conname = 'payment_attempts_response_body_bytes_valid'
      `)
      assert.deepEqual(phaseA.rows, [{ convalidated: false }])
      const overloads = await postgres.client.query<{
        legacy_completion: string | null
        exact_completion: string | null
      }>(`
        SELECT
          to_regprocedure(
            'public.complete_payment_attempt(text,text,jsonb,smallint,jsonb)'
          )::text AS legacy_completion,
          to_regprocedure(
            'public.complete_payment_attempt(text,text,jsonb,smallint,jsonb,bytea)'
          )::text AS exact_completion
      `)
      assert.deepEqual(overloads.rows, [{
        legacy_completion: 'complete_payment_attempt(text,text,jsonb,smallint,jsonb)',
        exact_completion: 'complete_payment_attempt(text,text,jsonb,smallint,jsonb,bytea)',
      }])

      await postgres.client.query(responseBodyValidationMigrationDdl)
      await postgres.client.query(responseBodyValidationMigrationDdl)
      const phaseB = await postgres.client.query<{ convalidated: boolean }>(`
        SELECT convalidated
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'payment_attempts'::regclass
          AND conname = 'payment_attempts_response_body_bytes_valid'
      `)
      assert.deepEqual(phaseB.rows, [{ convalidated: true }])
    })

    await t.test('an issued world payment parks after reservation expiry and keeps the offer locked', async () => {
      await resetFresh(postgres.client)
      const txHash = hash('6')
      const offer = await postgres.client.query<{ id: number }>(`
        INSERT INTO transfer_offers (
          channel, asset_type, asset_id, seller_id, buyer_id,
          price_usdc, seller_wallet, buyer_wallet,
          market_draft_id, market_listing_id, market_checkout_id, market_buyer,
          status, reserved_by, reserved_at, reserved_until
        ) VALUES (
          'world', 'thing', 206, 1, 2,
          2, $1, $2,
          706, 906, 806, 'market-buyer',
          'open', 2,
          date_trunc('second', clock_timestamp()) - interval '10 minutes',
          date_trunc('second', clock_timestamp()) - interval '5 minutes'
        )
        RETURNING id
      `, [SELLER_WALLET, BUYER_WALLET])
      const offerId = offer.rows[0]!.id
      await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, counterparty_id, operation, target_key,
          offer_id, asset_type, asset_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, tx_hash
        )
        SELECT
          'attempt_expired_world_001', 2, 1, 'world_sale', 'world-sale:' || id::text,
          id, 'thing', asset_id, repeat('1', 64), jsonb_build_object('offer_id', id),
          'x402', 'base', $2, $3, $4, 2000000,
          $5, repeat('2', 64), 1, 4102444800,
          22000000, reserved_at, reserved_until, 'payment_pending', $6
        FROM transfer_offers WHERE id = $1
      `, [
        offerId,
        BASE_USDC,
        BUYER_WALLET,
        SELLER_WALLET,
        hash('5'),
        txHash,
      ])

      await postgres.client.query(`
        UPDATE transfer_offers SET
          pending_payment_attempt_id = 'attempt_expired_world_001',
          pending_x402_tx_hash = $2,
          pending_x402_payer = $3,
          pending_x402_at = clock_timestamp()
        WHERE id = $1
      `, [offerId, txHash, BUYER_WALLET])
      const parked = await postgres.client.query(`
        SELECT pending_payment_attempt_id, pending_x402_tx_hash, x402_evidence_state
        FROM transfer_offers WHERE id = $1
      `, [offerId])
      assert.deepEqual(parked.rows, [{
        pending_payment_attempt_id: 'attempt_expired_world_001',
        pending_x402_tx_hash: txHash,
        x402_evidence_state: 'pending',
      }])
      await rejectsWithCode(
        postgres.client.query(`UPDATE transfer_offers SET status = 'canceled' WHERE id = $1`, [offerId]),
        '55000',
      )
    })

    await t.test('one live attempt owns an operation target', async () => {
      await resetFresh(postgres.client)
      await insertAttempt(postgres.client, {
        publicId: 'attempt_live_owner_0001',
        operation: 'frontier',
        targetKey: 'frontier:north',
      })
      await rejectsWithCode(insertAttempt(postgres.client, {
        publicId: 'attempt_live_owner_0002',
        operation: 'frontier',
        targetKey: 'frontier:north',
        status: 'payment_pending',
      }), '23505')

      await postgres.client.query(`
        UPDATE payment_attempts SET status = 'invalid'
        WHERE public_id = 'attempt_live_owner_0001'
      `)
      await insertAttempt(postgres.client, {
        publicId: 'attempt_live_replacement_1',
        operation: 'frontier',
        targetKey: 'frontier:north',
      })

      await insertAttempt(postgres.client, {
        publicId: 'attempt_other_operation_01',
        operation: 'kind_invention',
        targetKey: 'frontier:north',
      })
      assert.equal(
        Number((await postgres.client.query(
          `SELECT count(*)::int AS count FROM payment_attempts`,
        )).rows[0]!.count),
        3,
      )
    })

    await t.test('a Base USDC nonce is unique for its payer but reusable by another payer', async () => {
      await resetFresh(postgres.client)
      const nonce = hash('a')
      await insertAttempt(postgres.client, {
        publicId: 'attempt_nonce_owner_0001',
        operation: 'frontier',
        targetKey: 'frontier:east',
        payerWallet: BUYER_WALLET,
        nonce,
      })
      await rejectsWithCode(insertAttempt(postgres.client, {
        publicId: 'attempt_nonce_owner_0002',
        operation: 'kind_invention',
        targetKey: 'kind:bell',
        payerWallet: BUYER_WALLET,
        nonce,
      }), '23505')
      await insertAttempt(postgres.client, {
        publicId: 'attempt_nonce_other_0001',
        operation: 'kind_invention',
        targetKey: 'kind:chime',
        payerWallet: OTHER_WALLET,
        nonce,
      })
    })

    await t.test('one transaction hash cannot pay a fee, direct sale, or world sale twice', async () => {
      await resetFresh(postgres.client)
      const txHash = hash('b')
      await insertAttempt(postgres.client, {
        publicId: 'attempt_fee_hash_owner_01',
        operation: 'frontier',
        status: 'completed',
        txHash,
      })
      for (const [publicId, operation] of [
        ['attempt_direct_hash_0001', 'direct_sale'],
        ['attempt_world_hash_00001', 'world_sale'],
      ] as const) {
        await rejectsWithCode(insertAttempt(postgres.client, {
          publicId,
          operation,
          status: 'completed',
          txHash,
        }), '23505')
      }
    })

    await t.test('concurrent live claims have exactly one database winner', async () => {
      await resetFresh(postgres.client)
      const results = await Promise.allSettled([
        insertAttempt(postgres.client, {
          publicId: 'attempt_concurrent_one_01',
          operation: 'kind_revision',
          targetKey: 'kind:7:revision:2',
        }),
        insertAttempt(postgres.client, {
          publicId: 'attempt_concurrent_two_01',
          operation: 'kind_revision',
          targetKey: 'kind:7:revision:2',
        }),
      ])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.deepEqual(
        results.filter(result => result.status === 'rejected').map(result =>
          postgresCode((result as PromiseRejectedResult).reason),
        ),
        ['23505'],
      )
      const count = await postgres.client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM payment_attempts
         WHERE operation = 'kind_revision' AND target_key = 'kind:7:revision:2'`,
      )
      assert.deepEqual(count.rows, [{ count: 1 }])
    })

    await t.test('atomic completion rolls back its business effect when lease ownership is lost', async () => {
      await resetFresh(postgres.client)
      const txHash = hash('6')
      await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, lease_owner, lease_expires_at,
          tx_hash, finalized_block_number, finalized_block_hash,
          finalized_block_time, finalized_at
        ) VALUES (
          'attempt_atomic_completion_01', 1, 'frontier', 'frontier:atomic',
          repeat('a', 64), '{}'::jsonb,
          'x402', 'base', $1, $2, $3, 1000000,
          $4, repeat('b', 64), 1, 9999999999,
          10, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
          'payment_pending', 'right-lease', clock_timestamp() + interval '1 minute',
          $5, 11, $6, '2026-08-16T12:01:00Z', '2026-08-16T12:02:00Z'
        )
      `, [BASE_USDC, BUYER_WALLET, SELLER_WALLET, hash('5'), txHash, hash('4')])

      await rejectsWithCode(postgres.client.query(`
        WITH business_effect AS (
          INSERT INTO events (kind, actor, detail)
          VALUES ('place_created', 'seller', '{"atomic":true}'::jsonb)
          RETURNING id
        )
        SELECT complete_payment_attempt(
          'attempt_atomic_completion_01',
          'wrong-lease',
          jsonb_build_object('event_id', business_effect.id),
          201::smallint,
          jsonb_build_object('ok', true)
        )
        FROM business_effect
      `), '55000')

      assert.equal(Number((await postgres.client.query(
        `SELECT count(*)::int AS count FROM events WHERE detail = '{"atomic":true}'::jsonb`,
      )).rows[0]!.count), 0)
      assert.equal((await postgres.client.query(
        `SELECT status FROM payment_attempts WHERE public_id = 'attempt_atomic_completion_01'`,
      )).rows[0]!.status, 'payment_pending')

      await postgres.client.query(`
        WITH business_effect AS (
          INSERT INTO events (kind, actor, detail)
          VALUES ('place_created', 'seller', '{"atomic":true}'::jsonb)
          RETURNING id
        )
        SELECT complete_payment_attempt(
          'attempt_atomic_completion_01',
          'right-lease',
          jsonb_build_object('event_id', business_effect.id),
          201::smallint,
          jsonb_build_object('ok', true)
        )
        FROM business_effect
      `)
      const completed = await postgres.client.query(
        `SELECT status, response_status, response_json, response_body_bytes FROM payment_attempts
         WHERE public_id = 'attempt_atomic_completion_01'`,
      )
      assert.deepEqual(completed.rows, [{
        status: 'completed',
        response_status: 201,
        response_json: { ok: true },
        response_body_bytes: null,
      }])
    })

    await t.test('completion preserves exact facilitator response bytes across a database reload', async () => {
      await resetFresh(postgres.client)
      await postgres.client.query(replayMigrationDdl)
      await postgres.client.query(replayMigrationDdl)
      await postgres.client.query(responseBodyMigrationDdl)
      await postgres.client.query(responseBodyMigrationDdl)
      const txHash = hash('4')
      const requestHash = canonicalPaymentRequest({}).hash
      await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, offer_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, lease_owner, lease_expires_at
        ) VALUES (
          'attempt_exact_response_01', 2, 'frontier', 'frontier:exact-response', 91,
          $5, '{}'::jsonb,
          'x402', 'base', $1, $2, $3, 1000000,
          $4, repeat('b', 64), 1, 9999999999,
          10, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
          'settling', 'response-lease', clock_timestamp() + interval '1 minute'
        )
      `, [BASE_USDC, BUYER_WALLET, SELLER_WALLET, hash('5'), requestHash])
      const database = {
        query: async (text: string, params: readonly unknown[] = []) =>
          (await postgres.client.query(text, [...params])).rows,
      }

      const pending = await bindPaymentEvidence(database, {
        publicId: 'attempt_exact_response_01',
        leaseOwner: 'response-lease',
        txHash,
        finality: {
          blockNumber: 11n,
          blockHash: hash('6'),
          blockTime: '2026-08-16T12:01:00Z',
          finalizedAt: '2026-08-16T12:02:00Z',
        },
        paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
      })
      assert.equal(pending.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
      await rejectsWithCode(postgres.client.query(`
        UPDATE payment_attempts SET response_json = '{}'::jsonb
        WHERE public_id = 'attempt_exact_response_01'
      `), '55000')

      const exactBody = '{\n  "thing": { "id": 42 },\n  "ok": true\n}'
      await postgres.client.query(`
        SELECT complete_payment_attempt(
          'attempt_exact_response_01',
          'response-lease',
          jsonb_build_object('thing_id', 42),
          201::smallint,
          jsonb_build_object('ok', true, 'thing', jsonb_build_object('id', 42)),
          convert_to($1, 'UTF8')
        )
      `, [exactBody])
      const stored = await postgres.client.query(`
        SELECT response_json, convert_from(response_body_bytes, 'UTF8') AS response_body
        FROM payment_attempts
        WHERE public_id = 'attempt_exact_response_01'
      `)
      assert.deepEqual(stored.rows, [{
        response_json: {
          __1f3d9_x402_response_v1: {
            header: FACILITATOR_RESPONSE_HEADER,
            body: { ok: true, thing: { id: 42 } },
          },
        },
        response_body: exactBody,
      }])

      const reloaded = await findPaymentAttempt(database, {
        actorId: 2,
        operation: 'frontier',
        offerId: 91,
      })
      assert.equal(reloaded?.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
      assert.deepEqual(reloaded?.response, { ok: true, thing: { id: 42 } })
      assert.equal(reloaded?.responseBody, exactBody)
      await rejectsWithCode(postgres.client.query(`
        UPDATE payment_attempts SET response_body_bytes = convert_to('{"ok":false}', 'UTF8')
        WHERE public_id = 'attempt_exact_response_01'
      `), '55000')
    })

    await t.test('byte-exact completion rejects invalid, mismatched, and oversized bodies atomically', async () => {
      for (const [suffix, body] of [
        ['invalid', '[]'],
        ['mismatch', '{"ok":false}'],
        ['oversized', `{"padding":"${'x'.repeat(200_000)}"}`],
      ] as const) {
        await resetFresh(postgres.client)
        await postgres.client.query(`
          INSERT INTO payment_attempts (
            public_id, actor_id, operation, target_key, request_hash, request_json,
            method, network, token, payer_wallet, payee_wallet, amount_units,
            x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
            start_block, start_time, end_time, status, lease_owner, lease_expires_at,
            tx_hash, finalized_block_number, finalized_block_hash,
            finalized_block_time, finalized_at
          ) VALUES (
            $1, 1, 'frontier', $2, repeat('a', 64), '{}'::jsonb,
            'x402', 'base', $3, $4, $5, 1000000,
            $6, repeat('b', 64), 1, 9999999999,
            10, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
            'payment_pending', 'body-lease', clock_timestamp() + interval '1 minute',
            $7, 11, $8, '2026-08-16T12:01:00Z', '2026-08-16T12:02:00Z'
          )
        `, [
          `attempt_body_${suffix}_01`, `frontier:body-${suffix}`, BASE_USDC,
          BUYER_WALLET, SELLER_WALLET, hash(suffix === 'invalid' ? '1' : suffix === 'mismatch' ? '2' : '3'),
          hash(suffix === 'invalid' ? '4' : suffix === 'mismatch' ? '5' : '6'),
          hash(suffix === 'invalid' ? '7' : suffix === 'mismatch' ? '8' : '9'),
        ])
        await rejectsWithCode(postgres.client.query(`
          SELECT complete_payment_attempt(
            $1, 'body-lease', '{"thing_id":42}'::jsonb, 201::smallint,
            '{"ok":true}'::jsonb, convert_to($2, 'UTF8')
          )
        `, [`attempt_body_${suffix}_01`, body]), '23514')
        assert.equal((await postgres.client.query(
          'SELECT status FROM payment_attempts WHERE public_id = $1',
          [`attempt_body_${suffix}_01`],
        )).rows[0]!.status, 'payment_pending')
      }
    })

    await t.test('upgrade backfills recorded legacy facts and leaves unknown facts null', async () => {
      await resetLegacy(postgres.client)
      const unknownHash = hash('c')
      const directHash = hash('d')
      const pendingHash = hash('e')
      await postgres.client.query(`
        INSERT INTO payment_uses (
          tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc, created_at
        ) VALUES ($1, 1, 'custom_fee', NULL, NULL, NULL, '2026-08-16T11:00:00Z')
      `, [unknownHash])
      const directOfferId = await seedDirectLegacyPayment(postgres.client, directHash)
      const worldOfferId = await seedPendingWorldPayment(postgres.client, pendingHash)

      await postgres.client.query(migrationDdl)
      await postgres.client.query(migrationDdl)

      const attempts = await postgres.client.query(`
        SELECT public_id, actor_id, counterparty_id, operation, target_key,
          offer_id, asset_type, asset_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units::text,
          x402_nonce, start_time, end_time, status, tx_hash,
          finalized_block_number, result_json, response_json
        FROM payment_attempts
        ORDER BY tx_hash
      `)
      assert.deepEqual(attempts.rows, [
        {
          public_id: `legacy_use_${unknownHash.slice(2)}`,
          actor_id: 1,
          counterparty_id: null,
          operation: 'legacy',
          target_key: null,
          offer_id: null,
          asset_type: null,
          asset_id: null,
          request_hash: null,
          request_json: null,
          method: null,
          network: 'base',
          token: BASE_USDC,
          payer_wallet: null,
          payee_wallet: null,
          amount_units: null,
          x402_nonce: null,
          start_time: null,
          end_time: null,
          status: 'legacy_completed',
          tx_hash: unknownHash,
          finalized_block_number: null,
          result_json: null,
          response_json: null,
        },
        {
          public_id: `legacy_use_${directHash.slice(2)}`,
          actor_id: 2,
          counterparty_id: 1,
          operation: 'direct_sale',
          target_key: `offer:${directOfferId}`,
          offer_id: directOfferId,
          asset_type: 'thing',
          asset_id: 101,
          request_hash: null,
          request_json: null,
          method: 'claim',
          network: 'base',
          token: BASE_USDC,
          payer_wallet: BUYER_WALLET,
          payee_wallet: SELLER_WALLET,
          amount_units: '3000000',
          x402_nonce: null,
          start_time: null,
          end_time: null,
          status: 'legacy_completed',
          tx_hash: directHash,
          finalized_block_number: null,
          result_json: null,
          response_json: null,
        },
        {
          public_id: `legacy_world_${pendingHash.slice(2)}`,
          actor_id: 2,
          counterparty_id: 1,
          operation: 'world_sale',
          target_key: `offer:${worldOfferId}`,
          offer_id: worldOfferId,
          asset_type: 'thing',
          asset_id: 202,
          request_hash: null,
          request_json: null,
          method: 'x402',
          network: 'base',
          token: BASE_USDC,
          payer_wallet: BUYER_WALLET,
          payee_wallet: SELLER_WALLET,
          amount_units: '2000000',
          x402_nonce: null,
          start_time: new Date('2026-08-16T12:00:00Z'),
          end_time: new Date('2026-08-16T12:05:00Z'),
          status: 'payment_pending',
          tx_hash: pendingHash,
          finalized_block_number: null,
          result_json: null,
          response_json: null,
        },
      ])
    })

    await t.test('upgrade aborts contradictory legacy custody instead of hiding a hash collision', async () => {
      await resetLegacy(postgres.client)
      const collidedHash = hash('f')
      await postgres.client.query(`
        INSERT INTO payment_uses (
          tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc
        ) VALUES ($1, 1, 'frontier', $2, $3, 1)
      `, [collidedHash, BUYER_WALLET, SELLER_WALLET])
      await seedPendingWorldPayment(postgres.client, collidedHash)

      const connection = await postgres.client.connect()
      try {
        await connection.query('BEGIN')
        await rejectsWithCode(connection.query(migrationDdl), '23505')
        await connection.query('ROLLBACK')
      } finally {
        connection.release()
      }
      const table = await postgres.client.query<{ table_name: string | null }>(
        `SELECT to_regclass('public.payment_attempts')::text AS table_name`,
      )
      assert.deepEqual(table.rows, [{ table_name: null }])
    })

    await t.test('world receipts reject the exact reservation end boundary', async () => {
      await resetFresh(postgres.client)
      const seedFinalizedWorldPayment = async (
        digit: string,
        assetId: number,
        blockTime: string,
      ): Promise<{ offerId: number; txHash: string }> => {
        const txHash = hash(digit)
        const offerId = Number((await postgres.client.query<{ id: number }>(
          `SELECT nextval(pg_get_serial_sequence('transfer_offers', 'id'))::int AS id`,
        )).rows[0]!.id)
        const attemptId = `attempt_world_${digit.repeat(16)}`
        await postgres.client.query(`
          INSERT INTO payment_attempts (
            public_id, actor_id, counterparty_id, operation, target_key,
            offer_id, asset_type, asset_id, method, network, token,
            payer_wallet, payee_wallet, amount_units, start_time, end_time,
            status, tx_hash, finalized_block_number, finalized_block_hash,
            finalized_block_time, finalized_at, result_json,
            response_status, response_json, completed_at
          ) VALUES (
            $1, 2, 1, 'world_sale', 'offer:' || $2::text,
            $2::integer, 'thing', $3, 'x402', 'base', $4,
            $5, $6, 2000000, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
            'completed', $7, 22000010, $8,
            $9, clock_timestamp(), jsonb_build_object('offer_id', $2),
            200, jsonb_build_object('ok', true), clock_timestamp()
          )
        `, [
          attemptId,
          offerId,
          assetId,
          BASE_USDC,
          BUYER_WALLET,
          SELLER_WALLET,
          txHash,
          hash('8'),
          blockTime,
        ])
        await postgres.client.query(`
          INSERT INTO transfer_offers (
            id, channel, asset_type, asset_id, seller_id, buyer_id,
            price_usdc, seller_wallet, buyer_wallet,
            market_draft_id, market_listing_id, market_checkout_id, market_buyer,
            pending_payment_attempt_id,
            pending_x402_tx_hash, pending_x402_payer, pending_x402_at,
            x402_evidence_state, status, reserved_by,
            reserved_at, reserved_until, claimed_at
          ) VALUES (
            $1, 'world', 'thing', $2, 1, 2,
            2, $6, $3,
            $2, $2, $2, 'market-buyer',
            $4,
            $5, $3, '2026-08-16T12:02:00Z',
            'pending', 'claimed', 2,
            '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
            '2026-08-16T12:04:00Z'
          )
        `, [offerId, assetId, BUYER_WALLET, attemptId, txHash, SELLER_WALLET])
        await postgres.client.query(`
          INSERT INTO payment_uses (
            tx_hash, payment_attempt_id, actor_id, purpose,
            payer_wallet, payee_wallet, amount_usdc
          ) VALUES ($1, $2, 2, 'sale', $3, $4, 2)
        `, [txHash, attemptId, BUYER_WALLET, SELLER_WALLET])
        return { offerId, txHash }
      }

      const boundary = await seedFinalizedWorldPayment(
        '9',
        303,
        '2026-08-16T12:05:00Z',
      )
      await rejectsWithCode(postgres.client.query(`
        INSERT INTO sale_payments (
          offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
          tx_hash, verified_via, block_time
        ) VALUES ($1, 2, $2, $3, 2, $4, 'x402', '2026-08-16T12:05:00Z')
      `, [boundary.offerId, BUYER_WALLET, SELLER_WALLET, boundary.txHash]), '23514')

      const inside = await seedFinalizedWorldPayment(
        '7',
        304,
        '2026-08-16T12:04:59Z',
      )
      await postgres.client.query(`
        INSERT INTO sale_payments (
          offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
          tx_hash, verified_via, block_time
        ) VALUES ($1, 2, $2, $3, 2, $4, 'x402', '2026-08-16T12:04:59Z')
      `, [inside.offerId, BUYER_WALLET, SELLER_WALLET, inside.txHash])
    })
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
