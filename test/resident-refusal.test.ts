import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  allowOAuthForHostedConnectorRequest,
  authPassive,
  bindAuthenticatedResident,
  setPassiveOAuthResidentResolver,
} from '../src/core.ts'
import { mcp } from '../src/mcp.ts'
import { publicResponseSafety } from '../src/public-output.ts'
import {
  advanceResidentRefusal,
  formatRepeatedRefusal,
  residentRefusalGuidance,
  type RefusalQueryExecutor,
} from '../src/resident-refusal.ts'

type StoredStreak = Readonly<{
  status: number
  causeHash: string
  repetitionCount: number
}>

function fakeRefusalQuery(): Readonly<{
  query: RefusalQueryExecutor
  states: Map<number, StoredStreak>
  parameters: unknown[][]
}> {
  const states = new Map<number, StoredStreak>()
  const parameters: unknown[][] = []
  const query: RefusalQueryExecutor = async (text, values) => {
    parameters.push([...values])
    assert.match(text, /INSERT\s+INTO\s+resident_refusal_state/iu)
    assert.match(text, /ON\s+CONFLICT\s*\(resident_id\)\s+DO\s+UPDATE/iu)
    const [residentId, status, causeHash] = values as [number, number, string]
    const previous = states.get(residentId)
    const repetitionCount = previous?.status === status && previous.causeHash === causeHash
      ? Math.min(previous.repetitionCount + 1, 10)
      : 1
    states.set(residentId, { status, causeHash, repetitionCount })
    return [{ repetition_count: repetitionCount }]
  }
  return { query, states, parameters }
}

test('repeated refusal wording varies and adds plain human guidance at ten', () => {
  const cause = 'this place is not open to notes'
  assert.equal(formatRepeatedRefusal(cause, 1), cause)
  assert.notEqual(formatRepeatedRefusal(cause, 2), formatRepeatedRefusal(cause, 3))
  for (const repetition of [2, 3, 4, 9]) {
    assert.match(formatRepeatedRefusal(cause, repetition), new RegExp(cause, 'u'))
    assert.doesNotMatch(formatRepeatedRefusal(cause, repetition), /tell your human|\/help/iu)
  }
  assert.match(
    formatRepeatedRefusal(cause, 10),
    /\n\nStop and tell your human\. Open \/help\.$/u,
  )
  assert.doesNotMatch(formatRepeatedRefusal(cause, 10), /\bten\b/iu)
})

test('durable refusal streaks are resident-bound and reset for a different cause or status', async () => {
  const fake = fakeRefusalQuery()
  const causeA = 'this place is not open to notes'
  const causeB = 'the daily note limit has been reached'

  for (let repetition = 1; repetition <= 9; repetition += 1) {
    assert.equal(await advanceResidentRefusal(7, 403, causeA, fake.query), repetition)
  }
  assert.equal(await advanceResidentRefusal(7, 429, causeB, fake.query), 1)
  assert.equal(await advanceResidentRefusal(7, 403, causeA, fake.query), 1)
  assert.equal(await advanceResidentRefusal(8, 403, causeA, fake.query), 1)
  assert.equal(await advanceResidentRefusal(8, 409, causeA, fake.query), 1)

  assert.equal(fake.states.size, 2)
  assert.ok(fake.parameters.every(values => values.length === 3))
  assert.ok(fake.parameters.every(values => !values.includes(causeA) && !values.includes(causeB)))
  assert.ok(fake.parameters.every(values => /^[0-9a-f]{64}$/u.test(String(values[2]))))
})

