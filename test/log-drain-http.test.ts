import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import {
  LOG_DRAIN_LIMITS,
  mountLogDrainRoutes,
  type LogDrainRouteDependencies,
} from '../src/log-drain-routes.ts'
import type { RuntimeLogRecord } from '../src/runtime-logs.ts'

const LOG_DRAIN_SECRET = 'ab'.repeat(32)
const CITY_KEY = `1f3d9_sk_${'cd'.repeat(24)}`
const MARKET_TOKEN = `1f3ea_at_${'ef'.repeat(32)}`

function delivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1573817250283254651097202070',
    deploymentId: 'dpl_city123',
    source: 'lambda',
    host: '1f3d9.com',
    timestamp: 1_773_792_000_123,
    projectId: 'prj_city123',
    projectName: '1f3d9',
    level: 'error',
    message: 'request failed safely',
    path: '/api/index',
    statusCode: 500,
    proxy: {
      timestamp: 1_773_792_000_100,
      method: 'GET',
      path: '/api/market/shelves?cursor=public',
      userAgent: ['VercelDrain test'],
      statusCode: 500,
    },
    ...overrides,
  }
}

function signedHeaders(body: string, secret = LOG_DRAIN_SECRET): Record<string, string> {
  return {
    'content-type': 'application/x-ndjson',
    'x-vercel-signature': createHmac('sha1', secret).update(body, 'utf8').digest('hex'),
  }
}

function routeHarness(overrides: Partial<LogDrainRouteDependencies> = {}) {
  const batches: RuntimeLogRecord[][] = []
  const dependencies: LogDrainRouteDependencies = {
    environment: { LOG_DRAIN_SECRET },
    insert: async records => {
      batches.push([...records])
      return records.length
    },
    ...overrides,
  }
  const app = new Hono()
  mountLogDrainRoutes(app, dependencies)
  return { app, batches }
}

test('verification probes echo only a bounded x-vercel-verify challenge and never write', async () => {
  const { app, batches } = routeHarness()

  const unsigned = await app.request('/api/internal/log-drain', {
    method: 'POST',
    headers: { 'x-vercel-verify': 'verify_0123456789abcdef' },
    body: '{}',
  })
  assert.equal(unsigned.status, 200)
  assert.equal(unsigned.headers.get('x-vercel-verify'), 'verify_0123456789abcdef')
  assert.equal(unsigned.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await unsigned.json(), { ok: true, verification: true })

  const fixed = await app.request(
    '/api/internal/log-drain?verification=team_verify_0123456789abcdef',
    { method: 'POST', body: '{}' },
  )
  assert.equal(fixed.status, 200)
  assert.equal(fixed.headers.get('x-vercel-verify'), 'team_verify_0123456789abcdef')
  assert.deepEqual(await fixed.json(), { ok: true, verification: true })

  const body = '{}'
  const signed = await app.request('/api/internal/log-drain', {
    method: 'POST',
    headers: {
      ...signedHeaders(body),
      'x-vercel-verify': 'verify_signed_0123456789',
    },
    body,
  })
  assert.equal(signed.status, 200)
  assert.equal(signed.headers.get('x-vercel-verify'), 'verify_signed_0123456789')

  const signedWrong = await app.request('/api/internal/log-drain', {
    method: 'POST',
    headers: {
      'x-vercel-signature': '0'.repeat(40),
      'x-vercel-verify': 'verify_must_not_bypass_signature',
    },
    body,
  })
  assert.equal(signedWrong.status, 403)
  assert.equal(signedWrong.headers.get('x-vercel-verify'), null)

  const signedEmpty = await app.request('/api/internal/log-drain', {
    method: 'POST',
    headers: {
      'x-vercel-signature': '',
      'x-vercel-verify': 'verify_empty_must_not_bypass',
    },
    body,
  })
  assert.equal(signedEmpty.status, 403)
  assert.equal(signedEmpty.headers.get('x-vercel-verify'), null)

  const conflicting = await app.request(
    '/api/internal/log-drain?verification=team_verify_query',
    {
      method: 'POST',
      headers: { 'x-vercel-verify': 'team_verify_header' },
      body: '{}',
    },
  )
  assert.equal(conflicting.status, 403)

  for (const challenge of ['', 'contains a space', `v_${'x'.repeat(600)}`]) {
    const rejected = await app.request('/api/internal/log-drain', {
      method: 'POST',
      headers: challenge ? { 'x-vercel-verify': challenge } : {},
      body: '{}',
    })
    assert.equal(rejected.status, 403)
  }

  const invalidQuery = await app.request('/api/internal/log-drain?unexpected=value', {
    method: 'POST', body: '{}',
  })
  assert.equal(invalidQuery.status, 400)

  const oversizedChallenge = 'x'.repeat(LOG_DRAIN_LIMITS.batchBytes + 1)
  const boundedChallenge = await app.request('/api/internal/log-drain', {
    method: 'POST',
    headers: { 'x-vercel-verify': 'verify_bounded_body' },
    body: oversizedChallenge,
  })
  assert.equal(boundedChallenge.status, 413)
  assert.equal(batches.length, 0)
})

