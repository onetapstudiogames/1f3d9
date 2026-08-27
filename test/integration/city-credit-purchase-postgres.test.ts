import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { resumeDurableX402 } from '../../src/payment-flow.ts'
import {
  canonicalPaymentRequest,
  createOrReadPaymentAttempt,
  getPaymentAttemptRecord,
} from '../../src/payment-attempts.ts'
import { TREASURY } from '../../src/pay.ts'

type CityCreditPurchaseModule = Readonly<{
  cityCreditPurchaseTargetKey(actorId: number, requestId: unknown): string
  mountCityCreditPurchaseRoutes(
    app: Hono,
    deps: Readonly<{
      authenticate(): Promise<Readonly<{ id: number }> | null>
      database: {
        query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
      }
    }>,
  ): void
  completeCityCreditPurchase(
    database: {
      query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
    },
    input: Readonly<{ attemptId: string; leaseOwner: string }>,
  ): Promise<Readonly<{
    state: string
    attemptId?: string
    status?: number
    response?: Record<string, unknown>
    responseBody?: string
    paymentResponseHeader?: string | null
  }>>
}>

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'city_credit_purchase_integration'
const PURCHASE_MODULE_URL = new URL('../../src/city-credit-purchase.ts', import.meta.url)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAYER = `0x${'11'.repeat(20)}`
const PAYEE = `0x${'22'.repeat(20)}`
const TX_ONE = `0x${'33'.repeat(32)}`
const TX_LATE = `0x${'44'.repeat(32)}`
const BLOCK_HASH = `0x${'55'.repeat(32)}`
const AMOUNT_DOLLARS = '7'
const AMOUNT_UNITS = 7_000_000n

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ database: Pool; containerName: string }> {
  const containerName = `1f3d9-credit-purchase-${process.pid}-${randomBytes(4).toString('hex')}`
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
      database: POSTGRES_DATABASE, ssl: false, max: 8,
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

async function purchaseModule(): Promise<CityCreditPurchaseModule> {
  assert.equal(
    existsSync(PURCHASE_MODULE_URL),
    true,
    'add src/city-credit-purchase.ts before running the real-Postgres purchase gate',
  )
  return await import(PURCHASE_MODULE_URL.href) as unknown as CityCreditPurchaseModule
}

function paymentDatabase(database: Pool): {
  query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
} {
  return {
    query: async (text, params = []) => (await database.query(text, [...params])).rows,
  }
}

async function reset(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'credit-purchase-test', repeat('1', 64)),
      (7, 'credit-buyer', 'credit-purchase-test', repeat('7', 64))
  `)
}

function settlementHeader(txHash: string): string {
  return Buffer.from(JSON.stringify({
    success: true,
    transaction: txHash,
    payer: PAYER,
    network: 'base',
  })).toString('base64')
}

function retryPaymentHeader(): string {
  const now = Math.floor(Date.now() / 1_000)
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: `0x${'77'.repeat(65)}`,
      authorization: {
        from: PAYER,
        to: TREASURY,
        value: AMOUNT_UNITS.toString(),
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce: `0x${'88'.repeat(32)}`,
      },
    },
  }), 'utf8').toString('base64')
}

async function purchaseRequest(
  app: Hono,
  requestId: string,
  paymentHeader?: string,
): Promise<Response> {
  const body = JSON.stringify({ request_id: requestId, amount_dollars: AMOUNT_DOLLARS })
  return await app.request('/api/city-credit/purchase/x402', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      ...(paymentHeader ? { 'x-payment': paymentHeader } : {}),
    },
    body,
  })
}

type AttemptTimes = Readonly<{
  startTime: string
  endTime: string
  blockTime: string
  finalizedAt: string
  recoveryStartedAt: string
  recoveryDeadlineAt: string
}>

function attemptTimes(lateFinality: boolean): AttemptTimes {
  const now = Date.now()
  const startTime = new Date(now - 30 * 60_000).toISOString()
  const endTime = new Date(now - 20 * 60_000).toISOString()
  const blockTime = new Date(now - 25 * 60_000).toISOString()
  const finalizedAt = new Date(now - (lateFinality ? 5 : 24) * 60_000).toISOString()
  const recoveryStartedAt = new Date(now - 25 * 60_000).toISOString()
  const recoveryDeadlineAt = new Date(now + 95 * 60_000).toISOString()
  assert.ok(blockTime >= startTime && blockTime < endTime)
  if (lateFinality) assert.ok(finalizedAt > endTime)
  assert.equal(
    Date.parse(recoveryDeadlineAt) - Date.parse(recoveryStartedAt),
    2 * 60 * 60_000,
  )
  return { startTime, endTime, blockTime, finalizedAt, recoveryStartedAt, recoveryDeadlineAt }
}

async function realLateAttemptTimes(database: Pool): Promise<AttemptTimes> {
  const result = await database.query<{
    start_time: Date
    end_time: Date
    block_time: Date
    recovery_deadline_at: Date
  }>(`
    WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT at AS start_time,
      at + interval '2 seconds' AS end_time,
      at + interval '1 second' AS block_time,
      at + interval '2 hours' AS recovery_deadline_at
    FROM observed
  `)
  const row = result.rows[0]!
  return {
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    blockTime: row.block_time.toISOString(),
    finalizedAt: row.end_time.toISOString(),
    recoveryStartedAt: row.start_time.toISOString(),
    recoveryDeadlineAt: row.recovery_deadline_at.toISOString(),
  }
}

async function realDueAttemptTimes(database: Pool): Promise<AttemptTimes> {
  const result = await database.query<{
    start_time: Date
    end_time: Date
    block_time: Date
    finalized_at: Date
    recovery_started_at: Date
    recovery_deadline_at: Date
  }>(`
    WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at),
    boundary AS MATERIALIZED (SELECT at, at + interval '2 seconds' AS deadline FROM observed)
    SELECT at - interval '30 minutes' AS start_time,
      at - interval '20 minutes' AS end_time,
      at - interval '25 minutes' AS block_time,
      at - interval '24 minutes' AS finalized_at,
      deadline - interval '2 hours' AS recovery_started_at,
      deadline AS recovery_deadline_at
    FROM boundary
  `)
  const row = result.rows[0]!
  assert.equal(
    row.recovery_deadline_at.getTime() - row.recovery_started_at.getTime(),
    2 * 60 * 60_000,
  )
  return {
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    blockTime: row.block_time.toISOString(),
    finalizedAt: row.finalized_at.toISOString(),
    recoveryStartedAt: row.recovery_started_at.toISOString(),
    recoveryDeadlineAt: row.recovery_deadline_at.toISOString(),
  }
}

async function waitPastDatabaseTime(database: Pool, boundary: string): Promise<string> {
  const wallClockStartedAt = Date.now()
  for (;;) {
    const result = await database.query<{ observed_at: Date; passed: boolean }>(`
      SELECT clock_timestamp() AS observed_at,
        clock_timestamp() > $1::timestamptz AS passed
    `, [boundary])
    const row = result.rows[0]!
    if (row.passed) {
      assert.ok(
        Date.now() - wallClockStartedAt >= 1_500,
        'the test must cross a real PostgreSQL operation window, not backdate fixtures',
      )
      return row.observed_at.toISOString()
    }
    await delay(25)
  }
}

async function insertPurchaseAttempt(
  database: Pool,
  input: Readonly<{
    publicId: string
    requestId: string
    targetKey: string
    txHash: string
    times: AttemptTimes
    leaseOwner?: string | null
    includeFinality: boolean
  }>,
): Promise<void> {
  const request = { request_id: input.requestId, amount_dollars: AMOUNT_DOLLARS }
  const canonical = canonicalPaymentRequest(request)
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, start_block, start_time, end_time,
      status, lease_owner, lease_expires_at, tx_hash,
      finalized_block_number, finalized_block_hash, finalized_block_time, finalized_at,
      recovery_started_at, recovery_deadline_at, response_json
    ) VALUES (
      $1, 7, 'credit_purchase', $2, $3, $4::jsonb,
      'x402', 'base', $5, $6, $7, $8,
      $9, repeat('a', 64), 80000000, $10::timestamptz, $11::timestamptz,
      'payment_pending', $12, CASE WHEN $12::text IS NULL THEN NULL
        ELSE clock_timestamp() + interval '1 minute' END, $13,
      CASE WHEN $14::boolean THEN 80000001 END,
      CASE WHEN $14::boolean THEN $15 END,
      CASE WHEN $14::boolean THEN $16::timestamptz END,
      CASE WHEN $14::boolean THEN $17::timestamptz END,
      $18::timestamptz, $19::timestamptz,
      jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object('header', $20::text)
      )
    )
  `, [
    input.publicId,
    input.targetKey,
    canonical.hash,
    canonical.json,
    USDC,
    PAYER,
    PAYEE,
    AMOUNT_UNITS.toString(),
    `0x${'66'.repeat(32)}`,
    input.times.startTime,
    input.times.endTime,
    input.leaseOwner ?? null,
    input.txHash,
    input.includeFinality,
    BLOCK_HASH,
    input.times.blockTime,
    input.times.finalizedAt,
    input.times.recoveryStartedAt,
    input.times.recoveryDeadlineAt,
    settlementHeader(input.txHash),
  ])
}

