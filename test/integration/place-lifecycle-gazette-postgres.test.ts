import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'

import { applyMigration, type MigrationFile } from '../../scripts/migrate.ts'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'place_lifecycle_gazette_integration'
const PUBLIC_SEARCH_MIGRATION_FILE =
  'db/migrations/20260821_public_search_indexes.sql' as MigrationFile

type PostgresInstance = Readonly<{
  database: Pool
  databaseUrl: string
  containerName: string
}>

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
      || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<PostgresInstance> {
  const containerName = `1f3d9-place-lifecycle-gazette-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${POSTGRES_DATABASE}`
    const database = new Pool({ connectionString: databaseUrl, ssl: false })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await database.query('SELECT 1')
        return { database, databaseUrl, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await database.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8', windowsHide: true,
    })
    throw error
  }
}

async function gazetteContractBytes(database: Pool): Promise<Buffer> {
  const result = await database.query<{ contract_bytes: Buffer }>(`
    SELECT convert_to(jsonb_build_object(
      'room', to_jsonb(place) - ARRAY['founding_name', 'retired_at'],
      'state', gazette_submission_room_state(place),
      'guards_ready', gazette_submission_room_guards_ready(),
      'forbidden_contents_absent', gazette_submission_room_has_no_forbidden_contents(),
      'guard_triggers', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'table', trigger.tgrelid::regclass::text,
          'name', trigger.tgname,
          'enabled', trigger.tgenabled
        ) ORDER BY trigger.tgrelid::regclass::text, trigger.tgname), '[]'::jsonb)
        FROM pg_trigger trigger
        WHERE trigger.tgname LIKE 'gazette_%'
          AND NOT trigger.tgisinternal
      ),
      'activation_events', (
        SELECT coalesce(jsonb_agg(to_jsonb(event) ORDER BY event.id), '[]'::jsonb)
        FROM events event
        WHERE event.kind = 'place_edited'
          AND event.actor = 'the city'
          AND event.detail->>'place_id' = '454'
      ),
      'notes', (
        SELECT coalesce(jsonb_agg(to_jsonb(note) ORDER BY note.id), '[]'::jsonb)
        FROM notes note WHERE note.place_id = 454
      ),
      'things', (
        SELECT coalesce(jsonb_agg(to_jsonb(thing) ORDER BY thing.id), '[]'::jsonb)
        FROM things thing WHERE thing.place_id = 454
      ),
      'child_places', (
        SELECT coalesce(jsonb_agg(to_jsonb(child) ORDER BY child.id), '[]'::jsonb)
        FROM places child WHERE child.parent_id = 454
      ),
      'laws', (
        SELECT coalesce(jsonb_agg(to_jsonb(law) ORDER BY law.id), '[]'::jsonb)
        FROM place_law_changes law WHERE law.place_id = 454
      ),
      'presence', (
        SELECT coalesce(jsonb_agg(to_jsonb(presence) ORDER BY presence.resident_id), '[]'::jsonb)
        FROM resident_presence presence
        WHERE presence.current_place_id = 454 OR presence.home_place_id = 454
      )
    )::text, 'UTF8') AS contract_bytes
    FROM places place
    WHERE place.id = 454
  `)
  assert.equal(result.rows.length, 1, 'Gazette room #454 must exist')
  return result.rows[0]!.contract_bytes
}

test('place lifecycle and public search migrations preserve an activated Gazette room', async t => {
  const postgres = await startPostgres()
  t.after(async () => {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], {
      encoding: 'utf8', windowsHide: true,
    })
  })

  const [schema, placeLifecycleMigration, gazetteActivation, withdrawalActivation,
    publicSearchMigration] = await Promise.all([
    readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/migrations/20260901_place_lifecycle.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/migrations/20260901_gazette_withdrawal_activation.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../db/migrations/20260821_public_search_indexes.sql', import.meta.url), 'utf8'),
  ])

  await postgres.database.query(schema)
  await postgres.database.query(`
    DROP TRIGGER places_protect_founding_name ON places;
    DROP TRIGGER places_record_founding_name_history ON places;
    ALTER TABLE places ALTER COLUMN founding_name DROP NOT NULL;

    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (1, 'gazette-founder', 'integration-test', repeat('1', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, founding_name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT 2, world.id, 'continent', 'gazette test continent',
      'gazette test continent', 'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world WHERE world.place_kind = 'world';

    INSERT INTO places (
      id, parent_id, place_kind, name, founding_name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room', NULL,
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    );

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, 454, 454);
  `)
  await postgres.database.query(gazetteActivation)
  await postgres.database.query(withdrawalActivation)
  await postgres.database.query(`
    INSERT INTO notes (place_id, author_id, body)
    VALUES (454, 1, 'A protected Gazette submission that must remain byte-identical.')
  `)
  assert.equal((await postgres.database.query(`
    SELECT gazette_submission_room_state(place) AS state
    FROM places place WHERE id = 454
  `)).rows[0]!.state, 'withdrawals_open')

  await assert.rejects(
    postgres.database.query(`
      UPDATE places SET founding_name = name WHERE id = 454
    `),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, '23514')
      assert.equal(
        (error as { constraint?: string }).constraint,
        'gazette_submission_room_lifecycle',
      )
      return true
    },
  )

  const before = await gazetteContractBytes(postgres.database)
  await postgres.database.query(placeLifecycleMigration)
  assert.deepEqual(await gazetteContractBytes(postgres.database), before)
  assert.deepEqual((await postgres.database.query(`
    SELECT place.founding_name,
      (SELECT count(*)::integer FROM place_name_history history
        WHERE history.place_id = place.id
          AND history.name = place.name
          AND history.event_id IS NULL) AS founding_history_rows
    FROM places place WHERE place.id = 454
  `)).rows, [{
    founding_name: 'the gazette submission room',
    founding_history_rows: 1,
  }])

  for (let run = 0; run < 2; run += 1) {
    await applyMigration(
      postgres.databaseUrl,
      PUBLIC_SEARCH_MIGRATION_FILE,
      publicSearchMigration,
    )
    assert.deepEqual(await gazetteContractBytes(postgres.database), before)
  }
})
