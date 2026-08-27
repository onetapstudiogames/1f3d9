import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import {
  beginCityCreditSpend,
  type CityCreditDatabase,
} from '../../src/city-credit.ts'
import { deliverPayPalCredit } from '../../src/paypal-credit-delivery.ts'
import {
  attachPayPalOrder,
  beginPayPalCreditIntent,
  type PayPalCreditStoreDatabase,
} from '../../src/paypal-credit-store.ts'
import {
  acceptCreditGift,
  parseGiftClaimToken,
  redirectCreditGift,
} from '../../src/prepaid-credit.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'prepaid_city_credit_concurrency'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260826_prepaid_city_credit.sql', import.meta.url),
  'utf8',
)

type TestDatabase = CityCreditDatabase & PayPalCreditStoreDatabase
type Outcome = Readonly<
  { ok: true; value: Readonly<Record<string, unknown>> }
  | { ok: false; error: unknown }
>

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ pool: Pool; containerName: string }> {
  const containerName = `1f3d9-credit-race-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`, POSTGRES_IMAGE,
  ])
  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const pool = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 8,
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

function database(client: Pool | PoolClient): TestDatabase {
  return {
    query: async (text, params = []) => (await client.query(text, [...params])).rows,
  }
}

async function resetFresh(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await pool.query(schemaDdl)
  await pool.query(migrationDdl)
  await pool.query(migrationDdl)
  await pool.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'credit-race-test', repeat('1', 64)),
      (2, 'resident-two', 'credit-race-test', repeat('2', 64)),
      (3, 'resident-three', 'credit-race-test', repeat('3', 64))
  `)
}

async function waitForRowLock(pool: Pool, processId: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT COALESCE((
        SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1
      ), false) AS waiting
    `, [processId])
    if (result.rows[0]?.waiting) return
    await delay(10)
  }
  assert.fail(`PostgreSQL backend ${processId} did not wait on the locked row`)
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const pid = result.rows[0]?.pid
  assert.ok(Number.isInteger(pid) && pid! > 0)
  return pid!
}

function observe(operation: Promise<Readonly<Record<string, unknown>>>): Promise<Outcome> {
  return operation.then(
    value => Object.freeze({ ok: true as const, value }),
    error => Object.freeze({ ok: false as const, error }),
  )
}

async function orderedRowRace(
  pool: Pool,
  lock: (coordinator: PoolClient) => Promise<void>,
  first: (database: TestDatabase) => Promise<Readonly<Record<string, unknown>>>,
  second: (database: TestDatabase) => Promise<Readonly<Record<string, unknown>>>,
): Promise<readonly [Outcome, Outcome]> {
  const coordinator = await pool.connect()
  const firstClient = await pool.connect()
  const secondClient = await pool.connect()
  const [coordinatorPid, firstPid, secondPid] = await Promise.all([
    backendPid(coordinator), backendPid(firstClient), backendPid(secondClient),
  ])
  assert.notEqual(firstPid, secondPid)
  assert.notEqual(coordinatorPid, firstPid)
  assert.notEqual(coordinatorPid, secondPid)
  await coordinator.query('BEGIN')
  try {
    await lock(coordinator)
    const firstOutcome = observe(first(database(firstClient)))
    await waitForRowLock(pool, firstPid)
    const secondOutcome = observe(second(database(secondClient)))
    const concurrent = Promise.all([firstOutcome, secondOutcome] as const)
    await waitForRowLock(pool, secondPid)
    await coordinator.query('COMMIT')
    return await concurrent
  } catch (error) {
    await coordinator.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    coordinator.release()
    firstClient.release()
    secondClient.release()
  }
}

async function createPendingGift(pool: Pool, suffix: string) {
  const db = database(pool)
  const intent = await beginPayPalCreditIntent(db, {
    requestId: `gift-race-${suffix.toLowerCase()}`,
    intentKind: 'order', delivery: 'gift', recipientId: 2,
    amountUnits: 1_000_000n, paypalEnvironment: 'sandbox',
  })
  const order = await attachPayPalOrder(db, {
    purchaseId: intent.purchaseId, orderId: `ORDER-${suffix}`,
  })
  const purchase = await deliverPayPalCredit(db, {
    intent: { ...intent, remoteOrderId: order.orderId, status: order.status },
    sourceKey: `paypal:capture:${suffix}`,
    purchaseKind: 'paypal', eventId: `fixture:${suffix}`,
    eventKind: 'PAYMENT.CAPTURE.COMPLETED', remoteResourceId: suffix,
  })
  return Object.freeze({
    giftId: String(purchase.gift_id),
    claimToken: parseGiftClaimToken(intent.claimToken),
  })
}

