import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'
import { REFERENCE_SECTIONS } from '../src/door.ts'

// Residents can see who is listening right now, city-wide: browse view=residents with
// resident_view=listening reads GET /api/residents?view=listening on every door.

type Door = 'key' | 'connect' | 'app'
const DOORS: readonly Door[] = ['key', 'connect', 'app']

type Backing = Readonly<{ path: string; query: Readonly<Record<string, string>> }>

function backingApp(): Readonly<{ app: Hono; calls: Backing[] }> {
  const calls: Backing[] = []
  const app = new Hono()
  app.all('*', c => {
    calls.push(Object.freeze({ path: c.req.path, query: Object.freeze({ ...c.req.query() }) }))
    return c.json({ listening: [], listening_page: { total_items: 0, returned_items: 0, has_more: false } })
  })
  return Object.freeze({ app, calls })
}

async function rpc(door: Door, method: string, params: unknown, backing: Hono) {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, backing, { door, authenticateLegacyCatalog: async () => true }))
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    assert.equal(response.status, 200, door)
    return await response.json() as Record<string, any>
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

test('every door offers resident_view=listening on browse and says what it lists', async () => {
  for (const door of DOORS) {
    const body = await rpc(door, 'tools/list', {}, new Hono())
    const browse = (body.result.tools as Array<Record<string, any>>).find(tool => tool.name === 'browse')
    assert.ok(browse, `${door} lists browse`)
    const residentView = browse.inputSchema.properties.resident_view
    assert.deepEqual(residentView.enum, ['census', 'presence', 'listening'], `${door} resident_view enum`)
    assert.match(String(residentView.description), /listening lists every resident listening right now/u, `${door} field says what listening lists`)
    assert.match(String(browse.description), /listening view/u, `${door} browse names the listening view`)
  }
})

test('browse resident_view=listening reads the listening view on every door, with hidden=outline when asked', async () => {
  for (const door of DOORS) {
    const backing = backingApp()
    const body = await rpc(door, 'tools/call', {
      name: 'browse', arguments: { view: 'residents', resident_view: 'listening' },
    }, backing.app)
    assert.equal(body.result.isError, false, `${door}: ${JSON.stringify(body)}`)
    assert.deepEqual(backing.calls.map(call => [call.path, call.query]), [['/api/residents', { view: 'listening' }]], door)

    const outlined = backingApp()
    const hidden = await rpc(door, 'tools/call', {
      name: 'browse', arguments: { view: 'residents', resident_view: 'listening', hidden: 'outline' },
    }, outlined.app)
    assert.equal(hidden.result.isError, false, `${door}: ${JSON.stringify(hidden)}`)
    assert.deepEqual(outlined.calls.map(call => call.query), [{ view: 'listening', hidden: 'outline' }], door)
  }
})

test('browse resident_view=listening refuses paging, a handle, and a change marker before any read', async () => {
  for (const extra of [{ handle: 'tiny-lantern' }, { before_id: 5 }, { limit: 5 }, { after_change_marker: '7' }]) {
    const backing = backingApp()
    const body = await rpc('key', 'tools/call', {
      name: 'browse', arguments: { view: 'residents', resident_view: 'listening', ...extra },
    }, backing.app)
    assert.equal(body.result.isError, true, JSON.stringify(extra))
    assert.ok(String(body.result.content[0].text).includes(
      'Browse residents listening takes no handle, before_id, limit, or after_change_marker; it lists everyone listening now, up to 200, with listening_page.',
    ), JSON.stringify(extra))
    assert.deepEqual(backing.calls, [], JSON.stringify(extra))
  }
})

test('the reference says residents can read everyone listening right now, quiet rooms included', () => {
  const talk = REFERENCE_SECTIONS['same-room-talk'].replace(/\s+/gu, ' ')
  assert.ok(talk.includes('GET /api/residents?view=listening'), 'same-room talk names the read')
  assert.match(talk, /every resident listening right now, in any room, quiet rooms included/u)
})
