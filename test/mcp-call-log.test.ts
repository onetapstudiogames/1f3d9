import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { bindAuthenticatedResident } from '../src/core.ts'
import { CITY_PUBLIC_TOOL_CATALOG, mcp } from '../src/mcp.ts'
import {
  classifyClient,
  MCP_CALL_LOG_PAGE_MAX,
  outcomeForRefusalClass,
  parseMcpCallLogQuery,
  readMcpCallLog,
  recordMcpCall,
  refusalClassFromEnvelope,
  runMcpCallLogRetention,
  writeMcpCallBriefly,
  type McpCallLogDatabase,
  type McpCallLogRow,
} from '../src/mcp-call-log.ts'
import { mountMcpCallLogRoutes } from '../src/mcp-call-log-routes.ts'
import { runEachRetention } from '../src/log-retention.ts'
import { percentileMs, timeInserts, timingDatabaseUrl } from '../scripts/mcp-call-log-timing.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const AUTHORIZATION = `Bearer 1f3d9_sk_${'ab'.repeat(24)}`
const PRIVATE_ARGUMENT = 'argument-private-marker'
const ROW_KEYS = [
  'clientFamily', 'door', 'httpStatus', 'latencyMs', 'outcome', 'refusalClass',
  'requestId', 'residentId', 'tool',
]

function harness(options: { hang?: boolean; fail?: boolean } = {}) {
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  const rows: McpCallLogRow[] = []
  const callLog = async (row: McpCallLogRow) => {
    rows.push(row)
    if (options.fail) throw Object.assign(new Error('insert-private-marker'), { code: '53300' })
    if (options.hang) await new Promise(() => {})
  }
  const city = new Hono()
  const connector = new Hono()
  connector.post('/mcp', c => mcp(c, city, { callLog }))
  connector.post('/mcp/connect', c => mcp(c, city, {
    hostedChat: true, forwardUnauthorizedStatus: true, callLog,
  }))
  const call = (name: unknown, args: unknown = {}, path = '/mcp/connect', headers: Record<string, string> = {}) =>
    connector.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'caller-id', method: 'tools/call', params: { name, arguments: args } }),
    })
  return { city, call, rows }
}

test('the client classifier matches the user agents seen in production request rows', () => {
  const table: ReadonlyArray<readonly [string | null | undefined, string]> = [
    ['openai-mcp/1.0.0', 'chatgpt'],
    ['openai-mcp/1.0.0 (Codex)', 'codex'],
    ['codex-mcp-client/0.160.1', 'codex'],
    ['codex-mcp-client/0.162.0-alpha.2', 'codex'],
    ['Claude-User', 'claude_ai'],
    ['claude-code/2.1.291 (sdk-cli)', 'claude_code'],
    ['claude-code/2.1.292 (cli)', 'claude_code'],
    ['curl/8.5.0', 'other'],
    ['python-httpx/0.28.1', 'other'],
    ['Mozilla/5.0 openai-mcp/1.0.0', 'other'],
    ['', 'other'],
    [null, 'other'],
    [undefined, 'other'],
  ]
  for (const [agent, family] of table) assert.equal(classifyClient(agent), family, String(agent))
})

test('a city fault or unreachable route is an error and every other class is a refusal', () => {
  assert.equal(outcomeForRefusalClass('city_fault'), 'error')
  assert.equal(outcomeForRefusalClass('unreachable'), 'error')
  for (const errorClass of ['bad_input', 'not_found', 'auth_required', 'forbidden',
    'payment_required', 'conflict', 'rate_limited', 'rpc_error'] as const) {
    assert.equal(outcomeForRefusalClass(errorClass), 'refused')
  }
  assert.equal(refusalClassFromEnvelope('{"error_class":"conflict"}'), 'conflict')
  assert.equal(refusalClassFromEnvelope('{"error_class":"made_up"}'), null)
  assert.equal(refusalClassFromEnvelope('not json'), null)
})

test('every catalogue tool name fits the stored tool column', () => {
  for (const tool of CITY_PUBLIC_TOOL_CATALOG) assert.match(tool.name, /^[a-z_]{1,64}$/u)
})

