import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'world_root_integration'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const expansionDdl = await readFile(
  new URL('../../db/migrations/20260814_world_root_expand.sql', import.meta.url),
  'utf8',
)
const topologyDdl = await readFile(
  new URL('../../db/migrations/20260814_world_root_topology.sql', import.meta.url),
  'utf8',
)

const legacySchemaDdl = `
  CREATE TABLE residents (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE
  );

  CREATE TABLE places (
    id SERIAL PRIMARY KEY,
    parent_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
    open_to_building BOOLEAN NOT NULL DEFAULT FALSE,
    open_to_things BOOLEAN NOT NULL DEFAULT FALSE,
    open_to_notes BOOLEAN NOT NULL DEFAULT FALSE,
    active_offer_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX places_frontier_name
    ON places (lower(name)) WHERE parent_id IS NULL;

  CREATE TABLE resident_presence (
    resident_id INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE RESTRICT,
    current_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
    home_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE things (
    id SERIAL PRIMARY KEY,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
  );

  CREATE TABLE notes (
    id SERIAL PRIMARY KEY,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
    author_id INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
    body TEXT NOT NULL
  );

  CREATE TABLE place_law_changes (
    id BIGSERIAL PRIMARY KEY,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
    actor_id INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
  );

  CREATE TABLE active_labels (
    id BIGSERIAL PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    actor_id INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
  );
`

interface PostgresInstance {
  client: Client
  containerName: string
}

interface PlaceRow {
  id: number
  parent_id: number | null
  place_kind: 'world' | 'continent' | 'place'
  name: string
  owner_id: number | null
  open_to_building: boolean
  open_to_things: boolean
  open_to_notes: boolean
}

