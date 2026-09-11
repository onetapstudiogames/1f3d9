import assert from 'node:assert/strict'
import test from 'node:test'
import { readLookingResidentsAtPlace, readResidentLooking, recordResidentLooking } from '../src/resident-looking.ts'
import { mcp } from '../src/mcp.ts'
import { handleMcpLooking } from '../src/mcp-looking.ts'
import { Hono } from 'hono'

function fakeDatabase(rows: unknown[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = []
  const database = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('$'), values })
    return rows
  }) as unknown as typeof import('../src/db.ts').sql
  return { database, calls }
}

test('looking write derives the room from presence and combines one resident row', async () => {
  const { database, calls } = fakeDatabase()
  await recordResidentLooking({ id: 17 }, database)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.text, /SELECT current_place_id AS place_id[\s\S]+resident_id = \$/u)
  assert.match(calls[0]!.text, /ON CONFLICT \(resident_id\) DO UPDATE/u)
  assert.match(calls[0]!.text, /resident_looking\.started_at ELSE EXCLUDED\.started_at/u)
  assert.match(calls[0]!.text, /resident_id <> \$/u)
  assert.doesNotMatch(calls[0]!.text, /events|public_change|target|query|body|credential/iu)
})

test('looking reads suppress expired and moved-away rows and fail open', async () => {
  const now = new Date()
  const { database, calls } = fakeDatabase([{
    resident_id: 17, place_id: 4,
    started_at: now, expires_at: new Date(now.getTime() + 60_000),
  }])
  const found = await readResidentLooking([17], database)
  assert.equal(found.get(17)?.place_id, 4)
  assert.match(calls[0]!.text, /looking\.place_id = presence\.current_place_id/u)
  assert.match(calls[0]!.text, /looking\.expires_at > clock_timestamp\(\)/u)

  const broken = (async () => { throw Object.assign(new Error('missing'), { code: '42P01' }) }) as unknown as typeof import('../src/db.ts').sql
  assert.equal((await readResidentLooking([17], broken)).size, 0)
})

test('stalled optional looking reads return empty within their bound', async () => {
  const stalled = (() => new Promise<never>(() => {})) as unknown as typeof import('../src/db.ts').sql
  const started = Date.now()
  const [byResident, byPlace] = await Promise.all([
    readResidentLooking([17], stalled),
    readLookingResidentsAtPlace(4, 200, stalled),
  ])
  assert.equal(byResident.size, 0)
  assert.deepEqual(byPlace, { residents: [], total: 0, has_more: false })
  assert.ok(Date.now() - started < 400, 'optional public signal reads exceeded their 250ms bound')
})

test('only valid root and hosted identities are attributed by their correct MCP door', async () => {
  const previousHosted = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const recorded: number[] = []
    const city = new Hono()
    city.get('/api/place/:id', c => c.json({ place: { id: 2 } }))
    city.post('/api/internal/mcp-looking', c => handleMcpLooking(c, {
      authenticate: async context => {
        const authorization = context.req.header('authorization')
        const id = authorization === 'Bearer root-valid' ? 11
          : authorization === 'Bearer hosted-valid' ? 22 : null
        return id === null ? null : { id } as import('../src/core.ts').Resident
      },
      record: async resident => { recorded.push(resident.id) },
    }))
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, city))
    gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))
    const call = async (path: string, authorization: string, name = 'look') => gateway.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { place_id: 2 } } }),
    })
    assert.equal((await call('/mcp', 'Bearer invalid')).status, 200)
    assert.deepEqual(recorded, [], 'invalid optional auth resolves no resident and makes no write')
    await call('/mcp', 'Bearer root-valid')
    await call('/mcp/connect', 'Bearer hosted-valid')
    assert.deepEqual(recorded, [11, 22], 'recorder receives the passively resolved resident ids')
    await call('/mcp', 'Bearer root-valid', 'browse')
    assert.deepEqual(recorded, [11, 22], 'another tool never reaches the private handler')
  } finally {
    if (previousHosted === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHosted
  }
})

test('the private handler rejects raw requests before authentication or recording', async () => {
  let authenticated = 0
  let recorded = 0
  const app = new Hono()
  app.post('/api/internal/mcp-looking', c => handleMcpLooking(c, {
    authenticate: async () => { authenticated += 1; return { id: 1 } as import('../src/core.ts').Resident },
    record: async () => { recorded += 1 },
  }))
  const response = await app.request('/api/internal/mcp-looking', { method: 'POST' })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'looking_beacon_rejected')
  assert.equal(response.headers.get('x-1f3d9-error-class'), 'not_found')
  assert.ok(response.headers.get('x-request-id'))
  assert.equal(authenticated, 0)
  assert.equal(recorded, 0)
})

test('a stalled or throwing signal request keeps the successful look bounded', async () => {
  for (const behavior of ['stall', 'throw'] as const) {
    const city = new Hono()
    city.get('/api/place/:id', c => c.json({ place: { id: 2 } }))
    const ordinaryRequest = city.request.bind(city)
    city.request = ((input: Request | string, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input, 'http://local').pathname
      if (path !== '/api/internal/mcp-looking') return ordinaryRequest(input, init)
      return behavior === 'stall'
        ? new Promise<Response>(() => {})
        : Promise.reject(new Error('signal unavailable'))
    }) as typeof city.request
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, city))
    const started = Date.now()
    const response = await gateway.request('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer root-valid' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'look', arguments: { place_id: 2 } } }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as { result: { isError: boolean } }
    assert.equal(payload.result.isError, false)
    assert.ok(Date.now() - started < 400, `${behavior} attribution exceeded its 250ms bound`)
  }
})
