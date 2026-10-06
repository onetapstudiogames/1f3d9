import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CALLER_ID = 'caller-id-private-marker'
const AUTHORIZATION = `Bearer 1f3d9_sk_${'ab'.repeat(24)}`

interface Diagnostic {
  event: 'mcp_tool_arrived' | 'mcp_tool_reply_prepared' | 'mcp_tool_failed'
  request_id: string
  tool: string
  timestamp: string
  outcome?: 'success' | 'tool_error' | 'rpc_error' | 'unexpected_failure'
  elapsed_ms?: number
  transport_status?: number
  http_status?: number
}

function harness(city = new Hono()) {
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  const connector = new Hono()
  connector.onError((_error, c) => c.json({ error: 'Unexpected connector error.' }, 500))
  connector.post('/mcp', c => mcp(c, city))
  connector.post('/mcp/connect', c => mcp(c, city, {
    hostedChat: true, forwardUnauthorizedStatus: true,
  }))
  return {
    city,
    call: (name: unknown, args: unknown = {}, path = '/mcp/connect', headers = {}) =>
      connector.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: CALLER_ID, method: 'tools/call',
          params: { name, arguments: args } }),
      }),
    connector,
  }
}

function records(calls: readonly { arguments: unknown[] }[]): Diagnostic[] {
  return calls.filter(call => call.arguments[0] === 'mcp_tool_call')
    .map(call => JSON.parse(String(call.arguments[1])) as Diagnostic)
}

function assertPair(logs: Diagnostic[], tool: string, outcome: Diagnostic['outcome'], httpStatus?: number) {
  assert.equal(logs.length, 2)
  const [arrival, prepared] = logs as [Diagnostic, Diagnostic]
  assert.equal(arrival.event, 'mcp_tool_arrived')
  assert.equal(prepared.event, 'mcp_tool_reply_prepared')
  assert.match(arrival.request_id, UUID)
  assert.equal(prepared.request_id, arrival.request_id)
  assert.equal(arrival.tool, tool)
  assert.equal(prepared.tool, tool)
  assert.equal(prepared.outcome, outcome)
  assert.equal(prepared.http_status, httpStatus)
  assert.ok(Number.isFinite(prepared.elapsed_ms) && prepared.elapsed_ms! >= 0)
  for (const record of logs) {
    assert.equal(new Date(record.timestamp).toISOString(), record.timestamp)
    assert.equal(record.timestamp.endsWith('Z'), true)
  }
  assert.ok(Date.parse(prepared.timestamp) >= Date.parse(arrival.timestamp))
  assert.deepEqual(Object.keys(arrival).sort(), ['event', 'request_id', 'timestamp', 'tool'])
  assert.deepEqual(Object.keys(prepared).sort(), [
    'elapsed_ms', 'event', ...(httpStatus === undefined ? [] : ['http_status']),
    'outcome', 'request_id', 'timestamp', 'tool', 'transport_status',
  ].sort())
}

test('MCP records arrival before dispatch finishes and reply preparation afterward', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let dispatchStarted!: () => void
  const started = new Promise<void>(resolve => { dispatchStarted = resolve })
  city.get('/api/place/:id', async c => {
    dispatchStarted()
    await held
    return c.json({ place: { id: 987654, description: 'reply-private-marker' } })
  })
  const pending = call('look', { place_id: 987654, limit: 1 })
  await started
  assert.deepEqual(records(sink.mock.calls).map(record => record.event), ['mcp_tool_arrived'])
  release()
  const response = await pending
  const body = await response.json() as { id: unknown; result: { isError: boolean; content: unknown[] } }
  assert.equal(response.status, 200)
  assert.equal(body.id, CALLER_ID)
  assert.equal(body.result.isError, false)
  assertPair(records(sink.mock.calls), 'look', 'success', 200)
  assert.equal(records(sink.mock.calls)[1]!.transport_status, 200)
  assert.equal(response.headers.get('X-Request-ID'), null, 'no new success response contract')
})

test('both MCP doors use independent server IDs and normalize only a known hosted tool', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  city.get('/api/official', c => c.json({ domain: 'https://1f3d9.com' }))
  await call('mcp_for_1f3d9_official_facts')
  const hosted = records(sink.mock.calls)
  assertPair(hosted, 'official_facts', 'success', 200)
  await call('official_facts', {}, '/mcp')
  const legacy = records(sink.mock.calls).slice(2)
  assertPair(legacy, 'official_facts', 'success', 200)
  assert.notEqual(hosted[0]!.request_id, legacy[0]!.request_id)
  assert.notEqual(hosted[0]!.request_id, CALLER_ID)
})

