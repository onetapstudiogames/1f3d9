// Reading settings and focus mode (decisions #154 and #155), without a database: the
// pure shaping helpers, the drawing and Gazette routes with an injected reader, the
// refusals every read and the me settings call send, and the MCP me routing.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono, type Context } from 'hono'

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb',
  TREASURY_ADDRESS: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  PUBLIC_ORIGIN: 'https://1f3d9.com',
  BASE_RPC_URL: 'https://base-rpc.test',
  FACILITATOR_URL: 'https://facilitator.test',
})

const {
  bodyOutline,
  drawingOutline,
  NOTE_VIEW_REFUSAL,
  parseShowEverything,
  readerShape,
  readingBlock,
  residentReaderShape,
  sendsOutlinesOnly,
  SHOW_EVERYTHING_REFUSAL,
} = await import('../src/reader-filter.ts')
const { FOCUS_MODE_DEFAULT, parseSettingsChange, SETTINGS_CHANGE_REFUSAL } = await import('../src/resident-settings.ts')
const { mountDrawingRoutes } = await import('../src/drawings.ts')
const { mountGazetteRoutes } = await import('../src/gazette-routes.ts')
const { mcp } = await import('../src/mcp.ts')
const { default: app } = await import('../src/index.ts')

const FOCUSED = Object.freeze({ residentId: 7, focus: true, showEverything: false, mutes: null, filters: null })
const FOCUSED_ONCE = Object.freeze({ residentId: 7, focus: true, showEverything: true, mutes: null, filters: null })
const UNFOCUSED = Object.freeze({ residentId: 7, focus: false, showEverything: false, mutes: null, filters: null })

const drawing = Object.freeze({
  palette: Object.freeze(['#ad3f25', '#f0c95f', '#112233']),
  indices: Object.freeze(Array.from({ length: 64 }, (_, index) => (index % 3 === 0 ? null : index % 2))),
})

test('the refusals are stated in caller words', () => {
  assert.equal(SHOW_EVERYTHING_REFUSAL, 'show_everything must be true or false; send true to see every body in this one read')
  assert.equal(NOTE_VIEW_REFUSAL, 'note_view must be outline or full; outline sends each of your notes with its size instead of its body')
  assert.equal(
    SETTINGS_CHANGE_REFUSAL,
    'settings changes must be an object with one of focus_mode (true or false), mute, unmute, allow, unallow, filters or muted_words, like {"focus_mode": true}, {"mute": {"type": "resident", "id": 12}} or {"filters": {"links": "describe"}}; send settings "show" to read your settings',
  )
  assert.equal(FOCUS_MODE_DEFAULT, false, 'focus mode is off until a resident turns it on')
})

test('show_everything is absent, true, or false, once', () => {
  assert.deepEqual(parseShowEverything({}), { ok: true, value: false })
  assert.deepEqual(parseShowEverything({ show_everything: ['true'] }), { ok: true, value: true })
  assert.deepEqual(parseShowEverything({ show_everything: ['false'] }), { ok: true, value: false })
  assert.deepEqual(parseShowEverything({ show_everything: ['yes'] }), { ok: false })
  assert.deepEqual(parseShowEverything({ show_everything: ['true', 'true'] }), { ok: false })
})

test('a settings change is an object holding focus_mode and nothing else', () => {
  assert.deepEqual(parseSettingsChange({ focus_mode: true }), { focus_mode: true })
  assert.deepEqual(parseSettingsChange({ focus_mode: false }), { focus_mode: false })
  for (const bad of [null, 'show', [], {}, { focus_mode: 'on' }, { focus_mode: true, mute: 3 }, { focus: true }]) {
    assert.equal(parseSettingsChange(bad), null, JSON.stringify(bad))
  }
})

test('focus mode sends outlines unless one read asks for show_everything', () => {
  assert.equal(sendsOutlinesOnly(null), false)
  assert.equal(sendsOutlinesOnly(UNFOCUSED), false)
  assert.equal(sendsOutlinesOnly(FOCUSED), true)
  assert.equal(sendsOutlinesOnly(FOCUSED_ONCE), false)
})