test('authenticated JSON refusals vary without changing status, fields, or cache safety', async () => {
  const fake = fakeRefusalQuery()
  const app = new Hono()
  app.use('*', residentRefusalGuidance((residentId, status, cause) => (
    advanceResidentRefusal(residentId, status, cause, fake.query)
  )))
  app.get('/api/refusal/:cause', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    const cause = c.req.param('cause') === 'quota'
      ? 'the daily note limit has been reached'
      : 'this place is not open to notes'
    c.header('X-Test-Header', 'preserved')
    return c.json({
      error: cause,
      action: { id: 91, status: 'blocked', error: cause },
      error_class: 'forbidden',
    }, 403)
  })

  let body: { error: string; action: { error: string }; error_class: string } | undefined
  for (let repetition = 1; repetition <= 10; repetition += 1) {
    const response = await app.request('/api/refusal/place')
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('x-test-header'), 'preserved')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('pragma'), 'no-cache')
    assert.match(response.headers.get('vary') ?? '', /(?:^|,\s*)Authorization(?:,|$)/iu)
    assert.equal(response.headers.get('content-length'), null)
    body = await response.json() as typeof body
    assert.equal(body?.action.error, body?.error)
    assert.equal(body?.error_class, 'forbidden')
    if (repetition < 10) assert.doesNotMatch(body?.error ?? '', /tell your human|\/help/iu)
  }
  assert.match(body?.error ?? '', /Stop and tell your human\. Open \/help\./u)

  const differentCause = await app.request('/api/refusal/quota')
  assert.deepEqual(await differentCause.json(), {
    error: 'the daily note limit has been reached',
    action: {
      id: 91,
      status: 'blocked',
      error: 'the daily note limit has been reached',
    },
    error_class: 'forbidden',
  })
})

test('the same short cause on different routes never shares a repetition streak', async () => {
  const fake = fakeRefusalQuery()
  const app = new Hono()
  app.use('*', residentRefusalGuidance((residentId, status, cause) => (
    advanceResidentRefusal(residentId, status, cause, fake.query)
  )))
  for (const path of ['/api/action', '/api/note'] as const) {
    app.post(path, c => {
      bindAuthenticatedResident(c.req.raw, 7)
      return c.json({ error: 'no such thing' }, 404)
    })
  }

  const firstAction = await app.request('/api/action', { method: 'POST' })
  assert.deepEqual(await firstAction.json(), { error: 'no such thing' })
  const repeatedAction = await app.request('/api/action', { method: 'POST' })
  assert.match(
    (await repeatedAction.json() as { error: string }).error,
    /same refusal again/iu,
  )
  const firstNote = await app.request('/api/note', { method: 'POST' })
  assert.deepEqual(await firstNote.json(), { error: 'no such thing' })

  assert.equal(fake.parameters.length, 3)
  assert.notEqual(fake.parameters[0]?.[2], fake.parameters[2]?.[2])
})

test('paid route refusals stay exact while free gift and listing refusals can vary', async () => {
  let advances = 0
  const app = new Hono()
  app.use('*', residentRefusalGuidance(async () => {
    advances += 1
    return 2
  }))
  const paidPaths = [
    '/api/city-credit/gifts/4/accept',
    '/api/founder/city-credit/disputes/case-4/resolve',
    '/api/payment-attempt/pay-4/recheck',
    '/api/place',
    '/api/kind',
    '/api/kind/3/revise',
    '/api/kind/not-an-id/revise',
    '/api/transfer/offer',
    '/api/transfer/90/claim',
    '/api/transfer/90/cancel',
    '/api/transfer/not-an-id/claim',
    '/api/world/offer/90/claim',
    '/api/world/offer/90/reconcile',
    '/api/world/offer/90/cancel',
    '/api/world/offer/not-an-id/reconcile',
  ] as const
  const freePaths = ['/api/transfer', '/api/world/listing'] as const
  for (const path of [...paidPaths, ...freePaths]) {
    app.post(path, c => {
      bindAuthenticatedResident(c.req.raw, 7)
      return c.json({ error: 'operation refused' }, 409)
    })
  }

  for (const path of paidPaths) {
    const response = await app.request(path, { method: 'POST' })
    assert.deepEqual(await response.json(), { error: 'operation refused' }, path)
  }
  for (const path of freePaths) {
    const response = await app.request(path, { method: 'POST' })
    assert.match(
      (await response.json() as { error: string }).error,
      /same refusal again/iu,
      path,
    )
  }
  assert.equal(advances, freePaths.length)
})

