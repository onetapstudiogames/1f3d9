import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client } from 'pg'
import { founderWorldDrawing } from '../helpers/drawings-fixtures/drawing-samples.ts'
import { registerSchemaContractTests } from './drawings-tests/schema-contract.ts'
import { registerWorldMigrationTests } from './drawings-tests/world-migrations.ts'
import { registerDrawingConstraintsTests } from './drawings-tests/drawing-constraints.ts'
import { registerSnapshotInheritanceTests } from './drawings-tests/snapshot-inheritance.ts'
import { registerDrawingRoutesTests } from './drawings-tests/drawing-routes.ts'
import { registerPaidRevisionTests } from './drawings-tests/paid-revisions.ts'
import { registerLateFinalityTests } from './drawings-tests/late-finality.ts'
import { registerLegacyPaymentTests } from './drawings-tests/legacy-payments.ts'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'drawings_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260827_drawings.sql', import.meta.url),
  'utf8',
)
const worldRootDrawingMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_world_root_drawing.sql', import.meta.url),
  'utf8',
)
const worldRootTopologyMigrationDdl = await readFile(
  new URL('../../db/migrations/20260814_world_root_topology.sql', import.meta.url),
  'utf8',
)
const drawingContractMigrationDdl = await readFile(
  new URL('../../db/migrations/20260828_drawing_contract.sql', import.meta.url),
  'utf8',
)

function drawingFunctionDdl(name: string): string {
  const startMarker = `CREATE OR REPLACE FUNCTION ${name}`
  const start = drawingContractMigrationDdl.indexOf(startMarker)
  assert.notEqual(start, -1, `missing ${name} in drawing contract migration`)
  const endMarker = '$function$;'
  const end = drawingContractMigrationDdl.indexOf(endMarker, start)
  assert.notEqual(end, -1, `unterminated ${name} in drawing contract migration`)
  return drawingContractMigrationDdl.slice(start, end + endMarker.length)
}

let routeClient: Client | undefined
const routeSql = (async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(routeClient, 'the route PostgreSQL client must be connected')
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  return (await routeClient.query(text, [...values])).rows as Record<string, unknown>[]
}) as ((strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<Record<string, unknown>[]>) & {
  query: (text: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>
}
routeSql.query = async (text, values = []) => {
  assert.ok(routeClient, 'the route PostgreSQL client must be connected')
  return (await routeClient.query(text, [...values])).rows as Record<string, unknown>[]
}
mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql: routeSql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/drawings',
  },
})