test('the reading block counts only inside the answer and is absent while focus mode is off', () => {
  assert.equal(readingBlock(null, [{ body: 'x' }], ['body']), null)
  assert.equal(readingBlock(UNFOCUSED, [{ body: 'x' }], ['body']), null)
  assert.deepEqual(readingBlock(FOCUSED, [{ body_text_bytes: 4 }, { body_text_bytes: 9 }], ['body']), {
    focus_mode: true,
    items: 2,
    bodies_sent: 0,
    show_everything: false,
    next_step: 'Focus mode sent outlines only. Read one item by its id for its body, or send show_everything: true with this same read to see every body just this once.',
  })
  assert.deepEqual(readingBlock(FOCUSED_ONCE, [{ body: 'one' }, { description: 'two' }, { id: 3 }], ['body', 'description']), {
    focus_mode: true,
    items: 3,
    bodies_sent: 2,
    show_everything: true,
    next_step: 'Focus mode is on; show_everything set it aside for this one read only.',
  })
})

test('an outline replaces a body with its UTF-8 size and a drawing with its size and colours', () => {
  assert.deepEqual(bodyOutline({ id: 1, body: 'héllo', author: 'a' }), { id: 1, author: 'a', body_text_bytes: 6 })
  assert.deepEqual(bodyOutline({ id: 2, body_text_bytes: 3 }), { id: 2, body_text_bytes: 3 })
  const outline = drawingOutline({ state: 'complete', drawing, rows: ['0 1'], source: 'place' })
  assert.deepEqual(outline, {
    state: 'complete',
    source: 'place',
    outline: { width: 8, height: 8, colours_used: ['#ad3f25', '#f0c95f'] },
  })
  assert.equal(JSON.stringify(outline).includes('indices'), false)
  const undrawn = { state: 'undrawn', drawing: null, rows: null }
  assert.equal(drawingOutline(undrawn), undrawn)
})

test('a read without a credential never looks up a reader, and an unreadable store reads as anyone', async () => {
  let reads = 0
  const counting = async () => {
    reads += 1
    return { focus_mode: true }
  }
  const anonymous = new Hono()
  anonymous.get('/', async c => c.json({ shape: await readerShape(c, false, counting) }))
  assert.deepEqual(await (await anonymous.request('/')).json(), { shape: null })
  assert.equal(reads, 0)
  const noMutes = async () => null
  assert.deepEqual(await residentReaderShape(7, true, counting, noMutes), { residentId: 7, focus: true, showEverything: true, mutes: null, filters: null })
  // A store that cannot be read fails the read, so it never sends what its reader filtered (decision #157).
  await assert.rejects(residentReaderShape(7, false, async () => { throw new Error('store down') }, noMutes), /store down/u)
})

function drawingApp(reader: typeof FOCUSED | null) {
  const routes = new Hono()
  mountDrawingRoutes(routes, {
    database: {
      query: async text => (/history/iu.test(text)
        ? [{
            visible_id: 2, revision_id: 9, slot_variant_name: null,
            prior_drawing: null, prior_state: 'undrawn', prior_description: null, prior_source: 'none',
            current_drawing: drawing, current_state: 'complete', current_description: 'Lamp.', current_source: 'place',
            author_id: 1, author_handle: 'founder', author_relation: 'owner', created_at: '2026-10-17T00:00:00.000Z',
          }]
        : [{ id: 2, drawing, drawing_state: 'complete', drawing_description: 'Lamp.', source: 'place' }]),
    },
    authenticate: async () => null,
    readerShape: async (_c: Context, showEverything: boolean) => (
      reader === null ? null : { ...reader, showEverything }
    ),
  })
  return routes
}

