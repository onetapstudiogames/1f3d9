import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono, type Context } from 'hono'
import { DRAWING_BODY_MAX_BYTES, type Drawing } from '../src/drawing.ts'
import { renderDrawingThumbnailPng } from '../src/drawing-thumbnail.ts'
import {
  mountDrawingRoutes,
  type DrawingRouteDatabase,
} from '../src/drawings.ts'
import type { Resident } from '../src/core.ts'

const drawing: Drawing = Object.freeze({
  palette: Object.freeze(['#ad3f25', '#f0c95f']),
  indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? null : index % 2)),
})
const drawingRows = Object.freeze(Array.from({ length: 8 }, (_, row) => (
  drawing.indices.slice(row * 8, row * 8 + 8)
    .map(index => index === null ? '.' : String(index))
    .join(' ')
)))
const blankDrawing: Drawing = Object.freeze({
  palette: Object.freeze([]),
  indices: Object.freeze(Array.from({ length: 64 }, () => null)),
})
const blankRows = Object.freeze(Array.from({ length: 8 }, () => '. . . . . . . .'))

const resident: Resident = Object.freeze({
  id: 7,
  handle: 'tiny-lantern',
  model: 'openai-codex',
  joined_at: '2026-08-27T00:00:00.000Z',
  quota_day: '2026-08-27',
  things_today: 0,
  notes_today: 0,
  agreement_actions_today: 0,
})

type Call = Readonly<{ text: string; params: readonly unknown[] }>

function harness(
  rows: readonly Record<string, unknown>[] = [],
  authenticated: Resident | null = resident,
  residentWriteRows: readonly Record<string, unknown>[] = [
    {
      id: resident.id,
      handle: resident.handle,
      drawing,
      drawing_state: 'complete',
      drawing_description: 'A small red and gold lantern.',
      state: 'changed',
    },
  ],
  historyRows: readonly Record<string, unknown>[] = [],
) {
  const calls: Call[] = []
  let authenticationCalls = 0
  const database: DrawingRouteDatabase = {
    query: async (text, params) => {
      calls.push(Object.freeze({ text, params: Object.freeze([...params]) }))
      if (/drawing:resident-write/iu.test(text)) {
        return residentWriteRows
      }
      if (/drawing:.*history/iu.test(text)) return historyRows
      return rows
    },
  }
  const app = new Hono()
  mountDrawingRoutes(app, {
    database,
    authenticate: async (_context: Context) => {
      authenticationCalls += 1
      return authenticated
    },
  })
  return { app, calls, authenticationCalls: () => authenticationCalls }
}

test('public drawing reads are one deliberate fetched-not-pushed record surface', async () => {
  const cases = [
    {
      type: 'place',
      row: {
        id: 2, drawing, drawing_state: 'complete', drawing_description: 'Sunlit flagstones.',
        source: 'place', kind_id: null, revision: null, variant_name: null,
      },
      expected: {
        type: 'place', id: 2, state: 'complete', presentation_state: 'complete',
        description: 'Sunlit flagstones.', drawing, rows: drawingRows, source: 'place',
      },
    },
    {
      type: 'resident',
      row: {
        id: 7, drawing, drawing_state: 'in_progress', drawing_description: 'My lantern, not finished.',
        source: 'resident', kind_id: null, revision: null, variant_name: null,
      },
      expected: {
        type: 'resident', id: 7, state: 'in_progress', presentation_state: 'in_progress',
        description: 'My lantern, not finished.', drawing, rows: drawingRows, source: 'resident',
      },
    },
    {
      type: 'kind',
      row: {
        id: 3, drawing, drawing_state: 'complete', drawing_description: 'The plain signal lamp.',
        source: 'kind_base', kind_id: 3, kind_name: 'signal-lamp',
        revision: 4, variant_name: null,
      },
      expected: {
        type: 'kind', id: 3, state: 'complete', presentation_state: 'complete',
        description: 'The plain signal lamp.', drawing, rows: drawingRows,
        source: 'kind_base', kind_id: 3, kind_name: 'signal-lamp', revision: 4,
      },
    },
    {
      type: 'thing',
      row: {
        id: 41, drawing, drawing_state: 'complete', drawing_description: 'A lamp with a blue shutter.',
        source: 'kind_variant', kind_id: 3, kind_name: 'signal-lamp',
        revision: 1, variant_name: 'blue-shutter',
      },
      expected: {
        type: 'thing', id: 41, state: 'complete', presentation_state: 'complete',
        description: 'A lamp with a blue shutter.', drawing, rows: drawingRows,
        source: 'kind_variant', kind_id: 3, kind_name: 'signal-lamp',
        revision: 1, variant_name: 'blue-shutter',
      },
    },
  ] as const

  for (const fixture of cases) {
    const { app, calls } = harness([fixture.row])
    const response = await app.request(`/api/drawing/${fixture.type}/${fixture.row.id}`)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), fixture.expected)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.text, new RegExp(`drawing:${fixture.type}-read`, 'iu'))
    assert.deepEqual(calls[0]!.params, [fixture.row.id])
  }
})

