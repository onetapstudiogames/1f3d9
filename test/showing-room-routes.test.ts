import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

const CANARY = 'unpublished private prompt canary'
const ROOT = { authorization: 'Bearer founder-root' }
const ADD = { request_id: 'question-eleven', title: 'The next question', prompt: CANARY }

function fixture() {
  const calls: Array<Readonly<{ operation: string; input?: unknown }>> = []
  const dependencies = {
    authRootKey: async (c: { req: { header(name: string): string | undefined } }) => {
      const key = c.req.header('authorization')
      if (key === 'Bearer founder-root') return { id: 1 }
      if (key === 'Bearer second-founder-root') return { id: 2 }
      if (key === 'Bearer resident-root') return { id: 75 }
      return null
    },
    list: async (input: unknown) => {
      calls.push({ operation: 'list', input })
      return { ok: true as const, value: { contests: [{ id: 11, prompt: CANARY }], runs: [], has_more: false, next_before_id: null } }
    },
    add: async (input: unknown) => {
      calls.push({ operation: 'add', input })
      return { ok: true as const, created: true, value: { contest: { id: 11, revision: 1 }, disposition: 'created' } }
    },
    edit: async (id: number, input: unknown) => {
      calls.push({ operation: 'edit', input: { id, body: input } })
      return { ok: true as const, value: { contest: { id, revision: 2 } } }
    },
    control: async (input: Readonly<Record<string, unknown>>) => {
      calls.push({ operation: 'control', input })
      return { ok: true as const, value: { disposition: 'created', state: 'paused' } }
    },
  }
  return { calls, dependencies }
}

function request(method: string, body: unknown) {
  return { method, headers: { ...ROOT, 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

test('only resident 1 with its root key can read any private showing room data', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  for (const [authorization, status] of [
    [undefined, 401], ['Bearer founder-oauth', 401], ['Bearer founder-pairing', 401],
    ['Bearer second-founder-root', 403], ['Bearer resident-root', 403],
  ] as const) {
    const response = await app.request('/api/founder/showing-room', { headers: authorization ? { authorization } : {} })
    assert.equal(response.status, status, `${authorization ?? 'anonymous'} must be refused`)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/u)
    assert.equal(response.headers.get('vary'), 'Authorization')
    assert.equal((await response.text()).includes(CANARY), false)
  }
  assert.deepEqual(calls, [])
})

test('founder reads are passive, private and bounded with a stable cursor', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  const first = await app.request('/api/founder/showing-room', { headers: ROOT })
  assert.equal(first.status, 200)
  assert.match(first.headers.get('cache-control') ?? '', /private.*no-store/u)
  assert.equal(first.headers.get('vary'), 'Authorization')
  assert.equal((await first.json()).contests[0].prompt, CANARY)
  const next = await app.request('/api/founder/showing-room?before_id=11&limit=100', { headers: ROOT })
  assert.equal(next.status, 200)
  assert.deepEqual(calls, [
    { operation: 'list', input: { before_id: null, before_run_id: null, limit: 20 } },
    { operation: 'list', input: { before_id: 11, before_run_id: null, limit: 100 } },
  ])
  for (const query of ['limit=101', 'limit=0', 'limit=2&limit=3', 'before_id=-1', 'prompt=leak']) {
    const response = await app.request(`/api/founder/showing-room?${query}`, { headers: ROOT })
    assert.equal(response.status, 400, query)
  }
  assert.equal(calls.length, 2)
  const both = await app.request('/api/founder/showing-room?before_id=11&before_run_id=8&limit=2', { headers: ROOT })
  assert.equal(both.status, 200)
  assert.deepEqual(calls.at(-1), { operation: 'list', input: { before_id: 11, before_run_id: 8, limit: 2 } })
})

test('all founder writes refuse non-root identities before reading or storing a body', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  for (const [path, method] of [
    ['/api/founder/showing-room/contests', 'POST'],
    ['/api/founder/showing-room/contests/11', 'PATCH'],
    ['/api/founder/showing-room/control', 'POST'],
  ] as const) {
    for (const [authorization, expected] of [['Bearer founder-oauth', 401], ['Bearer second-founder-root', 403]] as const) {
      const response = await app.request(path, { method, headers: { authorization }, body: '{invalid' })
      assert.equal(response.status, expected)
    }
  }
  assert.deepEqual(calls, [])
})

test('a queued question accepts only bounded request_id, title and prompt', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  const created = await app.request('/api/founder/showing-room/contests', request('POST', ADD))
  assert.equal(created.status, 201)
  assert.deepEqual(calls, [{ operation: 'add', input: ADD }])
  for (const body of [
    { ...ADD, author_id: 1 }, { ...ADD, prize: 2 }, { ...ADD, title: '' },
    { ...ADD, title: 'x'.repeat(121) }, { ...ADD, prompt: 'x'.repeat(1801) },
    { ...ADD, prompt: '\u0000' }, { ...ADD, request_id: 'private key with spaces' },
    { title: ADD.title, prompt: ADD.prompt }, [], null,
  ]) {
    const response = await app.request('/api/founder/showing-room/contests', request('POST', body))
    assert.equal(response.status, 400)
  }
  const large = await app.request('/api/founder/showing-room/contests', request('POST', { ...ADD, prompt: 'x'.repeat(17_000) }))
  assert.equal(large.status, 413)
  assert.equal(calls.length, 1)
})

