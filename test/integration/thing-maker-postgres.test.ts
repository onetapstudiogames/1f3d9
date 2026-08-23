import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'thing_maker_integration'
const MIGRATION_URL = new URL('../../db/migrations/20260822_thing_maker.sql', import.meta.url)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-thing-maker-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
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

async function resetFresh(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA IF EXISTS city_snapshot CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
}

async function resetLegacy(database: Pool): Promise<void> {
  await resetFresh(database)
  await database.query(`
    DROP SCHEMA IF EXISTS city_snapshot CASCADE;
    DROP TRIGGER IF EXISTS things_set_maker_on_insert ON things;
    DROP FUNCTION IF EXISTS set_thing_maker_on_insert();
    DROP TRIGGER IF EXISTS things_keep_birth_history ON things;
    ALTER TABLE things DROP COLUMN maker_id;
    CREATE OR REPLACE FUNCTION protect_thing_history() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'things are retained as history; set withdrawn_at instead'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.kind_id IS DISTINCT FROM OLD.kind_id
        OR NEW.birth_revision IS DISTINCT FROM OLD.birth_revision
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'a thing birth revision is immutable' USING ERRCODE = '55000';
      END IF;
      IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'a withdrawn thing is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.withdrawn_at IS NOT NULL AND NEW.withdrawn_at < NEW.created_at THEN
        RAISE EXCEPTION 'withdrawn_at cannot predate creation' USING ERRCODE = '22007';
      END IF;
      RETURN NEW;
    END
    $function$;
    CREATE TRIGGER things_keep_birth_history BEFORE UPDATE OR DELETE ON things
      FOR EACH ROW EXECUTE FUNCTION protect_thing_history();
  `)
}

async function seedResidentsAndPlace(database: Pool): Promise<number> {
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash, joined_at) VALUES
      (1, 'maker-one', 'thing-maker-test', repeat('1', 64), '2026-08-19T00:00:00Z'),
      (2, 'owner-two', 'thing-maker-test', repeat('2', 64), '2026-08-19T00:00:00Z')
  `)
  const worldId = Number((await database.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  const continentId = Number((await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'continent', 'Maker Test Continent', 1)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  return Number((await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'place', 'Maker Test Room', 1)
    RETURNING id
  `, [continentId])).rows[0]!.id)
}

async function seedLegacyThing(
  database: Pool,
  placeId: number,
  options: Readonly<{
    id?: number
    actor?: string | null
    eventKind?: 'thing_created' | 'thing_crafted'
    eventOffset?: string
    duplicate?: boolean
    mismatchedDetail?: boolean
  }> = {},
): Promise<number> {
  const id = options.id ?? 7
  await database.query(`
    INSERT INTO things (id, place_id, name, body, owner_id, created_at)
    VALUES ($1, $2, 'legacy thing', repeat(chr(109), 37), 2, '2026-08-20T12:00:00Z')
  `, [id, placeId])
  if (options.actor === null) return id

  const kind = options.eventKind ?? 'thing_created'
  const actor = options.actor ?? 'maker-one'
  const eventOffset = options.eventOffset ?? '0 seconds'
  const detail = options.mismatchedDetail
    ? `jsonb_build_object('thing_id', $1::integer, 'place_id', $2::integer, 'name', 'legacy thing',
        'kind_id', 99, 'birth_revision', 1)`
    : `jsonb_build_object('thing_id', $1::integer, 'place_id', $2::integer, 'name', 'legacy thing',
        'kind_id', NULL, 'birth_revision', NULL)`
  const insertEvent = `
    INSERT INTO events (at, kind, actor, detail)
    VALUES ('2026-08-20T12:00:00Z'::timestamptz + $3::interval, $4::text, $5::text, ${detail})
  `
  await database.query(insertEvent, [id, placeId, eventOffset, kind, actor])
  if (options.duplicate === true) {
    await database.query(insertEvent, [id, placeId, eventOffset, kind, actor])
  }
  return id
}