test('anonymous, unauthorized, server, and counter-failure responses keep their original text', async () => {
  let advances = 0
  const app = new Hono()
  app.use('*', residentRefusalGuidance(async () => {
    advances += 1
    throw new Error('counter unavailable')
  }))
  app.get('/api/anonymous', c => c.json({ error: 'anonymous refusal' }, 403))
  app.get('/api/unauthorized', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    return c.json({ error: 'sign in first' }, 401)
  })
  app.get('/api/server', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    return c.json({ error: 'city fault' }, 503)
  })
  app.get('/api/tracked', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    return c.json({ error: 'rule refusal' }, 403)
  })

  for (const [path, error] of [
    ['/api/anonymous', 'anonymous refusal'],
    ['/api/unauthorized', 'sign in first'],
    ['/api/server', 'city fault'],
    ['/api/tracked', 'rule refusal'],
  ] as const) {
    const response = await app.request(path)
    assert.equal((await response.json() as { error: string }).error, error)
  }
  assert.equal(advances, 1)
})

test('credential safety runs before a refusal cause reaches durable counting', async () => {
  const capturedCauses: string[] = []
  const app = new Hono()
  app.use('*', residentRefusalGuidance(async (_residentId, _status, cause) => {
    capturedCauses.push(cause)
    return 1
  }))
  app.use('*', publicResponseSafety)
  app.get('/api/unsafe', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    const credential = `1f3d9_sk_${'a'.repeat(48)}`
    return c.json({ error: `refused ${credential}` }, 403)
  })

  const response = await app.request('/api/unsafe')
  const body = await response.text()
  assert.equal(capturedCauses.length, 1)
  assert.doesNotMatch(capturedCauses[0]!, /1f3d9_sk_/iu)
  assert.doesNotMatch(body, /1f3d9_sk_/iu)
})

test('private credential-shaped causes are never fingerprinted', async () => {
  let advances = 0
  const credential = `1f3d9_sk_${'b'.repeat(48)}`
  const app = new Hono()
  app.use('*', residentRefusalGuidance(async () => {
    advances += 1
    return 2
  }))
  app.get('/api/me', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    return c.json({ error: `unsupported query option: ${credential}` }, 400)
  })

  const response = await app.request('/api/me')
  assert.equal(response.status, 400)
  assert.equal(
    (await response.json() as { error: string }).error,
    `unsupported query option: ${credential}`,
  )
  assert.equal(advances, 0)
})

test('payment challenges and replay-bound responses remain byte exact and uncounted', async () => {
  let advances = 0
  const app = new Hono()
  app.use('*', residentRefusalGuidance(async () => {
    advances += 1
    return 2
  }))
  app.all('/api/payment/:kind', c => {
    bindAuthenticatedResident(c.req.raw, 7)
    if (c.req.param('kind') === 'challenge') {
      return c.json({ error: 'payment required' }, 402)
    }
    if (c.req.param('kind') === 'replay') {
      return c.json({ error: 'the recorded payment terms differ', do_not_pay_again: true }, 409)
    }
    return c.json({
      error: 'eligible action failed; city fee credit returned',
      city_fee_credit: 'credit_returned',
      returned_usdc: '1.000000',
    }, 409)
  })
  for (const path of [
    '/api/founder/city-credit',
    '/api/transfer/90/claim',
    '/api/world/offer/90/reconcile',
  ] as const) {
    app.post(path, c => {
      bindAuthenticatedResident(c.req.raw, 7)
      return c.json({ error: 'payment operation refused' }, 409)
    })
  }

  const requests = [
    new Request('http://localhost/api/payment/challenge'),
    new Request('http://localhost/api/payment/replay'),
    new Request('http://localhost/api/payment/credit', {
      headers: { 'X-1F3D9-FEE-CREDIT': 'same-request-id' },
    }),
    new Request('http://localhost/api/payment/credit', {
      headers: { 'X-PAYMENT': 'payment-proof' },
    }),
    new Request('http://localhost/api/founder/city-credit', { method: 'POST' }),
    new Request('http://localhost/api/transfer/90/claim', { method: 'POST' }),
    new Request('http://localhost/api/world/offer/90/reconcile', { method: 'POST' }),
  ]
  for (const request of requests) {
    const response = await app.request(request)
    const firstText = await response.clone().text()
    assert.equal(await response.text(), firstText)
  }
  assert.equal(advances, 0)
})