test('request replay and changed terms preserve the stored result or return a conflict', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, {
    ...dependencies,
    add: async input => input.title === ADD.title
      ? { ok: true, value: { disposition: 'replayed', contest: { id: 11, revision: 1 } } }
      : { ok: false, status: 409, error: 'request_id already names different question text; use a new request_id' },
  })
  const replay = await app.request('/api/founder/showing-room/contests', request('POST', ADD))
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).contest.id, 11)
  const conflict = await app.request('/api/founder/showing-room/contests', request('POST', { ...ADD, title: 'Changed' }))
  assert.equal(conflict.status, 409)
  assert.match((await conflict.json()).error, /request_id/u)
})

test('queued edits require a revision and cannot change running question rules or state', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, {
    ...dependencies,
    edit: async (id, input) => input.expected_revision === 1
      ? dependencies.edit(id, input)
      : { ok: false, status: 409, error: 'this question changed or opened; read the backlog before editing again' },
  })
  const accepted = await app.request('/api/founder/showing-room/contests/11', request('PATCH', { expected_revision: 1, title: 'Changed' }))
  assert.equal(accepted.status, 200)
  const stale = await app.request('/api/founder/showing-room/contests/11', request('PATCH', { expected_revision: 2, state: 'cancelled' }))
  assert.equal(stale.status, 409)
  for (const body of [{ title: 'Changed' }, { expected_revision: 1 }, { expected_revision: 1, state: 'open' }, { expected_revision: 1, vote_close: 'tomorrow' }]) {
    const response = await app.request('/api/founder/showing-room/contests/11', request('PATCH', body))
    assert.equal(response.status, 400)
  }
  assert.equal(calls.length, 1)
})

test('control admits only documented operations and never accepts an arbitrary author, prize, clock or note', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  for (const body of [
    { request_id: 'pause-1', action: 'pause' },
    { request_id: 'resume-1', action: 'resume' },
    { request_id: 'square-1', action: 'square', enabled: true },
  ]) {
    assert.equal((await app.request('/api/founder/showing-room/control', request('POST', body))).status, 200)
  }
  for (const body of [
    { request_id: 'bad', action: 'square', enabled: 'true' },
    { request_id: 'bad', action: 'pause', author_id: 1 },
    { request_id: 'bad', action: 'resume', prize: 1 },
    { request_id: 'bad', action: 'resume', now: '2026-11-02' },
    { request_id: 'bad', action: 'publish', body: CANARY },
  ]) {
    assert.equal((await app.request('/api/founder/showing-room/control', request('POST', body))).status, 400)
  }
  assert.equal(calls.length, 3)
})

test('management limit names the retry time and database failures reveal no queued prompt', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, {
    ...dependencies,
    add: async () => ({ ok: false, status: 429, error: '60 showing room changes are allowed per hour; retry in 120 seconds', retry_after: 120 }),
    list: async () => { throw new Error(CANARY) },
  })
  const limited = await app.request('/api/founder/showing-room/contests', request('POST', ADD))
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '120')
  const unavailable = await app.request('/api/founder/showing-room', { headers: ROOT })
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.text()).includes(CANARY), false)
})

test('activation records a manual legacy handover and refuses takeover of question ten', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  const activation = {
    request_id: 'first-managed-slot', action: 'activate',
    first_slot: '2026-11-02T15:00:00.000Z', first_question_number: 11,
    manual_legacy: { rules_note_id: 40225, count_note_id: 42001, winner_note_ids: [42002], credit_source_keys: ['showing-room-q10-manual-r75'] },
  }
  const accepted = await app.request('/api/founder/showing-room/control', request('POST', activation))
  assert.equal(accepted.status, 200)
  assert.deepEqual(calls, [{ operation: 'control', input: activation }])
  for (const body of [
    { ...activation, first_question_number: 10 },
    { ...activation, first_slot: '2026-11-03T15:00:00.000Z' },
    { ...activation, first_slot: '2026-11-02T16:00:00.000Z' },
    { ...activation, manual_legacy: undefined },
    { ...activation, manual_legacy: { ...activation.manual_legacy, rules_note_id: 1 } },
    { ...activation, manual_legacy: { ...activation.manual_legacy, count_note_id: 40225 } },
    { ...activation, manual_legacy: { ...activation.manual_legacy, winner_note_ids: [40225] } },
    { ...activation, manual_legacy: { ...activation.manual_legacy, private_key: 'not-accepted' } },
  ]) {
    assert.equal((await app.request('/api/founder/showing-room/control', request('POST', body))).status, 400)
  }
  assert.equal(calls.length, 1)
})

test('body declarations are optional but the actual UTF-8 byte bound always applies', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies, calls } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, dependencies)
  for (const declaration of ['garbled', '1, 2', '17000']) {
    const response = await app.request('/api/founder/showing-room/contests', {
      ...request('POST', ADD), headers: { ...ROOT, 'content-length': declaration },
    })
    assert.equal(response.status, 400)
  }
  assert.equal(calls.length, 0)
  const response = await app.request('/api/founder/showing-room/contests', {
    ...request('POST', { ...ADD, prompt: '\u3042'.repeat(6000) }), headers: { ...ROOT, 'content-length': '1' },
  })
  assert.equal(response.status, 413)
  assert.equal(calls.length, 0)
})

test('an uncertain edit tells the founder to read its revision before retrying', async () => {
  const { mountShowingRoomRoutes } = await import('../src/showing-room-routes.ts')
  const { dependencies } = fixture()
  const app = new Hono()
  mountShowingRoomRoutes(app, { ...dependencies, edit: async () => { throw new Error(CANARY) } })
  const response = await app.request('/api/founder/showing-room/contests/11', request('PATCH', { expected_revision: 1, title: 'Changed' }))
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.match(body.error, /read.*revision/u)
  assert.equal(body.error.includes('request_id'), false)
  assert.equal(body.error.includes(CANARY), false)
})
