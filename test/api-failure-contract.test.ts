import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { apiFailureContract, apiFailureResponse, type ApiFailureReport } from '../src/api-failure.ts'
import { publicJson, publicResponseSafety } from '../src/public-output.ts'
import cityApp from '../src/index.ts'

const PUBLIC_ORIGIN = 'https://city.example'

test('plain API errors carry the same trace and recovery fields as connector errors', async () => {
  const app = new Hono()
  app.use('*', apiFailureContract(() => PUBLIC_ORIGIN))
  app.get('/api/example', c => {
    c.header('Retry-After', '9')
    c.header('Cache-Control', 'no-store')
    c.header('Vary', 'Authorization')
    return c.json({ error: 'example was refused', detail: 7, do_not_pay_again: true }, 409)
  })

  const response = await app.request('/api/example')
  const body = await response.json() as Record<string, unknown>

  assert.equal(response.status, 409)
  assert.equal(body.error, 'example was refused')
  assert.equal(body.detail, 7)
  assert.equal(body.do_not_pay_again, true)
  assert.equal(body.error_class, 'conflict')
  assert.equal(body.http_status, 409)
  assert.equal(body.front_door_tool, 'front_door')
  assert.equal(body.front_door, `${PUBLIC_ORIGIN}/`)
  assert.equal(body.request_id, response.headers.get('x-request-id'))
  assert.equal(response.headers.get('x-1f3d9-error-class'), 'conflict')
  assert.equal(response.headers.get('retry-after'), '9')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Authorization')
  assert.match(String(body.request_id), /^[0-9a-f-]{36}$/iu)
})

test('the mounted city app applies the failure contract to ordinary API validation', async () => {
  const response = await cityApp.request('/api/thing/not-a-number')
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.error_class, 'bad_input')
  assert.equal(body.http_status, 400)
  assert.equal(body.front_door_tool, 'front_door')
  assert.match(String(body.front_door), /^https:\/\//u)
  assert.equal(body.request_id, response.headers.get('x-request-id'))
})

test('the direct failure helper reuses an existing request id and logs the same reference', async () => {
  const records: ApiFailureReport[] = []
  const app = new Hono()
  app.get('/api/payment', c => apiFailureResponse(
    c,
    503,
    { error: 'payment lookup failed' },
    {
      publicOrigin: PUBLIC_ORIGIN,
      requestId: 'payment-request-reference',
      report: record => records.push(record),
      event: 'payment_route_failure',
    },
  ))

  const response = await app.request('/api/payment')
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.request_id, 'payment-request-reference')
  assert.equal(body.error_class, 'city_fault')
  assert.equal(body.http_status, 503)
  assert.equal(response.headers.get('x-request-id'), 'payment-request-reference')
  assert.deepEqual(records, [{
    event: 'payment_route_failure',
    request_id: 'payment-request-reference',
    error_class: 'city_fault',
    status: 503,
    method: 'GET',
    path: '/api/payment',
  }])
})

test('failure logs use the route template and never a credential-shaped dynamic path', async () => {
  const records: ApiFailureReport[] = []
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  const app = new Hono()
  app.get('/api/payment/:id', c => apiFailureResponse(c, 404, { error: 'not found' }, {
    publicOrigin: PUBLIC_ORIGIN,
    event: 'payment_route_failure',
    report: record => records.push(record),
  }))

  await app.request(`/api/payment/${credential}?copied=${credential}`)
  assert.equal(records[0]?.path, '/api/payment/:id')
  assert.doesNotMatch(JSON.stringify(records), new RegExp(credential, 'iu'))
})

test('unsafe caller-supplied request ids are replaced before response headers or logs', async () => {
  const records: ApiFailureReport[] = []
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  const app = new Hono()
  app.get('/api/payment', c => apiFailureResponse(c, 502, {
    error: 'payment failed',
    request_id: credential,
  }, {
    publicOrigin: PUBLIC_ORIGIN,
    event: 'payment_route_failure',
    report: record => records.push(record),
  }))

  const response = await app.request('/api/payment')
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.request_id, credential)
  assert.match(String(body.request_id), /^[0-9a-f-]{36}$/iu)
  assert.equal(response.headers.get('x-request-id'), body.request_id)
  assert.doesNotMatch(JSON.stringify(records), new RegExp(credential, 'iu'))
})