test('a verified hosted OAuth backing request binds only its resolved resident to the counter', async () => {
  const previousHosted = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  const accessToken = `1f3d9_at_${'c'.repeat(64)}`
  const resident = {
    id: 50,
    handle: 'quiet-reader',
    model: 'hosted-chat',
    joined_at: '2026-08-22T00:00:00.000Z',
    quota_day: '2026-08-22',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  }
  const countedResidents: number[] = []
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  setPassiveOAuthResidentResolver(async token => token === accessToken ? resident : null)
  try {
    const app = new Hono()
    app.use('*', residentRefusalGuidance(async residentId => {
      countedResidents.push(residentId)
      return 1
    }))
    app.get('/api/backing', async c => {
      const authenticated = await authPassive(c)
      return authenticated
        ? c.json({ error: 'this place is closed' }, 403)
        : c.json({ error: 'sign in first' }, 401)
    })

    const valid = new Request('http://localhost/api/backing', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    allowOAuthForHostedConnectorRequest(valid)
    assert.equal((await app.request(valid)).status, 403)

    const invalid = new Request('http://localhost/api/backing', {
      headers: { authorization: `Bearer 1f3d9_at_${'d'.repeat(64)}` },
    })
    allowOAuthForHostedConnectorRequest(invalid)
    assert.equal((await app.request(invalid)).status, 401)
    assert.deepEqual(countedResidents, [50])
  } finally {
    if (previousHosted === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHosted
    setPassiveOAuthResidentResolver(null)
  }
})

test('legacy and hosted MCP keep escalation text and matching machine failure fields', async () => {
  const previousHosted = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const fake = fakeRefusalQuery()
    const app = new Hono()
    app.use('*', residentRefusalGuidance((residentId, status, cause) => (
      advanceResidentRefusal(residentId, status, cause, fake.query)
    )))
    app.post('/api/action', c => {
      const authorization = c.req.header('authorization')
      bindAuthenticatedResident(c.req.raw, authorization === 'Bearer hosted-test' ? 8 : 7)
      const cause = 'this place is not open to that action'
      return c.json({
        error: cause,
        action: { id: 33, status: 'blocked', error: cause },
      }, 403)
    })
    app.post('/mcp', c => mcp(c, app))
    app.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))

    for (const [path, authorization] of [
      ['/mcp', 'Bearer legacy-test'],
      ['/mcp/connect', 'Bearer hosted-test'],
    ] as const) {
      let toolText = ''
      for (let repetition = 1; repetition <= 10; repetition += 1) {
        const response = await app.request(path, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: repetition,
            method: 'tools/call',
            params: { name: 'act', arguments: { action: 'go_home' } },
          }),
        })
        assert.equal(response.status, 200)
        const payload = await response.json() as {
          result: { isError: boolean; content: Array<{ text: string }> }
        }
        assert.equal(payload.result.isError, true)
        toolText = payload.result.content[0]?.text ?? ''
      }
      const failure = JSON.parse(toolText) as {
        error: string
        action: { error: string }
        error_class: string
        http_status: number
      }
      assert.match(failure.error, /Stop and tell your human\. Open \/help\./u)
      assert.equal(failure.action.error, failure.error)
      assert.equal(failure.error_class, 'forbidden')
      assert.equal(failure.http_status, 403)
    }
  } finally {
    if (previousHosted === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHosted
  }
})
