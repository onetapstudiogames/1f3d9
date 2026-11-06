// An id that names no place or thing at all is refused in caller words, against real
// PostgreSQL: the action record's foreign keys are decided by the database, so a
// missing destination or source thing once failed that insert and answered 500.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const WALKER = Object.freeze({ id: 2, handle: 'lost-walker', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const FRIEND = Object.freeze({ id: 3, handle: 'kind-friend', secret: `1f3d9_sk_${'3'.repeat(48)}` })
const MISSING_ID = 999_999

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>
type Answer = Readonly<{ status: number; json: Json; headers: Headers }>

async function call(
  app: CityApp, secret: string, method: string, path: string, body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Answer> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: { ...bearer(secret), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({
    status: response.status, json: text ? JSON.parse(text) as Json : {}, headers: response.headers,
  })
}

function missingDestination(currentPlaceId: number): string {
  return `destination place_id ${MISSING_ID} was not found; call look with place_id ${currentPlaceId} and view outline, or use GET /api/map?view=outline&parent_id=${currentPlaceId} if your client can open URLs, to choose a public adjacent destination`
}

const MISSING_THING = `thing_id ${MISSING_ID} was not found; a withdrawn thing is permanently gone. Call look for a place, or use GET /api/place/:id if your client can open URLs, and send a current active thing_id`

/** Row counts of every city table except the private repeat-refusal counter. */
async function tableCounts(): Promise<Record<string, number>> {
  const db = connectedDatabase()
  const tables = (await db.query<{ name: string }>(`
    SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'resident_refusal_state'
    ORDER BY tablename
  `)).rows.map(row => row.name)
  const counts: Record<string, number> = {}
  for (const table of tables) {
    const rows = (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${table}"`)).rows
    counts[table] = rows[0]!.count
  }
  return counts
}

async function walkerPresence(): Promise<unknown> {
  return (await connectedDatabase().query(
    'SELECT current_place_id, home_place_id, updated_at FROM resident_presence WHERE resident_id = $1',
    [WALKER.id],
  )).rows[0]
}

test('an id that names no place or thing is refused before anything is recorded', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('missing-ids')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    const setUp = async () => {
      const rooms = await resetCity([FOUNDER, WALKER, FRIEND])
      await standIn(WALKER.id, rooms.eastRoomId)
      await standIn(FRIEND.id, rooms.eastRoomId)
      const thingId = Number((await connectedDatabase().query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'pocket lamp', 'a small lamp', $2, $2)
        RETURNING id
      `, [rooms.eastRoomId, WALKER.id])).rows[0]!.id)
      return Object.freeze({ ...rooms, thingId })
    }

    await t.test('a move, use, consume, or give naming a missing id is a plain not-found refusal', async () => {
      const rooms = await setUp()
      const cases: ReadonlyArray<Readonly<{ label: string; method: string; path: string; body?: unknown; expected: string }>> = [
        { label: 'move to a missing place', method: 'POST', path: '/api/action',
          body: { action: 'move', to_place_id: MISSING_ID }, expected: missingDestination(rooms.eastRoomId) },
        { label: 'move to a missing place while carrying', method: 'POST', path: '/api/action',
          body: { action: 'move', to_place_id: MISSING_ID, carry_thing_id: rooms.thingId },
          expected: missingDestination(rooms.eastRoomId) },
        { label: 'use a missing thing', method: 'POST', path: '/api/action',
          body: { action: 'use', thing_id: MISSING_ID }, expected: MISSING_THING },
        { label: 'use a missing thing by its alias', method: 'POST', path: `/api/thing/${MISSING_ID}/use`,
          expected: MISSING_THING },
        { label: 'consume a missing thing', method: 'POST', path: '/api/action',
          body: { action: 'consume', thing_id: MISSING_ID }, expected: MISSING_THING },
        { label: 'consume a missing thing by its alias', method: 'POST', path: `/api/thing/${MISSING_ID}/consume`,
          expected: MISSING_THING },
        { label: 'give a missing thing', method: 'POST', path: '/api/action',
          body: { action: 'give', thing_id: MISSING_ID, to_handle: FRIEND.handle }, expected: MISSING_THING },
        { label: 'use a real thing toward a missing place', method: 'POST', path: '/api/action',
          body: { action: 'use', thing_id: rooms.thingId, to_place_id: MISSING_ID },
          expected: missingDestination(rooms.eastRoomId) },
      ]
      for (const refusal of cases) {
        const countsBefore = await tableCounts()
        const presenceBefore = await walkerPresence()
        const answer = await call(app, WALKER.secret, refusal.method, refusal.path, refusal.body)
        assert.equal(answer.status, 404, `${refusal.label}: ${JSON.stringify(answer.json)}`)
        const error = String(answer.json.error)
        // A repeated identical refusal gains the ordinary repeat sentences at its end.
        assert.ok(error.startsWith(refusal.expected), `${refusal.label}: ${error}`)
        assert.equal(answer.json.action, undefined, `${refusal.label}: no action was recorded`)
        assert.equal(answer.json.error_class, 'not_found', refusal.label)
        assert.equal(answer.headers.get('x-1f3d9-error-class'), 'not_found', refusal.label)
        assert.deepEqual(await tableCounts(), countsBefore, `${refusal.label}: nothing was written`)
        assert.deepEqual(await walkerPresence(), presenceBefore, `${refusal.label}: the walker did not move`)
      }
    })

    await t.test('an id that exists still meets the ordinary recorded refusal, and the answers say what the reference says', async () => {
      const rooms = await setUp()
      const closed = await call(app, WALKER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.westRoomId })
      assert.equal(closed.status, 403, JSON.stringify(closed.json))
      assert.equal((closed.json.action as Json | undefined)?.status, 'failed')
      const recorded = (await connectedDatabase().query<{ count: number }>(
        `SELECT count(*)::int AS count FROM action_runs WHERE actor_id = $1 AND destination_place_id = $2`,
        [WALKER.id, rooms.westRoomId],
      )).rows[0]!.count
      assert.equal(recorded, 1)
      // A refusal carries its trace reference in the body and both failure headers.
      assert.equal(typeof closed.json.request_id, 'string')
      assert.equal(closed.headers.get('x-request-id'), closed.json.request_id)
      assert.equal(closed.headers.get('x-1f3d9-error-class'), 'forbidden')

      const moved = await call(app, WALKER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      assert.equal(moved.status, 200, JSON.stringify(moved.json))
      // A success names neither the actor nor the requested destination and carries no trace reference.
      assert.deepEqual(Object.keys(moved.json), ['action'])
      assert.deepEqual(moved.json.action, {
        id: (closed.json.action as Json).id as number + 1,
        action: 'move',
        status: 'applied',
        place_id: rooms.continentId,
        effects_applied: 0,
      })
      assert.equal(moved.headers.get('x-request-id'), null)
      assert.equal(moved.headers.get('x-1f3d9-error-class'), null)

      // There is no idempotency key: the same move sent again is a new action at the place you stand.
      const again = await call(app, WALKER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId },
        { 'idempotency-key': 'same-move' })
      assert.equal(again.status, 200, JSON.stringify(again.json))
      assert.equal((again.json.action as Json).id, (moved.json.action as Json).id as number + 1)
      assert.equal((again.json.action as Json).status, 'applied')
      assert.equal((again.json.action as Json).place_id, rooms.continentId)
    })

    await t.test('every other route given a missing place or thing id refuses without a city fault', async () => {
      const rooms = await setUp()
      await connectedDatabase().query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      const wallet = `0x${'a'.repeat(40)}`
      const feeCredit = () => ({ 'x-1f3d9-fee-credit': `fee-${randomUUID().replaceAll('-', '')}` })
      const survey: ReadonlyArray<Readonly<{
        label: string; method: string; path: string; body?: unknown; headers?: Readonly<Record<string, string>>
      }>> = [
        { label: 'go_home', method: 'POST', path: '/api/go-home' },
        { label: 'home at a missing place', method: 'POST', path: '/api/me/home', body: { place_id: MISSING_ID } },
        { label: 'found under a missing parent', method: 'POST', path: '/api/place', body: { parent_id: MISSING_ID, name: 'Lost Annex' } },
        { label: 'place_edit of a missing place', method: 'PATCH', path: `/api/place/${MISSING_ID}`, body: { description: 'gone' } },
        { label: 'rename of a missing place', method: 'PATCH', path: `/api/place/${MISSING_ID}`,
          body: { name: 'Gone Hall' }, headers: feeCredit() },
        { label: 'retire a missing place', method: 'PATCH', path: `/api/place/${MISSING_ID}`,
          body: { retired: true }, headers: feeCredit() },
        { label: 'laws of a missing place', method: 'PUT', path: `/api/place/${MISSING_ID}/laws`, body: { traits: [] } },
        { label: 'make in a missing place', method: 'POST', path: '/api/thing', body: { place_id: MISSING_ID, name: 'stray' } },
        { label: 'make of a missing kind', method: 'POST', path: '/api/thing', body: { place_id: rooms.eastRoomId, name: 'stray', kind_id: MISSING_ID } },
        { label: 'revise a missing kind', method: 'POST', path: `/api/kind/${MISSING_ID}/revise`,
          body: { description: 'gone' }, headers: feeCredit() },
        { label: 'thing_edit of a missing thing', method: 'PATCH', path: `/api/thing/${MISSING_ID}`, body: { name: 'stray' } },
        { label: 'thing_upgrade of a missing thing', method: 'POST', path: `/api/thing/${MISSING_ID}/upgrade`, body: {} },
        { label: 'withdraw a missing thing', method: 'POST', path: `/api/thing/${MISSING_ID}/withdraw`, body: { thing_name: 'stray' } },
        { label: 'mark a missing thing', method: 'POST', path: `/api/thing/${MISSING_ID}/mark`, body: { action: 'mark' } },
        { label: 'flag a missing thing', method: 'POST', path: '/api/flag', body: { target_type: 'thing', target_id: MISSING_ID, reason: 'checking' } },
        { label: 'flag a missing place', method: 'POST', path: '/api/flag', body: { target_type: 'place', target_id: MISSING_ID, reason: 'checking' } },
        { label: 'say in a missing place', method: 'POST', path: '/api/note', body: { place_id: MISSING_ID, body: 'hello' } },
        { label: 'line in a missing place', method: 'POST', path: '/api/line', body: { place_id: MISSING_ID, body: 'hello', request_id: randomUUID() } },
        { label: 'answer a missing ping', method: 'POST', path: `/api/ping/${MISSING_ID}/answer`, body: { answer: 'yes', request_id: randomUUID() } },
        { label: 'dismiss a missing ping', method: 'POST', path: `/api/ping/${MISSING_ID}/dismiss`, body: { request_id: randomUUID() } },
        { label: 'transfer a missing thing', method: 'POST', path: '/api/transfer', body: { type: 'thing', id: MISSING_ID, to_handle: FRIEND.handle } },
        { label: 'transfer a missing place', method: 'POST', path: '/api/transfer', body: { type: 'place', id: MISSING_ID, to_handle: FRIEND.handle } },
        { label: 'transfer a missing kind', method: 'POST', path: '/api/transfer', body: { type: 'kind', id: MISSING_ID, to_handle: FRIEND.handle } },
        { label: 'offer a missing thing', method: 'POST', path: '/api/transfer/offer',
          body: { type: 'thing', id: MISSING_ID, to_handle: FRIEND.handle, price_usdc: 1, seller_wallet: wallet } },
        { label: 'cancel a missing offer', method: 'POST', path: `/api/transfer/${MISSING_ID}/cancel`, body: {} },
        { label: 'accept a missing waiting transfer', method: 'POST', path: `/api/transfer/waiting/${MISSING_ID}/accept`, body: {} },
        { label: 'decline a missing waiting transfer', method: 'POST', path: `/api/transfer/waiting/${MISSING_ID}/decline`, body: {} },
        { label: 'sign a missing agreement', method: 'POST', path: `/api/agreement/${MISSING_ID}/sign` },
        { label: 'open accession on a missing agreement', method: 'POST', path: `/api/agreement/${MISSING_ID}/open-accession` },
        { label: 'move carrying a missing thing', method: 'POST', path: '/api/action',
          body: { action: 'move', to_place_id: rooms.continentId, carry_thing_id: MISSING_ID } },
        { label: 'give a missing place by target', method: 'POST', path: '/api/action',
          body: { action: 'give', target_type: 'place', target_id: MISSING_ID, to_handle: FRIEND.handle } },
        { label: 'use a real thing on a missing thing target', method: 'POST', path: '/api/action',
          body: { action: 'use', thing_id: rooms.thingId, target_type: 'thing', target_id: MISSING_ID } },
      ]
      const answers: string[] = []
      for (const request of survey) {
        const answer = await call(app, WALKER.secret, request.method, request.path, request.body, request.headers)
        answers.push(`${answer.status} ${request.label}: ${String(answer.json.error ?? 'ok')}`)
        assert.ok(answer.status < 500, `${request.label}: ${answer.status} ${JSON.stringify(answer.json)}`)
      }
      t.diagnostic(answers.join('\n'))
    })
  } finally {
    await postgres.stop()
  }
})
