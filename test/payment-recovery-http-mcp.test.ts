import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono, type Context } from 'hono'
import { mcp } from '../src/mcp.ts'
import {
  mountPaymentRecoveryRoutes,
  type PaymentRecoveryRouteDependencies,
} from '../src/payment-recovery-routes.ts'
import type { PaymentRecoveryAttempt } from '../src/payment-recovery.ts'

const ATTEMPT_ID = `pay_${'ab'.repeat(32)}`
const CRON_SECRET = `cron_${'cd'.repeat(32)}`

function storedAttempt(
  overrides: Partial<PaymentRecoveryAttempt> = {},
): PaymentRecoveryAttempt {
  return Object.freeze({
    publicId: ATTEMPT_ID,
    actorId: 68,
    operation: 'frontier',
    method: 'x402',
    status: 'payment_pending',
    recoveryDeadlineAt: '2026-08-22T02:15:00.000Z',
    ...overrides,
  }) as PaymentRecoveryAttempt
}

function privateView(current: PaymentRecoveryAttempt): Record<string, unknown> {
  return {
    id: current.publicId,
    state: current.status,
    operation: current.operation,
    method: current.method,
    recovery_deadline_at: current.recoveryDeadlineAt,
    do_not_pay_again: true,
    next_action: current.status === 'payment_pending'
      ? 'Wait for automatic recovery or recheck this attempt; do not pay again.'
      : 'No automatic city effect will occur.',
  }
}

function routeDependencies(
  overrides: Partial<PaymentRecoveryRouteDependencies> = {},
): PaymentRecoveryRouteDependencies {
  let current = storedAttempt()
  return {
    authenticate: async (c: Context) => c.req.header('authorization') === 'Bearer resident'
      ? { id: 68 }
      : null,
    getOwnedAttempt: async (publicId, actorId) => (
      publicId === current.publicId && actorId === current.actorId ? current : null
    ),
    privateView,
    recheck: async value => {
      current = storedAttempt({ ...value, status: 'completed' })
      return { state: 'completed', attemptId: value.publicId }
    },
    runBatch: async limit => ({
      scanned: limit,
      completed: 1,
      pending: 1,
      busy: 0,
      terminalized: 0,
      failed: 0,
    }),
    environment: { CRON_SECRET },
    ...overrides,
  }
}

function createHttpApp(deps: PaymentRecoveryRouteDependencies) {
  const app = new Hono()
  mountPaymentRecoveryRoutes(app, deps)
  return app
}

