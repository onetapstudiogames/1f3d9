import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { Client } from 'pg'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'drawing_upgrade_integration'
const PRE_DRAWING_SCHEMA_COMMIT = '98594c0081a9001d7e8653cd08ffb140c291f127'
const PRE_DRAWING_SCHEMA_SHA256 =
  '8117fe2c3f69a9a6f21c71f97a24584010883bb4167b4919acfea6ffb57af81f'
const preDrawingSchemaDdl = gunzipSync(Buffer.from((await readFile(
  new URL('../fixtures/production-pre-drawing-schema-98594c0.sql.gz.base64', import.meta.url),
  'utf8',
)).replace(/\s/gu, ''), 'base64')).toString('utf8')
const drawingContractMigrationDdl = await readFile(
  new URL('../../db/migrations/20260828_drawing_contract.sql', import.meta.url),
  'utf8',
)
const legacyDrawingsMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_drawings.sql', import.meta.url),
  'utf8',
)
const worldRootDrawingMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_world_root_drawing.sql', import.meta.url),
  'utf8',
)
const founderWorldDrawing = Object.freeze({
  palette: Object.freeze(['#0b1714', '#123026', '#1c4434']),
  indices: Object.freeze([
    0, 0, 0, 0, 0, 0, 0, 0,
    null, 0, 1, 0, 0, 0, 0, 0,
    null, 0, 0, 0, 0, 0, 1, 0,
    0, null, 0, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 0, null, 0, 1, 0, 0, 0,
    0, 0, null, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 1, 0, 0,
  ]),
})
const legacyResidentDrawing = drawing('#ad3f25')
const legacyKindDrawing = drawing('#f0c95f')
const legacyUntypedThingDrawing = drawing('#9d9276')
const legacyTypedThingDrawing = drawing('#384f7d')
const authoredResidentDrawing = drawing('#245f4b')
const authoredPlaceDrawing = drawing('#8e4b32')
const authoredThingDrawing = drawing('#516a91')
const authoredKindDrawing = drawing('#b48b35')

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() ||
      `exit ${result.status ?? 'unknown'}`
    throw new Error(`Docker drawing-upgrade fixture failed: ${detail}`)
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