test('both doors write one row per tools/call with exactly the closed fields', async t => {
  t.mock.method(console, 'info', () => {})
  const { city, call, rows } = harness()
  city.get('/api/official', c => c.json({ domain: 'https://1f3d9.com' }))
  city.get('/api/me', c => c.json({ error: 'nope' }, 409))
  city.get('/api/physics', c => c.json({ error: 'down' }, 503))

  await call('mcp_for_1f3d9_official_facts', {}, '/mcp/connect', { 'user-agent': 'openai-mcp/1.0.0' })
  await call('official_facts', {}, '/mcp', { 'user-agent': 'claude-code/2.1.291 (sdk-cli)' })
  await call('me', {}, '/mcp/connect', { authorization: AUTHORIZATION, 'user-agent': 'openai-mcp/1.0.0 (Codex)' })
  await call('physics', {}, '/mcp', { 'user-agent': 'Claude-User' })
  await call('no_such_tool', {}, '/mcp')
  await call('look', { parent_id: 796 }, '/mcp/connect')

  assert.equal(rows.length, 6)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS)
    assert.match(row.requestId, UUID)
    assert.ok(Number.isInteger(row.latencyMs) && row.latencyMs >= 0)
  }
  const [hostedOk, legacyOk, conflict, fault, rpc, badInput] = rows as [
    McpCallLogRow, McpCallLogRow, McpCallLogRow, McpCallLogRow, McpCallLogRow, McpCallLogRow,
  ]
  assert.deepEqual({ ...hostedOk, requestId: '', latencyMs: 0 }, {
    door: 'connect', tool: 'official_facts', residentId: null, clientFamily: 'chatgpt',
    requestId: '', outcome: 'ok', refusalClass: null, httpStatus: 200, latencyMs: 0,
  })
  assert.equal(legacyOk.door, 'mcp')
  assert.equal(legacyOk.clientFamily, 'claude_code')
  assert.equal(legacyOk.outcome, 'ok')
  assert.deepEqual([conflict.clientFamily, conflict.outcome, conflict.refusalClass, conflict.httpStatus],
    ['codex', 'refused', 'conflict', 409])
  assert.deepEqual([fault.clientFamily, fault.outcome, fault.refusalClass, fault.httpStatus],
    ['claude_ai', 'error', 'city_fault', 503])
  assert.deepEqual([rpc.tool, rpc.outcome, rpc.refusalClass, rpc.httpStatus],
    ['unknown', 'refused', 'rpc_error', null])
  assert.deepEqual([badInput.tool, badInput.outcome, badInput.refusalClass, badInput.httpStatus],
    ['look', 'refused', 'bad_input', null])
})

test('an unreachable backing route and an unexpected exception are both errors', async t => {
  t.mock.method(console, 'info', () => {})
  const { city, call, rows } = harness()
  const requestMock = t.mock.method(city, 'request', async () => { throw new Error('raw-private-marker') })
  await call('official_facts')
  assert.deepEqual([rows[0]!.outcome, rows[0]!.refusalClass, rows[0]!.httpStatus], ['error', 'unreachable', null])
  requestMock.mock.restore()

  const connector = new Hono()
  const thrown: McpCallLogRow[] = []
  connector.onError((_error, c) => c.json({ error: 'unexpected' }, 500))
  connector.post('/mcp', c => mcp(c, city, { callLog: async row => { thrown.push(row) } }))
  // JSON preserves a malicious own toString; name conversion throws before dispatch.
  const response = await connector.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: { toString: 'raw-private-marker' } } }),
  })
  assert.equal(response.status, 500)
  assert.equal(thrown.length, 1)
  assert.deepEqual([thrown[0]!.tool, thrown[0]!.outcome, thrown[0]!.refusalClass, thrown[0]!.httpStatus],
    ['unknown', 'error', null, null])
  assert.equal(JSON.stringify(thrown).includes('raw-private-marker'), false)
})

test('the resident id is bound on both doors and null when anonymous', async t => {
  t.mock.method(console, 'info', () => {})
  const { city, call, rows } = harness()
  city.get('/api/me', c => {
    bindAuthenticatedResident(c.req.raw, 42)
    return c.json({ handle: 'someone' })
  })
  city.get('/api/official', c => c.json({ domain: 'https://1f3d9.com' }))

  await call('me', {}, '/mcp', { authorization: AUTHORIZATION })
  await call('me', {}, '/mcp/connect', { authorization: AUTHORIZATION })
  await call('official_facts', {}, '/mcp', { authorization: AUTHORIZATION })
  await call('official_facts', {}, '/mcp/connect')

  assert.deepEqual(rows.map(row => [row.door, row.residentId]), [
    ['mcp', 42], ['connect', 42], ['mcp', null], ['connect', null],
  ])
})