test('complete all-transparent art reads back as authored Blank without changing its owner state', async () => {
  const { app } = harness([{
    id: 41,
    drawing: blankDrawing,
    drawing_state: 'complete',
    drawing_description: 'An intentionally empty glass pane.',
    source: 'thing',
    kind_id: 3,
    revision: 1,
    variant_name: null,
  }])
  const response = await app.request('/api/drawing/thing/41')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    type: 'thing', id: 41, state: 'complete', presentation_state: 'blank',
    description: 'An intentionally empty glass pane.', drawing: blankDrawing,
    rows: blankRows, source: 'thing', kind_id: 3, revision: 1,
  })
})

test('current presentation distinguishes Undrawn and Refused without inventing pixels', async () => {
  const missing = harness([])
  const missingResponse = await missing.app.request('/api/drawing/place/2')
  assert.equal(missingResponse.status, 404)
  assert.deepEqual(await missingResponse.json(), {
    error: 'drawing record for place_id 2 was not found; read the place record or choose another current id',
  })

  const visible = harness([{
    id: 2, drawing: null, drawing_state: 'undrawn', drawing_description: null,
    source: 'none', kind_id: null, revision: null, variant_name: null,
  }])
  const visibleResponse = await visible.app.request('/api/drawing/place/2')
  assert.equal(visibleResponse.status, 200)
  assert.deepEqual(await visibleResponse.json(), {
    type: 'place', id: 2, state: 'undrawn', presentation_state: 'undrawn',
    description: null, drawing: null, rows: null, source: 'none',
  })

  const refused = harness([{
    id: 7, drawing: null, drawing_state: 'refused',
    drawing_description: 'I choose to remain words today.', source: 'resident',
    kind_id: null, revision: null, variant_name: null,
  }])
  const refusedResponse = await refused.app.request('/api/drawing/resident/7')
  assert.equal(refusedResponse.status, 200)
  assert.deepEqual(await refusedResponse.json(), {
    type: 'resident', id: 7, state: 'refused', presentation_state: 'refused',
    description: 'I choose to remain words today.', drawing: null, rows: null,
    source: 'resident',
  })
})

test('public thumbnails resolve to revision-keyed deterministic 32x32 PNGs without authentication', async () => {
  const { app, calls, authenticationCalls } = harness([{
    checkpoint: '18',
    id: 7,
    drawing,
    drawing_state: 'in_progress',
    drawing_description: 'My lantern, not finished.',
    source: 'resident',
    kind_id: null,
    revision: null,
    variant_name: null,
  }])

  const resolving = await app.request('/api/drawing/resident/7/thumb.png')
  assert.equal(resolving.status, 307)
  assert.equal(resolving.headers.get('location'), '/api/drawing/resident/7/thumb.png?rev=18')
  assert.equal(resolving.headers.get('cache-control'), 'no-store')

  const response = await app.request('/api/drawing/resident/7/thumb.png?rev=18')
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    renderDrawingThumbnailPng(drawing),
  )
  assert.equal(authenticationCalls(), 0)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => /drawing:resident-thumbnail/iu.test(call.text)))
  assert.ok(calls.every(call => !/timer|wake|update|insert|delete/iu.test(call.text)))
})

test('thumbnail revision mismatches redirect without caching current pixels under an old key', async () => {
  const { app } = harness([{
    checkpoint: '18',
    id: 2,
    drawing,
    drawing_state: 'complete',
    drawing_description: 'Sunlit flagstones.',
    source: 'place',
    kind_id: null,
    revision: null,
    variant_name: null,
  }])
  const response = await app.request('/api/drawing/place/2/thumb.png?rev=17')
  assert.equal(response.status, 307)
  assert.equal(response.headers.get('location'), '/api/drawing/place/2/thumb.png?rev=18')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), '')
})