async function purchaseFacts(database: Pool, attemptId: string): Promise<{
  entries: Array<Record<string, unknown>>
  account: Array<Record<string, unknown>>
  uses: Array<Record<string, unknown>>
  fees: Array<Record<string, unknown>>
  attempt: Array<Record<string, unknown>>
}> {
  const [entries, account, uses, fees, attempt] = await Promise.all([
    database.query(`
      SELECT id::text, resident_id, entry_kind, amount_units::text,
             payment_attempt_id, source_key, created_at
      FROM city_credit_entries
      WHERE payment_attempt_id = $1 AND entry_kind = 'purchase'
      ORDER BY id
    `, [attemptId]),
    database.query(`
      SELECT resident_id, balance_units::text
      FROM city_credit_accounts WHERE resident_id = 7
    `),
    database.query(`
      SELECT tx_hash, payment_attempt_id, purpose, actor_id,
             payer_wallet, payee_wallet, amount_usdc::text
      FROM payment_uses WHERE payment_attempt_id = $1
    `, [attemptId]),
    database.query('SELECT id::text, purpose FROM fees WHERE tx_hash IN ($1, $2)', [TX_ONE, TX_LATE]),
    database.query(`
      SELECT status, result_json, response_status, response_json,
             convert_from(response_body_bytes, 'UTF8') AS response_body,
             finalized_block_time, finalized_at, recovery_deadline_at, completed_at
      FROM payment_attempts WHERE public_id = $1
    `, [attemptId]),
  ])
  return {
    entries: entries.rows,
    account: account.rows,
    uses: uses.rows,
    fees: fees.rows,
    attempt: attempt.rows,
  }
}

