import assert from 'node:assert/strict'
import type { Client } from 'pg'
import { founderWorldDrawing } from '../../helpers/drawings-fixtures/drawing-samples.ts'

export async function registerDrawingConstraintsTests(
  client: Client,
  replacement: { palette: string[]; indices: (number | null)[] },
  inheritedThingId: number,
  thingDrawing: { palette: string[]; indices: (number | null)[] },
  kindId: number,
  placeDrawing: { palette: string[]; indices: (number | null)[] },
): Promise<void> {
  await client.query(`
    UPDATE residents
    SET drawing = $1::jsonb,
      drawing_state = 'in_progress',
      drawing_description = 'The replacement is deliberately unfinished.'
    WHERE id = 1
  `, [JSON.stringify(replacement)])
  assert.deepEqual(
    (await client.query<{
      drawing: unknown
      drawing_state: string
      drawing_description: string
    }>(`
      SELECT drawing, drawing_state, drawing_description FROM residents WHERE id = 1
    `)).rows[0],
    {
      drawing: replacement,
      drawing_state: 'in_progress',
      drawing_description: 'The replacement is deliberately unfinished.',
    },
  )

  await assert.rejects(
    client.query(`
      UPDATE things
      SET drawing = $2::jsonb,
        drawing_state = 'complete',
        drawing_description = 'Typed things may not invent instance pixels.'
      WHERE id = $1
    `, [inheritedThingId, JSON.stringify(thingDrawing)]),
    (error: unknown) => (error as { code?: string }).code === '23514',
  )
  await assert.rejects(
    client.query(`
      INSERT INTO kind_revisions (
        kind_id, revision, description, traits, recipe,
        drawing, drawing_state, drawing_description, drawing_variants
      )
      SELECT kind_id, 2, description, traits, recipe,
        drawing, drawing_state, drawing_description, $2::jsonb
      FROM kind_revisions
      WHERE kind_id = $1 AND revision = 1
    `, [kindId, JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      name: `variant-${index}`,
      drawing: thingDrawing,
      state: 'complete',
      description: `Variant ${index}.`,
    })))]),
    (error: unknown) => (error as { code?: string }).code === '23514',
  )

  await assert.rejects(
    client.query(
      "UPDATE places SET drawing = $1::jsonb WHERE place_kind = 'world'",
      [JSON.stringify(placeDrawing)],
    ),
    (error: unknown) => (error as { code?: string }).code === '55000',
  )
  assert.deepEqual(
    (await client.query<{ drawing: unknown }>("SELECT drawing FROM places WHERE place_kind = 'world'")).rows[0]?.drawing,
    founderWorldDrawing,
  )
}
