import assert from 'node:assert/strict'
import type { Client } from 'pg'
import {
  authoredKindDrawing,
  authoredPlaceDrawing,
  authoredResidentDrawing,
  authoredThingDrawing,
} from '../../helpers/drawing-upgrade-fixtures/drawing-samples.ts'

export async function registerCompletedContractRerunTests(
  client: Client,
  preDrawingSchemaDdl: string,
  drawingContractMigrationDdl: string,
  snapshotExportPrivileges: (client: Client) => Promise<Readonly<{
    public_records: boolean
    public_records_v2: boolean
  }>>,
): Promise<void> {
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
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: true,
    public_records_v2: false,
  })
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
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: true,
    public_records_v2: false,
  })
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
}