async function replaySafetyFacts(database: Pool, targetKey: string): Promise<Record<string, unknown>> {
  const result = await database.query(`
    SELECT
      (SELECT count(*)::text FROM payment_attempts WHERE target_key = $1) AS attempts,
      (SELECT array_agg(status ORDER BY created_at, public_id)
         FROM payment_attempts WHERE target_key = $1) AS attempt_states,
      (SELECT count(*)::text FROM payment_uses) AS payment_uses,
      (SELECT count(*)::text FROM city_credit_entries WHERE entry_kind = 'purchase') AS purchases,
      coalesce((SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = 7), '0')
        AS balance_units
  `, [targetKey])
  return result.rows[0] ?? {}
}

test('x402 credit purchases are atomic and recovery-safe in real PostgreSQL', {
  timeout: 120_000,
}, async t => {
  const purchase = await purchaseModule()
  const postgres = await startPostgres()
  t.after(async () => {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })

  await t.test('one finalized payment creates one exact purchase receipt and replay mints nothing', async () => {
    await reset(postgres.database)
    const attemptId = `pay_${'71'.repeat(32)}`
    const leaseOwner = 'credit-purchase-lease-atomic-0001'
    const requestId = 'credit-purchase-postgres-atomic-0001'
    const targetKey = purchase.cityCreditPurchaseTargetKey(7, requestId)
    await insertPurchaseAttempt(postgres.database, {
      publicId: attemptId,
      requestId,
      targetKey,
      txHash: TX_ONE,
      times: attemptTimes(false),
      leaseOwner,
      includeFinality: true,
    })

    let queryCalls = 0
    const database = {
      query: async (text: string, params: readonly unknown[] = []) => {
        queryCalls += 1
        return (await postgres.database.query(text, [...params])).rows
      },
    }
    const completed = await purchase.completeCityCreditPurchase(database, { attemptId, leaseOwner })
    assert.equal(queryCalls, 1, 'the payment use, purchase row, balance, and attempt completion are one statement')
    assert.equal(completed.state, 'completed')
    assert.equal(completed.attemptId, attemptId)
    assert.equal(completed.status, 201)
    assert.ok(completed.paymentResponseHeader)

    const firstFacts = await purchaseFacts(postgres.database, attemptId)
    assert.equal(firstFacts.entries.length, 1)
    assert.deepEqual(firstFacts.entries.map(row => ({
      resident_id: row.resident_id,
      entry_kind: row.entry_kind,
      amount_units: row.amount_units,
      payment_attempt_id: row.payment_attempt_id,
      source_key_present: typeof row.source_key === 'string' && row.source_key.length > 0,
    })), [{
      resident_id: 7,
      entry_kind: 'purchase',
      amount_units: AMOUNT_UNITS.toString(),
      payment_attempt_id: attemptId,
      source_key_present: true,
    }])
    assert.deepEqual(firstFacts.account, [{ resident_id: 7, balance_units: AMOUNT_UNITS.toString() }])
    assert.deepEqual(firstFacts.uses, [{
      tx_hash: TX_ONE,
      payment_attempt_id: attemptId,
      purpose: 'credit_purchase',
      actor_id: 7,
      payer_wallet: PAYER,
      payee_wallet: PAYEE,
      amount_usdc: '7.000000',
    }])
    assert.deepEqual(firstFacts.fees, [], 'buying prepaid credit is not a city fee spend')
    assert.equal(firstFacts.attempt[0]?.status, 'completed')
    assert.equal(firstFacts.attempt[0]?.response_status, 201)
    const durableResponse = firstFacts.attempt[0]?.response_json as {
      __1f3d9_x402_response_v1?: { body?: unknown }
    }
    assert.equal(
      firstFacts.attempt[0]?.response_body,
      JSON.stringify(durableResponse.__1f3d9_x402_response_v1?.body),
      'stored response bytes are the exact public body, not the internal header envelope',
    )

    const replay = await purchase.completeCityCreditPurchase(database, { attemptId, leaseOwner })
    assert.equal(queryCalls, 2, 'replay also remains one statement')
    assert.deepEqual(replay, completed)
    const replayFacts = await purchaseFacts(postgres.database, attemptId)
    assert.equal(replayFacts.entries.length, 1)
    assert.equal(replayFacts.uses.length, 1)
    assert.deepEqual(replayFacts.account, firstFacts.account)
    assert.deepEqual(replayFacts.attempt, firstFacts.attempt)
  })

  await t.test('a payment finalized after its authorization window still buys credit inside recovery', async () => {
    await reset(postgres.database)
    const attemptId = `pay_${'72'.repeat(32)}`
    const requestId = 'credit-purchase-postgres-late-00001'
    const targetKey = purchase.cityCreditPurchaseTargetKey(7, requestId)
    const windowTimes = await realLateAttemptTimes(postgres.database)
    await insertPurchaseAttempt(postgres.database, {
      publicId: attemptId,
      requestId,
      targetKey,
      txHash: TX_LATE,
      times: windowTimes,
      includeFinality: false,
    })
    const finalizedAt = await waitPastDatabaseTime(postgres.database, windowTimes.endTime)
    const times = Object.freeze({ ...windowTimes, finalizedAt })
    const database = paymentDatabase(postgres.database)
    const stored = await getPaymentAttemptRecord(database, { publicId: attemptId, actorId: 7 })
    assert.ok(stored)
    assert.equal(stored.operation, 'credit_purchase')
    assert.equal(stored.actorId, 7, 'the authenticated buyer owns the private recovery attempt')
    assert.equal(stored.amountUnits, AMOUNT_UNITS)

    let recoveryLookupCalled = false
    const resumed = await resumeDurableX402({ database, attempt: stored, actorId: 7 }, {
      custodyReady: async () => true,
      recoverTransaction: async () => {
        recoveryLookupCalled = true
        return null
      },
      classify: async () => ({
        state: 'matched',
        from: PAYER,
        to: PAYEE,
        amount: AMOUNT_UNITS,
        blockTime: new Date(times.blockTime),
        blockNumber: 80_000_001n,
        blockHash: BLOCK_HASH,
        finalizedAt: new Date(times.finalizedAt),
      }),
    })
    assert.equal(recoveryLookupCalled, false, 'the stored transaction is reused')
    assert.equal(resumed.state, 'ready')
    if (resumed.state !== 'ready') assert.fail('expected the late-finalizing payment to be ready')
    assert.equal(resumed.blockTime, times.blockTime)
    assert.equal(resumed.finalizedAt, times.finalizedAt)
    assert.ok(resumed.finalizedAt > times.endTime, 'finality observation is later than authorization')
    assert.ok(times.recoveryDeadlineAt > resumed.finalizedAt, 'the shared two-hour recovery window is open')

    const completed = await purchase.completeCityCreditPurchase(database, {
      attemptId: resumed.attemptId,
      leaseOwner: resumed.leaseOwner,
    })
    assert.equal(completed.state, 'completed')
    assert.equal(completed.status, 201)

    const facts = await purchaseFacts(postgres.database, attemptId)
    assert.equal(facts.entries.length, 1)
    assert.equal(facts.entries[0]?.amount_units, AMOUNT_UNITS.toString())
    assert.deepEqual(facts.account, [{ resident_id: 7, balance_units: AMOUNT_UNITS.toString() }])
    assert.equal(facts.uses.length, 1)
    assert.equal(facts.attempt[0]?.status, 'completed')
    assert.equal(
      (facts.attempt[0]?.finalized_block_time as Date).toISOString(),
      times.blockTime,
    )
    assert.equal((facts.attempt[0]?.finalized_at as Date).toISOString(), times.finalizedAt)
    assert.ok(
      (facts.attempt[0]?.finalized_at as Date) > (facts.attempt[0]?.finalized_block_time as Date),
    )
  })

  await t.test('an elapsed recovery deadline keeps one request id terminal with or without a payment header', async () => {
    const expectedTerminalFacts = {
      attempts: '1',
      attempt_states: ['expired'],
      payment_uses: '0',
      purchases: '0',
      balance_units: '0',
    }
    const seedDueAttempt = async (input: Readonly<{
      attemptDigit: string
      transactionDigit: string
      requestId: string
    }>) => {
      await reset(postgres.database)
      const attemptId = `pay_${input.attemptDigit.repeat(32)}`
      const targetKey = purchase.cityCreditPurchaseTargetKey(7, input.requestId)
      const times = await realDueAttemptTimes(postgres.database)
      await insertPurchaseAttempt(postgres.database, {
        publicId: attemptId,
        requestId: input.requestId,
        targetKey,
        txHash: `0x${input.transactionDigit.repeat(32)}`,
        times,
        includeFinality: false,
      })
      const observedAt = await waitPastDatabaseTime(
        postgres.database,
        times.recoveryDeadlineAt,
      )
      assert.ok(observedAt > times.recoveryDeadlineAt)
      const app = new Hono()
      purchase.mountCityCreditPurchaseRoutes(app, {
        authenticate: async () => ({ id: 7 }),
        database: paymentDatabase(postgres.database),
      })
      return { app, attemptId, targetKey, times }
    }
    const assertTerminal = async (response: Response): Promise<void> => {
      const body = await response.json() as Record<string, unknown>
      assert.equal(response.status, 409)
      assert.equal(body.do_not_pay_again, true)
      assert.match(String(body.error), /recovery deadline|no longer valid/iu)
    }

    const withoutHeaderRequestId = 'credit-purchase-postgres-expired-001'
    const withoutHeader = await seedDueAttempt({
      attemptDigit: '73',
      transactionDigit: '74',
      requestId: withoutHeaderRequestId,
    })
    await assertTerminal(await purchaseRequest(withoutHeader.app, withoutHeaderRequestId))
    assert.deepEqual(
      await replaySafetyFacts(postgres.database, withoutHeader.targetKey),
      expectedTerminalFacts,
    )

    const withHeaderRequestId = 'credit-purchase-postgres-expired-002'
    const withHeader = await seedDueAttempt({
      attemptDigit: '75',
      transactionDigit: '76',
      requestId: withHeaderRequestId,
    })
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('expired request-id retry reached an external payment service')
    }) as typeof fetch
    try {
      await assertTerminal(await purchaseRequest(
        withHeader.app,
        withHeaderRequestId,
        retryPaymentHeader(),
      ))
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(fetchCalls, 0, 'a due request id is resolved before Base or facilitator access')
    assert.deepEqual(
      await replaySafetyFacts(postgres.database, withHeader.targetKey),
      expectedTerminalFacts,
    )

    const freshRequest = await purchaseRequest(
      withHeader.app,
      'credit-purchase-postgres-expired-003',
    )
    assert.equal(freshRequest.status, 402, 'a genuinely new purchase needs a new request id')
    const freshBody = await freshRequest.json() as Record<string, unknown>
    assert.match(String(freshBody.error), /send the X-PAYMENT header/iu)

    const directLookupRequestId = 'credit-purchase-postgres-expired-004'
    const directLookup = await seedDueAttempt({
      attemptDigit: '77',
      transactionDigit: '78',
      requestId: directLookupRequestId,
    })
    let nextPublicIdCalls = 0
    const replayed = await createOrReadPaymentAttempt(
      paymentDatabase(postgres.database),
      {
        actorId: 7,
        operation: 'credit_purchase',
        targetKey: directLookup.targetKey,
        request: { request_id: directLookupRequestId, amount_dollars: AMOUNT_DOLLARS },
        method: 'x402',
        network: 'base',
        token: USDC,
        payerWallet: PAYER,
        payeeWallet: PAYEE,
        amountUnits: AMOUNT_UNITS,
        x402Nonce: `0x${'66'.repeat(32)}`,
        x402PayloadDigest: 'a'.repeat(64),
        startBlock: 80_000_000n,
        startTime: directLookup.times.startTime,
        endTime: directLookup.times.endTime,
      },
      () => {
        nextPublicIdCalls += 1
        return `pay_${'79'.repeat(32)}`
      },
    )
    assert.equal(replayed.disposition, 'existing')
    assert.equal(replayed.attempt.publicId, directLookup.attemptId)
    assert.equal(replayed.attempt.status, 'expired')
    assert.equal(nextPublicIdCalls, 0, 'the header-path lookup must not create a replacement attempt')
    assert.deepEqual(
      await replaySafetyFacts(postgres.database, directLookup.targetKey),
      expectedTerminalFacts,
    )
  })
})
