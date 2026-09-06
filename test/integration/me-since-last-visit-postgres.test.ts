import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'me_since_last_visit_integration'
const RESIDENT_SECRET = `1f3d9_sk_${'v'.repeat(48)}`
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

process.env.DATABASE_URL = 'postgresql://integration-test.invalid/me-since-last-visit'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
process.env.IDENTITY_RECOVERY_ENABLED = 'false'
process.env.IDENTITY_ROTATION_ENABLED = 'false'

interface QueryStatement {
  readonly text: string
  readonly values: readonly unknown[]
}

interface TestTaggedSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>
  query: (text: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>
  transaction: (
    build: (transaction: { query: (text: string, values?: readonly unknown[]) => QueryStatement }) => readonly QueryStatement[],
    options?: Readonly<{ readOnly?: boolean }>,
  ) => Promise<Record<string, unknown>[][]>
}

let database: Pool | null = null

function connectedDatabase(): Pool {
  assert.ok(database, 'the since-last-visit PostgreSQL client must be connected')
  return database
}

function sqlText(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
}

function taggedFor(queryable: Pool | PoolClient) {
  const tagged = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record<string, unknown>[]> => (
    await queryable.query(sqlText(strings, values), values)
  ).rows as Record<string, unknown>[]
  tagged.query = async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => (
    await queryable.query(text, [...values])
  ).rows as Record<string, unknown>[]
  return tagged
}

const sql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => (
    taggedFor(connectedDatabase())(strings, ...values)
  ),
  {
    query: async (text: string, values: readonly unknown[] = []) => (
      taggedFor(connectedDatabase()).query(text, values)
    ),
    transaction: async (
      build: (transaction: { query: (text: string, values?: readonly unknown[]) => QueryStatement }) => readonly QueryStatement[],
      options: Readonly<{ readOnly?: boolean }> = {},
    ) => {
      const transaction = {
        query: (text: string, values: readonly unknown[] = []): QueryStatement => ({ text, values }),
      }
      const statements = build(transaction)
      const client = await connectedDatabase().connect()
      try {
        await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
        const results: Record<string, unknown>[][] = []
        for (const statement of statements) {
          results.push((await client.query(statement.text, [...statement.values])).rows)
        }
        await client.query('COMMIT')
        return results
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  },
) as TestTaggedSql

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/me-since-last-visit',
  },
})

const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
const { default: cityApp } = await import('../../src/index.ts')
const { deliverPayPalCredit } = await import('../../src/paypal-credit-delivery.ts')
const {
  attachPayPalSubscription,
  beginPayPalCreditIntent,
} = await import('../../src/paypal-credit-store.ts')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-me-visit-${process.pid}-${randomBytes(4).toString('hex')}`
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
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
    throw error
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${RESIDENT_SECRET}` }
}

type SinceLastVisit = Readonly<{
  city_updates: Readonly<{ count: number; href: string }>
  fee_credit_received: Readonly<{
    accepted_gifts: Readonly<{ amount: string; amount_units: string; record_link: string }>
    settled_purchases: Readonly<{ amount: string; amount_units: string; record_link: string }>
    pending_gifts: Readonly<{ count: number; record_link: string }>
  }>
  last_visit_at: string | null
}>

async function readMe(): Promise<SinceLastVisit> {
  const response = await cityApp.request('http://city.test/api/me', { headers: authHeaders() })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return (JSON.parse(text) as { since_last_visit: SinceLastVisit }).since_last_visit
}

async function waitForSnapshotReadToBlock(client: Pool): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = await client.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE query LIKE '%city-credit:read-attention%'
          AND wait_event_type = 'Lock'
      ) AS blocked
    `)
    if (waiting.rows[0]?.blocked) return
    await delay(20)
  }
  assert.fail('the marker update did not reach the controlled advisory lock')
}

test('the prior visit marker and received-credit counts use one PostgreSQL snapshot', async () => {
  const postgres = await startPostgres()
  database = postgres.client
  setEngineTransactionRunnerForTests(async (_db, work) => {
    const client = await connectedDatabase().connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  let blocker: PoolClient | null = null
  try {
    await postgres.client.query(schemaDdl)
    await postgres.client.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (7, 'visit-reader', 'postgres-test', $1)
    `, [createHash('sha256').update(RESIDENT_SECRET).digest('hex')])
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (7, NULL, NULL)
    `)

    const firstVisit = await readMe()
    assert.equal(firstVisit.last_visit_at, null)
    assert.equal(firstVisit.city_updates.count, 0)
    assert.equal(firstVisit.fee_credit_received.settled_purchases.amount, '0.000000')
    const baselineMarker = await postgres.client.query<{ read_at: Date }>(`
      SELECT read_at FROM city_credit_last_me_reads WHERE resident_id = 7
    `)
    const baselineReadAt = baselineMarker.rows[0]!.read_at.toISOString()

    await postgres.client.query(`
      CREATE FUNCTION pause_me_marker_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(234, 1);
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER pause_me_marker_update
      BEFORE UPDATE ON city_credit_last_me_reads
      FOR EACH ROW EXECUTE FUNCTION pause_me_marker_update();
    `)
    blocker = await postgres.client.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(234, 1)')

    const interleavedVisitPromise = readMe()
    await waitForSnapshotReadToBlock(postgres.client)
    const intent = await beginPayPalCreditIntent(sql, {
      requestId: 'snapshot-purchase-0001',
      intentKind: 'allowance',
      delivery: 'self',
      recipientId: 7,
      amountUnits: 2_000_000n,
      paypalEnvironment: 'sandbox',
    })
    const subscription = await attachPayPalSubscription(sql, {
      purchaseId: intent.purchaseId,
      subscriptionId: 'SNAPSHOT-SUBSCRIPTION-0001',
    })
    const purchase = await deliverPayPalCredit(sql, {
      intent: Object.freeze({
        ...intent,
        remoteSubscriptionId: subscription.subscriptionId,
        status: subscription.status,
      }),
      sourceKey: 'paypal:sale:SNAPSHOT-SALE-0001',
      purchaseKind: 'allowance',
      eventId: 'SNAPSHOT-EVENT-0001',
      eventKind: 'PAYMENT.SALE.COMPLETED',
      remoteResourceId: 'SNAPSHOT-SALE-0001',
    })
    await blocker.query('COMMIT')
    blocker.release()
    blocker = null

    const interleavedVisit = await interleavedVisitPromise
    assert.equal(interleavedVisit.last_visit_at, baselineReadAt)
    assert.equal(interleavedVisit.fee_credit_received.settled_purchases.amount, '0.000000')
    const interleavedMarker = await postgres.client.query<{
      last_credit_entry_id: string
      read_at: Date
    }>(`
      SELECT last_credit_entry_id::text, read_at
      FROM city_credit_last_me_reads WHERE resident_id = 7
    `)
    assert.equal(interleavedMarker.rows[0]!.last_credit_entry_id, '0')

    const nextVisit = await readMe()
    assert.equal(nextVisit.last_visit_at, interleavedMarker.rows[0]!.read_at.toISOString())
    assert.equal(nextVisit.fee_credit_received.settled_purchases.amount, '2.000000')
    assert.equal(nextVisit.fee_credit_received.settled_purchases.amount_units, '2000000')
    const finalMarker = await postgres.client.query<{ last_credit_entry_id: string }>(`
      SELECT last_credit_entry_id::text
      FROM city_credit_last_me_reads WHERE resident_id = 7
    `)
    assert.equal(finalMarker.rows[0]!.last_credit_entry_id, purchase.receipt_id)
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
    setEngineTransactionRunnerForTests(null)
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  }
})