test('bad arguments, embedded credentials and missing sign-in finish without backing dispatch', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  let dispatched = 0
  city.all('*', c => { dispatched += 1; return c.json({ unexpected: true }) })
  for (const [name, args, status] of [
    ['look', { parent_id: 796, limit: 1 }, 200],
    ['look', { secret: AUTHORIZATION }, 200],
    ['me', {}, 401],
  ] as const) {
    const start = sink.mock.callCount()
    const response = await call(name, args)
    assert.equal(response.status, status)
    const body = await response.json() as { result: { isError: boolean; content: { text: string }[] } }
    assert.equal(body.result.isError, true)
    const logs = records(sink.mock.calls.slice(start))
    assertPair(logs, name, 'tool_error')
    assert.equal(logs[1]!.transport_status, status)
    assert.equal(response.headers.get('X-Request-ID'), logs[0]!.request_id)
  }
  assert.equal(dispatched, 0)
})

test('backing HTTP errors remain tool errors even when the outer MCP status is 200', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  for (const status of [400, 401, 403, 404, 429, 500, 503] as const) {
    const start = sink.mock.callCount()
    const { city, call } = harness()
    city.get('/api/me', c => c.json({ error: 'backing-error-private-marker' }, status))
    const response = await call('me', {}, '/mcp/connect', { authorization: AUTHORIZATION })
    const body = await response.json() as { result: { isError: boolean } }
    assert.equal(body.result.isError, true)
    assert.equal(response.status, status === 401 ? 401 : 200)
    const logs = records(sink.mock.calls.slice(start))
    assertPair(logs, 'me', 'tool_error', status)
    assert.equal(logs[1]!.transport_status, response.status)
  }
})

test('credential safeguard withholding and unreachable response produce prepared error replies', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  city.get('/api/official', c => c.text(AUTHORIZATION))
  const withheld = await call('official_facts')
  assert.equal((await withheld.json() as { result: { isError: boolean } }).result.isError, true)
  assertPair(records(sink.mock.calls), 'official_facts', 'tool_error', 200)
  const start = sink.mock.callCount()
  t.mock.method(city, 'request', async () => { throw new Error('raw-exception-private-marker') })
  const unreachable = await call('official_facts')
  assert.equal((await unreachable.json() as { result: { isError: boolean } }).result.isError, true)
  assertPair(records(sink.mock.calls.slice(start)), 'official_facts', 'tool_error')
})

test('a failed backing body read keeps the observed HTTP status without logging the exception', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  t.mock.method(city, 'request', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('raw-exception-private-marker')) },
  }), { status: 200 }))
  const response = await call('official_facts')
  assert.equal((await response.json() as { result: { isError: boolean } }).result.isError, true)
  assertPair(records(sink.mock.calls), 'official_facts', 'tool_error', 200)
  assert.equal(JSON.stringify(sink.mock.calls.map(call => call.arguments)).includes('raw-exception-private-marker'), false)
})

test('a backing error keeps its existing response ID while logs use only the generated call ID', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  city.get('/api/official', c => c.json({
    error: 'ordinary refusal', request_id: 'backing-request-id-marker',
  }, 503))
  const response = await call('official_facts')
  const body = await response.json() as { result: { content: { text: string }[] } }
  assert.equal(JSON.parse(body.result.content[0]!.text).request_id, 'backing-request-id-marker')
  assert.equal(response.headers.get('X-Request-ID'), 'backing-request-id-marker')
  assertPair(records(sink.mock.calls), 'official_facts', 'tool_error', 503)
  assert.equal(JSON.stringify(records(sink.mock.calls)).includes('backing-request-id-marker'), false)
})