const blankIndices = (): null[] => Array.from({ length: 64 }, () => null)
const drawing = (colour: string) => ({
  palette: [colour],
  indices: [0, ...blankIndices().slice(1)],
})
const blankDrawing = () => ({ palette: [], indices: blankIndices() })
const ownerSecret = `1f3d9_sk_${'d'.repeat(48)}`
const ownerAuthorization = Object.freeze({ authorization: `Bearer ${ownerSecret}` })

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`Docker drawings fixture failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function connect(config: ConstructorParameters<typeof Client>[0]): Promise<Client> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    const client = new Client(config)
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
      await delay(200)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
}

async function rejectsCheck(client: Client, candidate: unknown): Promise<void> {
  await assert.rejects(
    client.query('UPDATE residents SET drawing = $1::jsonb WHERE id = 1', [JSON.stringify(candidate)]),
    (error: unknown) => (error as { code?: string }).code === '23514',
  )
}

async function installLegacyNullWorldDrawing(client: Client): Promise<void> {
  await client.query(`
    BEGIN;
    ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_shape;
    ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_drawing_exact;
    ALTER TABLE places DROP CONSTRAINT IF EXISTS places_drawing_contract;
    ALTER TABLE places DISABLE TRIGGER places_protect_topology_write;
    UPDATE places SET drawing = NULL WHERE place_kind = 'world';
    ALTER TABLE places ENABLE TRIGGER places_protect_topology_write;
    ALTER TABLE places ADD CONSTRAINT places_world_shape CHECK (
      (
        place_kind = 'world'
        AND parent_id IS NULL
        AND name = 'the world'
        AND owner_id IS NULL
        AND active_offer_id IS NULL
        AND drawing IS NULL
        AND NOT open_to_building
        AND NOT open_to_things
        AND NOT open_to_notes
      )
      OR (
        place_kind IN ('continent', 'place')
        AND parent_id IS NOT NULL
        AND owner_id IS NOT NULL
      )
    ) NOT VALID;
    ALTER TABLE places VALIDATE CONSTRAINT places_world_shape;
    COMMIT;
  `)
}

test('real PostgreSQL enforces, preserves, moderates, exports, and settles drawings', async t => {
  const runId = `${process.pid}-${randomBytes(5).toString('hex')}`
  const container = `1f3d9-drawings-${runId}`
  const password = randomBytes(24).toString('hex')
  let client: Client | undefined
  t.after(async () => {
    routeClient = undefined
    await client?.end().catch(() => undefined)
    docker(['rm', '--force', container], true)
  })

  docker([
    'run', '--detach', '--name', container,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  const portText = docker(['port', container, '5432/tcp'])
  const port = Number(portText.match(/:(\d+)\s*$/u)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)
  client = await connect({
    host: '127.0.0.1', port, user: 'postgres', password,
    database: POSTGRES_DATABASE, ssl: false,
  })
  routeClient = client

  await registerSchemaContractTests(
    client, drawingFunctionDdl,
  )

  await client.query(schemaDdl)
  const freshWorld = (await client.query<{ id: number; drawing: unknown }>(`
    SELECT id, drawing FROM places WHERE place_kind = 'world'
  `)).rows[0]!
  assert.deepEqual(freshWorld.drawing, founderWorldDrawing)

  await registerWorldMigrationTests(
    client, freshWorld, migrationDdl, installLegacyNullWorldDrawing,
    worldRootDrawingMigrationDdl, worldRootTopologyMigrationDdl,
    drawingContractMigrationDdl, schemaDdl, drawing,
  )

  const residentDrawing = drawing('#ad3f25')
  const placeDrawing = drawing('#174d3c')
  const kindDrawing = drawing('#f0c95f')
  const thingDrawing = drawing('#9d9276')
  await client.query(`
    INSERT INTO residents (
      id, handle, model, secret_hash, drawing, drawing_state, drawing_description
    )
    VALUES
      (1, 'drawing-owner', 'integration', $1, $2::jsonb, 'complete', 'A resident mark.'),
      (2, 'paid-drawing-owner', 'integration', $3, NULL, 'undrawn', NULL)
  `, [
    '1'.repeat(64),
    JSON.stringify(residentDrawing),
    createHash('sha256').update(ownerSecret, 'utf8').digest('hex'),
  ])
  await client.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
  const placeId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (
      parent_id, place_kind, name, description, owner_id,
      drawing, drawing_state, drawing_description
    )
    SELECT id, 'continent', 'Drawing Quarter', 'exact public place', 1,
      $1::jsonb, 'complete', 'A brick-red drawing quarter.'
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `, [JSON.stringify(placeDrawing)])).rows[0]!.id)
  const kindId = Number((await client.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('drawn-kind', 1) RETURNING id
  `)).rows[0]!.id)
  const kindVariants = [{
    name: 'blue-shutter',
    drawing: drawing('#1e5964'),
    state: 'complete',
    description: 'A blue shutter over the kind owner’s lantern.',
  }]
  await client.query(`
    INSERT INTO kind_revisions (
      kind_id, revision, description, drawing, drawing_state,
      drawing_description, drawing_variants
    )
    VALUES (
      $1, 1, 'drawn definition', $2::jsonb, 'complete',
      'The kind owner’s plain lantern.', $3::jsonb
    )
  `, [kindId, JSON.stringify(kindDrawing), JSON.stringify(kindVariants)])
  const ownThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id,
      drawing, drawing_state, drawing_description
    ) VALUES (
      $1, 'untyped owner drawing', '', 1, 1,
      $2::jsonb, 'complete', 'An untyped owner-authored thing.'
    )
    RETURNING id
  `, [placeId, JSON.stringify(thingDrawing)])).rows[0]!.id)
  const inheritedThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id,
      birth_revision, current_revision
    ) VALUES ($1, 'inherited thing', '', 1, 1, $2, 1, 1)
    RETURNING id
  `, [placeId, kindId])).rows[0]!.id)
  const variantThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id,
      birth_revision, current_revision, drawing_variant_name
    ) VALUES ($1, 'variant thing', '', 1, 1, $2, 1, 1, 'blue-shutter')
    RETURNING id
  `, [placeId, kindId])).rows[0]!.id)

  for (const candidate of [
    { palette: ['#ad3f25'], indices: blankIndices(), extra: true },
    { palette: ['#AD3F25'], indices: blankIndices() },
    { palette: Array.from({ length: 65 }, () => '#ad3f25'), indices: blankIndices() },
    { palette: ['#ad3f25'], indices: blankIndices().slice(1) },
    { palette: ['#ad3f25'], indices: [...blankIndices().slice(1), 1] },
    { palette: ['#ad3f25'], indices: [...blankIndices().slice(1), 0.5] },
  ]) await rejectsCheck(client, candidate)

  const replacement = drawing('#0b1714')
  await registerDrawingConstraintsTests(
    client, replacement, inheritedThingId, thingDrawing, kindId, placeDrawing,
  )

  await client.query(`
    INSERT INTO events (kind, actor, detail)
    VALUES ('resident_edited', 'drawing-owner', $1::jsonb)
  `, [JSON.stringify({ resident_id: 1, source_thing_id: ownThingId, private: 'omit' })])

  const snapshot = async (className: string, recordId: number) => (
    await client!.query<{ payload: Record<string, unknown> }>(`
      SELECT payload FROM city_snapshot.public_records
      WHERE class_name = $1 AND record_id = $2::text
    `, [className, recordId])
  ).rows[0]!.payload

  await registerSnapshotInheritanceTests(
    client, snapshot, replacement, freshWorld, placeId, placeDrawing,
    kindId, kindDrawing, ownThingId, thingDrawing, inheritedThingId,
    variantThingId, kindVariants,
  )

  const database = {
    query: async (text: string, params: readonly unknown[] = []) =>
      (await client!.query(text, [...params])).rows,
  }
  await registerDrawingRoutesTests(
    client, database, freshWorld, inheritedThingId, drawing,
  )

  await registerPaidRevisionTests(
    client, database, placeId, drawing,
  )

  await registerLateFinalityTests(
    client, database, drawing,
  )

  await registerLegacyPaymentTests(
    client, database, placeId,
  )
})