test('private inspection is owner-bound, passive, no-store, and secret-free', async () => {
  const app = createHttpApp(routeDependencies())

  const unauthenticated = await app.request(`/api/payment-attempt/${ATTEMPT_ID}`)
  assert.equal(unauthenticated.status, 401)

  const response = await app.request(`/api/payment-attempt/${ATTEMPT_ID}`, {
    headers: { authorization: 'Bearer resident' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.match(response.headers.get('vary') ?? '', /authorization/iu)
  const body = await response.json() as { payment_attempt: Record<string, unknown> }
  assert.equal(body.payment_attempt.id, ATTEMPT_ID)
  assert.equal(body.payment_attempt.do_not_pay_again, true)
  const encoded = JSON.stringify(body)
  for (const forbidden of [
    'request_hash', 'request_json', 'lease_owner', 'nonce', 'payload_digest',
    'payment_response_header', 'secret',
  ]) assert.doesNotMatch(encoded, new RegExp(forbidden, 'iu'))

  const foreign = await app.request(`/api/payment-attempt/${ATTEMPT_ID}`, {
    headers: { authorization: 'Bearer other' },
  })
  assert.equal(foreign.status, 401)
})

test('explicit recheck accepts exactly an empty object and uses stored terms only', async () => {
  let calls = 0
  const app = createHttpApp(routeDependencies({
    recheck: async value => {
      calls += 1
      assert.equal(value.publicId, ATTEMPT_ID)
      return { state: 'payment_pending', attemptId: value.publicId }
    },
  }))
  const headers = {
    authorization: 'Bearer resident',
    'content-type': 'application/json',
  }

  for (const body of [
    JSON.stringify({ name: 'changed' }),
    JSON.stringify({ transaction: `0x${'ef'.repeat(32)}` }),
    '[]',
  ]) {
    const rejected = await app.request(`/api/payment-attempt/${ATTEMPT_ID}/recheck`, {
      method: 'POST', headers, body,
    })
    assert.equal(rejected.status, 400)
  }
  const queryRejected = await app.request(
    `/api/payment-attempt/${ATTEMPT_ID}/recheck?transaction=pretend`,
    { method: 'POST', headers, body: '{}' },
  )
  assert.equal(queryRejected.status, 400)

  const response = await app.request(`/api/payment-attempt/${ATTEMPT_ID}/recheck`, {
    method: 'POST', headers, body: '{}',
  })
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
})

test('cron recovery fails closed and returns aggregate counts without attempt identifiers', async () => {
  let runs = 0
  const app = createHttpApp(routeDependencies({
    runBatch: async limit => {
      runs += 1
      assert.equal(limit, 10)
      return {
        scanned: 2, completed: 1, pending: 1, busy: 0, terminalized: 0, failed: 0,
      }
    },
  }))

  for (const authorization of [undefined, 'Bearer wrong']) {
    const response = await app.request('/api/internal/payment-recovery', {
      headers: authorization ? { authorization } : {},
    })
    assert.equal(response.status, 401)
  }
  assert.equal(runs, 0)

  const response = await app.request('/api/internal/payment-recovery', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json() as Record<string, unknown>
  assert.deepEqual(body, {
    ok: true,
    scanned: 2,
    completed: 1,
    pending: 1,
    busy: 0,
    terminalized: 0,
    failed: 0,
  })
  assert.doesNotMatch(JSON.stringify(body), /pay_|attempt|transaction/iu)
})

test('cron recovery stays disabled when CRON_SECRET is missing or malformed', async () => {
  for (const secret of [undefined, '', 'short', `bad secret_${'a'.repeat(32)}`]) {
    let runs = 0
    const app = createHttpApp(routeDependencies({
      environment: { CRON_SECRET: secret },
      runBatch: async () => {
        runs += 1
        throw new Error('must not run')
      },
    }))
    const response = await app.request('/api/internal/payment-recovery', {
      headers: { authorization: `Bearer ${secret ?? 'missing'}` },
    })
    assert.equal(response.status, 503)
    assert.equal(runs, 0)
  }
})

async function callTool(app: Hono, argumentsValue: Record<string, unknown>) {
  return await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer resident',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'payment_attempt', arguments: argumentsValue },
    }),
  })
}

test('MCP exposes one protected no-store inspect/recheck tool and never accepts payment proof', async () => {
  const city = new Hono()
  city.get('/api/payment-attempt/:id', c => c.json({
    action: 'inspect',
    id: c.req.param('id'),
    authorization: c.req.header('authorization'),
  }))
  city.post('/api/payment-attempt/:id/recheck', async c => c.json({
    action: 'recheck',
    id: c.req.param('id'),
    authorization: c.req.header('authorization'),
    body: await c.req.json(),
  }, 202))
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, city))

  const listedResponse = await gateway.request('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer resident', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const listed = await listedResponse.json() as {
    result: { tools: Array<Record<string, any>> }
  }
  const tool = listed.result.tools.find(candidate => candidate.name === 'payment_attempt')
  assert.ok(tool)
  assert.deepEqual(tool.inputSchema.required, ['action', 'attempt_id'])
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['inspect', 'recheck'])
  assert.equal('transaction' in tool.inputSchema.properties, false)
  assert.equal('payment' in tool.inputSchema.properties, false)
  assert.match(tool.description, /do not pay again|without paying again/iu)

  for (const action of ['inspect', 'recheck'] as const) {
    const response = await callTool(gateway, { action, attempt_id: ATTEMPT_ID })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
    assert.equal(payload.result.isError, false)
    const forwarded = JSON.parse(payload.result.content[0]!.text) as Record<string, unknown>
    assert.equal(forwarded.action, action)
    assert.equal(forwarded.id, ATTEMPT_ID)
    assert.equal(forwarded.authorization, 'Bearer resident')
    if (action === 'recheck') assert.deepEqual(forwarded.body, {})
  }

  for (const unsafe of [
    { action: 'recheck', attempt_id: ATTEMPT_ID, transaction: `0x${'aa'.repeat(32)}` },
    { action: 'recheck', attempt_id: ATTEMPT_ID, secret: 'pretend' },
  ]) {
    const response = await callTool(gateway, unsafe)
    const payload = await response.json() as { result: { isError: boolean } }
    assert.equal(payload.result.isError, true)
  }
})
