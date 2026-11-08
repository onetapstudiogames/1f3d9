// Thing endings and snapshot format 4, against real PostgreSQL 17: the migration leaves
// every earlier city_snapshot view, the shared base views included, exactly as it was,
// format v3 reads the same records byte for byte before and after, and v4 is installed
// with its grant to the export role only, the same as a fresh db/schema.sql.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import { canonicalJson } from '../../src/public-snapshot-format.ts'
import {
  connectedDatabase,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20261106_thing_endings.sql', import.meta.url),
  'utf8',
)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const SECTION_MARKER = '\n-- Thing endings, the same statements as\n'
const NEXT_SECTION_MARKER = '\n-- Stored public activity summaries, decision #166.\n'

/** The city's schema as it is before this migration: db/schema.sql with its section removed. */
function schemaBeforeThingEndings(): string {
  const start = schemaDdl.indexOf(SECTION_MARKER)
  const end = schemaDdl.indexOf(NEXT_SECTION_MARKER, start)
  assert.ok(start > 0 && end > start, 'one thing endings section before the stored public activity section')
  const before = schemaDdl.slice(0, start) + schemaDdl.slice(end)
  assert.doesNotMatch(before, /public_records_v4|thing_end_due_from|thing_end_try_blocked_by/u)
  return before
}

/** Start again from an empty database. A fresh database lets everyone use the public schema. */
async function resetTo(db: Pool, ddl: string): Promise<void> {
  await db.query(`
    DROP SCHEMA IF EXISTS city_snapshot CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO PUBLIC
  `)
  await db.query(ddl)
}