interface PresenceRow {
  resident_id: number
  current_place_id: number | null
  home_place_id: number | null
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<PostgresInstance> {
  const containerName = `1f3d9-world-root-test-${process.pid}-${randomBytes(4).toString('hex')}`
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

    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const client = new Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: POSTGRES_DATABASE,
        ssl: false,
      })
      try {
        await client.connect()
        return { client, containerName }
      } catch (error) {
        lastError = error
        await client.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetDatabase(database: Client, ddl: string): Promise<void> {
  await database.query('DROP SCHEMA IF EXISTS city_snapshot CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(ddl)
}

async function assertPgError(
  database: Client,
  statement: string,
  values: readonly unknown[],
  code: string,
): Promise<void> {
  await assert.rejects(
    database.query(statement, [...values]),
    (error: unknown) => (error as { code?: string }).code === code,
  )
}

async function seedResidents(database: Client): Promise<void> {
  await database.query(
    `INSERT INTO residents (id, handle, model, secret_hash)
     VALUES
       (1, 'resident-one', 'integration', $1),
       (2, 'resident-two', 'integration', $2),
       (3, 'resident-three', 'integration', $3)`,
    ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
  )
}

test('world-root schema and migration invariants hold in PostgreSQL', async t => {
  const postgres = await startPostgres()
  const database = postgres.client

  try {
    await t.test('a fresh schema has one lawless transit root with local child permissions', async () => {
      await resetDatabase(database, schemaDdl)
      await seedResidents(database)

      const rootResult = await database.query<PlaceRow>(
        `SELECT id, parent_id, place_kind, name, owner_id,
                open_to_building, open_to_things, open_to_notes
         FROM places
         WHERE parent_id IS NULL`,
      )
      assert.deepEqual(rootResult.rows, [{
        id: rootResult.rows[0]!.id,
        parent_id: null,
        place_kind: 'world',
        name: 'the world',
        owner_id: null,
        open_to_building: false,
        open_to_things: false,
        open_to_notes: false,
      }])
      const worldId = rootResult.rows[0]!.id

      const continentResult = await database.query<{ id: number }>(
        `INSERT INTO places (
           parent_id, place_kind, name, owner_id,
           open_to_building, open_to_things, open_to_notes
         )
         VALUES ($1, 'continent', 'Open Continent', 1, TRUE, TRUE, TRUE)
         RETURNING id`,
        [worldId],
      )
      const continentId = continentResult.rows[0]!.id
      const childResult = await database.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         VALUES ($1, 'place', 'A Room', 1)
         RETURNING id`,
        [continentId],
      )
      const childId = childResult.rows[0]!.id

      const permissions = await database.query<{
        name: string
        open_to_building: boolean
        open_to_things: boolean
        open_to_notes: boolean
      }>(
        `SELECT name, open_to_building, open_to_things, open_to_notes
         FROM places
         WHERE id IN ($1, $2)
         ORDER BY id`,
        [worldId, continentId],
      )
      assert.deepEqual(permissions.rows, [
        {
          name: 'the world',
          open_to_building: false,
          open_to_things: false,
          open_to_notes: false,
        },
        {
          name: 'Open Continent',
          open_to_building: true,
          open_to_things: true,
          open_to_notes: true,
        },
      ], 'the root permissions must not overwrite or inherit into its continent')

      await assertPgError(
        database,
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         VALUES ($1, 'place', 'Room in the Void', 1)`,
        [worldId],
        '23514',
      )
      await assertPgError(
        database,
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         VALUES ($1, 'continent', 'Nested Continent', 1)`,
        [continentId],
        '23514',
      )
      await assertPgError(
        database,
        `INSERT INTO places (
           parent_id, place_kind, name, owner_id,
           open_to_building, open_to_things, open_to_notes
         ) VALUES (NULL, 'world', 'another world', NULL, FALSE, FALSE, FALSE)`,
        [],
        '23514',
      )
      await assertPgError(
        database,
         `INSERT INTO places (
           parent_id, place_kind, name, owner_id,
           open_to_building, open_to_things, open_to_notes, drawing
         )
         SELECT NULL, 'world', 'the world', NULL, FALSE, FALSE, FALSE, drawing
         FROM places WHERE id = $1`,
        [worldId],
        '23505',
      )

      const trait = await database.query<{ id: number }>(
        `INSERT INTO traits (name, description, coiner_id)
         VALUES ('local-law', 'local only', 1)
         RETURNING id`,
      )
      const traitId = trait.rows[0]!.id

      await database.query(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
         VALUES ($1, 'child thing', '', 1, 1)`,
        [childId],
      )
      await database.query(
        `INSERT INTO notes (place_id, author_id, body)
         VALUES ($1, 1, 'continent note')`,
        [continentId],
      )
      await database.query(
        `INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
         VALUES ($1, $2, 1, 'add', 0)`,
        [continentId, traitId],
      )

      await assertPgError(
        database,
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
         VALUES ($1, 'void thing', '', 1, 1)`,
        [worldId],
        '23514',
      )
      await assertPgError(
        database,
        `INSERT INTO notes (place_id, author_id, body)
         VALUES ($1, 1, 'void note')`,
        [worldId],
        '23514',
      )
      await assertPgError(
        database,
        `INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
         VALUES ($1, $2, 1, 'add', 0)`,
        [worldId, traitId],
        '23514',
      )
      await assertPgError(
        database,
        `INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
         VALUES (1, $1, $1)`,
        [worldId],
        '23514',
      )
      await assertPgError(
        database,
        `INSERT INTO active_labels (target_type, target_id, label, actor_id)
         VALUES ('place', $1, 'labeled', 1)`,
        [worldId],
        '23514',
      )
      await assertPgError(
        database,
        `UPDATE places SET owner_id = 1 WHERE id = $1`,
        [worldId],
        '55000',
      )
      await assertPgError(database, 'DELETE FROM places WHERE id = $1', [worldId], '55000')
    })

    await t.test('the staged migration reparents legacy continents and is idempotent', async () => {
      await resetDatabase(database, legacySchemaDdl)
      await database.query(
        `INSERT INTO residents (id, handle)
         VALUES (1, 'resident-one'), (2, 'resident-two'), (3, 'resident-three')`,
      )
      await database.query(
        `INSERT INTO places (
           id, parent_id, name, description, owner_id,
           open_to_building, open_to_things, open_to_notes
         ) VALUES
           (10, NULL, 'Mainland', '', 1, TRUE, TRUE, TRUE),
           (20, NULL, 'Possibility', '', 2, FALSE, TRUE, FALSE),
           (11, 10, 'Mainland Room', '', 1, FALSE, FALSE, FALSE)`,
      )
      await database.query(
        `INSERT INTO resident_presence (
           resident_id, current_place_id, home_place_id, updated_at
         ) VALUES
           (2, NULL, 11, '2026-08-01T00:00:00Z'),
           (3, 10, 10, '2026-08-02T00:00:00Z')`,
      )

      await database.query(expansionDdl)
      const expanded = await database.query<{
        worlds: string
        nullable_owner: string
      }>(
        `SELECT
           (SELECT count(*) FROM places WHERE place_kind = 'world') AS worlds,
           (SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'places'
              AND column_name = 'owner_id') AS nullable_owner`,
      )
      assert.deepEqual(expanded.rows, [{ worlds: '0', nullable_owner: 'YES' }])

      await database.query(topologyDdl)
      const firstTopology = await database.query<PlaceRow>(
        `SELECT id, parent_id, place_kind, name, owner_id,
                open_to_building, open_to_things, open_to_notes
         FROM places
         ORDER BY id`,
      )
      const world = firstTopology.rows.find(place => place.place_kind === 'world')
      assert.ok(world)
      assert.equal(world.parent_id, null)
      assert.equal(world.owner_id, null)
      assert.equal(firstTopology.rows.filter(place => place.parent_id === null).length, 1)
      assert.deepEqual(
        firstTopology.rows
          .filter(place => place.place_kind === 'continent')
          .map(place => ({ id: place.id, parent_id: place.parent_id })),
        [{ id: 10, parent_id: world.id }, { id: 20, parent_id: world.id }],
      )
      assert.equal(firstTopology.rows.find(place => place.id === 11)?.place_kind, 'place')
      assert.equal(firstTopology.rows.find(place => place.id === 11)?.parent_id, 10)

      const presence = await database.query<PresenceRow>(
        `SELECT resident_id, current_place_id, home_place_id
         FROM resident_presence
         ORDER BY resident_id`,
      )
      assert.deepEqual(presence.rows, [
        { resident_id: 1, current_place_id: world.id, home_place_id: null },
        { resident_id: 2, current_place_id: world.id, home_place_id: 11 },
        { resident_id: 3, current_place_id: 10, home_place_id: 10 },
      ])

      await database.query(topologyDdl)
      const secondTopology = await database.query<{
        worlds: string
        roots: string
        continents: string
      }>(
        `SELECT
           count(*) FILTER (WHERE place_kind = 'world') AS worlds,
           count(*) FILTER (WHERE parent_id IS NULL) AS roots,
           count(*) FILTER (
             WHERE place_kind = 'continent' AND parent_id = $1
           ) AS continents
         FROM places`,
        [world.id],
      )
      assert.deepEqual(secondTopology.rows, [{ worlds: '1', roots: '1', continents: '2' }])
      assert.deepEqual(
        (await database.query<PresenceRow>(
          `SELECT resident_id, current_place_id, home_place_id
           FROM resident_presence
           ORDER BY resident_id`,
        )).rows,
        presence.rows,
      )
    })

    await t.test('the full loopback schema upgrades a legacy tree and reapplies cleanly', async () => {
      await resetDatabase(database, schemaDdl)
      await seedResidents(database)

      const originalWorld = await database.query<{ id: number }>(
        `SELECT id FROM places WHERE place_kind = 'world'`,
      )
      const originalWorldId = originalWorld.rows[0]!.id
      const mainland = await database.query<{ id: number }>(
        `INSERT INTO places (
           parent_id, place_kind, name, owner_id,
           open_to_building, open_to_things, open_to_notes
         ) VALUES ($1, 'continent', 'Legacy Mainland', 1, TRUE, FALSE, TRUE)
         RETURNING id`,
        [originalWorldId],
      )
      const possibility = await database.query<{ id: number }>(
        `INSERT INTO places (
           parent_id, place_kind, name, owner_id,
           open_to_building, open_to_things, open_to_notes
         ) VALUES ($1, 'continent', 'Legacy Possibility', 2, FALSE, TRUE, FALSE)
         RETURNING id`,
        [originalWorldId],
      )
      const room = await database.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         VALUES ($1, 'place', 'Legacy Room', 1)
         RETURNING id`,
        [mainland.rows[0]!.id],
      )
      await database.query(
        `INSERT INTO resident_presence (
           resident_id, current_place_id, home_place_id, updated_at
         ) VALUES
           (2, NULL, $1, '2026-08-03T00:00:00Z'),
           (3, $2, $2, '2026-08-04T00:00:00Z')`,
        [room.rows[0]!.id, possibility.rows[0]!.id],
      )

      // Recreate the material shape of a pre-world-root local database while
      // retaining all unrelated tables that the complete schema also upgrades.
      await database.query(`
        DROP SCHEMA IF EXISTS city_snapshot CASCADE;
        DROP TRIGGER IF EXISTS places_protect_topology ON places;
        DROP TRIGGER IF EXISTS places_protect_topology_write ON places;
        DROP TRIGGER IF EXISTS places_protect_topology_insert ON places;
        DROP TRIGGER IF EXISTS things_reject_world_place ON things;
        DROP TRIGGER IF EXISTS notes_reject_world_place ON notes;
        DROP TRIGGER IF EXISTS place_law_changes_reject_world_place ON place_law_changes;
        DROP TRIGGER IF EXISTS resident_presence_reject_world_home ON resident_presence;
        DROP TRIGGER IF EXISTS active_labels_reject_world_place ON active_labels;
        DROP INDEX IF EXISTS places_one_world;
        DROP INDEX IF EXISTS places_one_root;
        DROP INDEX IF EXISTS places_sibling_name;
        ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_shape;
        ALTER TABLE places DROP CONSTRAINT IF EXISTS places_place_kind_allowed;
        ALTER TABLE places DROP CONSTRAINT IF EXISTS places_active_offer_positive;
        UPDATE places SET parent_id = NULL WHERE place_kind = 'continent';
        DELETE FROM places WHERE place_kind = 'world';
        ALTER TABLE places DROP COLUMN place_kind;
        ALTER TABLE places ALTER COLUMN owner_id SET NOT NULL;
        CREATE UNIQUE INDEX places_frontier_name
          ON places (lower(name)) WHERE parent_id IS NULL;
      `)

      await database.query(schemaDdl)
      const firstUpgradePlaces = await database.query<PlaceRow>(
        `SELECT id, parent_id, place_kind, name, owner_id,
                open_to_building, open_to_things, open_to_notes
         FROM places
         ORDER BY id`,
      )
      const upgradedWorld = firstUpgradePlaces.rows.find(place => place.place_kind === 'world')
      assert.ok(upgradedWorld)
      assert.equal(upgradedWorld.parent_id, null)
      assert.equal(upgradedWorld.owner_id, null)
      assert.equal(firstUpgradePlaces.rows.filter(place => place.parent_id === null).length, 1)
      assert.deepEqual(
        firstUpgradePlaces.rows
          .filter(place => place.place_kind === 'continent')
          .map(place => ({
            name: place.name,
            parent_id: place.parent_id,
            permissions: [
              place.open_to_building,
              place.open_to_things,
              place.open_to_notes,
            ],
          })),
        [
          {
            name: 'Legacy Mainland',
            parent_id: upgradedWorld.id,
            permissions: [true, false, true],
          },
          {
            name: 'Legacy Possibility',
            parent_id: upgradedWorld.id,
            permissions: [false, true, false],
          },
        ],
      )
      assert.equal(
        firstUpgradePlaces.rows.find(place => place.id === room.rows[0]!.id)?.parent_id,
        mainland.rows[0]!.id,
      )

      const firstUpgradePresence = await database.query<PresenceRow>(
        `SELECT resident_id, current_place_id, home_place_id
         FROM resident_presence
         ORDER BY resident_id`,
      )
      assert.deepEqual(firstUpgradePresence.rows, [
        { resident_id: 1, current_place_id: upgradedWorld.id, home_place_id: null },
        {
          resident_id: 2,
          current_place_id: upgradedWorld.id,
          home_place_id: room.rows[0]!.id,
        },
        {
          resident_id: 3,
          current_place_id: possibility.rows[0]!.id,
          home_place_id: possibility.rows[0]!.id,
        },
      ])

      const activeOfferConstraint = await database.query<{ convalidated: boolean }>(
        `SELECT convalidated
         FROM pg_constraint
         WHERE conrelid = 'places'::regclass
           AND conname = 'places_active_offer_positive'`,
      )
      assert.deepEqual(activeOfferConstraint.rows, [{ convalidated: true }])
      await assertPgError(
        database,
        'UPDATE places SET active_offer_id = 0 WHERE id = $1',
        [mainland.rows[0]!.id],
        '23514',
      )

      await database.query(schemaDdl)
      assert.deepEqual(
        (await database.query<PlaceRow>(
          `SELECT id, parent_id, place_kind, name, owner_id,
                  open_to_building, open_to_things, open_to_notes
           FROM places
           ORDER BY id`,
        )).rows,
        firstUpgradePlaces.rows,
      )
      assert.deepEqual(
        (await database.query<PresenceRow>(
          `SELECT resident_id, current_place_id, home_place_id
           FROM resident_presence
           ORDER BY resident_id`,
        )).rows,
        firstUpgradePresence.rows,
      )
    })
  } finally {
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