test('fixed verification survives signed deliveries without replacing ingestion', async () => {
  const body = `${JSON.stringify(delivery())}\n`
  const { app, batches } = routeHarness()
  const response = await app.request(
    '/api/internal/log-drain?verification=team_verify_0123456789abcdef',
    { method: 'POST', headers: signedHeaders(body), body },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-vercel-verify'), 'team_verify_0123456789abcdef')
  assert.deepEqual(await response.json(), { ok: true, accepted: 1, skipped: 0 })
  assert.equal(batches.length, 1)
})

test('the receiver fails closed when configuration or HMAC authentication is absent or wrong', async () => {
  for (const configured of [undefined, '', 'short', 'AB'.repeat(32), `bad secret_${'a'.repeat(32)}`]) {
    const { app, batches } = routeHarness({
      environment: { LOG_DRAIN_SECRET: configured },
    })
    const body = `${JSON.stringify(delivery())}\n`
    const response = await app.request('/api/internal/log-drain', {
      method: 'POST', headers: signedHeaders(body), body,
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'log drain is unavailable' })
    assert.equal(batches.length, 0)
  }

  const body = `${JSON.stringify(delivery())}\n`
  const { app, batches } = routeHarness()
  for (const signature of [undefined, '', 'not-hex', '0'.repeat(40)]) {
    const response = await app.request('/api/internal/log-drain', {
      method: 'POST',
      headers: signature === undefined ? {} : { 'x-vercel-signature': signature },
      body,
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'log drain signature verification failed',
    })
  }
  assert.equal(batches.length, 0)

  const valid = await app.request('/api/internal/log-drain', {
    method: 'POST', headers: signedHeaders(body), body,
  })
  assert.equal(valid.status, 200)
  assert.deepEqual(await valid.json(), { ok: true, accepted: 1, skipped: 0 })
  assert.equal(batches.length, 1)
})

test('malformed lines are skipped while valid records are allowlisted, normalized, and secret-free', async () => {
  const first = delivery({
    message: `failure included ${CITY_KEY} CRON_SECRET=cron_${'12'.repeat(32)} api_key: sk-${'z'.repeat(40)} postgres URL https://operator:password@example.test/private`,
    authorization: `Bearer ${LOG_DRAIN_SECRET}`,
    headers: { cookie: `session=${MARKET_TOKEN}` },
    proxy: {
      timestamp: 1_773_792_000_100,
      method: 'post',
      path: `/api/action?authorization=Bearer%20${LOG_DRAIN_SECRET}#private`,
      userAgent: [`agent ${MARKET_TOKEN}`],
      statusCode: -1,
      clientIp: '203.0.113.42',
    },
  })
  const second = delivery({
    id: '1573817250283254651097202071',
    deploymentId: 'dpl_market123',
    projectId: 'prj_market123',
    projectName: undefined,
    message: 'Authorization: Basic dXNlcjpwYXNzd29yZA==; cookie: first=abc; session=supersecret',
  })
  const structured = delivery({
    id: '1573817250283254651097202072',
    deploymentId: 'dpl_structured123',
    message: 'payload {"api_key":"ordinary-unprefixed-secret"} AWS_SECRET_ACCESS_KEY=another-unprefixed-secret',
  })
  const prefixed = delivery({
    id: '1573817250283254651097202073',
    deploymentId: 'dpl_prefixed123',
    message: 'oauth refresh_token=verySensitiveValue123 access_token=otherSensitiveValue456',
  })
  const camelCase = delivery({
    id: '1573817250283254651097202074',
    deploymentId: 'dpl_camel123',
    message: 'oauth {"accessToken":"camelSensitiveValue123","refreshToken":"camelSensitiveValue456"}',
  })
  const nulAssignment = delivery({
    id: '1573817250283254651097202075',
    deploymentId: 'dpl_nul_assignment123',
    message: 'api\0_key=nulSensitiveValue123',
  })
  const splitToken = delivery({
    id: '1573817250283254651097202076',
    deploymentId: 'dpl_nul_token123',
    message: `resident 1f3d9_sk_\0${'ab'.repeat(24)}`,
  })
  const diagnostic = delivery({
    id: '1573817250283254651097202077',
    deploymentId: 'dpl_diagnostic123',
    message: 'connector authorization failed after refresh',
  })
  const body = [
    JSON.stringify(first), '{broken', '[]', '', JSON.stringify(second),
    JSON.stringify(structured), JSON.stringify(prefixed), JSON.stringify(camelCase),
    JSON.stringify(nulAssignment), JSON.stringify(splitToken), JSON.stringify(diagnostic),
  ].join('\n')
  const { app, batches } = routeHarness()

  const response = await app.request('/api/internal/log-drain', {
    method: 'POST', headers: signedHeaders(body), body,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, accepted: 8, skipped: 2 })
  assert.equal(batches.length, 1)
  assert.equal(batches[0]!.length, 8)
  const [
    storedCity, storedMarket, storedStructured, storedPrefixed,
    storedCamelCase, storedNulAssignment, storedSplitToken, storedDiagnostic,
  ] = batches[0]!
  assert.deepEqual(Object.keys(storedCity!).sort(), [
    'deploymentId', 'durationMs', 'id', 'level', 'message', 'project',
    'requestMethod', 'requestPath', 'source', 'statusCode', 'timestamp', 'userAgent',
  ])
  assert.equal(storedCity!.project, 'prj_city123')
  assert.equal(storedCity!.requestMethod, 'POST')
  assert.equal(storedCity!.requestPath, '/api/action')
  assert.equal(storedCity!.statusCode, -1)
  assert.equal(storedCity!.durationMs, null)
  assert.equal(storedMarket!.project, 'prj_market123')
  const encoded = JSON.stringify(batches)
  assert.doesNotMatch(encoded, /"(?:authorization|cookie|clientIp)"\s*:/iu)
  assert.doesNotMatch(encoded, new RegExp(CITY_KEY, 'u'))
  assert.doesNotMatch(encoded, new RegExp(MARKET_TOKEN, 'u'))
  assert.doesNotMatch(encoded, new RegExp(LOG_DRAIN_SECRET, 'u'))
  assert.doesNotMatch(encoded, /cron_1212|sk-zzzz|operator:password/iu)
  assert.doesNotMatch(encoded, /dXNlcjpwYXNzd29yZA|first=abc|supersecret/iu)
  assert.doesNotMatch(
    encoded,
    /ordinary-unprefixed-secret|another-unprefixed-secret|verySensitiveValue123|otherSensitiveValue456|camelSensitiveValue|nulSensitiveValue/iu,
  )
  assert.equal(storedMarket!.message, '[redacted: log text contained credential material]')
  assert.equal(storedStructured!.message, '[redacted: log text contained credential material]')
  assert.equal(storedPrefixed!.message, '[redacted: log text contained credential material]')
  assert.equal(storedCamelCase!.message, '[redacted: log text contained credential material]')
  assert.equal(storedNulAssignment!.message, '[redacted: log text contained credential material]')
  assert.equal(storedSplitToken!.message, 'resident [redacted city credential]')
  assert.equal(storedDiagnostic!.message, 'connector authorization failed after refresh')
})

test('fragmented bodies stay bounded and unexpected compression is never acknowledged', async () => {
  const body = `${JSON.stringify(delivery())}\n`
  const encoder = new TextEncoder()
  const fragmentedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const character of body) controller.enqueue(encoder.encode(character))
      controller.close()
    },
  })
  const { app, batches } = routeHarness()
  const fragmented = new Request('https://city.test/api/internal/log-drain', {
    method: 'POST',
    headers: signedHeaders(body),
    body: fragmentedBody,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const accepted = await app.request(fragmented)
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { ok: true, accepted: 1, skipped: 0 })

  const compressed = await app.request('/api/internal/log-drain', {
    method: 'POST',
    headers: { ...signedHeaders(body), 'content-encoding': 'gzip' },
    body,
  })
  assert.equal(compressed.status, 415)
  assert.deepEqual(await compressed.json(), {
    error: 'log drain content encoding is unsupported',
  })
  assert.equal(batches.length, 1)
})