test('a successful look takes its resident from the looking request', async t => {
  t.mock.method(console, 'info', () => {})
  const { city, call, rows } = harness()
  city.get('/api/place/:id', c => c.json({ place: { id: 7 } }))
  city.post('/api/internal/mcp-looking', c => {
    bindAuthenticatedResident(c.req.raw, 9)
    return c.body(null, 204)
  })
  await call('look', { place_id: 7 }, '/mcp/connect', { authorization: AUTHORIZATION })
  assert.equal(rows[0]!.residentId, 9)
})

test('no argument value reaches the row', async t => {
  t.mock.method(console, 'info', () => {})
  const { city, call, rows } = harness()
  city.get('/api/place/:id', c => c.json({ place: { id: 7, description: PRIVATE_ARGUMENT } }))
  await call('look', { place_id: 7, view: PRIVATE_ARGUMENT })
  await call('say', { place_id: 7, text: PRIVATE_ARGUMENT }, '/mcp', { authorization: AUTHORIZATION })
  await call(PRIVATE_ARGUMENT, { text: PRIVATE_ARGUMENT })
  assert.equal(rows.length, 3)
  assert.equal(JSON.stringify(rows).includes(PRIVATE_ARGUMENT), false)
})

test('a failing or hanging write keeps the same response within the cap and prints one fixed line', async t => {
  t.mock.method(console, 'info', () => {})
  const errors = t.mock.method(console, 'error', () => {})
  const baseline = harness()
  baseline.city.get('/api/official', c => c.json({ domain: 'https://1f3d9.com' }))
  const expected = await (await baseline.call('official_facts')).json() as { result: unknown }

  for (const mode of [{ fail: true }, { hang: true }]) {
    const { city, call, rows } = harness(mode)
    city.get('/api/official', c => c.json({ domain: 'https://1f3d9.com' }))
    const started = performance.now()
    const response = await call('official_facts')
    const elapsed = performance.now() - started
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json() as { result: unknown }).result, expected.result)
    assert.equal(rows.length, 1)
    assert.ok(elapsed < 1_000, `write cap held the reply for ${elapsed} ms`)
  }
  const lines = errors.mock.calls.filter(entry => entry.arguments[0] === 'mcp_call_log_failure')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(String(lines[0]!.arguments[1])), {
    event: 'mcp_call_log_failure', error_name: 'Error', error_code: '53300',
  })
  assert.deepEqual(JSON.parse(String(lines[1]!.arguments[1])), {
    event: 'mcp_call_log_failure', error_name: 'McpCallLogTimeout',
  })
  assert.equal(JSON.stringify(errors.mock.calls.map(entry => entry.arguments)).includes('insert-private-marker'), false)
})

test('other MCP methods write no row', async t => {
  t.mock.method(console, 'info', () => {})
  const rows: McpCallLogRow[] = []
  const connector = new Hono()
  connector.post('/mcp', c => mcp(c, new Hono(), { callLog: async row => { rows.push(row) } }))
  for (const method of ['initialize', 'ping', 'tools/list', 'resources/list']) {
    await connector.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    })
  }
  assert.deepEqual(rows, [])
})

function recordingDatabase(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; params: readonly unknown[] }[] = []
  const database: McpCallLogDatabase = {
    query: async (text, params = []) => {
      calls.push({ text, params })
      return rows
    },
  }
  return { calls, database }
}

const SAMPLE: McpCallLogRow = Object.freeze({
  door: 'connect',
  tool: 'look',
  residentId: 12,
  clientFamily: 'chatgpt',
  requestId: '6f1c2c0e-2b7a-4d7e-9f00-0a1b2c3d4e5f',
  outcome: 'refused',
  refusalClass: 'not_found',
  httpStatus: 404,
  latencyMs: 31,
})

test('the insert is one parameterised statement of the nine closed fields', async () => {
  const { calls, database } = recordingDatabase()
  await recordMcpCall(database, SAMPLE)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.text, /INSERT INTO mcp_call_log \(\s*door, tool, resident_id, client_family, request_id,\s*outcome, refusal_class, http_status, latency_ms\s*\)/u)
  assert.deepEqual(calls[0]!.params, ['connect', 'look', 12, 'chatgpt', SAMPLE.requestId, 'refused', 'not_found', 404, 31])
  for (const bad of [
    { ...SAMPLE, tool: 'Look' },
    { ...SAMPLE, outcome: 'ok' as const },
    { ...SAMPLE, residentId: 0 },
    { ...SAMPLE, latencyMs: 600_001 },
    { ...SAMPLE, requestId: 'not-a-uuid' },
    { ...SAMPLE, httpStatus: 99 },
  ]) {
    await assert.rejects(recordMcpCall(database, bad), /outside the reviewed shape/u)
  }
  assert.equal(calls.length, 1)
})

