import assert from 'node:assert/strict'
import type { Client } from 'pg'
import { Hono } from 'hono'
import { founderWorldDrawing, rowsFor } from '../../helpers/drawings-fixtures/drawing-samples.ts'

export async function registerSnapshotInheritanceTests(
  client: Client,
  snapshot: (className: string, recordId: number) => Promise<Record<string, unknown>>,
  replacement: { palette: string[]; indices: (number | null)[] },
  freshWorld: { id: number; drawing: unknown },
  placeId: number,
  placeDrawing: { palette: string[]; indices: (number | null)[] },
  kindId: number,
  kindDrawing: { palette: string[]; indices: (number | null)[] },
  ownThingId: number,
  thingDrawing: { palette: string[]; indices: (number | null)[] },
  inheritedThingId: number,
  variantThingId: number,
  kindVariants: { name: string; drawing: { palette: string[]; indices: (number | null)[] }; state: string; description: string }[],
): Promise<void> {
  assert.deepEqual((await snapshot('residents', 1)).drawing, replacement)
  assert.equal((await snapshot('residents', 1)).drawing_state, 'in_progress')
  assert.equal(
    (await snapshot('residents', 1)).drawing_description,
    'The replacement is deliberately unfinished.',
  )
  assert.deepEqual((await snapshot('residents', 1)).drawing_rows, rowsFor(replacement))
  assert.equal((await snapshot('residents', 1)).drawing_source, 'resident')
  assert.deepEqual((await snapshot('places', freshWorld.id)).drawing, founderWorldDrawing)
  assert.equal((await snapshot('places', freshWorld.id)).drawing_state, 'complete')
  assert.deepEqual((await snapshot('places', freshWorld.id)).drawing_rows, rowsFor(founderWorldDrawing))
  assert.equal((await snapshot('places', freshWorld.id)).drawing_source, 'place')
  assert.deepEqual((await snapshot('places', placeId)).drawing, placeDrawing)
  assert.equal((await snapshot('places', placeId)).drawing_source, 'place')
  assert.deepEqual((await snapshot('kinds', kindId)).drawing, kindDrawing)
  assert.equal((await snapshot('kinds', kindId)).drawing_source, 'kind_base')
  assert.equal((await snapshot('kinds', kindId)).revision, 1)
  assert.deepEqual((await snapshot('things', ownThingId)).drawing, thingDrawing)
  assert.equal((await snapshot('things', ownThingId)).drawing_source, 'thing')
  assert.deepEqual((await snapshot('things', inheritedThingId)).drawing, kindDrawing)
  assert.equal((await snapshot('things', inheritedThingId)).drawing_source, 'kind_base')
  assert.equal((await snapshot('things', inheritedThingId)).kind_id, kindId)
  assert.equal((await snapshot('things', inheritedThingId)).revision, 1)
  assert.deepEqual((await snapshot('things', variantThingId)).drawing, kindVariants[0]!.drawing)
  assert.equal((await snapshot('things', variantThingId)).drawing_source, 'kind_variant')
  assert.equal((await snapshot('things', variantThingId)).variant_name, 'blue-shutter')

  await client.query('UPDATE things SET owner_id = 2 WHERE id = $1', [variantThingId])
  assert.deepEqual((await snapshot('things', variantThingId)).drawing, kindVariants[0]!.drawing)
  assert.equal((await snapshot('things', variantThingId)).drawing_source, 'kind_variant')
  assert.equal((await snapshot('things', variantThingId)).variant_name, 'blue-shutter')

  await client.query(`
    UPDATE things
    SET drawing = NULL,
      drawing_state = 'refused',
      drawing_description = 'The thing owner refuses the selected kind variant.'
    WHERE id = $1
  `, [variantThingId])
  const refusedVariantSnapshot = await snapshot('things', variantThingId)
  assert.equal(refusedVariantSnapshot.drawing_state, 'refused')
  assert.equal(refusedVariantSnapshot.drawing_source, 'thing')
  assert.equal(refusedVariantSnapshot.variant_name, null)

  const { mountDrawingRoutes: mountRefusalDrawingRoutes } = await import('../../../src/drawings.ts')
  const refusalDrawingApp = new Hono()
  mountRefusalDrawingRoutes(refusalDrawingApp, {
    database: {
      query: async (text: string, params: readonly unknown[] = []) =>
        (await client!.query(text, [...params])).rows,
    },
    authenticate: async () => null,
  })
  const refusedVariantCurrent = await refusalDrawingApp.request(
    `/api/drawing/thing/${variantThingId}`,
  )
  assert.equal(refusedVariantCurrent.status, 200)
  assert.deepEqual(await refusedVariantCurrent.json(), {
    type: 'thing', id: variantThingId,
    state: 'refused', presentation_state: 'refused',
    description: 'The thing owner refuses the selected kind variant.',
    drawing: null, rows: null, source: 'thing',
    kind_id: kindId, revision: 1,
  })
  await client.query(`
    UPDATE things
    SET drawing = NULL, drawing_state = 'undrawn', drawing_description = NULL
    WHERE id = $1
  `, [variantThingId])
  assert.equal((await snapshot('things', variantThingId)).drawing_source, 'kind_variant')
  assert.equal((await snapshot('things', variantThingId)).variant_name, 'blue-shutter')

  await client.query(`
    UPDATE things
    SET drawing = NULL,
      drawing_state = 'refused',
      drawing_description = 'The thing owner refuses inherited artwork.'
    WHERE id = $1
  `, [inheritedThingId])
  assert.equal((await snapshot('things', inheritedThingId)).drawing, null)
  assert.equal((await snapshot('things', inheritedThingId)).drawing_state, 'refused')
  assert.equal((await snapshot('things', inheritedThingId)).drawing_source, 'thing')
  await client.query(`
    UPDATE things
    SET drawing = NULL, drawing_state = 'undrawn', drawing_description = NULL
    WHERE id = $1
  `, [inheritedThingId])
  assert.deepEqual((await snapshot('things', inheritedThingId)).drawing, kindDrawing)
  assert.equal((await snapshot('things', inheritedThingId)).drawing_source, 'kind_base')
  const eventId = Number((await client.query<{ id: number }>(`
    SELECT id FROM events WHERE kind = 'resident_edited' ORDER BY id DESC LIMIT 1
  `)).rows[0]!.id)
  assert.deepEqual((await snapshot('events', eventId)).detail, {
    resident_id: 1, source_thing_id: ownThingId,
  })

  await client.query(`
    INSERT INTO drawing_revisions (
      target_type, target_id,
      prior_state, prior_description, prior_drawing, prior_source,
      prior_kind_id, prior_kind_revision,
      current_state, current_description, current_drawing, current_source,
      current_kind_id, current_kind_revision, current_variant_name,
      slot_variant_name, author_id, author_relation
    ) VALUES (
      'thing', $1,
      'complete', 'The kind owner’s plain lantern.', $2::jsonb, 'kind_base',
      $3, 1,
      'complete', 'A blue shutter over the kind owner’s lantern.', $4::jsonb, 'kind_variant',
      $3, 1, 'blue-shutter',
      'blue-shutter', 1, 'owner'
    )
  `, [
    inheritedThingId,
    JSON.stringify(kindDrawing),
    kindId,
    JSON.stringify(kindVariants[0]!.drawing),
  ])

  await client.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES
      ('resident', 1, 'remove', 1, 'hide resident drawing'),
      ('kind', $1, 'remove', 1, 'hide kind drawing')
  `, [kindId])
  const hiddenResident = await snapshot('residents', 1)
  assert.equal(hiddenResident.handle, 'drawing-owner')
  assert.equal(hiddenResident.drawing, null)
  assert.equal((await snapshot('kinds', kindId)).status, 'maintainer_hidden')
  assert.equal((await snapshot('things', inheritedThingId)).drawing, null)
  assert.equal((await snapshot('things', inheritedThingId)).drawing_source, null)
  assert.deepEqual((await snapshot('things', ownThingId)).drawing, thingDrawing)
}