test('row, field, line, count, and whole-body limits stay bounded without a 500', async () => {
  const longMessage = '🏙'.repeat(LOG_DRAIN_LIMITS.messageBytes)
  const longAgent = 'agent/'.repeat(LOG_DRAIN_LIMITS.userAgentBytes)
  const bounded = delivery({
    message: longMessage,
    proxy: {
      method: 'GET-WITH-AN-IMPOSSIBLY-LONG-METHOD',
      path: `/${'é'.repeat(LOG_DRAIN_LIMITS.requestPathBytes)}?secret=must-disappear`,
      userAgent: [longAgent],
      statusCode: 200,
    },
  })
  const oversizedLine = JSON.stringify({ padding: 'x'.repeat(LOG_DRAIN_LIMITS.lineBytes) })
  const rows = Array.from({ length: LOG_DRAIN_LIMITS.insertRows + 1 }, (_, index) => (
    JSON.stringify(delivery({
      id: `log_${String(index).padStart(4, '0')}`,
      message: index === 0 ? longMessage : 'bounded',
      proxy: index === 0 ? (bounded.proxy as Record<string, unknown>) : undefined,
    }))
  ))
  rows.splice(1, 0, oversizedLine)
  const body = rows.join('\n')
  assert.ok(Buffer.byteLength(body, 'utf8') < LOG_DRAIN_LIMITS.batchBytes)
  const { app, batches } = routeHarness()

  const response = await app.request('/api/internal/log-drain', {
    method: 'POST', headers: signedHeaders(body), body,
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: LOG_DRAIN_LIMITS.insertRows + 1,
    skipped: 1,
  })
  assert.deepEqual(batches.map(batch => batch.length), [LOG_DRAIN_LIMITS.insertRows, 1])
  const stored = batches[0]![0]!
  assert.ok(Buffer.byteLength(stored.message ?? '', 'utf8') <= LOG_DRAIN_LIMITS.messageBytes)
  assert.ok(Buffer.byteLength(stored.userAgent ?? '', 'utf8') <= LOG_DRAIN_LIMITS.userAgentBytes)
  assert.ok(Buffer.byteLength(stored.requestPath ?? '', 'utf8') <= LOG_DRAIN_LIMITS.requestPathBytes)
  assert.ok(Buffer.byteLength(stored.requestMethod ?? '', 'utf8') <= LOG_DRAIN_LIMITS.requestMethodBytes)
  assert.doesNotMatch(stored.requestPath ?? '', /secret|\?/iu)

  const tooLarge = 'x'.repeat(LOG_DRAIN_LIMITS.batchBytes + 1)
  const rejected = await app.request('/api/internal/log-drain', {
    method: 'POST', headers: signedHeaders(tooLarge), body: tooLarge,
  })
  assert.equal(rejected.status, 413)
  assert.deepEqual(await rejected.json(), { error: 'log drain batch is too large' })
  assert.equal(batches.length, 2)

  const tooManyLines = Array.from(
    { length: LOG_DRAIN_LIMITS.batchLines + 1 },
    () => 'x',
  ).join('\n')
  const lineRejected = await app.request('/api/internal/log-drain', {
    method: 'POST', headers: signedHeaders(tooManyLines), body: tooManyLines,
  })
  assert.equal(lineRejected.status, 413)
  assert.deepEqual(await lineRejected.json(), { error: 'log drain batch has too many lines' })
  assert.equal(batches.length, 2)
})

test('temporary storage failure asks for retry without reflecting database or payload secrets', async () => {
  const body = `${JSON.stringify(delivery({ message: CITY_KEY }))}\n`
  const { app } = routeHarness({
    insert: async () => {
      throw new Error(`postgres://operator:password@example.test/db ${LOG_DRAIN_SECRET}`)
    },
  })
  const response = await app.request('/api/internal/log-drain', {
    method: 'POST', headers: signedHeaders(body), body,
  })

  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '1')
  const encoded = JSON.stringify(await response.json())
  assert.match(encoded, /storage is temporarily unavailable/iu)
  assert.doesNotMatch(encoded, /postgres|password|drain_/iu)
})