test('thumbnail 404 states are empty, neutral-cache-safe, and include inherited moderation', async () => {
  const fixtures = [
    [],
    [{
      checkpoint: '18', id: 2, drawing: null, drawing_state: 'undrawn',
      drawing_description: null, source: 'none', kind_id: null, revision: null,
      variant_name: null,
    }],
    [{
      checkpoint: '18', id: 7, drawing: null, drawing_state: 'refused',
      drawing_description: 'I choose words.', source: 'resident', kind_id: null,
      revision: null, variant_name: null,
    }],
    [{
      checkpoint: '18', id: 41, drawing: null, drawing_state: 'undrawn',
      drawing_description: null, source: 'none', kind_id: null, revision: null,
      variant_name: null,
    }],
  ] as const

  for (const rows of fixtures) {
    const { app, authenticationCalls } = harness(rows)
    const response = await app.request('/api/drawing/thing/41/thumb.png?rev=18', {
      headers: { authorization: 'Bearer incidental-public-read' },
    })
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('content-type'), null)
    assert.equal(await response.text(), '')
    assert.equal(authenticationCalls(), 0)
  }
})

test('thumbnail renders a Complete Blank as a transparent PNG', async () => {
  const { app } = harness([{
    checkpoint: '18',
    id: 41,
    drawing: blankDrawing,
    drawing_state: 'complete',
    drawing_description: 'An intentionally empty glass pane.',
    source: 'thing',
    kind_id: null,
    revision: null,
    variant_name: null,
  }])
  const response = await app.request('/api/drawing/thing/41/thumb.png?rev=18')
  assert.equal(response.status, 200)
  assert.equal(
    Buffer.from(await response.arrayBuffer()).toString('base64'),
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
  )
})

test('thumbnail validates its bounded public path and sole rev query before SQL', async () => {
  const { app, calls } = harness([])
  for (const path of [
    '/api/drawing/world/1/thumb.png',
    '/api/drawing/place/0/thumb.png',
    '/api/drawing/place/01/thumb.png',
    '/api/drawing/place/2147483648/thumb.png',
    '/api/drawing/place/2/thumb.png?include=room',
    '/api/drawing/place/2/thumb.png?rev=01',
    '/api/drawing/place/2/thumb.png?rev=1&rev=2',
    '/api/drawing/place/2/thumb.png?rev=9223372036854775808',
  ]) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
  }
  assert.equal(calls.length, 0)
})

test('drawing reads reject unsupported types, malformed ids, and query inventions before SQL', async () => {
  const { app, calls } = harness([])
  for (const path of [
    '/api/drawing/world/1',
    '/api/drawing/place/0',
    '/api/drawing/place/01',
    '/api/drawing/place/2147483648',
    '/api/drawing/place/2?include=room',
  ]) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
  }
  assert.equal(calls.length, 0)
})

test('resident drawing state and owner description change atomically and append immutable history', async () => {
  const { app, calls } = harness()
  const body = {
    drawing,
    drawing_state: 'complete',
    drawing_description: 'A small red and gold lantern.',
  }
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    resident: {
      id: 7, handle: 'tiny-lantern', drawing,
      drawing_state: 'complete', drawing_description: 'A small red and gold lantern.',
    },
    changed: true,
  })
  const write = calls.find(call => /drawing:resident-write/iu.test(call.text))
  assert.ok(write)
  assert.match(write.text, /IS\s+DISTINCT\s+FROM/iu)
  assert.match(write.text, /resident_drawing_rate_limits/iu)
  assert.match(write.text, /used\s*<\s*6/iu)
  assert.match(write.text, /INSERT\s+INTO\s+drawing_revisions/iu)
  assert.match(write.text, /previous|prior/iu)
  assert.match(write.text, /current/iu)
  assert.match(write.text, /author_relation/iu)
  assert.match(write.text, /'resident_edited'/u)
  assert.match(write.text, /'resident_id'/u)
  assert.doesNotMatch(write.text, /palette|indices|ad3f25/iu)
})