test('writeMcpCallBriefly swallows a late rejection after the cap', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  let reject!: (error: Error) => void
  await writeMcpCallBriefly(() => new Promise((_resolve, rejecter) => { reject = rejecter }), SAMPLE, 10)
  reject(new Error('late'))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(errors.mock.callCount(), 1)
})

test('retention runs only in minutes 0 to 4 and checks its result', async () => {
  const idle = recordingDatabase()
  assert.deepEqual(await runMcpCallLogRetention(idle.database, new Date('2026-10-09T12:05:00Z')),
    { ran: false, deleted: 0 })
  assert.equal(idle.calls.length, 0)

  const ran = recordingDatabase([{ ran: true, deleted: 17 }])
  assert.deepEqual(await runMcpCallLogRetention(ran.database, new Date('2026-10-09T12:04:59Z')),
    { ran: true, deleted: 17 })
  assert.deepEqual(ran.calls[0]!.params, ['2026-10-09T12:04:59.000Z', '2026-09-09T12:04:59.000Z', 5_000])

  await assert.rejects(runMcpCallLogRetention(recordingDatabase([{ ran: false, deleted: 3 }]).database,
    new Date('2026-10-09T12:00:00Z')), /invalid result/u)
  await assert.rejects(runMcpCallLogRetention(recordingDatabase().database, new Date(Number.NaN)),
    /valid current time/u)
})

test('the founder query accepts only the five options inside their bounds', () => {
  assert.deepEqual(parseMcpCallLogQuery({}), {
    ok: true, value: { residentId: null, since: null, until: null, beforeId: null, limit: 100 },
  })
  const full = parseMcpCallLogQuery({
    resident_id: ['42'], since: ['2026-10-01T00:00:00Z'], until: ['2026-11-01T00:00:00Z'],
    before_id: ['900'], limit: [String(MCP_CALL_LOG_PAGE_MAX)],
  })
  assert.ok(full.ok)
  assert.equal(full.value.limit, 500)
  for (const query of [
    { force: ['1'] },
    { limit: ['501'] },
    { limit: ['0'] },
    { limit: ['1', '2'] },
    { resident_id: ['-1'] },
    { resident_id: ['2147483648'] },
    { before_id: ['abc'] },
    { since: ['yesterday'] },
    { since: ['2026-10-01'] },
    { until: ['2026-10-01T00:00:00'] },
    { since: ['2026-10-01T00:00:00Z'], until: ['2026-11-01T00:00:01Z'] },
    { since: ['2026-10-02T00:00:00Z'], until: ['2026-10-01T00:00:00Z'] },
  ]) {
    assert.equal(parseMcpCallLogQuery(query).ok, false, JSON.stringify(query))
  }
})

test('the founder read pages newest first and returns only the eleven columns', async () => {
  const stored = [5, 4, 3].map(id => ({
    id: String(id), at: new Date(`2026-10-09T12:00:0${id}Z`), door: 'mcp', tool: 'me',
    resident_id: 42, client_family: 'other', request_id: SAMPLE.requestId, outcome: 'ok',
    refusal_class: null, http_status: 200, latency_ms: 12, extra: 'never-served',
  }))
  const { calls, database } = recordingDatabase(stored)
  const page = await readMcpCallLog(database, {
    residentId: 42, since: new Date('2026-10-09T00:00:00Z'), until: null, beforeId: 6, limit: 2,
  })
  assert.match(calls[0]!.text, /WHERE id < \$1::bigint AND resident_id = \$2::integer AND at >= \$3::timestamptz/u)
  assert.match(calls[0]!.text, /ORDER BY id DESC\s+LIMIT \$4/u)
  assert.deepEqual(calls[0]!.params, [6, 42, '2026-10-09T00:00:00.000Z', 3])
  assert.equal(page.hasMore, true)
  assert.equal(page.nextBeforeId, 4)
  assert.deepEqual(page.calls.map(call => call.id), [5, 4])
  assert.deepEqual(Object.keys(page.calls[0]!).sort(), [
    'at', 'client_family', 'door', 'http_status', 'id', 'latency_ms', 'outcome',
    'refusal_class', 'request_id', 'resident_id', 'tool',
  ])
  assert.equal(page.calls[0]!.at, '2026-10-09T12:00:05.000Z')

  await assert.rejects(readMcpCallLog(recordingDatabase([{ ...stored[0], door: 'web' }]).database, {
    residentId: null, since: null, until: null, beforeId: null, limit: 1,
  }), /outside the reviewed shape/u)
})

