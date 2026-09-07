import assert from 'node:assert/strict'
import type { Client } from 'pg'
import { founderWorldDrawing } from '../../helpers/drawing-upgrade-fixtures/drawing-samples.ts'
import { releaseState } from '../../helpers/drawing-upgrade-fixtures/release-state.ts'

export async function registerReleaseOrderTests(
  client: Client,
  preDrawingSchemaDdl: string,
  gazetteMigrationDdl: string,
  drawingContractMigrationDdl: string,
  worldRootDrawingMigrationDdl: string,
  snapshotExportPrivileges: (client: Client) => Promise<Readonly<{
    public_records: boolean
    public_records_v2: boolean
  }>>,
): Promise<void> {

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

  await client.query(gazetteMigrationDdl)
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: true,
    public_records_v2: true,
  })
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

  const residentEditedEventId = Number((await client.query<{ id: string }>(`
    INSERT INTO events (kind, actor, detail)
    VALUES ('resident_edited', 'snapshot-owner', $1::jsonb)
    RETURNING id::text
  `, [JSON.stringify({ resident_id: 1, error: 'must stay private' })])).rows[0]!.id)
  const privateEventId = Number((await client.query<{ id: string }>(`
    INSERT INTO events (kind, actor, detail)
    VALUES ('drawing_upgrade_private_fixture', 'snapshot-owner', $1::jsonb)
    RETURNING id::text
  `, [JSON.stringify({ error: 'must stay private' })])).rows[0]!.id)
  const gazetteEventId = Number((await client.query<{ id: string }>(`
    INSERT INTO events (kind, actor, detail)
    VALUES ('gazette_printed', 'the Gazette printer', $1::jsonb)
    RETURNING id::text
  `, [JSON.stringify({ error: 'must stay private' })])).rows[0]!.id)
  await client.query(`
    INSERT INTO gazette_issues (
      issue_number, scheduled_for, printed_at, header, entry_count, event_id
    ) VALUES (
      1,
      TIMESTAMPTZ '2026-08-31 16:00:00+00',
      TIMESTAMPTZ '2026-08-31 16:00:00+00',
      'The Gazette — Issue 1 — 2026-08-31',
      0,
      $1
    )
  `, [gazetteEventId])

  const v2ViewDefinition = (await client.query<{ definition: string }>(`
    SELECT pg_get_viewdef('city_snapshot.public_records_v2'::regclass, TRUE) AS definition
  `)).rows[0]!.definition
  assert.match(v2ViewDefinition, /FROM city_snapshot\.public_records base_record/iu)
  assert.doesNotMatch(v2ViewDefinition, /public_records_without_drawing_contract/iu)
  const v2Records = new Map((await client.query<{
    class_name: string
    record_id: string
    payload: Record<string, unknown>
  }>(`
    SELECT class_name, record_id, payload
    FROM city_snapshot.public_records_v2
    WHERE (class_name = 'events' AND record_id IN ($1::text, $2::text, $3::text))
      OR class_name IN ('drawing_revisions', 'gazette_issues')
    ORDER BY class_name, record_id
  `, [residentEditedEventId, privateEventId, gazetteEventId])).rows.map(record => [
    `${record.class_name}:${record.record_id}`,
    record.payload,
  ]))
  assert.deepEqual(v2Records.get(`events:${residentEditedEventId}`), {
    id: residentEditedEventId,
    kind: 'resident_edited',
    actor: 'snapshot-owner',
    detail: { resident_id: 1 },
    at: v2Records.get(`events:${residentEditedEventId}`)?.at,
    status: 'exported',
    detail_policy: 'safe references only; authored text is in its primary exported record',
  })
  assert.deepEqual(v2Records.get(`events:${privateEventId}`), {
    id: privateEventId,
    status: 'not_public_or_sequence_gap',
  })
  assert.deepEqual(v2Records.get(`events:${gazetteEventId}`), {
    id: gazetteEventId,
    kind: 'gazette_printed',
    actor: 'the Gazette printer',
    detail: { issue_number: 1, entry_count: 0 },
    at: v2Records.get(`events:${gazetteEventId}`)?.at,
    status: 'exported',
    detail_policy: 'safe references only; authored text is in its primary exported record',
  })
  assert.equal(
    [...v2Records.keys()].some(key => key.startsWith('drawing_revisions:')),
    true,
  )
  assert.equal(v2Records.get('gazette_issues:1')?.issue_number, 1)
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: true,
    public_records_v2: true,
  })
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
}
