import assert from 'node:assert/strict'
import type { Client } from 'pg'
import {
  founderWorldDrawing,
  legacyKindDrawing,
  legacyResidentDrawing,
  legacyTypedThingDrawing,
  legacyUntypedThingDrawing,
} from '../../helpers/drawing-upgrade-fixtures/drawing-samples.ts'
import { releaseState } from '../../helpers/drawing-upgrade-fixtures/release-state.ts'

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

export async function registerLegacyBridgeTests(
  client: Client,
  preDrawingSchemaDdl: string,
  legacyDrawingsMigrationDdl: string,
  worldRootDrawingMigrationDdl: string,
  drawingContractMigrationDdl: string,
): Promise<void> {

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

}