test('successes, HTML pages, and non-API responses keep their original bodies', async () => {
  const app = new Hono()
  app.use('*', apiFailureContract(() => PUBLIC_ORIGIN))
  app.get('/api/ok', c => c.json({ ok: true }))
  app.get('/api/page', c => c.html('<p>no</p>', 404))
  app.get('/page', c => c.json({ error: 'page miss' }, 404))

  assert.deepEqual(await (await app.request('/api/ok')).json(), { ok: true })
  assert.equal(await (await app.request('/api/page')).text(), '<p>no</p>')
  assert.deepEqual(await (await app.request('/page')).json(), { error: 'page miss' })
})

test('a credential-withheld public read has a matching trace and says the read stopped', async () => {
  const records: string[] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => records.push(values.map(String).join(' '))
  try {
    const app = new Hono()
    app.use('*', apiFailureContract(() => PUBLIC_ORIGIN))
    app.use('*', publicResponseSafety)
    app.get('/api/unsafe/:id', c => c.body(
      `{"broken":"1f3d9_sk_${'ab'.repeat(24)}"`,
      200,
      { 'content-type': 'application/json' },
    ))

    const credential = `1f3d9_sk_${'cd'.repeat(24)}`
    const response = await app.request(`/api/unsafe/${credential}?copied=${credential}`)
    const body = await response.json() as Record<string, unknown>
    assert.equal(response.status, 500)
    assert.match(String(body.error), /read was stopped\.$/iu)
    assert.equal(body.request_id, response.headers.get('x-request-id'))
    assert.equal(body.error_class, 'city_fault')
    assert.equal(body.http_status, 500)
    assert.equal(body.error_name, 'public_response_withheld')
    assert.equal(records.length, 1)
    assert.match(records[0]!, new RegExp(String(body.request_id), 'u'))
    assert.match(records[0]!, /public_response_withheld/iu)
    assert.match(records[0]!, /\/api\/unsafe\/:id/u)
    assert.doesNotMatch(records[0]!, new RegExp(credential, 'iu'))
  } finally {
    console.error = originalError
  }
})

test('credential withholding carries the same named reference on the public root', async () => {
  const records: string[] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => records.push(values.map(String).join(' '))
  try {
    const app = new Hono()
    app.use('*', apiFailureContract(() => PUBLIC_ORIGIN))
    app.use('*', publicResponseSafety)
    app.get('/', c => c.body(`{"broken":"1f3d9_sk_${'ef'.repeat(24)}"`, 200, {
      'content-type': 'application/json',
      'content-length': '999',
      'cache-control': 'public, max-age=3600',
    }))

    const response = await app.request('/')
    const body = await response.json() as Record<string, unknown>
    assert.equal(response.status, 500)
    assert.equal(body.error_name, 'public_response_withheld')
    assert.equal(body.request_id, response.headers.get('x-request-id'))
    assert.equal(body.error_class, 'city_fault')
    assert.equal(body.http_status, 500)
    assert.notEqual(response.headers.get('content-length'), '999')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(records.length, 1)
  } finally {
    console.error = originalError
  }
})

test('standalone publicJson withholding uses the named logged failure contract', async () => {
  const records: string[] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => records.push(values.map(String).join(' '))
  try {
    const app = new Hono()
    const circular: Record<string, unknown> = { unsafe: `1f3d9_sk_${'01'.repeat(24)}` }
    circular.self = circular
    app.get('/isolated', c => publicJson(c, circular))
    const response = await app.request('/isolated')
    const body = await response.json() as Record<string, unknown>
    assert.equal(response.status, 500)
    assert.equal(body.error_name, 'public_response_withheld')
    assert.equal(body.request_id, response.headers.get('x-request-id'))
    assert.equal(body.error_class, 'city_fault')
    assert.equal(body.http_status, 500)
    assert.equal(records.length, 1)
  } finally {
    console.error = originalError
  }
})
