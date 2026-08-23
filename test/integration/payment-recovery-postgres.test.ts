import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  PaymentAttemptConflictError,
  acquireDueSettlementLease,
  appendLateFinalityEvidence,
  bindPaymentEvidence,
  canonicalPaymentRequest,
  completePaymentAttempt,
  createOrReadPaymentAttempt,
  expirePaymentAttempt,
  findReplayableTargetPaymentAttempt,
  markPaymentAttemptFounderReview,
} from '../../src/payment-attempts.ts'
import { bobPaymentRepairApplyOperations } from '../../scripts/bob-payment-repair-apply.ts'
import {
  BOB_REPAIR_EXPECTATIONS,
  buildBobPaymentRepairPlan,
  readBobRepairSnapshot,
  type BobTransferEvidence,
} from '../../scripts/repair-bob-payments.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'payment_recovery_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const recoveryMigrationDdl = await readFile(
  new URL('../../db/migrations/20260822_payment_recovery.sql', import.meta.url),
  'utf8',
)
const cityCreditMigrationDdl = await readFile(
  new URL('../../db/migrations/20260822_city_credit.sql', import.meta.url),
  'utf8',
)
const recoveryTriggerRepairMigrationDdl = await readFile(
  new URL('../../db/migrations/20260823_payment_recovery_trigger_repair.sql', import.meta.url),
  'utf8',
)

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAYER = `0x${'1'.repeat(40)}`
const PAYEE = `0x${'2'.repeat(40)}`
const TX = `0x${'3'.repeat(64)}`
const BLOCK_HASH = `0x${'4'.repeat(64)}`
const RESPONSE = { ok: true, place: { id: 91 } }
const RESPONSE_BODY = JSON.stringify(RESPONSE)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ database: Pool; containerName: string }> {
  const containerName = `1f3d9-payment-recovery-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const database = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown
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

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

async function reset(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'integration-test', repeat('1', 64)),
      (2, 'payer', 'integration-test', repeat('2', 64))
  `)
}

type AttemptOptions = Readonly<{
  publicId: string
  targetKey: string
  operation?: 'frontier' | 'direct_sale' | 'world_sale'
  status?: 'settling' | 'payment_pending' | 'needs_review' | 'expired'
  leaseOwner?: string | null
  txHash?: string | null
  finalized?: boolean
  recovery?: 'future' | 'due' | 'none'
  invalidReason?: string | null
}>