async function applyExpectedFailure(
  database: Pool,
  migrationDdl: string,
  expectedColumnPresent = false,
  expectedMessageFragment?: string,
): Promise<void> {
  const connection: PoolClient = await database.connect()
  let rejectionMessage = ''
  try {
    await assert.rejects(
      connection.query(migrationDdl),
      error => {
        rejectionMessage = String(error)
        return postgresCode(error) === '23514' && /thing maker history/iu.test(rejectionMessage)
      },
    )
  } finally {
    await connection.query('ROLLBACK').catch(() => undefined)
    connection.release()
  }
  const column = await database.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'things' AND column_name = 'maker_id'
    ) AS present
  `)
  assert.equal(
    column.rows[0]!.present,
    expectedColumnPresent,
    'failed history validation must roll back every schema change',
  )
  if (expectedMessageFragment !== undefined) {
    assert.match(rejectionMessage, new RegExp(`\\b${expectedMessageFragment}\\b`, 'u'))
  }
}

test('thing maker survives transfer and upgrades only from authenticated creation history', {
  timeout: 120_000,
}, async t => {
  assert.equal(
    existsSync(MIGRATION_URL),
    true,
    'add db/migrations/20260822_thing_maker.sql before running the PostgreSQL gate',
  )
  const migrationDdl = await readFile(MIGRATION_URL, 'utf8')
  const postgres = await startPostgres()
  try {
    await t.test('fresh inserts default only an omitted maker and freeze it after transfer', async () => {
      await resetFresh(postgres.client)
      const placeId = await seedResidentsAndPlace(postgres.client)
      const inserted = await postgres.client.query<{ id: number; maker_id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id)
        VALUES ($1, 'rollout thing', repeat(chr(114), 41), 1)
        RETURNING id, maker_id
      `, [placeId])
      assert.equal(inserted.rows[0]!.maker_id, 1)
      await assert.rejects(
        postgres.client.query(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, 'false maker', '', 1, 2)
        `, [placeId]),
        error => postgresCode(error) === '23514',
      )

      await postgres.client.query('UPDATE things SET owner_id = 2 WHERE id = $1', [inserted.rows[0]!.id])
      const transferred = await postgres.client.query<{ owner_id: number; maker_id: number }>(
        'SELECT owner_id, maker_id FROM things WHERE id = $1',
        [inserted.rows[0]!.id],
      )
      assert.deepEqual(transferred.rows[0], { owner_id: 2, maker_id: 1 })
      await assert.rejects(
        postgres.client.query('UPDATE things SET maker_id = 2 WHERE id = $1', [inserted.rows[0]!.id]),
        error => postgresCode(error) === '55000',
      )
    })

    await t.test('the full loopback schema upgrades and reapplies over legacy thing history', async () => {
      await resetLegacy(postgres.client)
      const placeId = await seedResidentsAndPlace(postgres.client)
      await seedLegacyThing(postgres.client, placeId)

      await postgres.client.query(schemaDdl)
      await postgres.client.query(schemaDdl)

      const thing = await postgres.client.query<{
        maker_id: number
        owner_id: number
        maker_required: boolean
      }>(`
        SELECT thing.maker_id, thing.owner_id,
          column_record.is_nullable = 'NO' AS maker_required
        FROM things AS thing
        CROSS JOIN information_schema.columns AS column_record
        WHERE thing.id = 7
          AND column_record.table_schema = 'public'
          AND column_record.table_name = 'things'
          AND column_record.column_name = 'maker_id'
      `)
      assert.deepEqual(thing.rows[0], { maker_id: 1, owner_id: 2, maker_required: true })
    })

    await t.test('upgrade is repeatable and preserves #31/#34-38 bytes, ownership, and withdrawal', async () => {
      await resetLegacy(postgres.client)
      const placeId = await seedResidentsAndPlace(postgres.client)
      await postgres.client.query(`
        INSERT INTO kinds (id, name, owner_id) VALUES (1, 'maker-test-kind', 1);
        INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
        VALUES (1, 1, '', '{}', '[]'::jsonb);
      `)
      await postgres.client.query(`
        WITH protected_ids(id) AS (
          VALUES (31), (34), (35), (36), (37), (38)
        )
        INSERT INTO things (id, place_id, name, body, owner_id, created_at)
        SELECT id, $1, 'archive-' || id,
          repeat(chr(97 + id % 20), 29 + id) || convert_from(decode('f09f8f99', 'hex'), 'UTF8'),
          2,
          '2026-08-20T12:00:00Z'::timestamptz + id * interval '1 second'
        FROM protected_ids
      `, [placeId])
      await postgres.client.query(`
        INSERT INTO things (
          id, place_id, name, body, owner_id,
          kind_id, birth_revision, current_revision, created_at, withdrawn_at
        ) VALUES (
          39, $1, 'withdrawn-crafted-archive', repeat(chr(119), 68), 2,
          1, 1, 1, '2026-08-20T12:00:39Z', '2026-08-21T12:00:39Z'
        )
      `, [placeId])
      await postgres.client.query(`
        INSERT INTO events (at, kind, actor, detail)
        SELECT thing.created_at, 'thing_created', 'maker-one', jsonb_build_object(
          'thing_id', thing.id,
          'place_id', thing.place_id,
          'name', thing.name,
          'kind_id', thing.kind_id,
          'birth_revision', thing.birth_revision
        )
        FROM things AS thing
        WHERE thing.id IN (31, 34, 35, 36, 37, 38)
      `)
      await postgres.client.query(`
        INSERT INTO events (at, kind, actor, detail)
        SELECT thing.created_at, 'thing_crafted', 'maker-one', jsonb_build_object(
          'thing_id', thing.id,
          'place_id', thing.place_id,
          'kind_id', thing.kind_id,
          'birth_revision', thing.birth_revision,
          'ingredient_ids', jsonb_build_array(31)
        )
        FROM things AS thing
        WHERE thing.id = 39
      `)
      const fingerprintSql = `
        SELECT id, md5(name) AS name_hash, md5(body) AS body_hash,
          octet_length(name)::integer AS name_bytes,
          octet_length(body)::integer AS body_bytes,
          place_id, owner_id, kind_id, birth_revision, current_revision,
          created_at::text, withdrawn_at::text
        FROM things
        WHERE id IN (31, 34, 35, 36, 37, 38)
        ORDER BY id
      `
      const before = (await postgres.client.query(fingerprintSql)).rows

      await postgres.client.query(migrationDdl)
      await postgres.client.query(migrationDdl)

      const after = (await postgres.client.query(fingerprintSql)).rows
      assert.deepEqual(after, before, 'maker migration changed protected thing bytes or lifecycle state')
      assert.ok(after.every(row => row.withdrawn_at === null), '#31/#34-38 must all remain active')
      const makers = await postgres.client.query<{ id: number; maker_id: number }>(`
        SELECT id, maker_id FROM things
        WHERE id IN (31, 34, 35, 36, 37, 38, 39)
        ORDER BY id
      `)
      assert.deepEqual(makers.rows, [31, 34, 35, 36, 37, 38, 39].map(id => ({ id, maker_id: 1 })))
      const withdrawn = await postgres.client.query<{ withdrawn: boolean }>(
        'SELECT withdrawn_at IS NOT NULL AS withdrawn FROM things WHERE id = 39',
      )
      assert.equal(withdrawn.rows[0]!.withdrawn, true, 'withdrawn history must also backfill safely')
    })

    await t.test('upgrade rolls back missing, duplicate, unknown, mismatched, or forged history', async () => {
      const cases = [
        { label: 'missing', options: { actor: null } },
        { label: 'duplicate', options: { duplicate: true } },
        { label: 'unknown actor', options: { actor: 'unknown-maker' } },
        { label: 'timestamp mismatch', options: { eventOffset: '1 microsecond' } },
        { label: 'birth-detail mismatch', options: { mismatchedDetail: true } },
      ] as const
      for (const historyCase of cases) {
        await resetLegacy(postgres.client)
        const placeId = await seedResidentsAndPlace(postgres.client)
        await seedLegacyThing(postgres.client, placeId, historyCase.options)
        await applyExpectedFailure(postgres.client, migrationDdl)
      }

      await resetLegacy(postgres.client)
      const lateResidentPlaceId = await seedResidentsAndPlace(postgres.client)
      await seedLegacyThing(postgres.client, lateResidentPlaceId)
      await postgres.client.query(`
        UPDATE residents
        SET joined_at = '2026-08-21T00:00:00Z'
        WHERE id = 1
      `)
      await applyExpectedFailure(postgres.client, migrationDdl)

      for (const orphanThingId of ['999', '"not-an-id"']) {
        await resetLegacy(postgres.client)
        const placeId = await seedResidentsAndPlace(postgres.client)
        await seedLegacyThing(postgres.client, placeId)
        await postgres.client.query(`
          INSERT INTO events (at, kind, actor, detail)
          VALUES (
            '2026-08-20T12:00:00Z',
            'thing_created',
            'maker-one',
            jsonb_build_object(
              'thing_id', $1::jsonb,
              'place_id', $2::integer,
              'name', 'orphan history',
              'kind_id', NULL,
              'birth_revision', NULL
            )
          )
        `, [orphanThingId, placeId])
        await applyExpectedFailure(postgres.client, migrationDdl)
      }

      await resetLegacy(postgres.client)
      const completeReportPlaceId = await seedResidentsAndPlace(postgres.client)
      await postgres.client.query(`
        INSERT INTO things (id, place_id, name, body, owner_id, created_at)
        SELECT id, $1, 'unresolved-' || id, repeat(chr(117), 19), 2,
          '2026-08-20T13:00:00Z'::timestamptz + id * interval '1 second'
        FROM generate_series(100, 126) AS id
      `, [completeReportPlaceId])
      await applyExpectedFailure(postgres.client, migrationDdl, false, '126')

      await resetLegacy(postgres.client)
      const placeId = await seedResidentsAndPlace(postgres.client)
      await seedLegacyThing(postgres.client, placeId)
      await postgres.client.query('ALTER TABLE things ADD COLUMN maker_id INTEGER')
      await postgres.client.query('UPDATE things SET maker_id = 2 WHERE id = 7')
      await applyExpectedFailure(postgres.client, migrationDdl, true)
      const forged = await postgres.client.query<{ maker_id: number }>(
        'SELECT maker_id FROM things WHERE id = 7',
      )
      assert.equal(forged.rows[0]!.maker_id, 2, 'failed reapply must not rewrite a forged maker')
    })
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