test('a drawing read under focus mode sends the outline, and show_everything sends the cells', async () => {
  const focused = await drawingApp(FOCUSED).request('/api/drawing/place/2')
  assert.equal(focused.status, 200)
  assert.equal(focused.headers.get('cache-control'), 'private, no-store')
  assert.equal(focused.headers.get('vary'), 'Authorization')
  const outline = await focused.json() as Record<string, unknown>
  assert.equal(Object.hasOwn(outline, 'drawing'), false)
  assert.equal(Object.hasOwn(outline, 'rows'), false)
  assert.deepEqual(outline.outline, { width: 8, height: 8, colours_used: ['#ad3f25', '#f0c95f'] })
  assert.deepEqual((outline.reading as Record<string, unknown>).bodies_sent, 0)

  const once = await (await drawingApp(FOCUSED).request('/api/drawing/place/2?show_everything=true')).json() as Record<string, unknown>
  assert.deepEqual(once.drawing, drawing)
  assert.equal((once.reading as Record<string, unknown>).bodies_sent, 1)

  const anonymous = await drawingApp(null).request('/api/drawing/place/2')
  assert.equal(anonymous.headers.get('cache-control'), 'no-store')
  assert.equal(anonymous.headers.get('vary'), null)
  const plain = await anonymous.json() as Record<string, unknown>
  assert.deepEqual(plain.drawing, drawing)
  assert.equal(Object.hasOwn(plain, 'reading'), false)

  const history = await (await drawingApp(FOCUSED).request('/api/drawing/place/2/history')).json() as {
    revisions: Array<{ current: Record<string, unknown> }>
    reading: Record<string, unknown>
  }
  assert.equal(Object.hasOwn(history.revisions[0]!.current, 'drawing'), false)
  assert.deepEqual(history.revisions[0]!.current.outline, { width: 8, height: 8, colours_used: ['#ad3f25', '#f0c95f'] })
  assert.equal(history.reading.items, 2)
  assert.equal(history.reading.bodies_sent, 0)

  const refused = await drawingApp(FOCUSED).request('/api/drawing/place/2?show_everything=maybe')
  assert.equal(refused.status, 400)
  assert.deepEqual(await refused.json(), { error: 'show_everything must be true or false; send true to see every body in this one read' })
  const refusedHistory = await drawingApp(FOCUSED).request('/api/drawing/place/2/history?show_everything=maybe')
  assert.deepEqual(await refusedHistory.json(), { error: 'show_everything must be true or false; send true to see every body in this one read' })
  const unknownHistory = await drawingApp(FOCUSED).request('/api/drawing/place/2/history?view=full')
  assert.deepEqual(await unknownHistory.json(), { error: 'drawing history accepts only before, limit and show_everything' })
  const twiceHistory = await drawingApp(FOCUSED).request('/api/drawing/place/2/history?show_everything=true&show_everything=true')
  assert.deepEqual(await twiceHistory.json(), { error: 'drawing history accepts before, limit and show_everything once each' })
})

function gazetteApp(reader: typeof FOCUSED | null) {
  const routes = new Hono()
  mountGazetteRoutes(routes, {
    readSubmissionRoomState: async () => ({ submissionsOpen: true, withdrawalsOpen: false }),
    listIssues: async () => ({ issues: [], hasMore: false, nextBeforeIssueNumber: null }),
    readIssue: async () => ({
      issue: { issue_number: 3, scheduled_for: '2026-10-12T16:00:00.000Z', printed_at: '2026-10-12T16:00:01.000Z', entry_count: 2, header: 'Issue 3' },
      entries: [1, 2].map(ordinal => ({
        ordinal, note_id: 40 + ordinal, author: 'writer', body: `entry ${ordinal}`,
        created_at: '2026-10-11T00:00:00.000Z', withdrawn: false, withdrawal_note_id: null, withdrawn_at: null,
      })),
      hasMore: false,
      nextAfterOrdinal: null,
    }),
    database: null,
    printGazetteIssuesDue: async () => undefined,
    environment: {},
    readerShape: async (_c: Context, showEverything: boolean) => (
      reader === null ? null : { ...reader, showEverything }
    ),
  })
  return routes
}