/** A small city with a thing, labels, a kind, an agreement, a world offer and events. */
async function seedCity(db: Pool): Promise<void> {
  await db.query(`
    INSERT INTO residents (id, handle, model, secret_hash, joined_at) VALUES
      (1, 'snapshot-founder', 'v4', repeat('1', 64), '2026-01-01T00:00:00Z'),
      (2, 'snapshot-maker', 'v4', repeat('2', 64), '2026-01-02T00:00:00Z')
  `)
  await db.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
  const worldId = Number((await db.query(`SELECT id FROM places WHERE place_kind = 'world'`)).rows[0]!.id)
  const roomId = Number((await db.query(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Snapshot Land', 'v4 land', 1) RETURNING id
  `, [worldId])).rows[0]!.id)
  const kindId = Number((await db.query(`INSERT INTO kinds (name, owner_id) VALUES ('snap-lamp', 2) RETURNING id`)).rows[0]!.id)
  await db.query('INSERT INTO kind_revisions (kind_id, revision, description) VALUES ($1, 1, $2)', [kindId, 'a lamp'])
  await db.query(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('kind_invented', 'snapshot-maker', jsonb_build_object('kind_id', $1::integer), '2026-02-01T00:00:00Z')
  `, [kindId])
  const thingIds: number[] = []
  for (const name of ['first lamp', 'second lamp']) {
    thingIds.push(Number((await db.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision)
      VALUES ($1, $2, 'a body', 2, 2, $3, 1, 1) RETURNING id
    `, [roomId, name, kindId])).rows[0]!.id))
  }
  await db.query(`INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'warm', 2)`, [thingIds[0]])
  const agreementId = Number((await db.query(`INSERT INTO agreements (created_by_id, body) VALUES (2, 'a promise') RETURNING id`)).rows[0]!.id)
  await db.query('INSERT INTO agreement_parties (agreement_id, resident_id) VALUES ($1, 2)', [agreementId])
  const offerId = Number((await db.query(`
    INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, price_usdc, seller_wallet, market_origin, market_draft_id)
    VALUES ('world', 'thing', $1, 2, 1.000000, $2, 'https://1f3ea.com', 77) RETURNING id
  `, [thingIds[1], `0x${'3b'.repeat(20)}`])).rows[0]!.id)
  await db.query('UPDATE things SET active_offer_id = $1 WHERE id = $2', [offerId, thingIds[1]])
  await db.query(`INSERT INTO events (kind, actor, detail) VALUES ('thing_created', 'snapshot-maker', jsonb_build_object('thing_id', $1::integer))`, [thingIds[0]])
}

/** The definition of every city_snapshot view by name, v4 aside. */
async function viewHashes(db: Pool): Promise<Record<string, string>> {
  const rows = (await db.query<{ name: string; definition: string; options: string | null; acl: string | null }>(`
    SELECT relation.relname AS name, pg_get_viewdef(relation.oid) AS definition,
      array_to_string(relation.reloptions, ',') AS options, relation.relacl::text AS acl
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'city_snapshot' AND relation.relkind IN ('v', 'm')
      AND relation.relname <> 'public_records_v4'
    ORDER BY relation.relname
  `)).rows
  return Object.fromEntries(rows.map(row => [
    row.name,
    createHash('sha256').update(`${row.definition}\n${row.options}\n${row.acl}`).digest('hex'),
  ]))
}

/** Every v3 record as the export role reads it in one repeatable-read snapshot, as canonical bytes. */
async function v3Bytes(db: Pool): Promise<string> {
  const client = await db.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL TIME ZONE 'UTC'")
    await client.query('SET LOCAL ROLE city_snapshot_export')
    const rows = (await client.query(`
      SELECT class_name, record_id, sort_key::text AS sort_key, payload
      FROM city_snapshot.public_records_v3
      ORDER BY class_name COLLATE "C", sort_key, record_id COLLATE "C"
    `)).rows
    await client.query('ROLLBACK')
    // A thing read carries no clock-dependent field in v3, so two reads of the same rows match.
    return rows.map(row => canonicalJson(row)).join('\n')
  } finally {
    client.release()
  }
}

async function v4Shape(db: Pool): Promise<Record<string, unknown>> {
  return (await db.query(`
    SELECT
      to_regclass('city_snapshot.public_records_v4') IS NOT NULL AS present,
      (SELECT array_to_string(reloptions, ',') FROM pg_class WHERE oid = to_regclass('city_snapshot.public_records_v4')) AS options,
      has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v4', 'SELECT') AS export_reads_v4,
      has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v3', 'SELECT') AS export_reads_v3,
      has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT') AS export_reads_v2,
      has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v4', 'INSERT,UPDATE,DELETE,TRUNCATE') AS export_writes_v4,
      (SELECT count(*)::int FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass('city_snapshot.public_records_v4'))) acl
        WHERE acl.grantee = 0) AS public_grants,
      (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
        WHERE table_schema = 'city_snapshot' AND table_name = 'public_records_v4') AS columns,
      (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_end_due_from(boolean, timestamptz, timestamptz, integer, timestamptz, timestamptz)')) AS due_from_volatility,
      (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_end_try_blocked_by(boolean, boolean, boolean, boolean, integer, integer, integer, boolean, integer[], integer[], integer[])')) AS gates_volatility
  `)).rows[0]!
}

const EXPECTED_V4_SHAPE = {
  present: true,
  options: 'security_barrier=true',
  export_reads_v4: true,
  export_reads_v3: true,
  export_reads_v2: true,
  export_writes_v4: false,
  public_grants: 0,
  columns: ['class_name', 'record_id', 'sort_key', 'payload'],
  due_from_volatility: 's',
  gates_volatility: 'i',
}

test('thing endings install snapshot format 4 and leave every earlier view as it was', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-snapshot')
  try {
    const db = connectedDatabase()
    let migratedDefinition = ''

    await t.test('the migration changes no earlier view and no v3 byte, and adds v4 for the export role only', async () => {
      await resetTo(db, schemaBeforeThingEndings())
      await seedCity(db)
      const hashesBefore = await viewHashes(db)
      assert.ok(Object.keys(hashesBefore).length >= 4, 'v1 base, its private input, v2 and v3 are hashed')
      assert.deepEqual((await db.query(`SELECT to_regclass('city_snapshot.public_records_v4') AS v4`)).rows, [{ v4: null }])
      const bytesBefore = await v3Bytes(db)
      await db.query(migrationDdl)
      assert.deepEqual(await viewHashes(db), hashesBefore)
      assert.equal(await v3Bytes(db), bytesBefore)
      assert.deepEqual(await v4Shape(db), EXPECTED_V4_SHAPE)
      await db.query(migrationDdl)
      assert.deepEqual(await viewHashes(db), hashesBefore, 'a second run changes nothing either')
      assert.equal(await v3Bytes(db), bytesBefore)
      assert.deepEqual(await v4Shape(db), EXPECTED_V4_SHAPE)
      migratedDefinition = String((await db.query(
        `SELECT pg_get_viewdef('city_snapshot.public_records_v4'::regclass) AS definition`,
      )).rows[0]!.definition)
    })

    await t.test('the export role reads v4 directly, and v4 reads only through its own joins', async () => {
      const client = await db.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query('SET LOCAL ROLE city_snapshot_export')
        const counts = (await client.query(`
          SELECT class_name, count(*)::int AS records FROM city_snapshot.public_records_v4
          WHERE class_name IN ('things', 'kinds', 'agreements', 'world_market_offers', 'events')
          GROUP BY class_name ORDER BY class_name
        `)).rows
        assert.deepEqual(counts.map(row => row.class_name), ['agreements', 'events', 'kinds', 'things', 'world_market_offers'])
        await assert.rejects(client.query('SELECT thing_end_due_at(1)'), /permission denied/u,
          'the id form of the due rule reads a table the export role may not read')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    await t.test('a fresh db/schema.sql installs the same v4 with the same grant', async () => {
      await resetTo(db, schemaDdl)
      assert.deepEqual(await v4Shape(db), EXPECTED_V4_SHAPE)
      assert.equal(String((await db.query(
        `SELECT pg_get_viewdef('city_snapshot.public_records_v4'::regclass) AS definition`,
      )).rows[0]!.definition), migratedDefinition)
    })
  } finally {
    await postgres.stop()
  }
})
