import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono, type Context } from 'hono'
import { DRAWING_BODY_MAX_BYTES, type Drawing } from '../src/drawing.ts'
import {
  mountDrawingRoutes,
  type DrawingRouteDatabase,
} from '../src/drawings.ts'
import type { Resident } from '../src/core.ts'

const drawing: Drawing = Object.freeze({
  palette: Object.freeze(['#ad3f25', '#f0c95f']),
  indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? null : index % 2)),
})

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
    { id: resident.id, handle: resident.handle, drawing, state: 'changed' },
  ],
) {
  const calls: Call[] = []
  const database: DrawingRouteDatabase = {
    query: async (text, params) => {
      calls.push(Object.freeze({ text, params: Object.freeze([...params]) }))
      if (/drawing:resident-write/iu.test(text)) {
        return residentWriteRows
      }
      return rows
    },
  }
  const app = new Hono()
  mountDrawingRoutes(app, {
    database,
    authenticate: async (_context: Context) => authenticated,
  })
  return { app, calls }
}

test('public drawing reads are one deliberate fetched-not-pushed record surface', async () => {
  const cases = [
    {
      type: 'place',
      row: { id: 2, drawing, source: 'place', kind_id: null, revision: null },
      expected: { type: 'place', id: 2, drawing, source: 'place' },
    },
    {
      type: 'resident',
      row: { id: 7, drawing, source: 'resident', kind_id: null, revision: null },
      expected: { type: 'resident', id: 7, drawing, source: 'resident' },
    },
    {
      type: 'kind',
      row: { id: 3, drawing, source: 'kind_revision', kind_id: 3, revision: 4 },
      expected: {
        type: 'kind', id: 3, drawing, source: 'kind_revision', kind_id: 3, revision: 4,
      },
    },
    {
      type: 'thing',
      row: { id: 41, drawing, source: 'kind_revision', kind_id: 3, revision: 1 },
      expected: {
        type: 'thing', id: 41, drawing, source: 'kind_revision', kind_id: 3, revision: 1,
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

test('thing override wins its pinned kind revision and deliberate blank stays authored', async () => {
  const blank = { palette: [], indices: Array.from({ length: 64 }, () => null) }
  const { app } = harness([{
    id: 41,
    drawing: blank,
    source: 'thing',
    kind_id: 3,
    revision: 1,
  }])
  const response = await app.request('/api/drawing/thing/41')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    type: 'thing', id: 41, drawing: blank, source: 'thing', kind_id: 3, revision: 1,
  })
})

test('hidden and absent drawings share 404 while undrawn visible records return null', async () => {
  const missing = harness([])
  const missingResponse = await missing.app.request('/api/drawing/place/2')
  assert.equal(missingResponse.status, 404)
  assert.deepEqual(await missingResponse.json(), { error: 'drawing record not found' })

  const visible = harness([{ id: 2, drawing: null, source: null, kind_id: null, revision: null }])
  const visibleResponse = await visible.app.request('/api/drawing/place/2')
  assert.equal(visibleResponse.status, 200)
  assert.deepEqual(await visibleResponse.json(), {
    type: 'place', id: 2, drawing: null, source: null,
  })
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

test('resident self drawing edit reads actual bytes, overwrites once, and emits no picture bytes', async () => {
  const { app, calls } = harness()
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ drawing }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    resident: { id: 7, handle: 'tiny-lantern', drawing },
    changed: true,
  })
  const write = calls.find(call => /drawing:resident-write/iu.test(call.text))
  assert.ok(write)
  assert.match(write.text, /drawing\s+IS\s+DISTINCT\s+FROM/iu)
  assert.match(write.text, /resident_drawing_rate_limits/iu)
  assert.match(write.text, /used\s*<\s*6/iu)
  assert.match(write.text, /'resident_edited'/u)
  assert.match(write.text, /'resident_id'/u)
  assert.doesNotMatch(write.text, /palette|indices|ad3f25/iu)
})

test('resident edit requires self auth, exact body shape, valid drawing, and actual-byte cap', async () => {
  const unauthenticated = harness([], null)
  const denied = await unauthenticated.app.request('/api/me/drawing', {
    method: 'PATCH', body: JSON.stringify({ drawing }),
  })
  assert.equal(denied.status, 401)

  const { app, calls } = harness()
  for (const body of [
    {},
    { drawing, description: 'not a resident field' },
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

test('resident drawing changed edits have one stated database-backed rate limit', async () => {
  const { app } = harness([], resident, [{
    id: resident.id,
    handle: resident.handle,
    drawing,
    state: 'rate_limited',
  }])
  const response = await app.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({ drawing }),
  })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.deepEqual(await response.json(), {
    error: 'resident drawing allows 6 changed edits per UTC minute; retry after 60 seconds',
  })
})
