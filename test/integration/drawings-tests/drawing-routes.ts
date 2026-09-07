import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Client } from 'pg'
import { Hono, type Context } from 'hono'
import type { Resident } from '../../../src/core.ts'
import { founderWorldDrawing, rowsFor } from '../../helpers/drawings-fixtures/drawing-samples.ts'

export async function registerDrawingRoutesTests(
  t: TestContext,
  client: Client,
  database: { query: (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]> },
  freshWorld: { id: number; drawing: unknown },
  inheritedThingId: number,
  drawing: (colour: string) => { palette: string[]; indices: (number | null)[] },
): Promise<void> {
  const drawingOwner: Resident = Object.freeze({
    id: 2,
    handle: 'paid-drawing-owner',
    model: 'integration',
    joined_at: '2026-08-27T00:00:00.000Z',
    quota_day: '2026-08-27',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  })
  const { mountDrawingRoutes } = await import('../../../src/drawings.ts')
  const drawingApp = new Hono()
  mountDrawingRoutes(drawingApp, {
    database,
    authenticate: async (_context: Context) => drawingOwner,
  })
  const worldDrawingRead = await drawingApp.request(`/api/drawing/place/${freshWorld.id}`)
  assert.equal(worldDrawingRead.status, 200)
  assert.deepEqual(await worldDrawingRead.json(), {
    type: 'place',
    id: freshWorld.id,
    state: 'complete',
    presentation_state: 'complete',
    description: '',
    drawing: founderWorldDrawing,
    rows: rowsFor(founderWorldDrawing),
    source: 'place',
  })
  const checkpoint = (await client.query<{ checkpoint: string }>(`
    SELECT current_change_id::text AS checkpoint
    FROM public_change_state
    WHERE singleton = true
  `)).rows[0]!.checkpoint
  const worldThumbnailRead = await drawingApp.request(
    `/api/drawing/place/${freshWorld.id}/thumb.png?rev=${checkpoint}`,
  )
  assert.equal(worldThumbnailRead.status, 200)
  assert.equal(worldThumbnailRead.headers.get('content-type'), 'image/png')
  assert.equal(
    worldThumbnailRead.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  )
  const worldThumbnailBytes = new Uint8Array(await worldThumbnailRead.arrayBuffer())
  assert.deepEqual([...worldThumbnailBytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const hiddenInheritedCurrent = await drawingApp.request(
    `/api/drawing/thing/${inheritedThingId}`,
  )
  assert.equal(hiddenInheritedCurrent.status, 200)
  assert.deepEqual(await hiddenInheritedCurrent.json(), {
    type: 'thing', id: inheritedThingId,
    state: 'undrawn', presentation_state: 'undrawn',
    description: null, drawing: null, rows: null, source: 'none',
  })
  const hiddenInheritedThumbnail = await drawingApp.request(
    `/api/drawing/thing/${inheritedThingId}/thumb.png?rev=${checkpoint}`,
  )
  assert.equal(hiddenInheritedThumbnail.status, 404)
  assert.equal(hiddenInheritedThumbnail.headers.get('cache-control'), 'no-store')
  const hiddenInheritedHistory = await drawingApp.request(
    `/api/drawing/thing/${inheritedThingId}/history`,
  )
  assert.equal(hiddenInheritedHistory.status, 200)
  assert.deepEqual(await hiddenInheritedHistory.json(), {
    type: 'thing', id: inheritedThingId,
    revisions: [],
    page: { limit: 20, has_more: false, next_before: null },
  })
  const admittedColours = ['#101010', '#202020', '#303030', '#404040', '#505050', '#606060']
  for (const colour of admittedColours) {
    const response = await drawingApp.request('/api/me/drawing', {
      method: 'PATCH',
      body: JSON.stringify({
        drawing: drawing(colour),
        drawing_state: 'complete',
        drawing_description: 'A resident rate-limit proof drawing.',
      }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json() as { changed: boolean }).changed, true)
  }
  const limited = await drawingApp.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({
      drawing: drawing('#707070'),
      drawing_state: 'complete',
      drawing_description: 'A resident rate-limit proof drawing.',
    }),
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  const exactRetry = await drawingApp.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({
      drawing: drawing(admittedColours.at(-1)!),
      drawing_state: 'complete',
      drawing_description: 'A resident rate-limit proof drawing.',
    }),
  })
  assert.equal(exactRetry.status, 200)
  assert.equal((await exactRetry.json() as { changed: boolean }).changed, false)
  assert.deepEqual((await client.query<{ used: number }>(`
    SELECT used FROM resident_drawing_rate_limits WHERE resident_id = 2
  `)).rows.map(row => Number(row.used)), [6])
  assert.equal(Number((await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM events
    WHERE kind = 'resident_edited' AND actor = 'paid-drawing-owner'
  `)).rows[0]?.count), 6)
}