function routeHarness(residentId: number | null, stored: Record<string, unknown>[] = []) {
  const app = new Hono()
  const { calls, database } = recordingDatabase(stored)
  mountMcpCallLogRoutes(app, {
    database,
    authenticate: async () => residentId === null ? null : {
      id: residentId, handle: 'h', model: 'm', joined_at: '', quota_day: '',
      things_today: 0, notes_today: 0, agreement_actions_today: 0,
    },
  })
  return { app, calls }
}

function storedRow(id: number, residentId: number | null = 42) {
  return {
    id: String(id), at: new Date(Date.UTC(2026, 9, 9, 12, 0, id)), door: 'connect', tool: 'look',
    resident_id: residentId, client_family: 'chatgpt', request_id: SAMPLE.requestId,
    outcome: 'refused', refusal_class: 'not_found', http_status: 404, latency_ms: 20,
  }
}

test('the founder call log route refuses without a key, for a non-founder and for a bad query', async () => {
  const missing = await routeHarness(null).app.request('/api/founder/mcp-calls')
  assert.equal(missing.status, 401)
  assert.match(missing.headers.get('cache-control') ?? '', /no-store/u)
  const stranger = routeHarness(7)
  const refused = await stranger.app.request('/api/founder/mcp-calls')
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { error: 'only founder resident #1 may read the tool call log' })
  assert.equal(stranger.calls.length, 0)

  const founder = routeHarness(1)
  for (const query of ['?force=1', '?limit=501', '?since=2026-10-01T00:00:00Z&until=2026-11-02T00:00:00Z', '?resident_id=x']) {
    const bad = await founder.app.request(`/api/founder/mcp-calls${query}`)
    assert.equal(bad.status, 400, query)
  }
  assert.equal(founder.calls.length, 0)
})

test('the founder call log route pages through next_before_id and filters by resident', async () => {
  const { app, calls } = routeHarness(1, [storedRow(9), storedRow(8), storedRow(7)])
  const first = await app.request('/api/founder/mcp-calls?resident_id=42&limit=2')
  assert.equal(first.status, 200)
  const body = await first.json() as {
    calls: Array<Record<string, unknown>>; returned_calls: number; has_more: boolean; next_before_id: number | null
  }
  assert.deepEqual(Object.keys(body).sort(), ['calls', 'has_more', 'next_before_id', 'returned_calls'])
  assert.equal(body.returned_calls, 2)
  assert.equal(body.has_more, true)
  assert.equal(body.next_before_id, 8)
  assert.deepEqual(body.calls.map(call => call.id), [9, 8])
  assert.deepEqual(calls[0]!.params, [42, 3])
  assert.match(calls[0]!.text, /WHERE resident_id = \$1::integer\s+ORDER BY id DESC/u)

  await app.request(`/api/founder/mcp-calls?resident_id=42&limit=2&before_id=${body.next_before_id}`)
  assert.deepEqual(calls[1]!.params, [8, 42, 3])
})

test('each retention runs in its own try so one failure never stops the other', async () => {
  const ran: string[] = []
  const reported: unknown[] = []
  await runEachRetention([
    { run: async () => { ran.push('runtime'); throw new Error('first') }, report: error => reported.push(error) },
    { run: async () => { ran.push('calls') }, report: error => reported.push(error) },
  ])
  assert.deepEqual(ran, ['runtime', 'calls'])
  assert.equal(reported.length, 1)
})

test('the preview timing script refuses without its guard and times the city write', async () => {
  assert.throws(() => timingDatabaseUrl({}), /CONFIRM_MCP_CALL_LOG_TIMING=PREVIEW_ONLY/u)
  assert.throws(() => timingDatabaseUrl({ CONFIRM_MCP_CALL_LOG_TIMING: 'PREVIEW_ONLY' }),
    /PREVIEW_DATABASE_URL_UNPOOLED must/u)
  assert.equal(timingDatabaseUrl({
    CONFIRM_MCP_CALL_LOG_TIMING: 'PREVIEW_ONLY', PREVIEW_DATABASE_URL_UNPOOLED: ' postgres://u@h/db ',
  }), 'postgres://u@h/db')
  assert.equal(percentileMs([5, 1, 3, 2, 4], 0.5), 3)
  assert.equal(percentileMs([5, 1, 3, 2, 4], 0.95), 5)
  assert.throws(() => percentileMs([], 0.5), /no timing samples/u)
  const { calls, database } = recordingDatabase()
  const timed = await timeInserts(database, 3)
  assert.equal(timed.samples.length, 3)
  assert.deepEqual(calls.map(call => call.params[4]), timed.requestIds)
})
