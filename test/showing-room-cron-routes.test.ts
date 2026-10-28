import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

const SYNTHETIC_CRON_SECRET = `synthetic_cron_${'7b'.repeat(32)}`
const path = '/api/internal/showing-room-close'
const database = Object.assign(async () => [], { query: async () => [] })
const completed = Object.freeze({ status: 'completed', runId: 71 })

function privateResponse(response: Response): void {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.equal(response.headers.get('vary'), 'Authorization')
}

test('showing room cron refuses missing, malformed and incorrect bearers without calling the runner', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  const app = new Hono()
  let calls = 0
  mountShowingRoomCronRoutes(app, {
    database, environment: { CRON_SECRET: SYNTHETIC_CRON_SECRET },
    runShowingRoomClose: async () => { calls += 1; return completed },
  })
  for (const authorization of [undefined, 'Basic synthetic', 'Bearer incorrect', 'Bearer ', `Bearer ${'x'.repeat(1100)}`]) {
    const response = await app.request(path, { headers: authorization ? { authorization } : {} })
    assert.equal(response.status, 401, 'only the configured cron bearer may invoke the weekly act')
    privateResponse(response)
    const body = await response.json() as {error:string}
    assert.match(body.error, /authorization|bearer/iu)
    assert.equal(body.error.includes(SYNTHETIC_CRON_SECRET), false)
  }
  assert.equal(calls, 0)
})

test('showing room cron reports unavailable configuration privately before invoking the runner', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  for (const secret of [undefined, '', 'too-short', ' '.repeat(32)]) {
    const app = new Hono()
    let calls = 0
    mountShowingRoomCronRoutes(app, {
      database, environment: { CRON_SECRET: secret },
      runShowingRoomClose: async () => { calls += 1; return completed },
    })
    const response = await app.request(path, { headers: { authorization: `Bearer ${SYNTHETIC_CRON_SECRET}` } })
    assert.equal(response.status, 503, 'missing cron configuration cannot look like a successful count')
    privateResponse(response)
    assert.match((await response.json() as {error:string}).error, /CRON_SECRET|configured/u)
    assert.equal(calls, 0)
  }
})

test('showing room cron accepts no clock, recipient, query or replay override', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  const app = new Hono()
  let calls = 0
  mountShowingRoomCronRoutes(app, {
    database, environment: { CRON_SECRET: SYNTHETIC_CRON_SECRET },
    runShowingRoomClose: async () => { calls += 1; return completed },
  })
  for (const query of ['now=2030-01-07T15:00Z', 'slot=2030-01-07T15:00Z', 'resident_id=2', 'force=true', 'x=1&x=2']) {
    const response = await app.request(`${path}?${query}`, { headers: { authorization: `Bearer ${SYNTHETIC_CRON_SECRET}` } })
    assert.equal(response.status, 400, 'caller options cannot alter the scheduled act')
    privateResponse(response)
  }
  assert.equal(calls, 0)
})

test('showing room cron passes only the database to the runner and returns its saved outcome', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  const app = new Hono()
  const calls: unknown[][] = []
  mountShowingRoomCronRoutes(app, {
    database, environment: { CRON_SECRET: SYNTHETIC_CRON_SECRET },
    runShowingRoomClose: async (...args) => { calls.push(args); return completed },
  })
  const response = await app.request(path, { headers: { authorization: `Bearer ${SYNTHETIC_CRON_SECRET}` } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), completed, 'the route must return the committed run identity')
  privateResponse(response)
  assert.deepEqual(calls, [[database]], 'the runner reads time from PostgreSQL itself')
})

test('every scheduled retry returns the same stored run without adding publication work in the route', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  const app = new Hono()
  let runnerCalls = 0
  mountShowingRoomCronRoutes(app, {
    database, environment: { CRON_SECRET: SYNTHETIC_CRON_SECRET },
    runShowingRoomClose: async () => { runnerCalls += 1; return completed },
  })
  for (let retry = 0; retry < 6; retry += 1) {
    const response = await app.request(path, { headers: { authorization: `Bearer ${SYNTHETIC_CRON_SECRET}` } })
    assert.deepEqual(await response.json(), completed, 'all six Monday ticks return the durable run')
    privateResponse(response)
  }
  assert.equal(runnerCalls, 6, 'every tick lets the runner resolve its immutable result')
})

test('unexpected showing room failures return fixed caller wording without exposing private prompt data', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  const app = new Hono()
  mountShowingRoomCronRoutes(app, {
    database, environment: { CRON_SECRET: SYNTHETIC_CRON_SECRET },
    runShowingRoomClose: async () => { throw new Error('PRIVATE_QUEUED_PROMPT_CANARY_827') },
  })
  const response = await app.request(path, { headers: { authorization: `Bearer ${SYNTHETIC_CRON_SECRET}` } })
  assert.equal(response.status, 503)
  privateResponse(response)
  const body = await response.json() as {error:string}
  assert.match(body.error, /retry|review/iu)
  assert.equal(body.error.includes('PRIVATE_QUEUED_PROMPT_CANARY_827'), false)
})

test('a recorded award conflict keeps the founder review instruction in the private cron response', async () => {
  const { mountShowingRoomCronRoutes } = await import('../src/showing-room-cron-routes.ts')
  const { ShowingRoomRunError } = await import('../src/showing-room-runner.ts')
  const app = new Hono()
  const message = 'the showing room award could not be confirmed; ask the founder to review this contest, its original source key and recipient'
  mountShowingRoomCronRoutes(app, {
    database, environment: { CRON_SECRET: SYNTHETIC_CRON_SECRET },
    runShowingRoomClose: async () => { throw new ShowingRoomRunError('award_review', message) },
  })
  const response = await app.request(path, { headers: { authorization: `Bearer ${SYNTHETIC_CRON_SECRET}` } })
  assert.equal(response.status, 503)
  privateResponse(response)
  assert.deepEqual(await response.json(), { error: message })
})