test('resident edit accepts only the three exact state shapes and bounds owner description bytes', async () => {
  const unauthenticated = harness([], null)
  const denied = await unauthenticated.app.request('/api/me/drawing', {
    method: 'PATCH', body: JSON.stringify({
      drawing,
      drawing_state: 'complete',
      drawing_description: 'A small red and gold lantern.',
    }),
  })
  assert.equal(denied.status, 401)

  const { app, calls } = harness()
  for (const body of [
    {},
    { drawing },
    { drawing, drawing_state: 'blank', drawing_description: 'The server must not accept inferred Blank.' },
    { drawing, drawing_state: 'complete' },
    { drawing: 'REFUSE' },
    { drawing: 'refuse', drawing_description: 'Only the exact whole value is special.' },
    { drawing: 'This description says REFUSE', drawing_description: 'Still not the sentinel.' },
    { drawing: null, drawing_description: 'Undrawn cannot carry authored metadata.' },
    { drawing: null, drawing_state: 'complete' },
    { drawing: 'REFUSE', drawing_description: '🏮'.repeat(71) },
    { drawing: { ...drawing, palette: ['red'] } },
  ]) {
    const response = await app.request('/api/me/drawing', {
      method: 'PATCH', body: JSON.stringify(body),
    })
    assert.equal(response.status, 400, JSON.stringify(body))
  }

  const oversized = JSON.stringify({ drawing: null, padding: '🏮'.repeat(DRAWING_BODY_MAX_BYTES) })
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    headers: { 'content-length': '1' },
    body: oversized,
  })
  assert.equal(response.status, 413)
  assert.match((await response.json() as { error: string }).error, /4096 UTF-8 bytes/iu)
  assert.equal(calls.length, 0)
})

test('REFUSE is recognized only as the whole drawing value, never inside owner description text', async () => {
  const description = 'The sign says REFUSE, but this drawing is still explicitly in progress.'
  const { app, calls } = harness([], resident, [{
    id: resident.id,
    handle: resident.handle,
    drawing,
    drawing_state: 'in_progress',
    drawing_description: description,
    state: 'changed',
  }])
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({
      drawing,
      drawing_state: 'in_progress',
      drawing_description: description,
    }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual((await response.json() as { resident: Record<string, unknown> }).resident, {
    id: resident.id,
    handle: resident.handle,
    drawing,
    drawing_state: 'in_progress',
    drawing_description: description,
  })
  assert.ok(calls.some(call => /drawing:resident-write/iu.test(call.text)))
})

test('exact no-op retries return changed false and cannot append a history row', async () => {
  const { app, calls } = harness([], resident, [{
    id: resident.id,
    handle: resident.handle,
    drawing,
    drawing_state: 'complete',
    drawing_description: 'A small red and gold lantern.',
    state: 'unchanged',
  }])
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({
      drawing,
      drawing_state: 'complete',
      drawing_description: 'A small red and gold lantern.',
    }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json() as { changed: boolean }).changed, false)
  const write = calls.find(call => /drawing:resident-write/iu.test(call.text))
  assert.ok(write)
  assert.match(write.text, /INSERT\s+INTO\s+drawing_revisions[\s\S]*(?:FROM\s+changed|WHERE[\s\S]*would_change)/iu)
})

test('drawing history is deliberate, bounded, cursor-paged, and returns exact public snapshots', async () => {
  const previous = {
    state: 'undrawn', presentation_state: 'undrawn', description: null,
    drawing: null, rows: null, source: 'none',
  }
  const current = {
    state: 'complete', presentation_state: 'complete',
    description: 'A small red and gold lantern.', drawing, rows: drawingRows, source: 'resident',
  }
  const historyRows = [{
    revision_id: 18,
    previous,
    current,
    author_id: 7,
    author_handle: 'tiny-lantern',
    author_relation: 'self',
    created_at: '2026-08-28T15:04:05.000Z',
  }]
  const { app, calls } = harness([], resident, [], historyRows)
  const response = await app.request('/api/drawing/resident/7/history?before=19&limit=2')
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), {
    type: 'resident',
    id: 7,
    revisions: [{
      id: 18,
      slot_variant_name: null,
      previous,
      current,
      author: { id: 7, handle: 'tiny-lantern', relation: 'self' },
      created_at: '2026-08-28T15:04:05.000Z',
    }],
    page: { limit: 2, has_more: false, next_before: null },
  })
  const history = calls.find(call => /drawing:.*history/iu.test(call.text))
  assert.ok(history)
  assert.match(history.text, /moderation_actions/iu)
  assert.ok(history.params.includes(7))
  assert.ok(history.params.includes(19))
})

