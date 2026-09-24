import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  call,
  type CityApp,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const EXTRA_RESIDENTS = [
  Object.freeze({ id: 5, handle: 'line-reader', secret: `1f3d9_sk_${'5'.repeat(48)}` }),
  Object.freeze({ id: 6, handle: 'line-listener', secret: `1f3d9_sk_${'6'.repeat(48)}` }),
] as const
const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR, ...EXTRA_RESIDENTS] as const

type AppWithBindings = Readonly<{
  request: (input: string, init?: RequestInit, bindings?: unknown) => Response | Promise<Response>
}>
type WaitLeaseRow = Readonly<{
  lease_id: string
  place_id: number
  started_at: Date
  expires_at: Date
}>

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('same-room wait route holds one request and releases its lease exactly once against PostgreSQL', {
  timeout: 600_000,
}, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-wait-route')
  try {
    const app = (await import('../../src/index.ts')).default
    const cityApp = app as CityApp
    const boundApp = app as unknown as AppWithBindings
    const db = connectedDatabase()
    const {
      WAIT_CURSOR_REFUSAL,
      WAIT_FIELDS_REFUSAL,
      WAIT_NO_PLACE_REFUSAL,
      WAIT_SECONDS_REFUSAL,
      waitAlreadyOpenRefusal,
    } = await import('../../src/room-talk-contract.ts')
    const { RESIDENT_AUTH_REFUSAL } = await import('../../src/core.ts')
    let rooms = await resetCity(RESIDENTS)
    let nextRequestNumber = 1
    const nextRequestId = () => requestId(nextRequestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    const count = async (table: 'events' | 'room_lines' | 'pings' | 'wait_leases') => Number(
      (await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0]!.count,
    )
    const checkpoint = async () => String((await db.query<{ checkpoint: string }>(`
      SELECT current_change_id::text AS checkpoint
      FROM public_change_state WHERE singleton = true
    `)).rows[0]!.checkpoint)
    const postWait = async (
      secret: string | null,
      bodyText: string | undefined,
      bindings?: unknown,
    ) => {
      const headers = new Headers(secret === null ? {} : bearer(secret))
      return await boundApp.request('http://city.test/api/wait-here', {
        method: 'POST',
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      }, bindings)
    }
    const postJson = (secret: string, body: unknown, bindings?: unknown) => (
      postWait(secret, JSON.stringify(body), bindings)
    )
    const waitForLease = async (residentId = FOUNDER.id): Promise<WaitLeaseRow> => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        const row = (await db.query<WaitLeaseRow>(`
          SELECT lease_id, place_id, started_at, expires_at
          FROM wait_leases WHERE resident_id = $1
        `, [residentId])).rows[0]
        if (row) return row
        await delay(10)
      }
      assert.fail('wait route did not open a lease')
    }
    const assertHeaders = (response: Response) => {
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      assert.equal(response.headers.get('Pragma'), 'no-cache')
      assert.equal(response.headers.get('Vary'), 'Authorization')
    }
    const assertNoLease = async () => assert.equal(await count('wait_leases'), 0)
    const assertRefusal = async (response: Response, status: number, sentence: string) => {
      assert.equal(response.status, status)
      assertHeaders(response)
      const body = await response.json() as Record<string, unknown>
      assert.equal(typeof body.error, 'string')
      assert.ok((body.error as string).startsWith(sentence), String(body.error))
      return body
    }
    const addReleaseProbe = async () => {
      await db.query('CREATE TABLE wait_release_probe (resident_id integer NOT NULL, lease_id uuid NOT NULL)')
      await db.query(`
        CREATE FUNCTION record_wait_release_probe() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO wait_release_probe (resident_id, lease_id) VALUES (OLD.resident_id, OLD.lease_id);
          RETURN OLD;
        END
        $$
      `)
      await db.query(`
        CREATE TRIGGER record_wait_release_probe AFTER DELETE ON wait_leases
        FOR EACH ROW EXECUTE FUNCTION record_wait_release_probe()
      `)
    }

    await reset()

    await t.test('a wait returns change with the new line within one poll after another resident speaks', async () => {
      await reset()
      const waiting = postJson(FOUNDER.secret, { seconds: 5 })
      await waitForLease()
      await delay(75)
      const said = await call(cityApp, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'hello from the next resident',
        request_id: nextRequestId(),
      })
      assert.equal(said.status, 201)

      const response = await waiting
      assert.equal(response.status, 200)
      assertHeaders(response)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'change')
      assert.equal((answer.lines as Record<string, unknown>[])[0]?.body, 'hello from the next resident')
      assert.equal(answer.lines_has_more, false)
      await assertNoLease()
    })

    await t.test("a wait returns change for an invitation to the waiter and for an answer to the waiter's older ping, and not for a ping between two others", async () => {
      await reset()
      const oldPing = await call(cityApp, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      assert.equal(oldPing.status, 201)
      const oldPingId = Number((oldPing.json.ping as Record<string, unknown>).id)
      const waiting = postJson(FOUNDER.secret, { seconds: 5 })
      await waitForLease()
      await delay(75)

      const answered = await call(cityApp, GROWER.secret, 'POST', `/api/ping/${oldPingId}/answer`, {
        answer: 'yes',
        request_id: nextRequestId(),
      })
      const invited = await call(cityApp, GROWER.secret, 'POST', '/api/ping', {
        to_handle: FOUNDER.handle,
        request_id: nextRequestId(),
      })
      const unrelated = await call(cityApp, GROWER.secret, 'POST', '/api/ping', {
        to_handle: NEIGHBOUR.handle,
        request_id: nextRequestId(),
      })
      assert.equal(answered.status, 200)
      assert.equal(invited.status, 201)
      assert.equal(unrelated.status, 201)

      const response = await waiting
      assert.equal(response.status, 200)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'change')
      const pings = answer.pings as Record<string, unknown>[]
      assert.deepEqual(pings.map(entry => entry.change_id), [...pings.map(entry => entry.change_id)].sort(
        (left, right) => BigInt(left as string) < BigInt(right as string) ? -1 : 1,
      ))
      assert.deepEqual(new Set(pings.map(entry => Number((entry.ping as Record<string, unknown>).id))), new Set([
        oldPingId,
        Number((invited.json.ping as Record<string, unknown>).id),
      ]))
      assert.deepEqual(new Set(pings.map(entry => entry.kind)), new Set(['ping_answered', 'ping_sent']))
      assert.equal(pings.some(entry => Number((entry.ping as Record<string, unknown>).id)
        === Number((unrelated.json.ping as Record<string, unknown>).id)), false)
      await assertNoLease()
    })

    await t.test('a cursor of "0" returns at once with at most fifty lines, has_more, and the fiftieth line change as the next cursor', async () => {
      await reset()
      for (let index = 0; index < 51; index += 1) {
        const resident = RESIDENTS[index % RESIDENTS.length]!
        const said = await call(cityApp, resident.secret, 'POST', '/api/line', {
          place_id: rooms.eastRoomId,
          body: `backlog line ${index + 1}`,
          request_id: nextRequestId(),
        })
        assert.equal(said.status, 201)
      }
      const fiftiethLine = await db.query<{ id: number; change_id: string }>(`
        SELECT line.id, pcl.change_id::text AS change_id
        FROM room_lines line
        JOIN events e ON e.detail->>'line_id' = line.id::text
        JOIN public_change_log pcl ON pcl.event_id = e.id
        ORDER BY pcl.change_id
        OFFSET 49 LIMIT 1
      `)
      const started = Date.now()
      const response = await postJson(FOUNDER.secret, {
        after_line_change: '0',
        after_ping_change: '0',
        seconds: 5,
      })
      assert.equal(response.status, 200)
      assert.ok(Date.now() - started < 1_500)
      const answer = await response.json() as Record<string, unknown>
      const lines = answer.lines as Record<string, unknown>[]
      assert.equal(answer.reason, 'change')
      assert.equal(lines.length, 50)
      assert.equal(answer.lines_has_more, true)
      assert.equal(lines[49]?.id, Number(fiftiethLine.rows[0]!.id))
      assert.equal(answer.next_after_line_change, fiftiethLine.rows[0]!.change_id)
      await assertNoLease()
    })

    await t.test('nothing arriving returns an empty timeout after the asked seconds, with both cursors at the checkpoint, and writes no event, line, ping, or lease', async () => {
      await reset()
      const before = {
        events: await count('events'),
        lines: await count('room_lines'),
        pings: await count('pings'),
        leases: await count('wait_leases'),
      }
      const marker = await checkpoint()
      const response = await postJson(FOUNDER.secret, { seconds: 1 })
      assert.equal(response.status, 200)
      assertHeaders(response)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'timeout')
      assert.deepEqual(answer.lines, [])
      assert.equal(answer.lines_has_more, false)
      assert.equal(answer.next_after_line_change, marker)
      assert.deepEqual(answer.pings, [])
      assert.equal(answer.pings_has_more, false)
      assert.equal(answer.next_after_ping_change, marker)
      assert.deepEqual({
        events: await count('events'),
        lines: await count('room_lines'),
        pings: await count('pings'),
        leases: await count('wait_leases'),
      }, before)
    })

    await t.test('moving away during a wait returns moved within one poll', async () => {
      await reset()
      const waiting = postJson(FOUNDER.secret, { seconds: 5 })
      await waitForLease()
      await delay(75)
      await standIn(FOUNDER.id, rooms.westRoomId)
      const response = await waiting
      assert.equal(response.status, 200)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'moved')
      await assertNoLease()
    })

    await t.test("a second wait while one is open answers 409 with the exact sentence and open_until equal to the first lease's expires_at, and opens once the first ends", async () => {
      await reset()
      const first = postJson(FOUNDER.secret, { seconds: 1 })
      const lease = await waitForLease()
      const second = await postJson(FOUNDER.secret, { seconds: 1 })
      const refusal = await assertRefusal(
        second,
        409,
        waitAlreadyOpenRefusal(lease.expires_at.toISOString()).error,
      )
      assert.equal(refusal.error, waitAlreadyOpenRefusal(lease.expires_at.toISOString()).error)
      assert.equal(refusal.open_until, lease.expires_at.toISOString())
      const firstAnswer = await first
      assert.equal(firstAnswer.status, 200)
      const startedAgain = await postJson(FOUNDER.secret, { seconds: 1 })
      assert.equal(startedAgain.status, 200)
      assert.equal((await startedAgain.json() as Record<string, unknown>).reason, 'timeout')
      await assertNoLease()
    })

    await t.test('thirty-one seconds, a numeric or negative cursor, a cursor ahead of the checkpoint, or an extra field is refused with its sentence and opens no lease', async () => {
      await reset()
      const marker = await checkpoint()
      const invalid = [
        { body: { seconds: 31 }, sentence: WAIT_SECONDS_REFUSAL.error },
        { body: { after_line_change: 0 }, sentence: WAIT_CURSOR_REFUSAL.error },
        { body: { after_line_change: -1 }, sentence: WAIT_CURSOR_REFUSAL.error },
        { body: { after_ping_change: '-1' }, sentence: WAIT_CURSOR_REFUSAL.error },
        {
          body: { after_line_change: (BigInt(marker) + 1n).toString() },
          sentence: WAIT_CURSOR_REFUSAL.error,
        },
        { body: { unexpected: true }, sentence: WAIT_FIELDS_REFUSAL.error },
        { body: [], sentence: WAIT_FIELDS_REFUSAL.error },
      ] as const
      for (const item of invalid) {
        const response = await postJson(FOUNDER.secret, item.body)
        await assertRefusal(response, 400, item.sentence)
        await assertNoLease()
      }
      const malformed = await postWait(FOUNDER.secret, '{')
      await assertRefusal(malformed, 400, WAIT_FIELDS_REFUSAL.error)
      const unauthenticated = await postWait(null, '{}')
      await assertRefusal(unauthenticated, 401, RESIDENT_AUTH_REFUSAL)
      const noPlace = await (async () => {
        await db.query('DELETE FROM resident_presence WHERE resident_id = $1', [FOUNDER.id])
        return postJson(FOUNDER.secret, { seconds: 1 })
      })()
      await assertRefusal(noPlace, 409, WAIT_NO_PLACE_REFUSAL.error)
      await assertNoLease()
    })

    await t.test("the wait route ends early when the caller's connection closes", async () => {
      await reset()
      await addReleaseProbe()
      const outgoing = Object.assign(new EventEmitter(), { destroyed: false })
      const started = Date.now()
      const waiting = postJson(FOUNDER.secret, { seconds: 10 }, { outgoing })
      const lease = await waitForLease()
      outgoing.emit('close')
      const response = await waiting
      assert.equal(response.status, 200)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'timeout')
      assert.ok(Date.now() - started < 1_500)
      assert.equal(Number((await db.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM wait_release_probe
        WHERE resident_id = $1 AND lease_id = $2
      `, [FOUNDER.id, lease.lease_id])).rows[0]!.count), 1)
      await assertNoLease()

      const alreadyDestroyed = Object.assign(new EventEmitter(), { destroyed: true })
      const destroyedAt = Date.now()
      const alreadyClosed = await postJson(FOUNDER.secret, { seconds: 10 }, { outgoing: alreadyDestroyed })
      assert.equal(alreadyClosed.status, 200)
      assert.equal((await alreadyClosed.json() as Record<string, unknown>).reason, 'timeout')
      assert.ok(Date.now() - destroyedAt < 1_500)
      assert.equal(alreadyDestroyed.listenerCount('close'), 0)
      assert.equal(Number((await db.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM wait_release_probe WHERE resident_id = $1
      `, [FOUNDER.id])).rows[0]!.count), 2)
      await assertNoLease()
    })

    await t.test('a failed lease release logs only its error name and still sends the timeout answer', async () => {
      await reset()
      await db.query(`
        CREATE FUNCTION refuse_wait_release_probe() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'release probe';
          RETURN OLD;
        END
        $$
      `)
      await db.query(`
        CREATE TRIGGER refuse_wait_release_probe BEFORE DELETE ON wait_leases
        FOR EACH ROW EXECUTE FUNCTION refuse_wait_release_probe()
      `)
      const logs: unknown[][] = []
      const originalError = console.error
      console.error = (...values: unknown[]) => { logs.push(values) }
      let response: Response
      try {
        response = await postJson(FOUNDER.secret, { seconds: 1 })
      } finally {
        console.error = originalError
      }
      assert.equal(response!.status, 200)
      assert.equal((await response!.json() as Record<string, unknown>).reason, 'timeout')
      assert.equal(logs.length, 1)
      assert.equal(logs[0]?.[0], 'wait_release_failure')
      assert.equal(typeof logs[0]?.[1], 'string')
      assert.notEqual(logs[0]?.[1], 'release probe')
      assert.equal(logs[0]?.length, 2)
      assert.equal(await count('wait_leases'), 1)
    })

    await t.test('an empty body waits the default ten seconds', async () => {
      await reset()
      const waiting = postWait(FOUNDER.secret, '')
      const lease = await waitForLease()
      const duration = Number((await db.query<{ milliseconds: string }>(`
        SELECT (extract(epoch FROM expires_at - started_at) * 1000)::bigint::text AS milliseconds
        FROM wait_leases WHERE resident_id = $1
      `, [FOUNDER.id])).rows[0]!.milliseconds)
      assert.equal(duration, 10_000)
      const whitespace = await postWait(FOUNDER.secret, ' \n\t ')
      const whitespaceRefusal = await assertRefusal(
        whitespace,
        409,
        waitAlreadyOpenRefusal(lease.expires_at.toISOString()).error,
      )
      assert.equal(whitespaceRefusal.open_until, lease.expires_at.toISOString())
      await delay(1_000)
      const said = await call(cityApp, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'the empty-body wait heard this line',
        request_id: nextRequestId(),
      })
      assert.equal(said.status, 201)
      const response = await waiting
      assert.equal(response.status, 200)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'change')
      assert.equal((answer.lines as Record<string, unknown>[])[0]?.body, 'the empty-body wait heard this line')
      await assertNoLease()
      assert.equal(lease.place_id, rooms.eastRoomId)
    })
  } finally {
    await postgres.stop()
  }
})
