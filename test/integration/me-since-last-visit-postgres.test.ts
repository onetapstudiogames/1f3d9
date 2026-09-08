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
const checkpointMigrationDdl = await readFile(
  new URL('../../db/migrations/20260908_me_public_checkpoint.sql', import.meta.url),
  'utf8',
)

process.env.DATABASE_URL = 'postgresql://integration-test.invalid/me-since-last-visit'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
process.env.IDENTITY_RECOVERY_ENABLED = 'false'
process.env.IDENTITY_ROTATION_ENABLED = 'false'
process.env.ECC_SKIP_GIT_HOOKS = '1'
process.env.AGENT_1F3D9_STUB_ONLY = '1'
process.env.AGENT_1F3EA_STUB_ONLY = '1'

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
  attachPayPalOrder,
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

type AroundRecord = Readonly<{
  id: number
  change_id: string
  href: string
  signer?: string
}>

type AroundCategory = Readonly<{
  count: number
  records: readonly AroundRecord[]
  has_more: boolean
  more_href: string | null
}>

type AroundYou = Readonly<{
  after_change_id: string | null
  through_change_id: string
  baseline: boolean
  scope: string
  notes_in_owned_places: AroundCategory
  new_things_in_owned_places: AroundCategory
  new_agreement_signers: AroundCategory
  mentions: AroundCategory
}>

type SinceLastVisit = Readonly<{
  city_updates: Readonly<{ count: number; href: string }>
  fee_credit_received: Readonly<{
    accepted_gifts: Readonly<{ amount: string; amount_units: string; record_link: string }>
    settled_purchases: Readonly<{ amount: string; amount_units: string; record_link: string }>
    pending_gifts: Readonly<{
      count: number
      record_link: string
      items: readonly Readonly<{ accept: string; refuse: string; sentence: string }>[]
    }>
    founder_issues: Readonly<{
      amount: string
      receipts: readonly Readonly<{ reason: string }>[]
    }>
  }>
  last_visit_at: string | null
  around_you: AroundYou
}>

async function readMe(): Promise<SinceLastVisit> {
  const response = await cityApp.request('http://city.test/api/me', { headers: authHeaders() })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return (JSON.parse(text) as { since_last_visit: SinceLastVisit }).since_last_visit
}

type ReadOutcome = Readonly<{ value: SinceLastVisit; error?: never }>
  | Readonly<{ value?: never; error: unknown }>

function trackedRead(pending: Promise<ReadOutcome>[]): Promise<ReadOutcome> {
  const outcome = readMe().then(
    value => ({ value }),
    error => ({ error }),
  )
  pending.push(outcome)
  return outcome
}