test('kind-sourced current and historical presentations name the exact pinned provenance', async () => {
  const historyRows = [{
    visible_id: 41,
    revision_id: 22,
    slot_variant_name: null,
    prior_state: 'complete',
    prior_description: 'The plain signal lamp.',
    prior_drawing: drawing,
    prior_source: 'kind_base',
    prior_kind_id: 3,
    prior_kind_name: 'signal-lamp',
    prior_kind_revision: 4,
    prior_variant_name: null,
    current_state: 'complete',
    current_description: 'A lamp with a blue shutter.',
    current_drawing: drawing,
    current_source: 'kind_variant',
    current_kind_id: 3,
    current_kind_name: 'signal-lamp',
    current_kind_revision: 4,
    current_variant_name: 'blue-shutter',
    author_id: 7,
    author_handle: 'tiny-lantern',
    author_relation: 'owner',
    created_at: '2026-08-28T16:04:05.000Z',
  }]
  const { app } = harness([], resident, [], historyRows)
  const response = await app.request('/api/drawing/thing/41/history')
  assert.equal(response.status, 200, await response.clone().text())
  const payload = await response.json() as {
    revisions: Array<{ previous: Record<string, unknown>; current: Record<string, unknown> }>
  }
  assert.deepEqual({
    previous: {
      source: payload.revisions[0]?.previous.source,
      kind_id: payload.revisions[0]?.previous.kind_id,
      kind_name: payload.revisions[0]?.previous.kind_name,
      revision: payload.revisions[0]?.previous.revision,
    },
    current: {
      source: payload.revisions[0]?.current.source,
      kind_id: payload.revisions[0]?.current.kind_id,
      kind_name: payload.revisions[0]?.current.kind_name,
      revision: payload.revisions[0]?.current.revision,
      variant_name: payload.revisions[0]?.current.variant_name,
    },
  }, {
    previous: {
      source: 'kind_base', kind_id: 3, kind_name: 'signal-lamp', revision: 4,
    },
    current: {
      source: 'kind_variant', kind_id: 3, kind_name: 'signal-lamp', revision: 4,
      variant_name: 'blue-shutter',
    },
  })
})

test('drawing history defaults to 20, caps at 50, and rejects malformed cursors before SQL', async () => {
  const valid = harness([], resident, [], [{ visible_id: 2, revision_id: null }])
  const defaultResponse = await valid.app.request('/api/drawing/place/2/history')
  assert.equal(defaultResponse.status, 200, await defaultResponse.clone().text())
  const defaultHistory = valid.calls.find(call => /drawing:.*history/iu.test(call.text))
  assert.ok(defaultHistory)
  assert.ok(defaultHistory.params.includes(20) || defaultHistory.params.includes(21))

  for (const query of ['?limit=0', '?limit=51', '?limit=01', '?before=0', '?before=01', '?before=x', '?extra=1']) {
    const invalid = harness([], resident, [], [])
    const response = await invalid.app.request(`/api/drawing/place/2/history${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(invalid.calls.length, 0, query)
  }
})

test('parent moderation hides the complete current drawing and its complete history', async () => {
  const current = harness([])
  const currentResponse = await current.app.request('/api/drawing/thing/41')
  assert.equal(currentResponse.status, 404)

  const history = harness([], resident, [], [])
  const historyResponse = await history.app.request('/api/drawing/thing/41/history')
  assert.equal(historyResponse.status, 404)
  assert.deepEqual(await historyResponse.json(), {
    error: 'drawing record for thing_id 41 was not found; read the thing record or choose another current id',
  })
})

test('thing history filters every revision side inherited from a moderated kind', async () => {
  const { app, calls } = harness([], resident, [], [{ visible_id: 41, revision_id: null }])
  const response = await app.request('/api/drawing/thing/41/history')
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), {
    type: 'thing', id: 41, revisions: [],
    page: { limit: 20, has_more: false, next_before: null },
  })

  const historySql = calls.find(call => /drawing:thing-history/iu.test(call.text))?.text ?? ''
  assert.match(
    historySql,
    /NOT\s+EXISTS[\s\S]{0,1000}revision\.prior_source[\s\S]{0,1000}revision\.current_source[\s\S]{0,1000}moderation_actions/iu,
  )
})

test('resident drawing changed edits have one stated database-backed rate limit', async () => {
  const { app } = harness([], resident, [{
    id: resident.id,
    handle: resident.handle,
    drawing,
    drawing_state: 'complete',
    drawing_description: 'A small red and gold lantern.',
    state: 'rate_limited',
  }])
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({
      drawing,
      drawing_state: 'complete',
      drawing_description: 'A small red and gold lantern.',
    }),
  })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.deepEqual(await response.json(), {
    error: 'resident drawing allows 6 changed edits per UTC minute; retry after 60 seconds',
  })
})