async function insertAttempt(database: Pool, options: AttemptOptions): Promise<void> {
  const request = { name: options.targetKey.split(':').at(-1), parent_id: null }
  const canonical = canonicalPaymentRequest(request)
  const finalized = options.finalized === true
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, start_block, start_time, end_time,
      status, lease_owner, lease_expires_at, tx_hash,
      finalized_block_number, finalized_block_hash, finalized_block_time, finalized_at,
      recovery_started_at, recovery_deadline_at, invalid_reason
    ) VALUES (
      $1, 2, $16, $2, $3, $4::jsonb,
      'x402', 'base', $5, $6, $7, 1000000,
      $8, repeat('6', 64), 50000000,
      clock_timestamp() - interval '15 minutes', clock_timestamp() + interval '15 minutes',
      $9, $10, CASE WHEN $10::text IS NULL THEN NULL ELSE clock_timestamp() + interval '30 seconds' END,
      $11,
      CASE WHEN $12 THEN 50000001 ELSE NULL END,
      CASE WHEN $12 THEN $13 ELSE NULL END,
      CASE WHEN $12 THEN clock_timestamp() - interval '1 minute' ELSE NULL END,
      CASE WHEN $12 THEN clock_timestamp() ELSE NULL END,
      CASE $14
        WHEN 'future' THEN date_trunc('milliseconds', statement_timestamp()) - interval '1 hour'
        WHEN 'due' THEN date_trunc('milliseconds', statement_timestamp()) - interval '2 hours'
        ELSE NULL
      END,
      CASE $14
        WHEN 'future' THEN date_trunc('milliseconds', statement_timestamp()) + interval '1 hour'
        WHEN 'due' THEN date_trunc('milliseconds', statement_timestamp())
        ELSE NULL
      END,
      $15
    )
  `, [
    options.publicId,
    options.targetKey,
    canonical.hash,
    canonical.json,
    USDC,
    PAYER,
    PAYEE,
    `0x${randomBytes(32).toString('hex')}`,
    options.status ?? 'payment_pending',
    options.leaseOwner ?? null,
    options.txHash === undefined ? `0x${randomBytes(32).toString('hex')}` : options.txHash,
    finalized,
    BLOCK_HASH,
    options.recovery ?? 'future',
    options.invalidReason === undefined
      ? options.status === 'expired' ? 'automatic recovery deadline reached' : null
      : options.invalidReason,
    options.operation ?? 'frontier',
  ])
}

test('payment recovery migration and primitives preserve exact deadline and terminal history', async t => {
  let postgres: Awaited<ReturnType<typeof startPostgres>> | null = null
  try {
    postgres = await startPostgres()
  } catch (error) {
    if (/docker .*not recognized|docker .*not found|cannot connect|daemon/iu.test(String(error))) {
      t.skip(`Docker unavailable: ${String(error)}`)
      return
    }
    throw error
  }
  const { database, containerName } = postgres
  t.after(async () => {
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
  })

  await t.test('city credit cannot replace the newer payment transition rules', async () => {
    await reset(database)
    await database.query(cityCreditMigrationDdl)
    await database.query(recoveryTriggerRepairMigrationDdl)
    await database.query(recoveryTriggerRepairMigrationDdl)
    await insertAttempt(database, {
      publicId: 'pay_recovery_after_credit', targetKey: 'frontier:root:after-credit',
      leaseOwner: 'lease-after-credit', recovery: 'due',
    })

    const expired = await expirePaymentAttempt({ query: async (text, params = []) => (
      await database.query(text, [...params])
    ).rows }, {
      publicId: 'pay_recovery_after_credit',
      leaseOwner: 'lease-after-credit',
      reason: 'automatic payment recovery deadline passed',
    })
    assert.equal(expired.status, 'expired')
  })

  await t.test('recovery deadline is exactly two hours and equality cannot complete', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_before_boundary', targetKey: 'frontier:root:before-boundary',
      leaseOwner: 'lease-before', finalized: true, recovery: 'future',
    })
    const completed = await completePaymentAttempt({ query: async (text, params = []) => (
      await database.query(text, [...params])
    ).rows }, {
      publicId: 'pay_recovery_before_boundary',
      leaseOwner: 'lease-before',
      result: { place_id: 91 }, responseStatus: 201, response: RESPONSE,
      responseBody: RESPONSE_BODY,
    })
    assert.equal(completed.status, 'completed')

    await insertAttempt(database, {
      publicId: 'pay_recovery_at_boundary', targetKey: 'frontier:root:at-boundary',
      leaseOwner: 'lease-due', finalized: true, recovery: 'due',
    })
    await assert.rejects(
      completePaymentAttempt({ query: async (text, params = []) => (
        await database.query(text, [...params])
      ).rows }, {
        publicId: 'pay_recovery_at_boundary',
        leaseOwner: 'lease-due', result: { place_id: 92 }, responseStatus: 201,
        response: RESPONSE, responseBody: RESPONSE_BODY,
      }),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
    const expired = await expirePaymentAttempt({ query: async (text, params = []) => (
      await database.query(text, [...params])
    ).rows }, {
      publicId: 'pay_recovery_at_boundary', leaseOwner: 'lease-due',
      reason: 'automatic recovery deadline reached',
    })
    assert.equal(expired.status, 'expired')

    const windows = await database.query<{ exact: boolean }>(`
      SELECT bool_and(recovery_deadline_at = recovery_started_at + interval '2 hours') AS exact
      FROM payment_attempts WHERE recovery_started_at IS NOT NULL
    `)
    assert.equal(windows.rows[0]?.exact, true)
  })

  await t.test('due-only leases refuse one millisecond before, acquire at equality, and overlap safely', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_due_lease_boundary', targetKey: 'frontier:root:due-lease-boundary',
      status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const boundary = await database.query<{ recovery_deadline_at: Date }>(`
      SELECT recovery_deadline_at FROM payment_attempts
      WHERE public_id = 'pay_recovery_due_lease_boundary'
    `)
    const deadline = boundary.rows[0]?.recovery_deadline_at
    assert.ok(deadline instanceof Date)

    const databaseAt = (observedAt: Date) => ({
      query: async (text: string, params: readonly unknown[] = []) => {
        if (!text.includes('payment-attempts:lease-due */')) {
          return (await database.query(text, [...params])).rows
        }
        assert.match(text, /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
        const controlled = text.replaceAll('clock_timestamp()', '$5::timestamptz')
        return (await database.query(controlled, [...params, observedAt.toISOString()])).rows
      },
    })
    const oneMillisecondBefore = new Date(deadline.getTime() - 1)
    const refused = await acquireDueSettlementLease(databaseAt(oneMillisecondBefore), {
      publicId: 'pay_recovery_due_lease_boundary', actorId: 2, leaseMilliseconds: 30_000,
    }, () => 'due_lease_before')
    assert.equal(refused.acquired, false)
    assert.equal(refused.attempt?.leaseOwner, null)

    const acquired = await acquireDueSettlementLease(databaseAt(deadline), {
      publicId: 'pay_recovery_due_lease_boundary', actorId: 2, leaseMilliseconds: 30_000,
    }, () => 'due_lease_exact')
    assert.equal(acquired.acquired, true)
    assert.equal(acquired.leaseOwner, 'due_lease_exact')

    await insertAttempt(database, {
      publicId: 'pay_recovery_due_lease_race', targetKey: 'frontier:root:due-lease-race',
      status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const racers = await Promise.all([
      acquireDueSettlementLease(paymentDatabase, {
        publicId: 'pay_recovery_due_lease_race', actorId: 2, leaseMilliseconds: 30_000,
      }, () => 'due_lease_racer_a'),
      acquireDueSettlementLease(paymentDatabase, {
        publicId: 'pay_recovery_due_lease_race', actorId: 2, leaseMilliseconds: 30_000,
      }, () => 'due_lease_racer_b'),
    ])
    assert.equal(racers.filter(result => result.acquired).length, 1)
    assert.equal(racers.filter(result => !result.acquired).length, 1)
  })

  await t.test('terminal states release live targets and overlapping completion cannot win after deadline', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_race', targetKey: 'frontier:root:race-target',
      leaseOwner: 'lease-race', finalized: true, recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const [expiry, completion] = await Promise.allSettled([
      expirePaymentAttempt(paymentDatabase, {
        publicId: 'pay_recovery_race', leaseOwner: 'lease-race',
        reason: 'automatic recovery deadline reached',
      }),
      completePaymentAttempt(paymentDatabase, {
        publicId: 'pay_recovery_race', leaseOwner: 'lease-race',
        result: { place_id: 93 }, responseStatus: 201, response: RESPONSE,
        responseBody: RESPONSE_BODY,
      }),
    ])
    assert.equal(expiry.status, 'fulfilled')
    assert.equal(completion.status, 'rejected')
    const row = await database.query<{ status: string; result_json: unknown; lease_owner: string | null }>(`
      SELECT status, result_json, lease_owner FROM payment_attempts
      WHERE public_id = 'pay_recovery_race'
    `)
    assert.deepEqual(row.rows, [{ status: 'expired', result_json: null, lease_owner: null }])

    await insertAttempt(database, {
      publicId: 'pay_recovery_reused_target', targetKey: 'frontier:root:race-target',
      status: 'settling', leaseOwner: null, txHash: null, recovery: 'none',
    })
    await insertAttempt(database, {
      publicId: 'pay_recovery_founder_live', targetKey: 'frontier:root:founder-target',
      leaseOwner: 'lease-founder', recovery: 'future',
    })
    const founderReview = await markPaymentAttemptFounderReview(paymentDatabase, {
      publicId: 'pay_recovery_founder_live', leaseOwner: 'lease-founder',
      reason: 'matching payment needs founder review',
    })
    assert.equal(founderReview.status, 'founder_review')
    await insertAttempt(database, {
      publicId: 'pay_recovery_founder_reuse', targetKey: 'frontier:root:founder-target',
      status: 'settling', leaseOwner: null, txHash: null, recovery: 'none',
    })
  })

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

  await t.test('recovery timestamps never move after first evidence', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_immutable', targetKey: 'frontier:root:immutable',
      status: 'settling', leaseOwner: 'lease-immutable', txHash: null, recovery: 'none',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    await bindPaymentEvidence(paymentDatabase, {
      publicId: 'pay_recovery_immutable', leaseOwner: 'lease-immutable', txHash: TX,
      finality: null,
    })
    const before = await database.query<{
      recovery_started_at: Date
      recovery_deadline_at: Date
    }>(`SELECT recovery_started_at, recovery_deadline_at FROM payment_attempts
        WHERE public_id = 'pay_recovery_immutable'`)
    await delay(20)
    await bindPaymentEvidence(paymentDatabase, {
      publicId: 'pay_recovery_immutable', leaseOwner: 'lease-immutable', txHash: TX,
      finality: null,
    })
    const after = await database.query<{
      recovery_started_at: Date
      recovery_deadline_at: Date
    }>(`SELECT recovery_started_at, recovery_deadline_at FROM payment_attempts
        WHERE public_id = 'pay_recovery_immutable'`)
    assert.deepEqual(after.rows, before.rows)
    await assert.rejects(
      database.query(`UPDATE payment_attempts
        SET recovery_started_at = recovery_started_at + interval '1 second',
            recovery_deadline_at = recovery_deadline_at + interval '1 second'
        WHERE public_id = 'pay_recovery_immutable'`),
      (error: unknown) => postgresCode(error) === '55000',
    )
  })

  await t.test('expired late finality appends founder review without deleting or rewriting history', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_late', targetKey: 'frontier:root:late',
      status: 'expired', leaseOwner: null, txHash: null, finalized: false, recovery: 'due',
    })
    const before = await database.query<{
      request_json: unknown
      invalid_reason: string
      created_at: Date
    }>(`SELECT request_json, invalid_reason, created_at FROM payment_attempts
        WHERE public_id = 'pay_recovery_late'`)
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const late = await appendLateFinalityEvidence(paymentDatabase, {
      publicId: 'pay_recovery_late', txHash: TX,
      finality: {
        blockNumber: 50_000_001n, blockHash: BLOCK_HASH,
        blockTime: new Date(Date.now() - 30_000).toISOString(),
        finalizedAt: new Date().toISOString(),
      },
      reason: 'matching payment finalized after automatic recovery ended',
    })
    assert.equal(late.status, 'founder_review')
    const after = await database.query<{
      status: string
      request_json: unknown
      invalid_reason: string
      created_at: Date
      finalized_block_number: string
      tx_hash: string
    }>(`SELECT status, request_json, invalid_reason, created_at,
               finalized_block_number::text, tx_hash
        FROM payment_attempts WHERE public_id = 'pay_recovery_late'`)
    assert.deepEqual(after.rows[0]?.request_json, before.rows[0]?.request_json)
    assert.equal(after.rows[0]?.invalid_reason, before.rows[0]?.invalid_reason)
    assert.deepEqual(after.rows[0]?.created_at, before.rows[0]?.created_at)
    assert.equal(after.rows[0]?.finalized_block_number, '50000001')
    assert.equal(after.rows[0]?.tx_hash, TX)

    const founderReason = 'matching payment finalized after automatic recovery ended'
    await insertAttempt(database, {
      publicId: 'pay_recovery_late_reason', targetKey: 'frontier:root:late-reason',
      status: 'expired', leaseOwner: null, txHash: null, finalized: false,
      recovery: 'due', invalidReason: null,
    })
    const reasoned = await appendLateFinalityEvidence(paymentDatabase, {
      publicId: 'pay_recovery_late_reason', txHash: `0x${'5'.repeat(64)}`,
      finality: {
        blockNumber: 50_000_002n, blockHash: `0x${'6'.repeat(64)}`,
        blockTime: new Date(Date.now() - 20_000).toISOString(),
        finalizedAt: new Date().toISOString(),
      },
      reason: founderReason,
    })
    assert.equal(reasoned.status, 'founder_review')
    assert.equal(reasoned.invalidReason, founderReason)

    await assert.rejects(
      database.query("DELETE FROM payment_attempts WHERE public_id = 'pay_recovery_late'"),
      (error: unknown) => postgresCode(error) === '55000',
    )
    await assert.rejects(
      database.query(`UPDATE payment_attempts SET request_json = '{"name":"rewritten"}'::jsonb
        WHERE public_id = 'pay_recovery_late'`),
      (error: unknown) => postgresCode(error) === '55000',
    )
  })

  await t.test('the trigger repair migration re-allows due x402 expiry from payment_pending', async () => {
    await reset(database)
    await database.query(`
      CREATE OR REPLACE FUNCTION protect_payment_attempt_history() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'payment attempt history cannot be deleted' USING ERRCODE = '55000';
        END IF;
        IF OLD.status IN ('completed', 'invalid', 'expired', 'legacy_completed', 'credit_returned')
          AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
        END IF;
        IF NOT (
          (OLD.status = 'settling' AND NEW.status IN (
            'settling', 'payment_pending', 'invalid', 'expired', 'needs_review'
          ))
          OR (OLD.status = 'payment_pending' AND NEW.status IN (
            'payment_pending', 'completed', 'invalid', 'needs_review'
          ))
          OR (OLD.status = 'needs_review' AND NEW.status IN (
            'needs_review', 'payment_pending', 'completed', 'invalid'
          ))
          OR (
            OLD.method = 'credit'
            AND OLD.status IN ('settling', 'payment_pending')
            AND NEW.status IN ('completed', 'credit_returned')
          )
          OR (OLD.status = NEW.status)
        ) THEN
          RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE = '55000';
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
          RAISE EXCEPTION 'payment attempt update time cannot move backward' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $function$;
    `)
    await insertAttempt(database, {
      publicId: 'pay_recovery_stale_trigger', targetKey: 'frontier:root:stale-trigger',
      status: 'payment_pending', leaseOwner: 'lease-due', recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }

    await assert.rejects(
      expirePaymentAttempt(paymentDatabase, {
        publicId: 'pay_recovery_stale_trigger',
        leaseOwner: 'lease-due',
        reason: 'automatic payment recovery deadline passed',
      }),
      (error: unknown) => postgresCode(error) === '55000',
    )

    await database.query(recoveryTriggerRepairMigrationDdl)
    const expired = await expirePaymentAttempt(paymentDatabase, {
      publicId: 'pay_recovery_stale_trigger',
      leaseOwner: 'lease-due',
      reason: 'automatic payment recovery deadline passed',
    })
    assert.equal(expired.status, 'expired')
    assert.equal(expired.leaseOwner, null)
    assert.equal(expired.invalidReason, 'automatic payment recovery deadline passed')
  })

  await t.test('additive migration backfills old live rows from their last known update', async () => {
    await reset(database)
    await database.query('ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_initialize_recovery_window')
    await database.query('ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_keep_history')
    await database.query('ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_recovery_window_valid')
    await database.query('ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_x402_live_recovery_required')
    await insertAttempt(database, {
      publicId: 'pay_recovery_backfill', targetKey: 'frontier:root:backfill',
      status: 'payment_pending', leaseOwner: null, recovery: 'none',
    })
    await database.query(`UPDATE payment_attempts
      SET recovery_started_at = NULL,
          recovery_deadline_at = NULL,
          created_at = clock_timestamp() - interval '4 hours',
          updated_at = clock_timestamp() - interval '3 hours'
      WHERE public_id = 'pay_recovery_backfill'`)
    await database.query('ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_initialize_recovery_window')
    await database.query('ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_keep_history')

    await database.query(recoveryMigrationDdl)
    const backfill = await database.query<{
      anchored_to_update: boolean
      is_past_deadline: boolean
    }>(`SELECT recovery_started_at = updated_at AS anchored_to_update,
              recovery_deadline_at <= clock_timestamp() AS is_past_deadline
        FROM payment_attempts WHERE public_id = 'pay_recovery_backfill'`)
    assert.deepEqual(backfill.rows, [{ anchored_to_update: true, is_past_deadline: true }])
  })

  await t.test('a finalized direct sale can claim after wall-clock reservation expiry only from stored terms', async () => {
    await reset(database)
    const offer = await database.query<{
      id: number
      reserved_at: Date
      reserved_until: Date
    }>(`
      WITH reservation AS MATERIALIZED (
        SELECT clock_timestamp() - interval '10 minutes' AS reserved_at
      )
      INSERT INTO transfer_offers (
        channel, asset_type, asset_id, seller_id, buyer_id, price_usdc,
        seller_wallet, buyer_wallet, status, reserved_by, reserved_at, reserved_until
      ) SELECT
        'direct', 'thing', 777, 1, 2, 1.000000,
        $1, $2, 'open', 2,
        reserved_at, reserved_at + interval '5 minutes'
      FROM reservation
      RETURNING id, reserved_at, reserved_until
    `, [PAYEE, PAYER])
    const storedOffer = offer.rows[0]
    assert.ok(storedOffer)
    const request = {
      offer_id: storedOffer.id,
      buyer_wallet: PAYER,
      seller_wallet: PAYEE,
      price_usdc: 1,
      asset_type: 'thing',
      asset_id: 777,
    }
    const canonical = canonicalPaymentRequest(request)
    const finalizedBlockTime = new Date(storedOffer.reserved_at.getTime() + 60_000)
    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, counterparty_id, operation, target_key, offer_id,
        asset_type, asset_id, request_hash, request_json, method, network, token,
        payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
        start_block, start_time, end_time, status, lease_owner, lease_expires_at,
        tx_hash, finalized_block_number, finalized_block_hash,
        finalized_block_time, finalized_at, recovery_started_at, recovery_deadline_at
      ) VALUES (
        'pay_recovery_delayed_direct', 2, 1, 'direct_sale', $1, $2,
        'thing', 777, $3, $4::jsonb, 'x402', 'base', $5,
        $6, $7, 1000000, $8, repeat('7', 64),
        50000000, $9, $10, 'payment_pending', 'delayed_direct_lease',
        clock_timestamp() + interval '30 seconds', $11, 50000001, $12,
        $13, clock_timestamp(),
        statement_timestamp() - interval '1 hour', statement_timestamp() + interval '1 hour'
      )
    `, [
      `direct-sale:${storedOffer.id}`,
      storedOffer.id,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      `0x${'8'.repeat(64)}`,
      storedOffer.reserved_at.toISOString(),
      storedOffer.reserved_until.toISOString(),
      `0x${'9'.repeat(64)}`,
      `0x${'a'.repeat(64)}`,
      finalizedBlockTime.toISOString(),
    ])

    const claimed = await database.query<{ status: string }>(`
      UPDATE transfer_offers
      SET status = 'claimed', claimed_at = clock_timestamp()
      WHERE id = $1
      RETURNING status
    `, [storedOffer.id])
    assert.deepEqual(claimed.rows, [{ status: 'claimed' }])
  })

  await t.test('a matching terminal direct attempt releases an otherwise active reservation', async () => {
    await reset(database)
    const offer = await database.query<{ id: number; reserved_at: Date; reserved_until: Date }>(`
      WITH reservation AS MATERIALIZED (
        SELECT clock_timestamp() AS reserved_at
      )
      INSERT INTO transfer_offers (
        channel, asset_type, asset_id, seller_id, buyer_id, price_usdc,
        seller_wallet, buyer_wallet, status, reserved_by, reserved_at, reserved_until
      ) SELECT
        'direct', 'thing', 778, 1, 2, 1.000000,
        $1, $2, 'open', 2, reserved_at, reserved_at + interval '5 minutes'
      FROM reservation
      RETURNING id, reserved_at, reserved_until
    `, [PAYEE, PAYER])
    const storedOffer = offer.rows[0]
    assert.ok(storedOffer)
    const request = {
      offer_id: storedOffer.id,
      buyer_wallet: PAYER,
      seller_wallet: PAYEE,
      price_usdc: 1,
      asset_type: 'thing',
      asset_id: 778,
    }
    const canonical = canonicalPaymentRequest(request)
    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, counterparty_id, operation, target_key, offer_id,
        asset_type, asset_id, request_hash, request_json, method, network, token,
        payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
        start_block, start_time, end_time, status, tx_hash, invalid_reason,
        recovery_started_at, recovery_deadline_at
      ) VALUES (
        'pay_recovery_invalid_direct', 2, 1, 'direct_sale', $1, $2,
        'thing', 778, $3, $4::jsonb, 'x402', 'base', $5,
        $6, $7, 1000000, $8, repeat('b', 64),
        50000000, $9, $10, 'invalid', $11,
        'confirmed payment does not match the immutable direct sale',
        statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '119 minutes'
      )
    `, [
      `direct-sale:${storedOffer.id}`,
      storedOffer.id,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      `0x${'c'.repeat(64)}`,
      storedOffer.reserved_at.toISOString(),
      storedOffer.reserved_until.toISOString(),
      `0x${'d'.repeat(64)}`,
    ])

    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, counterparty_id, operation, target_key, offer_id,
        asset_type, asset_id, request_hash, request_json, method, network, token,
        payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
        start_block, start_time, end_time, status
      ) VALUES (
        'pay_recovery_live_direct_retry', 2, 1, 'direct_sale', $1, $2,
        'thing', 778, $3, $4::jsonb, 'x402', 'base', $5,
        $6, $7, 1000000, $8, repeat('e', 64),
        50000000, $9, $10, 'settling'
      )
    `, [
      `direct-sale:${storedOffer.id}`,
      storedOffer.id,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      `0x${'f'.repeat(64)}`,
      storedOffer.reserved_at.toISOString(),
      storedOffer.reserved_until.toISOString(),
    ])

    await assert.rejects(
      database.query(`UPDATE transfer_offers
        SET status = 'canceled', canceled_at = clock_timestamp()
        WHERE id = $1`, [storedOffer.id]),
      (error: unknown) => postgresCode(error) === '55000',
    )
    await database.query(`
      UPDATE payment_attempts
      SET status = 'invalid', invalid_reason = 'retry was conclusively rejected',
          updated_at = clock_timestamp()
      WHERE public_id = 'pay_recovery_live_direct_retry'
    `)

    const canceled = await database.query<{ status: string }>(`
      UPDATE transfer_offers
      SET status = 'canceled', canceled_at = clock_timestamp()
      WHERE id = $1
      RETURNING status
    `, [storedOffer.id])
    assert.deepEqual(canceled.rows, [{ status: 'canceled' }])
  })

  await t.test('the approved Bob repair creates one exact continent, closes the probe, records repair events, and issues one credit', async () => {
    await reset(database)
    await database.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (68, 'bob', 'integration-test', repeat('6', 64))
    `)

    for (const expected of [
      BOB_REPAIR_EXPECTATIONS.coffee,
      BOB_REPAIR_EXPECTATIONS.theBlueAI,
    ]) {
      await database.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, start_block, start_time, end_time,
          status, tx_hash, response_json, recovery_started_at, recovery_deadline_at,
          created_at, updated_at, invalid_reason
        ) VALUES (
          $1, 68, 'frontier', $2, $3, $4::jsonb,
          'x402', 'base', $5, $6, $7, 1000000,
          $8, repeat('7', 64), 49000000,
          '2026-08-22T07:00:00Z', '2026-08-22T08:30:00Z',
          'expired', $9,
          jsonb_build_object(
            '__1f3d9_x402_response_v1', jsonb_build_object('header', 'dGVzdA==')
          ),
          $10::timestamptz, $11::timestamptz,
          '2026-08-22T07:00:00Z', $12::timestamptz,
          'automatic payment recovery deadline passed'
        )
      `, [
        expected.attemptId,
        expected.targetKey,
        expected.requestHash,
        JSON.stringify(expected.request),
        BOB_REPAIR_EXPECTATIONS.token,
        BOB_REPAIR_EXPECTATIONS.payer,
        BOB_REPAIR_EXPECTATIONS.recipient,
        `0x${randomBytes(32).toString('hex')}`,
        expected.txHash,
        expected.recoveryStartedAt,
        expected.recoveryDeadlineAt,
        expected.updatedAt,
      ])
    }

    const transferEvidence = Object.freeze(Object.fromEntries(([
      ['coffee', BOB_REPAIR_EXPECTATIONS.coffee],
      ['theBlueAI', BOB_REPAIR_EXPECTATIONS.theBlueAI],
    ] as const).map(([, expected]) => [expected.txHash, {
      state: 'matched',
      from: BOB_REPAIR_EXPECTATIONS.payer,
      to: BOB_REPAIR_EXPECTATIONS.recipient,
      amount: 1_000_000n,
      blockNumber: BigInt(expected.blockNumber),
      blockHash: expected.blockHash,
      blockTime: new Date(expected.blockTime),
      finalizedAt: new Date('2026-08-23T12:00:00Z'),
    } satisfies BobTransferEvidence])))

    const rollbackClient = await database.connect()
    try {
      await rollbackClient.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      const rollbackPlan = buildBobPaymentRepairPlan(
        await readBobRepairSnapshot(rollbackClient, true),
        transferEvidence,
      )
      const firstOperation = rollbackPlan.actions.find(
        action => action.kind === 'complete_theblueai',
      )
      assert.ok(firstOperation)
      await bobPaymentRepairApplyOperations.completeTheBlueAI(rollbackClient, firstOperation)
      const inside = await rollbackClient.query<{ places: number; uses: number; fees: number; founder_review: number; repair_events: number }>(`
        SELECT
          (SELECT count(*)::integer FROM places WHERE name = 'TheBlueAI') AS places,
          (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::integer FROM fees WHERE tx_hash = $2) AS fees,
          (SELECT count(*)::integer FROM payment_attempts
            WHERE public_id = $1 AND status = 'founder_review') AS founder_review,
          (SELECT count(*)::integer FROM events WHERE kind = 'payment_repair') AS repair_events
      `, [
        BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
        BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
      ])
      assert.deepEqual(inside.rows, [{ places: 1, uses: 0, fees: 0, founder_review: 1, repair_events: 1 }])
      await rollbackClient.query('ROLLBACK')
    } finally {
      rollbackClient.release()
    }
    const afterRollback = await database.query<{
      places: number
      uses: number
      fees: number
      founder_review: number
    }>(`
      SELECT
        (SELECT count(*)::integer FROM places WHERE name = 'TheBlueAI') AS places,
        (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
        (SELECT count(*)::integer FROM fees WHERE tx_hash = $2) AS fees,
        (SELECT count(*)::integer FROM payment_attempts
          WHERE public_id = $1 AND status = 'expired'
            AND finalized_block_number IS NULL) AS founder_review
    `, [
      BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
      BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
    ])
    assert.deepEqual(afterRollback.rows, [{ places: 0, uses: 0, fees: 0, founder_review: 1 }])

    const client = await database.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      const initial = buildBobPaymentRepairPlan(
        await readBobRepairSnapshot(client, true),
        transferEvidence,
      )
      assert.equal(initial.state, 'work_required')
      const complete = initial.actions.find(action => action.kind === 'complete_theblueai')
      const close = initial.actions.find(action => action.kind === 'close_coffee_probe')
      const credit = initial.actions.find(action => action.kind === 'issue_founder_credit')
      assert.ok(complete && close && credit)

      await bobPaymentRepairApplyOperations.completeTheBlueAI(client, complete)
      await bobPaymentRepairApplyOperations.closeCoffeeProbe(client, close)
      await bobPaymentRepairApplyOperations.issueFounderCredit(client, credit)

      const completed = buildBobPaymentRepairPlan(
        await readBobRepairSnapshot(client, true),
        transferEvidence,
      )
      assert.equal(completed.state, 'no_work')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    const exactCounts = await database.query<{
      blue_places: number
      coffee_places: number
      blue_uses: number
      coffee_uses: number
      blue_fees: number
      coffee_fees: number
      credits: number
      repair_events: number
      blue_status: string
      coffee_status: string
      blue_reason: string | null
      coffee_reason: string | null
    }>(`
      SELECT
        (SELECT count(*)::integer FROM places WHERE name = 'TheBlueAI') AS blue_places,
        (SELECT count(*)::integer FROM places WHERE lower(name) = 'coffee-shop') AS coffee_places,
        (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $1) AS blue_uses,
        (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $2) AS coffee_uses,
        (SELECT count(*)::integer FROM fees WHERE tx_hash = $3) AS blue_fees,
        (SELECT count(*)::integer FROM fees WHERE tx_hash = $4) AS coffee_fees,
        (SELECT count(*)::integer FROM city_credit_entries
          WHERE source_key = $5) AS credits,
        (SELECT count(*)::integer FROM events WHERE kind = 'payment_repair') AS repair_events,
        (SELECT status FROM payment_attempts WHERE public_id = $1) AS blue_status,
        (SELECT status FROM payment_attempts WHERE public_id = $2) AS coffee_status,
        (SELECT invalid_reason FROM payment_attempts WHERE public_id = $1) AS blue_reason,
        (SELECT invalid_reason FROM payment_attempts WHERE public_id = $2) AS coffee_reason
    `, [
      BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
      BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
      BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
      BOB_REPAIR_EXPECTATIONS.coffee.txHash,
      `bob-payment-repair:${BOB_REPAIR_EXPECTATIONS.coffee.attemptId}`,
    ])
    assert.deepEqual(exactCounts.rows, [{
      blue_places: 1,
      coffee_places: 0,
      blue_uses: 0,
      coffee_uses: 0,
      blue_fees: 0,
      coffee_fees: 0,
      credits: 1,
      repair_events: 2,
      blue_status: 'founder_review',
      coffee_status: 'founder_review',
      blue_reason: 'automatic payment recovery deadline passed',
      coffee_reason: 'automatic payment recovery deadline passed',
    }])

    const retryPlan = buildBobPaymentRepairPlan(
      await readBobRepairSnapshot(database),
      transferEvidence,
    )
    assert.equal(retryPlan.state, 'no_work')
  })
})
