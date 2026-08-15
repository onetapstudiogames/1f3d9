import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { FRONTDOOR, LLMS } from '../src/door.ts'
import { mcp } from '../src/mcp.ts'
import { MAX_CRAFT_INGREDIENTS } from '../src/physics.ts'
import { PUBLIC_EVENT_KINDS, publicPlaceTree } from '../src/window.ts'

const ACTIONS = ['talk', 'move', 'use', 'give', 'consume', 'make', 'go_home']
const BRICKS = ['destroy', 'move', 'transfer', 'label', 'block', 'wait', 'check_label']

function mcpRequest(body: Record<string, unknown>, authorization?: string) {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization) headers.authorization = authorization
  return app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) })
}

async function callTool(
  app: Hono,
  name: string,
  args: Record<string, unknown>,
  authorization = 'Bearer resident-secret',
) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  return response.json() as Promise<{
    result: { isError: boolean; content: Array<{ text: string }> }
  }>
}

test('MCP advertises every round-two control without accepting bearer arguments', async () => {
  const response = await mcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    'Bearer resident-secret',
  )
  const payload = await response.json() as {
    result: { tools: Array<{
      name: string
      description: string
      inputSchema: { properties?: Record<string, unknown> }
    }> }
  }
  const tools = payload.result.tools
  const names = tools.map(tool => tool.name)
  for (const name of ['act', 'laws', 'home', 'withdraw', 'moderate']) assert.ok(names.includes(name))

  const act = tools.find(tool => tool.name === 'act')!
  assert.deepEqual((act.inputSchema.properties?.action as { enum: string[] }).enum, ACTIONS)
  const make = tools.find(tool => tool.name === 'make')!
  assert.ok('ingredient_ids' in (make.inputSchema.properties ?? {}))
  assert.ok('open_to_use' in (make.inputSchema.properties ?? {}))
  assert.equal(
    (make.inputSchema.properties?.ingredient_ids as { maxItems?: number }).maxItems,
    MAX_CRAFT_INGREDIENTS,
  )
  const look = tools.find(tool => tool.name === 'look')!
  for (const property of [
    'limit',
    'before_subplace_id', 'subplace_limit',
    'before_thing_id', 'thing_limit',
    'before_note_id', 'note_limit',
  ]) assert.ok(property in (look.inputSchema.properties ?? {}), `${property} should be advertised`)
  assert.match(look.description, /recent.*default/i)
  assert.match(look.description, /continue|older/i)
  const me = tools.find(tool => tool.name === 'me')!
  for (const singular of ['place', 'thing', 'kind', 'agreement', 'note', 'offer']) {
    assert.ok(`before_${singular}_id` in (me.inputSchema.properties ?? {}))
    assert.ok(`${singular}_limit` in (me.inputSchema.properties ?? {}))
  }
  assert.match(me.description, /recent.*default/i)
  assert.equal(tools.every(tool => !('secret' in (tool.inputSchema.properties ?? {}))), true)
})

test('MCP look forwards independent place cursors without accepting credentials in arguments', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.all('/api/*', c => c.json({
    path: c.req.path,
    query: c.req.query(),
    authorization: c.req.header('authorization'),
  }))

  const result = await callTool(app, 'look', {
    place_id: 9,
    limit: 11,
    before_subplace_id: 51,
    subplace_limit: 12,
    before_thing_id: 61,
    thing_limit: 13,
    before_note_id: 71,
    note_limit: 14,
  })
  assert.equal(result.result.isError, false)
  const dispatched = JSON.parse(result.result.content[0]!.text) as {
    path: string
    query: Record<string, string>
    authorization: string
  }
  assert.deepEqual(dispatched, {
    path: '/api/place/9',
    query: {
      limit: '11',
      before_subplace_id: '51',
      subplace_limit: '12',
      before_thing_id: '61',
      thing_limit: '13',
      before_note_id: '71',
      note_limit: '14',
    },
    authorization: 'Bearer resident-secret',
  })

  const rejected = await callTool(app, 'look', { place_id: 9, token: 0 })
  assert.equal(rejected.result.isError, true)
  assert.match(rejected.result.content[0]!.text, /authorization header/i)
})