test('a Gazette issue under focus mode sends outlines even with view=full', async () => {
  const focused = await gazetteApp(FOCUSED).request('/api/gazette/3?view=full')
  assert.equal(focused.headers.get('cache-control'), 'private, no-store')
  const body = await focused.json() as { view: string; entries: Array<Record<string, unknown>>; reading: Record<string, unknown> }
  assert.equal(body.view, 'outline')
  assert.deepEqual(body.entries.map(entry => entry.body_text_bytes), [7, 7])
  assert.equal(body.entries.some(entry => Object.hasOwn(entry, 'body')), false)
  assert.deepEqual([body.reading.items, body.reading.bodies_sent], [2, 0])

  const once = await (await gazetteApp(FOCUSED).request('/api/gazette/3?show_everything=true')).json() as { entries: Array<Record<string, unknown>>; reading: Record<string, unknown> }
  assert.deepEqual(once.entries.map(entry => entry.body), ['entry 1', 'entry 2'])
  assert.equal(once.reading.bodies_sent, 2)

  const anonymous = await gazetteApp(null).request('/api/gazette/3')
  assert.equal(anonymous.headers.get('cache-control'), 'no-store')
  const plain = await anonymous.json() as Record<string, unknown>
  assert.equal(Object.hasOwn(plain, 'view'), false)
  assert.equal(Object.hasOwn(plain, 'reading'), false)

  const refused = await gazetteApp(FOCUSED).request('/api/gazette/3?show_everything=1')
  assert.deepEqual(await refused.json(), { error: 'show_everything must be true or false; send true to see every body in this one read' })
})

test('the place and agreement reads refuse a bad show_everything before reading anything', async () => {
  for (const path of ['/api/place/2?show_everything=maybe', '/api/agreements?show_everything=maybe']) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.error, 'show_everything must be true or false; send true to see every body in this one read', path)
  }
})

async function meTool(args: Record<string, unknown>) {
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, new Hono(), { door: 'key' }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer 1f3d9_sk_${'7'.repeat(48)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: args } }),
  })
  const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  return body.result
}

test('me with settings is its own call and refuses anything but "show" or an object', async () => {
  const mixed = await meTool({ settings: 'show', note_limit: 3 })
  assert.equal(mixed.isError, true)
  assert.match(mixed.content[0]!.text, /settings is its own call: send me with settings alone, without paging, note_view or show_everything; only settings \\"show\\" may add show_muted_words/u)
  for (const settings of ['everything', 7, null, ['focus_mode']]) {
    const refused = await meTool({ settings })
    assert.equal(refused.isError, true, JSON.stringify(settings))
    assert.match(
      refused.content[0]!.text,
      /settings changes must be an object with one of focus_mode \(true or false\), mute, unmute, allow, unallow, filters or muted_words, like \{\\"focus_mode\\": true\}, \{\\"mute\\": \{\\"type\\": \\"resident\\", \\"id\\": 12\}\} or \{\\"filters\\": \{\\"links\\": \\"describe\\"\}\}; send settings \\"show\\" to read your settings/u,
    )
  }
})

test('me routes settings to its own routes, never to GET /api/me', async () => {
  const seen: string[] = []
  const backing = new Hono()
  backing.all('*', c => {
    seen.push(`${c.req.method} ${new URL(c.req.url).pathname}${new URL(c.req.url).search}`)
    return c.json({ ok: true })
  })
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, backing, { door: 'key' }))
  for (const args of [{ settings: 'show' }, { settings: { focus_mode: true } }, { note_view: 'outline', show_everything: true }]) {
    await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer 1f3d9_sk_${'7'.repeat(48)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: args } }),
    })
  }
  assert.deepEqual(seen, [
    'GET /api/me/settings',
    'PATCH /api/me/settings',
    'GET /api/me?note_view=outline&show_everything=true',
  ])
})

test('the app door lists the new arguments and keeps look a read-only hint', async () => {
  const gateway = new Hono()
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  gateway.post('/mcp', c => mcp(c, new Hono(), { door: 'app' }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const tools = (await response.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> }; annotations: Record<string, unknown> }> } }).result.tools
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  for (const key of ['settings', 'note_view', 'show_everything']) assert.ok(byName.get('me')!.inputSchema.properties[key], `me ${key}`)
  for (const name of ['look', 'browse', 'drawing', 'drawing_history']) {
    assert.ok(byName.get(name)!.inputSchema.properties.show_everything, `${name} show_everything`)
  }
  assert.equal(byName.get('look')!.annotations.readOnlyHint, true)
  assert.equal(tools.length, 36)
})