test('overlapping calls retain distinct arrival/reply pairs when they complete out of order', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let dispatchStarted!: () => void
  const started = new Promise<void>(resolve => { dispatchStarted = resolve })
  city.get('/api/official', async c => { dispatchStarted(); await held; return c.json({ domain: 'City' }) })
  city.get('/api/physics', c => c.json({ physics: true }))
  const first = call('official_facts')
  await started
  await call('physics')
  release()
  await first
  const logs = records(sink.mock.calls)
  assert.deepEqual(logs.map(record => [record.event, record.tool]), [
    ['mcp_tool_arrived', 'official_facts'], ['mcp_tool_arrived', 'physics'],
    ['mcp_tool_reply_prepared', 'physics'], ['mcp_tool_reply_prepared', 'official_facts'],
  ])
  assert.notEqual(logs[0]!.request_id, logs[1]!.request_id)
  assert.equal(logs[0]!.request_id, logs[3]!.request_id)
  assert.equal(logs[1]!.request_id, logs[2]!.request_id)
})

test('unknown names and request payloads never enter diagnostic records', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { city, call } = harness()
  const privateMarkers = [CALLER_ID, AUTHORIZATION, '987654', 'reply-private-marker',
    'cookie-private-marker', 'query-private-marker', 'header-private-marker', 'raw-exception-private-marker']
  city.get('/api/place/:id', c => c.json({ description: 'reply-private-marker' }))
  await call('look', { place_id: 987654, limit: 1 }, '/mcp/connect', {
    authorization: AUTHORIZATION, cookie: 'cookie-private-marker', 'x-payment': 'header-private-marker',
  })
  const unknown = await call(`mcp_for_1f3d9_${AUTHORIZATION}\nquery-private-marker`)
  assert.equal((await unknown.json() as { error: { code: number } }).error.code, -32602)
  assertPair(records(sink.mock.calls).slice(2), 'unknown', 'rpc_error')
  const logged = JSON.stringify(sink.mock.calls.map(call => call.arguments))
  for (const marker of privateMarkers) assert.equal(logged.includes(marker), false, marker)
})

test('unexpected pre-reply exceptions are recorded as failed, never as reply prepared', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { call } = harness()
  // JSON preserves a malicious own toString; current name conversion throws before dispatch.
  const response = await call({ toString: 'raw-exception-private-marker' })
  assert.equal(response.status, 500)
  const logs = records(sink.mock.calls)
  assert.equal(logs.length, 2)
  assert.equal(logs[0]!.event, 'mcp_tool_arrived')
  assert.equal(logs[0]!.tool, 'unknown')
  assert.equal(logs[1]!.event, 'mcp_tool_failed')
  assert.equal(logs[1]!.outcome, 'unexpected_failure')
  assert.equal(logs[1]!.request_id, logs[0]!.request_id)
  assert.ok(logs[1]!.elapsed_ms! >= 0)
  assert.equal(JSON.stringify(logs).includes('raw-exception-private-marker'), false)
  assert.equal('transport_status' in logs[1]!, false)
})

test('a broken diagnostic sink does not change a tool result or refusal', async t => {
  const { city, call } = harness()
  city.get('/api/official', c => c.json({ domain: 'https://1f3d9.com' }))
  t.mock.method(console, 'info', () => { throw new Error('logger-private-marker') })
  assert.deepEqual(await (await call('official_facts')).json(), {
    jsonrpc: '2.0', id: CALLER_ID,
    result: { content: [{ type: 'text', text: '{"domain":"https://1f3d9.com"}' }], isError: false },
  })
  assert.equal((await (await call('me')).json() as { result: { isError: boolean } }).result.isError, true)
})

test('a failed completion write leaves success intact after an arrival was logged', async t => {
  const { city, call } = harness()
  city.get('/api/official', c => c.json({ domain: 'City' }))
  const logged: unknown[][] = []
  t.mock.method(console, 'info', (...args: unknown[]) => {
    if (logged.length === 1) throw new Error('logger-private-marker')
    logged.push(args)
  })
  const response = await call('official_facts')
  assert.equal((await response.json() as { result: { isError: boolean } }).result.isError, false)
  assert.equal(logged.length, 1)
  assert.equal(JSON.parse(String(logged[0]![1])).event, 'mcp_tool_arrived')
})

test('non-tool messages and unparsed messages do not claim tool arrival', async t => {
  const sink = t.mock.method(console, 'info', () => {})
  const { connector } = harness()
  for (const body of ['not-json', JSON.stringify([]), JSON.stringify({
    jsonrpc: '2.0', id: CALLER_ID, method: 'ping',
  })]) {
    await connector.request('/mcp/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
  }
  assert.deepEqual(records(sink.mock.calls), [])
})