test('MCP me forwards every independent holdings cursor', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.all('/api/*', c => c.json({ path: c.req.path, query: c.req.query() }))
  const args = {
    before_place_id: 11, place_limit: 21,
    before_thing_id: 12, thing_limit: 22,
    before_kind_id: 13, kind_limit: 23,
    before_agreement_id: 14, agreement_limit: 24,
    before_note_id: 15, note_limit: 25,
    before_offer_id: 16, offer_limit: 26,
  }
  const result = await callTool(app, 'me', args)
  assert.equal(result.result.isError, false)
  const dispatched = JSON.parse(result.result.content[0]!.text) as {
    path: string
    query: Record<string, string>
  }
  assert.equal(dispatched.path, '/api/me')
  assert.deepEqual(dispatched.query, Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, String(value)]),
  ))
})

test('round-two discovery text names the frozen vocabulary, canonical routes, and observation rule', () => {
  for (const text of [FRONTDOOR, LLMS]) {
    for (const action of ACTIONS) assert.match(text, new RegExp(`\\b${action}\\b`))
    for (const brick of BRICKS) assert.match(text, new RegExp(`\\b${brick}\\b`))
    for (const route of [
      '/api/action', '/api/place/:id/laws', '/api/me/home',
      '/api/thing/:id/withdraw', '/api/moderation',
    ]) assert.ok(text.includes(route), `${route} should be documented`)
    assert.match(text, /authenticated resident/i)
    assert.match(text, /anonymous[^\n]*(?:never|does not)[^\n]*(?:advance|resolve)/i)
  }
})

test('round-two MCP controls preserve HTTP bearer auth and dispatch to canonical routes', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.all('/api/*', async c => c.json({
    method: c.req.method,
    path: c.req.path,
    query: c.req.query(),
    authorization: c.req.header('authorization'),
    body: c.req.method === 'GET' ? null : await c.req.json(),
  }))

  const cases = [
    ['look', { place_id: 9, limit: 12, before_note_id: 100, note_limit: 25 }, 'GET', '/api/place/9'],
    ['make', {
      place_id: 9, name: 'shared bell', body: 'ring', open_to_use: true,
    }, 'POST', '/api/thing'],
    ['act', { action: 'move', to_place_id: 9 }, 'POST', '/api/action'],
    ['laws', { place_id: 9, traits: ['peaceful'] }, 'PUT', '/api/place/9/laws'],
    ['home', { place_id: 9 }, 'POST', '/api/me/home'],
    ['withdraw', { thing_id: 12 }, 'POST', '/api/thing/12/withdraw'],
    ['moderate', {
      action: 'remove', target_type: 'place', target_id: 9, reason: 'illegal content',
    }, 'POST', '/api/moderation'],
  ] as const

  for (const [name, args, method, path] of cases) {
    const result = await callTool(app, name, args)
    assert.equal(result.result.isError, false)
    const dispatched = JSON.parse(result.result.content[0]!.text) as {
      method: string
      path: string
      authorization: string
    }
    assert.deepEqual(dispatched, {
      ...dispatched,
      method,
      path,
      authorization: 'Bearer resident-secret',
    })
    if (name === 'look') {
      assert.deepEqual((dispatched as unknown as { query: Record<string, string> }).query, {
        limit: '12',
        before_note_id: '100',
        note_limit: '25',
      })
    }
    if (name === 'make') {
      assert.deepEqual((dispatched as unknown as { body: Record<string, unknown> }).body, {
        place_id: 9,
        name: 'shared bell',
        body: 'ring',
        open_to_use: true,
      })
    }
  }

  const rejected = await callTool(app, 'act', { action: 'go_home', token: 0 })
  assert.equal(rejected.result.isError, true)
  assert.match(rejected.result.content[0]!.text, /authorization header/i)
})

test('the window vocabulary covers round-two history and a removed place becomes a tombstone', () => {
  for (const kind of [
    'action', 'effect_scheduled', 'effect_resolved', 'laws_changed',
    'thing_withdrawn', 'thing_crafted',
  ]) assert.ok(PUBLIC_EVENT_KINDS.includes(kind))

  const places = publicPlaceTree([{
    id: 7,
    parent_id: null,
    name: 'unsafe original',
    owner: 'tiny-lantern',
    places: 1,
    things: 2,
    notes: 3,
    moderated: true,
  }])
  assert.deepEqual(places, [{
    id: 7,
    parent_id: null,
    name: '[removed by maintainer]',
    owner: 'tiny-lantern',
    places: 1,
    things: 2,
    notes: 3,
    moderated: true,
    children: [],
  }])
})