async function startPostgres(t: TestContext, purpose: string): Promise<Client> {
  const runId = `${process.pid}-${randomBytes(5).toString('hex')}`
  const container = `1f3d9-${purpose}-${runId}`
  const password = randomBytes(24).toString('hex')
  let client: Client | undefined
  t.after(async () => {
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
  const port = Number(docker(['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)
  client = await connect({
    host: '127.0.0.1', port, user: 'postgres', password,
    database: POSTGRES_DATABASE, ssl: false,
  })
  return client
}

test('real PostgreSQL upgrades the exact pre-drawing production schema in release order', async t => {
  assert.equal(
    createHash('sha256').update(preDrawingSchemaDdl).digest('hex'),
    PRE_DRAWING_SCHEMA_SHA256,
    `fixture must remain the exact db/schema.sql from ${PRE_DRAWING_SCHEMA_COMMIT}`,
  )
  assert.doesNotMatch(
    preDrawingSchemaDdl,
    /drawing_state|drawing_revisions|valid_city_drawing/u,
    'the production baseline must not silently inherit current drawing objects',
  )

  const client = await startPostgres(t, 'drawing-upgrade')

  await client.query(preDrawingSchemaDdl)
  assert.deepEqual((await client.query<{
    drawing_state: string | null
    drawing_revisions: string | null
    drawing_validator: string | null
  }>(`
    SELECT
      (SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'places'
         AND column_name = 'drawing_state') AS drawing_state,
      to_regclass('public.drawing_revisions')::text AS drawing_revisions,
      to_regprocedure('public.valid_city_drawing(jsonb)')::text AS drawing_validator
  `)).rows, [{ drawing_state: null, drawing_revisions: null, drawing_validator: null }])

  await client.query(drawingContractMigrationDdl)
  await client.query(worldRootDrawingMigrationDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (1, 'snapshot-owner', 'integration', $1)
  `, ['2'.repeat(64)])
  const snapshotPlaceId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    SELECT id, 'continent', 'Snapshot Quarter', 'dated snapshot fixture', 1
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `)).rows[0]!.id)
  const snapshotKindId = Number((await client.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('snapshot-undrawn-kind', 1)
    RETURNING id
  `)).rows[0]!.id)
  await client.query(`
    INSERT INTO kind_revisions (kind_id, revision, description)
    VALUES ($1, 1, 'The pinned base is deliberately undrawn.')
  `, [snapshotKindId])
  const snapshotThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id,
      kind_id, birth_revision, current_revision
    ) VALUES ($1, 'snapshot undrawn thing', '', 1, 1, $2, 1, 1)
    RETURNING id
  `, [snapshotPlaceId, snapshotKindId])).rows[0]!.id)
  const undrawnSnapshot = (await client.query<{ payload: Record<string, unknown> }>(`
    SELECT payload FROM city_snapshot.public_records
    WHERE class_name = 'things' AND record_id = $1::text
  `, [snapshotThingId])).rows[0]!.payload
  assert.equal(undrawnSnapshot.drawing_source, 'none')
  assert.equal(undrawnSnapshot.kind_id, null)
  assert.equal(undrawnSnapshot.kind_name, null)
  assert.equal(undrawnSnapshot.revision, null)
  assert.equal(undrawnSnapshot.variant_name, null)
  const firstState = await releaseState(client)
  await client.query(drawingContractMigrationDdl)
  await client.query(worldRootDrawingMigrationDdl)
  const repeatedState = await releaseState(client)

  assert.deepEqual(firstState.worldHistory, [
    {
      author_id: null,
      author_relation: 'founder',
      prior_state: 'undrawn',
      prior_description: null,
      prior_drawing: null,
      prior_source: 'none',
      current_state: 'complete',
      current_description: '',
      current_drawing: founderWorldDrawing,
      current_source: 'place',
    },
  ])
  assert.deepEqual(repeatedState.world, {
    count: '1',
    drawing: founderWorldDrawing,
    drawing_state: 'complete',
    drawing_description: '',
  })
  assert.equal(repeatedState.historyCounts.founder_rows, '1')
  assert.equal(
    repeatedState.worldHistory.filter(history => history.author_relation === 'founder').length,
    1,
  )
  assert.deepEqual(firstState.constraints, [
    { conname: 'kind_revisions_drawing_contract', convalidated: true },
    { conname: 'places_drawing_contract', convalidated: true },
    { conname: 'places_world_drawing_exact', convalidated: true },
    { conname: 'places_world_shape', convalidated: true },
    { conname: 'residents_drawing_contract', convalidated: true },
    { conname: 'things_drawing_contract', convalidated: true },
  ])
  assert.deepEqual(repeatedState.constraints, firstState.constraints)
  assert.deepEqual(firstState.triggers, [
    { table_name: 'drawing_revisions', trigger_name: 'drawing_revisions_append_only', enabled: 'O' },
    { table_name: 'places', trigger_name: 'places_protect_topology_write', enabled: 'O' },
  ])
  assert.deepEqual(repeatedState.triggers, firstState.triggers)
  assert.deepEqual(firstState.views, {
    drawing_revisions: 'drawing_revisions',
    public_records: 'city_snapshot.public_records',
    public_records_without_drawing_contract:
      'city_snapshot.public_records_without_drawing_contract',
  })
  assert.deepEqual(repeatedState.views, firstState.views)
})

test('a completed contract rerun cannot relabel later authored drawings as legacy', async t => {
  const client = await startPostgres(t, 'drawing-late-rerun')
  await client.query(preDrawingSchemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (1, 'later-drawing-owner', 'integration', $1)
  `, ['3'.repeat(64)])
  await client.query(`
    UPDATE resident_id_allocator
    SET last_id = greatest(last_id, 1)
    WHERE singleton
  `)
  const placeId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    SELECT id, 'continent', 'Later Drawing Quarter', 'undrawn before the contract', 1
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `)).rows[0]!.id)
  const thingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id)
    VALUES ($1, 'later drawn untyped thing', '', 1, 1)
    RETURNING id
  `, [placeId])).rows[0]!.id)
  const kindId = Number((await client.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('later-drawn-kind', 1)
    RETURNING id
  `)).rows[0]!.id)
  await client.query(`
    INSERT INTO kind_revisions (kind_id, revision, description)
    VALUES ($1, 1, 'undrawn before the contract')
  `, [kindId])
  await client.query(drawingContractMigrationDdl)
  assert.equal((await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM drawing_revisions
    WHERE (target_type = 'resident' AND target_id = 1)
      OR (target_type = 'place' AND target_id = $1)
      OR (target_type = 'thing' AND target_id = $2)
      OR (target_type = 'kind' AND target_id = $3)
  `, [placeId, thingId, kindId])).rows[0]!.count, '0')
  await client.query('BEGIN')
  try {
    await client.query(`
      UPDATE residents SET drawing = $1::jsonb, drawing_state = 'complete',
        drawing_description = 'resident-authored after install'
      WHERE id = 1
    `, [JSON.stringify(authoredResidentDrawing)])
    await client.query(`
      INSERT INTO drawing_revisions (
        target_type, target_id,
        prior_state, prior_description, prior_drawing, prior_source,
        current_state, current_description, current_drawing, current_source,
        author_id, author_relation
      ) VALUES (
        'resident', 1,
        'undrawn', NULL, NULL, 'none',
        'complete', 'resident-authored after install', $1::jsonb, 'resident',
        1, 'self'
      )
    `, [JSON.stringify(authoredResidentDrawing)])
    await client.query(`
      UPDATE places SET drawing = $1::jsonb, drawing_state = 'complete',
        drawing_description = 'place-authored after install'
      WHERE id = $2
    `, [JSON.stringify(authoredPlaceDrawing), placeId])
    await client.query(`
      INSERT INTO drawing_revisions (
        target_type, target_id,
        prior_state, prior_description, prior_drawing, prior_source,
        current_state, current_description, current_drawing, current_source,
        author_id, author_relation
      ) VALUES (
        'place', $2,
        'undrawn', NULL, NULL, 'none',
        'complete', 'place-authored after install', $1::jsonb, 'place',
        1, 'owner'
      )
    `, [JSON.stringify(authoredPlaceDrawing), placeId])
    await client.query(`
      UPDATE things SET drawing = $1::jsonb, drawing_state = 'complete',
        drawing_description = 'thing-authored after install'
      WHERE id = $2
    `, [JSON.stringify(authoredThingDrawing), thingId])
    await client.query(`
      INSERT INTO drawing_revisions (
        target_type, target_id,
        prior_state, prior_description, prior_drawing, prior_source,
        current_state, current_description, current_drawing, current_source,
        author_id, author_relation
      ) VALUES (
        'thing', $2,
        'undrawn', NULL, NULL, 'none',
        'complete', 'thing-authored after install', $1::jsonb, 'thing',
        1, 'owner'
      )
    `, [JSON.stringify(authoredThingDrawing), thingId])
    await client.query(`
      INSERT INTO kind_revisions (
        kind_id, revision, description, drawing,
        drawing_state, drawing_description, drawing_variants
      ) VALUES (
        $2, 2, 'drawn after the contract', $1::jsonb,
        'complete', 'kind-authored after install', '[]'::jsonb
      )
    `, [JSON.stringify(authoredKindDrawing), kindId])
    await client.query(`
      INSERT INTO drawing_revisions (
        target_type, target_id,
        prior_state, prior_description, prior_drawing, prior_source,
        current_state, current_description, current_drawing, current_source,
        current_kind_id, current_kind_revision,
        author_id, author_relation
      ) VALUES (
        'kind', $2,
        'undrawn', NULL, NULL, 'none',
        'complete', 'kind-authored after install', $1::jsonb, 'kind_base',
        $2, 2,
        1, 'kind_owner'
      )
    `, [JSON.stringify(authoredKindDrawing), kindId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
  const authoredHistory = (await client.query<{
    id: string
    target_type: string
    target_id: number
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
    current_kind_id: number | null
    current_kind_revision: number | null
    author_id: number | null
    author_relation: string
    created_at: string
  }>(`
    SELECT id::text, target_type, target_id,
      prior_state, prior_description, prior_drawing, prior_source,
      current_state, current_description, current_drawing, current_source,
      current_kind_id, current_kind_revision,
      author_id, author_relation, created_at::text
    FROM drawing_revisions
    WHERE (target_type = 'resident' AND target_id = 1)
      OR (target_type = 'place' AND target_id = $1)
      OR (target_type = 'thing' AND target_id = $2)
      OR (target_type = 'kind' AND target_id = $3)
    ORDER BY id
  `, [placeId, thingId, kindId])).rows
  assert.deepEqual(
    authoredHistory.map(row => [
      row.target_type, row.target_id,
      row.prior_state, row.prior_description, row.prior_drawing, row.prior_source,
      row.current_state, row.current_description, row.current_drawing, row.current_source,
      row.current_kind_id, row.current_kind_revision, row.author_id, row.author_relation,
    ]),
    [
      ['resident', 1, 'undrawn', null, null, 'none', 'complete',
        'resident-authored after install', authoredResidentDrawing, 'resident', null, null, 1, 'self'],
      ['place', placeId, 'undrawn', null, null, 'none', 'complete',
        'place-authored after install', authoredPlaceDrawing, 'place', null, null, 1, 'owner'],
      ['thing', thingId, 'undrawn', null, null, 'none', 'complete',
        'thing-authored after install', authoredThingDrawing, 'thing', null, null, 1, 'owner'],
      ['kind', kindId, 'undrawn', null, null, 'none', 'complete',
        'kind-authored after install', authoredKindDrawing, 'kind_base', kindId, 2, 1, 'kind_owner'],
    ],
  )
  await client.query(drawingContractMigrationDdl)
  const repeatedHistory = (await client.query(`
    SELECT id::text, target_type, target_id,
      prior_state, prior_description, prior_drawing, prior_source,
      current_state, current_description, current_drawing, current_source,
      current_kind_id, current_kind_revision,
      author_id, author_relation, created_at::text
    FROM drawing_revisions
    WHERE (target_type = 'resident' AND target_id = 1)
      OR (target_type = 'place' AND target_id = $1)
      OR (target_type = 'thing' AND target_id = $2)
      OR (target_type = 'kind' AND target_id = $3)
    ORDER BY id
  `, [placeId, thingId, kindId])).rows
  assert.equal(
    repeatedHistory.filter(row => row.author_relation === 'legacy').length,
    0,
    'a completed-contract rerun must not reinterpret later authored pixels as legacy',
  )
  assert.deepEqual(repeatedHistory, authoredHistory, 'a rerun must preserve exact authored history')
})

test('legacy drawings bridge into one stable history row per source before the founder world write', async t => {
  const client = await startPostgres(t, 'drawing-legacy-upgrade')

  await client.query(preDrawingSchemaDdl)
  await client.query(legacyDrawingsMigrationDdl)
  await client.query(worldRootDrawingMigrationDdl)
  const seeded = await seedLegacyDrawings(client)

  await client.query(drawingContractMigrationDdl)
  await client.query(worldRootDrawingMigrationDdl)
  const firstState = await releaseState(client)
  await client.query(drawingContractMigrationDdl)
  await client.query(worldRootDrawingMigrationDdl)
  const repeatedState = await releaseState(client)

  assert.deepEqual(repeatedState, firstState, 'legacy bridge path must rerun exactly')
  assert.deepEqual(repeatedState.world, {
    count: '1',
    drawing: founderWorldDrawing,
    drawing_state: 'complete',
    drawing_description: '',
  })
  assert.equal(repeatedState.worldHistory.length, 1)
  assert.equal(repeatedState.worldHistory[0]!.author_relation, 'founder')
  assert.deepEqual(
    repeatedState.worldHistory.map(history => ({
      author_id: history.author_id,
      prior_state: history.prior_state,
      prior_description: history.prior_description,
      prior_drawing: history.prior_drawing,
      prior_source: history.prior_source,
      current_state: history.current_state,
      current_description: history.current_description,
      current_drawing: history.current_drawing,
      current_source: history.current_source,
    })),
    [{
      author_id: null,
      prior_state: 'undrawn',
      prior_description: null,
      prior_drawing: null,
      prior_source: 'none',
      current_state: 'complete',
      current_description: '',
      current_drawing: founderWorldDrawing,
      current_source: 'place',
    }],
  )
  assert.deepEqual(repeatedState.typedThingCurrent, {
    drawing: null,
    drawing_state: 'undrawn',
    drawing_description: null,
  })
  assert.deepEqual(repeatedState.historyCounts, {
    founder_rows: '1',
    legacy_rows: '4',
    total_rows: '5',
    typed_legacy_rows: '1',
  })
  assert.deepEqual(repeatedState.legacyRows, [
    {
      target_type: 'kind',
      target_id: seeded.kindId,
      author_relation: 'legacy',
      prior_state: 'undrawn',
      prior_description: null,
      prior_drawing: null,
      prior_source: 'none',
      current_state: 'complete',
      current_description: '',
      current_drawing: legacyKindDrawing,
      current_source: 'kind_base',
    },
    {
      target_type: 'resident',
      target_id: 1,
      author_relation: 'legacy',
      prior_state: 'undrawn',
      prior_description: null,
      prior_drawing: null,
      prior_source: 'none',
      current_state: 'complete',
      current_description: '',
      current_drawing: legacyResidentDrawing,
      current_source: 'resident',
    },
    {
      target_type: 'thing',
      target_id: seeded.untypedThingId,
      author_relation: 'legacy',
      prior_state: 'undrawn',
      prior_description: null,
      prior_drawing: null,
      prior_source: 'none',
      current_state: 'complete',
      current_description: '',
      current_drawing: legacyUntypedThingDrawing,
      current_source: 'thing',
    },
    {
      target_type: 'thing',
      target_id: seeded.typedThingId,
      author_relation: 'legacy',
      prior_state: 'complete',
      prior_description: '',
      prior_drawing: legacyTypedThingDrawing,
      prior_source: 'thing',
      current_state: 'undrawn',
      current_description: null,
      current_drawing: null,
      current_source: 'none',
    },
  ])
  assert.deepEqual(repeatedState.constraints, [
    { conname: 'kind_revisions_drawing_contract', convalidated: true },
    { conname: 'places_drawing_contract', convalidated: true },
    { conname: 'places_world_drawing_exact', convalidated: true },
    { conname: 'places_world_shape', convalidated: true },
    { conname: 'residents_drawing_contract', convalidated: true },
    { conname: 'things_drawing_contract', convalidated: true },
  ])
  assert.deepEqual(repeatedState.triggers, [
    { table_name: 'drawing_revisions', trigger_name: 'drawing_revisions_append_only', enabled: 'O' },
    { table_name: 'places', trigger_name: 'places_protect_topology_write', enabled: 'O' },
  ])
})

async function releaseState(client: Client): Promise<Readonly<{
  world: Readonly<{
    count: string
    drawing: unknown
    drawing_state: string
    drawing_description: string
  }>
  worldHistory: readonly Readonly<{
    author_id: number | null
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>[]
  typedThingCurrent: Readonly<{
    drawing: unknown
    drawing_state: string | null
    drawing_description: string | null
  }> | null
  historyCounts: Readonly<{
    founder_rows: string
    legacy_rows: string
    total_rows: string
    typed_legacy_rows: string
  }>
  legacyRows: readonly Readonly<{
    target_type: string
    target_id: number
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>[]
  constraints: readonly Readonly<{ conname: string; convalidated: boolean }>[]
  triggers: readonly Readonly<{ table_name: string; trigger_name: string; enabled: string }>[]
  views: Readonly<{
    drawing_revisions: string | null
    public_records: string | null
    public_records_without_drawing_contract: string | null
  }>
}>> {
  const world = (await client.query<{
    count: string
    drawing: unknown
    drawing_state: string
    drawing_description: string
  }>(`
    SELECT count(*)::text AS count,
      min(drawing::text)::jsonb AS drawing,
      min(drawing_state) AS drawing_state,
      min(drawing_description) AS drawing_description
    FROM places WHERE place_kind = 'world'
  `)).rows[0]!
  const worldHistory = (await client.query<{
    author_id: number | null
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>(`
    SELECT revision.author_id, revision.author_relation,
      revision.prior_state, revision.prior_description, revision.prior_drawing, revision.prior_source,
      revision.current_state, revision.current_description, revision.current_drawing, revision.current_source
    FROM drawing_revisions revision
    JOIN places world ON world.id = revision.target_id
    WHERE revision.target_type = 'place'
      AND world.place_kind = 'world'
    ORDER BY revision.id
  `)).rows
  const typedThingCurrent = (await client.query<{
    drawing: unknown
    drawing_state: string | null
    drawing_description: string | null
  }>(`
    SELECT thing.drawing, thing.drawing_state, thing.drawing_description
    FROM things thing
    WHERE thing.name = 'legacy typed thing'
  `)).rows[0] ?? null
  const historyCounts = (await client.query<{
    founder_rows: string
    legacy_rows: string
    total_rows: string
    typed_legacy_rows: string
  }>(`
    SELECT
      count(*) FILTER (WHERE author_relation = 'founder')::text AS founder_rows,
      count(*) FILTER (WHERE author_relation = 'legacy')::text AS legacy_rows,
      count(*)::text AS total_rows,
      count(*) FILTER (
        WHERE author_relation = 'legacy'
          AND target_type = 'thing'
          AND prior_source = 'thing'
          AND current_source = 'none'
      )::text AS typed_legacy_rows
    FROM drawing_revisions
  `)).rows[0]!
  const legacyRows = (await client.query<{
    target_type: string
    target_id: number
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>(`
    SELECT
      target_type, target_id, author_relation,
      prior_state, prior_description, prior_drawing, prior_source,
      current_state, current_description, current_drawing, current_source
    FROM drawing_revisions
    WHERE author_relation = 'legacy'
    ORDER BY target_type, target_id, id
  `)).rows
  const constraints = (await client.query<{ conname: string; convalidated: boolean }>(`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'residents_drawing_contract',
      'places_drawing_contract',
      'kind_revisions_drawing_contract',
      'things_drawing_contract',
      'places_world_shape',
      'places_world_drawing_exact'
    )
    ORDER BY conname
  `)).rows
  const triggers = (await client.query<{
    table_name: string
    trigger_name: string
    enabled: string
  }>(`
    SELECT trigger.tgrelid::regclass::text AS table_name,
      trigger.tgname AS trigger_name,
      trigger.tgenabled AS enabled
    FROM pg_trigger trigger
    WHERE NOT trigger.tgisinternal AND trigger.tgname IN (
      'drawing_revisions_append_only',
      'places_protect_topology_write'
    )
    ORDER BY table_name, trigger_name
  `)).rows
  const views = (await client.query<{
    drawing_revisions: string | null
    public_records: string | null
    public_records_without_drawing_contract: string | null
  }>(`
    SELECT
      to_regclass('public.drawing_revisions')::text AS drawing_revisions,
      to_regclass('city_snapshot.public_records')::text AS public_records,
      to_regclass('city_snapshot.public_records_without_drawing_contract')::text
        AS public_records_without_drawing_contract
  `)).rows[0]!
  return Object.freeze({
    world: Object.freeze(world),
    worldHistory,
    typedThingCurrent: typedThingCurrent ? Object.freeze(typedThingCurrent) : null,
    historyCounts: Object.freeze(historyCounts),
    legacyRows,
    constraints,
    triggers,
    views: Object.freeze(views),
  })
}

function drawing(colour: string): Readonly<{ palette: readonly string[]; indices: readonly (number | null)[] }> {
  return Object.freeze({
    palette: Object.freeze([colour]),
    indices: Object.freeze(Array.from({ length: 64 }, (_, index) => (index === 0 ? 0 : null))),
  })
}

async function seedLegacyDrawings(client: Client): Promise<Readonly<{
  placeId: number
  kindId: number
  untypedThingId: number
  typedThingId: number
}>> {
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (1, 'legacy-owner', 'integration', $1)
    ON CONFLICT (id) DO UPDATE SET
      handle = EXCLUDED.handle,
      model = EXCLUDED.model,
      secret_hash = EXCLUDED.secret_hash
  `, ['1'.repeat(64)])
  await client.query(`
    UPDATE residents
    SET drawing = $1::jsonb
    WHERE id = 1
  `, [JSON.stringify(legacyResidentDrawing)])
  await client.query(`
    UPDATE resident_id_allocator
    SET last_id = greatest(last_id, 1)
    WHERE singleton
  `)
  const placeId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    SELECT id, 'continent', 'Legacy Drawing Quarter', 'legacy drawing place', 1
    FROM places
    WHERE place_kind = 'world'
    RETURNING id
  `)).rows[0]!.id)
  const drawnKindId = Number((await client.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('legacy-drawn-kind', 1) RETURNING id
  `)).rows[0]!.id)
  await client.query(`
    INSERT INTO kind_revisions (kind_id, revision, description, drawing)
    VALUES ($1, 1, 'legacy drawn kind', $2::jsonb)
  `, [drawnKindId, JSON.stringify(legacyKindDrawing)])
  const undrawnKindId = Number((await client.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('legacy-undrawn-kind', 1) RETURNING id
  `)).rows[0]!.id)
  await client.query(`
    INSERT INTO kind_revisions (kind_id, revision, description)
    VALUES ($1, 1, 'legacy undrawn kind')
  `, [undrawnKindId])
  const untypedThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, drawing)
    VALUES ($1, 'legacy untyped thing', '', 1, 1, $2::jsonb)
    RETURNING id
  `, [placeId, JSON.stringify(legacyUntypedThingDrawing)])).rows[0]!.id)
  const typedThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, drawing
    ) VALUES ($1, 'legacy typed thing', '', 1, 1, $2, 1, 1, $3::jsonb)
    RETURNING id
  `, [placeId, undrawnKindId, JSON.stringify(legacyTypedThingDrawing)])).rows[0]!.id)
  return Object.freeze({
    placeId,
    kindId: drawnKindId,
    untypedThingId,
    typedThingId,
  })
}