async function successfulRead(outcome: Promise<ReadOutcome>): Promise<SinceLastVisit> {
  const settled = await outcome
  if ('error' in settled) throw settled.error
  return settled.value
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
  const pendingReads: Promise<ReadOutcome>[] = []
  try {
    await postgres.client.query(schemaDdl)
    await postgres.client.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES
        (1, 'founder', 'postgres-test', $2),
        (7, 'visit-reader', 'postgres-test', $1),
        (8, 'neighbor', 'postgres-test', $3)
    `, [
      createHash('sha256').update(RESIDENT_SECRET).digest('hex'),
      createHash('sha256').update('founder-integration').digest('hex'),
      createHash('sha256').update('neighbor-integration').digest('hex'),
    ])
    const world = await postgres.client.query<{ id: number }>(`
      SELECT id FROM places WHERE place_kind = 'world' AND parent_id IS NULL
    `)
    assert.equal(world.rows.length, 1, 'the full local schema installs exactly one world row')
    const continent = await postgres.client.query<{ id: number }>(`
      INSERT INTO places (place_kind, parent_id, name, owner_id)
      VALUES ('continent', $1, 'visit continent', 1) RETURNING id
    `, [world.rows[0]!.id])
    const places = await postgres.client.query<{ id: number }>(`
      INSERT INTO places (place_kind, parent_id, name, owner_id)
      VALUES ('place', $1, 'reader room', 7),
        ('place', $1, 'neighbor room', 8),
        ('place', $1, 'later reader room', 8),
        ('place', $1, 'former reader room', 7) RETURNING id
    `, [continent.rows[0]!.id])
    const ownedPlaceId = places.rows[0]!.id
    const foreignPlaceId = places.rows[1]!.id
    const gainedPlaceId = places.rows[2]!.id
    const lostPlaceId = places.rows[3]!.id
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (7, NULL, NULL)
    `)
    await postgres.client.query(`
      INSERT INTO city_credit_last_me_reads (
        resident_id, previous_credit_entry_id, last_credit_entry_id,
        last_public_change_id, read_at
      ) VALUES (7, NULL, 0, NULL, '2026-09-01T12:00:00Z')
    `)
    await postgres.client.query('ALTER TABLE city_credit_last_me_reads DROP COLUMN last_public_change_id CASCADE')
    await postgres.client.query(checkpointMigrationDdl)
    await postgres.client.query(checkpointMigrationDdl)
    const migratedCheckpoint = await postgres.client.query<{ last_public_change_id: string | null }>(`
      SELECT last_public_change_id::text FROM city_credit_last_me_reads WHERE resident_id = 7
    `)
    assert.equal(migratedCheckpoint.rows[0]!.last_public_change_id, null)

    const historicalNote = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, 'visit-reader history predating the new checkpoint') RETURNING id
    `, [ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail)
      VALUES ('note', 'neighbor', jsonb_build_object(
        'note_id', $1::integer, 'place_id', $2::integer
      ))
    `, [historicalNote.rows[0]!.id, ownedPlaceId])

    const firstVisit = await readMe()
    assert.equal(firstVisit.last_visit_at, '2026-09-01T12:00:00.000Z')
    assert.ok(firstVisit.city_updates.count > 0)
    assert.equal(firstVisit.fee_credit_received.settled_purchases.amount, '0.000000')
    assert.equal(firstVisit.around_you.baseline, true)
    assert.equal(firstVisit.around_you.after_change_id, null)
    assert.ok(BigInt(firstVisit.around_you.through_change_id) > 0n)
    assert.equal(firstVisit.around_you.notes_in_owned_places.count, 0)
    assert.equal(firstVisit.around_you.mentions.count, 0)
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

    const interleavedVisitPromise = trackedRead(pendingReads)
    await waitForSnapshotReadToBlock(postgres.client)
    const followingVisitPromise = trackedRead(pendingReads)
    const note = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES ($1, 8, 'hello VISIT-READER, this committed late', '2020-01-01T00:00:00Z')
      RETURNING id
    `, [ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail, at)
      VALUES ('note', 'neighbor', jsonb_build_object(
        'note_id', $1::integer, 'place_id', $2::integer
      ), '2020-01-01T00:00:00Z')
    `, [note.rows[0]!.id, ownedPlaceId])
    const thing = await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, owner_id, maker_id)
      VALUES ($1, 'late lantern', 8, 8) RETURNING id
    `, [ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail, at)
      VALUES ('thing_created', 'neighbor', jsonb_build_object(
        'thing_id', $1::integer, 'place_id', $2::integer
      ), '2020-01-01T00:00:00Z'),
      ('thing_moved', 'neighbor', jsonb_build_object(
        'thing_id', $1::integer, 'place_id', $2::integer, 'mode', 'carry'
      ), '2020-01-01T00:00:00Z')
    `, [thing.rows[0]!.id, ownedPlaceId])
    const crafted = await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, owner_id, maker_id)
      VALUES ($1, 'crafted lantern', 8, 8) RETURNING id
    `, [ownedPlaceId])
    const withdrawn = await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, owner_id, maker_id, withdrawn_at)
      VALUES ($1, 'withdrawn lantern', 8, 8, now()) RETURNING id
    `, [ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail) VALUES
        ('thing_crafted', 'neighbor', jsonb_build_object(
          'thing_id', $1::integer, 'place_id', $3::integer
        )),
        ('thing_created', 'neighbor', jsonb_build_object(
          'thing_id', $2::integer, 'place_id', $3::integer
        ))
    `, [crafted.rows[0]!.id, withdrawn.rows[0]!.id, ownedPlaceId])
    const agreement = await postgres.client.query<{ id: number }>(`
      INSERT INTO agreements (created_by_id, body)
      VALUES (7, 'A late agreement.') RETURNING id
    `)
    await postgres.client.query(
      'INSERT INTO agreement_parties (agreement_id, resident_id) VALUES ($1, 7), ($1, 8)',
      [agreement.rows[0]!.id],
    )
    await postgres.client.query(
      'INSERT INTO agreement_signatures (agreement_id, resident_id) VALUES ($1, 7), ($1, 8)',
      [agreement.rows[0]!.id],
    )
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail, at)
      VALUES ('agreement_sign', 'visit-reader', jsonb_build_object('agreement_id', $1::integer),
        '2020-01-01T00:00:00Z'),
      ('agreement_sign', 'neighbor', jsonb_build_object('agreement_id', $1::integer),
        '2020-01-01T00:00:00Z')
    `, [agreement.rows[0]!.id])
    for (let index = 1; index < 12; index += 1) {
      const extra = await postgres.client.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES ($1, 8, $2) RETURNING id
      `, [ownedPlaceId, `@visit-reader bounded mention ${index}`])
      await postgres.client.query(`
        INSERT INTO events (kind, actor, detail)
        VALUES ('note', 'neighbor', jsonb_build_object(
          'note_id', $1::integer, 'place_id', $2::integer
        ))
      `, [extra.rows[0]!.id, ownedPlaceId])
    }
    const substring = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, 'visit-reader-extra is not an exact handle mention') RETURNING id
    `, [foreignPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail)
      VALUES ('note', 'neighbor', jsonb_build_object(
        'note_id', $1::integer, 'place_id', $2::integer
      ))
    `, [substring.rows[0]!.id, foreignPlaceId])
    const removed = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, 'visit-reader removed note') RETURNING id
    `, [ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail)
      VALUES ('note', 'neighbor', jsonb_build_object(
        'note_id', $1::integer, 'place_id', $2::integer
      ))
    `, [removed.rows[0]!.id, ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
      VALUES ('note', $1, 'remove', 1, 'integration exclusion')
    `, [removed.rows[0]!.id])
    const unsafe = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, $2) RETURNING id
    `, [ownedPlaceId, `visit-reader ${`1f3d9_sk_${'q'.repeat(48)}`}`])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail)
      VALUES ('note', 'neighbor', jsonb_build_object(
        'note_id', $1::integer, 'place_id', $2::integer
      ))
    `, [unsafe.rows[0]!.id, ownedPlaceId])
    const gainedNote = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, 'visit-reader gained this room later') RETURNING id
    `, [gainedPlaceId])
    const lostNote = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, 'visit-reader no longer owns this room') RETURNING id
    `, [lostPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail) VALUES
        ('note', 'neighbor', jsonb_build_object(
          'note_id', $1::integer, 'place_id', $3::integer
        )),
        ('note', 'neighbor', jsonb_build_object(
          'note_id', $2::integer, 'place_id', $4::integer
        ))
    `, [gainedNote.rows[0]!.id, lostNote.rows[0]!.id, gainedPlaceId, lostPlaceId])
    await postgres.client.query('UPDATE places SET owner_id = 7 WHERE id = $1', [gainedPlaceId])
    await postgres.client.query('UPDATE places SET owner_id = 8 WHERE id = $1', [lostPlaceId])
    const restored = await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES ($1, 8, 'visit-reader restored note') RETURNING id
    `, [ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail)
      VALUES ('note', 'neighbor', jsonb_build_object(
        'note_id', $1::integer, 'place_id', $2::integer
      ))
    `, [restored.rows[0]!.id, ownedPlaceId])
    await postgres.client.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
      VALUES ('note', $1, 'remove', 1, 'temporary integration exclusion'),
        ('note', $1, 'restore', 1, 'integration restoration')
    `, [restored.rows[0]!.id])
    await postgres.client.query(`
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, founder_id, source_key, reason
      ) VALUES (7, 'founder_issue', 1000000, 1,
        'integration:founder:late', 'Showing room prize')
    `)
    // The real delivery writes the gift, purchase, pending-arrival receipt,
    // and verified-event binding atomically, as the deferred triggers require.
    const giftIntent = await beginPayPalCreditIntent(sql, {
      requestId: 'snapshot-gift-0001',
      intentKind: 'order',
      delivery: 'gift',
      recipientId: 7,
      amountUnits: 1_000_000n,
      paypalEnvironment: 'sandbox',
    })
    const giftOrder = await attachPayPalOrder(sql, {
      purchaseId: giftIntent.purchaseId,
      orderId: 'SNAPSHOT-GIFT-ORDER-0001',
    })
    const pendingGift = await deliverPayPalCredit(sql, {
      intent: Object.freeze({
        ...giftIntent,
        remoteOrderId: giftOrder.orderId,
        status: giftOrder.status,
      }),
      sourceKey: 'paypal:capture:SNAPSHOT-GIFT-CAPTURE-0001',
      purchaseKind: 'paypal',
      eventId: 'SNAPSHOT-GIFT-EVENT-0001',
      eventKind: 'PAYMENT.CAPTURE.COMPLETED',
      remoteResourceId: 'SNAPSHOT-GIFT-CAPTURE-0001',
    })
    assert.equal(pendingGift.disposition, 'created')
    assert.equal(pendingGift.status, 'pending')
    assert.match(String(pendingGift.gift_id), /^city_gift_[0-9a-f]{32}$/u)
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

    const interleavedVisit = await successfulRead(interleavedVisitPromise)
    assert.equal(interleavedVisit.last_visit_at, baselineReadAt)
    assert.equal(interleavedVisit.fee_credit_received.settled_purchases.amount, '0.000000')
    assert.equal(interleavedVisit.around_you.notes_in_owned_places.count, 0)
    assert.equal(interleavedVisit.fee_credit_received.founder_issues.amount, '0.000000')
    const nextVisit = await successfulRead(followingVisitPromise)
    assert.notEqual(nextVisit.last_visit_at, baselineReadAt)
    assert.equal(nextVisit.fee_credit_received.settled_purchases.amount, '2.000000')
    assert.equal(nextVisit.fee_credit_received.settled_purchases.amount_units, '2000000')
    assert.equal(nextVisit.fee_credit_received.founder_issues.amount, '1.000000')
    assert.equal(nextVisit.fee_credit_received.founder_issues.receipts[0]?.reason, 'Showing room prize')
    assert.equal(nextVisit.fee_credit_received.pending_gifts.count, 1)
    assert.equal(
      nextVisit.fee_credit_received.pending_gifts.items[0]?.accept,
      `POST /api/city-credit/gifts/${pendingGift.gift_id}/accept`,
    )
    assert.equal(
      nextVisit.fee_credit_received.pending_gifts.items[0]?.refuse,
      `POST /api/city-credit/gifts/${pendingGift.gift_id}/refuse`,
    )
    assert.match(nextVisit.fee_credit_received.pending_gifts.items[0]?.sentence ?? '', /A human bought you/iu)
    assert.equal(nextVisit.around_you.notes_in_owned_places.count, 15)
    assert.equal(nextVisit.around_you.notes_in_owned_places.records.length, 10)
    assert.equal(nextVisit.around_you.notes_in_owned_places.has_more, true)
    assert.match(nextVisit.around_you.notes_in_owned_places.more_href ?? '', /^\/api\/changes\?since=\d+&limit=200$/u)
    // Gained and lost places both count here: mentions are city-wide.
    assert.equal(nextVisit.around_you.mentions.count, 15)
    assert.equal(nextVisit.around_you.new_things_in_owned_places.count, 2)
    assert.equal(nextVisit.around_you.new_things_in_owned_places.records[0]?.href, `/api/thing/${thing.rows[0]!.id}`)
    assert.equal(nextVisit.around_you.new_agreement_signers.count, 1)
    assert.equal(nextVisit.around_you.new_agreement_signers.records[0]?.signer, 'neighbor')
    assert.equal(
      nextVisit.around_you.new_agreement_signers.records[0]?.href,
      `/api/agreements?before_id=${agreement.rows[0]!.id + 1}&limit=1`,
    )
    assert.equal(nextVisit.around_you.notes_in_owned_places.records[0]?.id, note.rows[0]!.id)
    assert.equal(nextVisit.around_you.notes_in_owned_places.records[0]?.href, `/api/note/${note.rows[0]!.id}`)
    assert.equal(nextVisit.around_you.after_change_id, firstVisit.around_you.through_change_id)
    for (const href of [
      nextVisit.around_you.notes_in_owned_places.records[0]!.href,
      nextVisit.around_you.new_things_in_owned_places.records[0]!.href,
      nextVisit.around_you.new_agreement_signers.records[0]!.href,
      nextVisit.around_you.notes_in_owned_places.more_href!,
    ]) {
      const linkedRecord = await cityApp.request(`http://city.test${href}`)
      assert.equal(linkedRecord.status, 200, await linkedRecord.text())
    }
    const noReplay = await readMe()
    assert.equal(noReplay.around_you.notes_in_owned_places.count, 0)
    assert.equal(noReplay.around_you.mentions.count, 0)
    assert.equal(noReplay.around_you.new_things_in_owned_places.count, 0)
    assert.equal(noReplay.around_you.new_agreement_signers.count, 0)
    assert.equal(noReplay.fee_credit_received.founder_issues.amount, '0.000000')
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
    await Promise.all(pendingReads)
    setEngineTransactionRunnerForTests(null)
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  }
})