async function creditState(pool: Pool, residentId: number) {
  const [account, receipts] = await Promise.all([
    pool.query<{ balance_units: string }>(`
      SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = $1
    `, [residentId]),
    pool.query<{ entry_kind: string }>(`
      SELECT entry_kind FROM city_credit_entries WHERE resident_id = $1 ORDER BY id
    `, [residentId]),
  ])
  return Object.freeze({
    balance: account.rows[0]?.balance_units ?? '0',
    receipts: receipts.rows.map(row => row.entry_kind),
  })
}

function failure(outcome: Outcome): Error & { code?: string } {
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error instanceof Error)
  return outcome.error as Error & { code?: string }
}

test('real PostgreSQL serializes simultaneous prepaid-credit state transitions', {
  timeout: 120_000,
}, async t => {
  const postgres = await startPostgres()
  try {
    await t.test('two separate connections cannot spend one credit twice', async () => {
      await resetFresh(postgres.pool)
      await postgres.pool.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, founder_id, source_key, reason
        ) VALUES (2, 'founder_issue', 1000000, 1, 'credit-race-funding', 'race proof')
      `)
      const spend = (db: TestDatabase, suffix: string) => beginCityCreditSpend(db, {
        actorId: 2, operation: 'frontier', targetKey: `frontier:race-${suffix}`,
        requestId: `credit-race-${suffix}-0001`, request: { name: `Race ${suffix}` },
      })
      const [winner, loser] = await orderedRowRace(
        postgres.pool,
        async client => {
          await client.query('SELECT 1 FROM city_credit_accounts WHERE resident_id = 2 FOR UPDATE')
        },
        async db => await spend(db, 'first'),
        async db => await spend(db, 'second'),
      )

      assert.equal(winner.ok, true)
      if (winner.ok) assert.equal(winner.value.state, 'ready')
      const rejected = failure(loser)
      assert.equal(rejected.code, '23514')
      assert.match(rejected.message, /insufficient city fee credit/iu)
      assert.deepEqual(await creditState(postgres.pool, 2), {
        balance: '0', receipts: ['founder_issue', 'spend'],
      })
    })

    await t.test('accept and redirect each win honestly when first at the gift row lock', async () => {
      for (const firstAction of ['accept', 'redirect'] as const) {
        await resetFresh(postgres.pool)
        const gift = await createPendingGift(postgres.pool, `GIFT${firstAction.toUpperCase()}FIRST`)
        const accept = async (db: TestDatabase) => await acceptCreditGift(db, {
          residentId: 2, giftId: gift.giftId,
        })
        const redirect = async (db: TestDatabase) => await redirectCreditGift(db, {
          giftId: gift.giftId, claimToken: gift.claimToken, residentId: 3,
          requestId: `gift-race-${firstAction}-0001`,
        })
        const [winner, loser] = await orderedRowRace(
          postgres.pool,
          async client => {
            await client.query('SELECT 1 FROM city_credit_gifts WHERE public_id = $1 FOR UPDATE', [gift.giftId])
          },
          firstAction === 'accept' ? accept : redirect,
          firstAction === 'accept' ? redirect : accept,
        )

        assert.equal(winner.ok, true)
        if (winner.ok) assert.equal(winner.value.status, firstAction === 'accept' ? 'accepted' : 'pending')
        const rejected = failure(loser)
        assert.equal(rejected.name, 'PrepaidCreditConflictError')
        assert.match(rejected.message, firstAction === 'accept'
          ? /claim or recipient changed|no longer redirectable/iu
          : /not pending for this recipient|not found/iu)

        const giftRow = await postgres.pool.query<{ recipient_id: number; status: string }>(`
          SELECT recipient_id, status FROM city_credit_gifts WHERE public_id = $1
        `, [gift.giftId])
        assert.deepEqual(giftRow.rows, [firstAction === 'accept'
          ? { recipient_id: 2, status: 'accepted' }
          : { recipient_id: 3, status: 'pending' }])
        assert.deepEqual(await creditState(postgres.pool, 2), firstAction === 'accept'
          ? { balance: '1000000', receipts: ['purchase', 'gift_pending', 'gift_accept'] }
          : { balance: '0', receipts: ['purchase', 'gift_pending', 'gift_redirect'] })
        assert.deepEqual(await creditState(postgres.pool, 3), firstAction === 'accept'
          ? { balance: '0', receipts: [] }
          : { balance: '0', receipts: ['gift_pending'] })
      }
    })
  } finally {
    await postgres.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
