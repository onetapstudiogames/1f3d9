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
  request: (input: string | Request, init?: RequestInit, bindings?: unknown) => Response | Promise<Response>
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
    const previousHostedSignin = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    const previousPublicOrigin = process.env.PUBLIC_ORIGIN
    const previousHostedOrigins = process.env.HOSTED_CHAT_CIMD_ORIGINS
    const previousHostedClients = process.env.HOSTED_CHAT_OAUTH_CLIENTS
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    process.env.PUBLIC_ORIGIN = 'https://1f3d9.test'
    process.env.HOSTED_CHAT_CIMD_ORIGINS = '["https://chatgpt.com"]'
    process.env.HOSTED_CHAT_OAUTH_CLIENTS = '[]'
    let app: (typeof import('../../src/index.ts'))['default']
    try {
      app = (await import('../../src/index.ts')).default
    } finally {
      if (previousHostedSignin === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHostedSignin
      if (previousPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN
      else process.env.PUBLIC_ORIGIN = previousPublicOrigin
      if (previousHostedOrigins === undefined) delete process.env.HOSTED_CHAT_CIMD_ORIGINS
      else process.env.HOSTED_CHAT_CIMD_ORIGINS = previousHostedOrigins
      if (previousHostedClients === undefined) delete process.env.HOSTED_CHAT_OAUTH_CLIENTS
      else process.env.HOSTED_CHAT_OAUTH_CLIENTS = previousHostedClients
    }
    const cityApp = app as CityApp & AppWithBindings
    const boundApp = app as unknown as AppWithBindings
    const db = connectedDatabase()
    const {
      WAIT_CURSOR_REFUSAL,
      WAIT_FIELDS_REFUSAL,
      WAIT_NO_PLACE_REFUSAL,
      WAIT_SECONDS_REFUSAL,
    } = await import('../../src/room-talk-contract.ts')
    const { allowOAuthForHostedConnectorRequest, RESIDENT_AUTH_REFUSAL } = await import('../../src/core.ts')
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
    const waitForLease = async (
      residentId = FOUNDER.id,
      differentFromLeaseId?: string,
    ): Promise<WaitLeaseRow> => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        const row = (await db.query<WaitLeaseRow>(`
          SELECT lease_id, place_id, started_at, expires_at
          FROM wait_leases WHERE resident_id = $1
        `, [residentId])).rows[0]
        if (row && row.lease_id !== differentFromLeaseId) return row
        await delay(10)
      }
      assert.fail('wait route did not open a lease')
    }
    const leaseDurationMilliseconds = async (leaseId: string) => Number((await db.query<{ milliseconds: string }>(`
      SELECT (extract(epoch FROM expires_at - started_at) * 1000)::bigint::text AS milliseconds
      FROM wait_leases WHERE lease_id = $1
    `, [leaseId])).rows[0]!.milliseconds)
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
      await db.query('CREATE TABLE IF NOT EXISTS wait_release_probe (resident_id integer NOT NULL, lease_id uuid NOT NULL)')
      await db.query(`
        CREATE OR REPLACE FUNCTION record_wait_release_probe() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO wait_release_probe (resident_id, lease_id) VALUES (OLD.resident_id, OLD.lease_id);
          RETURN OLD;
        END
        $$
      `)
      await db.query(`
        DROP TRIGGER IF EXISTS record_wait_release_probe ON wait_leases
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

    await t.test('a second wait takes over: the first answers replaced within one poll, the cue follows the second, and only the second is ever deleted', async () => {
      await reset()
      await addReleaseProbe()
      const first = postJson(FOUNDER.secret, { seconds: 5 })
      const firstLease = await waitForLease()
      const firstAnswer = first.then(response => ({ response, resolvedAt: Date.now() }))
      const second = postJson(FOUNDER.secret, { seconds: 2 })
      const opened = await Promise.race([
        waitForLease(FOUNDER.id, firstLease.lease_id).then(lease => ({ lease })),
        second.then(response => ({ response })),
      ])
      if ('response' in opened) {
        assert.equal(opened.response.status, 200, `second wait returned ${opened.response.status}`)
        assert.fail('second wait answered before opening its lease')
      }
      const secondLease = opened.lease
      const listening = await call(cityApp, null, 'GET', '/api/place/' + rooms.eastRoomId)
      const listeners = listening.json.listening_residents as Record<string, unknown>[]
      assert.equal(listeners.length, 1)
      assert.equal(listeners[0]?.resident_id, FOUNDER.id)
      assert.equal(listeners[0]?.listening_until, secondLease.expires_at.toISOString())

      const firstResult = await Promise.race([firstAnswer, delay(3_000).then(() => null)])
      assert.ok(firstResult, 'first wait did not answer within 3,000 ms of the second lease opening')
      assert.equal(firstResult.response.status, 200)
      assertHeaders(firstResult.response)
      const firstBody = await firstResult.response.json() as Record<string, unknown>
      assert.equal(firstBody.reason, 'replaced')
      assert.ok(firstResult.resolvedAt - secondLease.started_at.getTime() <= 3_000)

      const secondResponse = await second
      assert.equal(secondResponse.status, 200)
      const secondBody = await secondResponse.json() as Record<string, unknown>
      assert.equal(secondBody.reason, 'timeout')
      await assertNoLease()
      const released = await db.query<{ lease_id: string }>(`
        SELECT lease_id::text AS lease_id FROM wait_release_probe WHERE resident_id = $1
      `, [FOUNDER.id])
      assert.deepEqual(released.rows.map(row => row.lease_id), [secondLease.lease_id])
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

    await t.test("an MCP wait_here call ends early when the connector's own connection closes", async () => {
      await reset()
      await addReleaseProbe()
      const outgoing = Object.assign(new EventEmitter(), { destroyed: false })
      const headers = new Headers(bearer(FOUNDER.secret))
      headers.set('Content-Type', 'application/json')
      const started = Date.now()
      const waiting = boundApp.request('http://city.test/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'wait_here', arguments: { seconds: 10 } },
        }),
      }, { outgoing })
      const lease = await waitForLease()
      outgoing.emit('close')
      const response = await waiting
      assert.equal(response.status, 200)
      const rpc = await response.json() as { result: { content: Array<{ text: string }> } }
      const answer = JSON.parse(rpc.result.content[0]!.text) as Record<string, unknown>
      assert.equal(answer.reason, 'timeout')
      assert.ok(Date.now() - started < 1_500)
      assert.equal(Number((await db.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM wait_release_probe
        WHERE resident_id = $1 AND lease_id = $2
      `, [FOUNDER.id, lease.lease_id])).rows[0]!.count), 1)
      await assertNoLease()
      assert.equal(outgoing.listenerCount('close'), 0)
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

    await t.test('an empty body and a whitespace body both wait ten seconds, and the newest wait hears the line', async () => {
      await reset()
      const firstWait = postWait(FOUNDER.secret, '')
      const firstLease = await waitForLease()
      assert.equal(await leaseDurationMilliseconds(firstLease.lease_id), 10_000)
      const secondWait = postWait(FOUNDER.secret, ' \n\t ')
      const secondLease = await waitForLease(FOUNDER.id, firstLease.lease_id)
      assert.equal(await leaseDurationMilliseconds(secondLease.lease_id), 10_000)

      const firstResponse = await firstWait
      assert.equal(firstResponse.status, 200)
      const firstAnswer = await firstResponse.json() as Record<string, unknown>
      assert.equal(firstAnswer.reason, 'replaced')
      const said = await call(cityApp, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'the whitespace-body wait heard this line',
        request_id: nextRequestId(),
      })
      assert.equal(said.status, 201)
      const response = await secondWait
      assert.equal(response.status, 200)
      const answer = await response.json() as Record<string, unknown>
      assert.equal(answer.reason, 'change')
      assert.equal((answer.lines as Record<string, unknown>[])[0]?.body, 'the whitespace-body wait heard this line')
      await assertNoLease()
      assert.equal(firstLease.place_id, rooms.eastRoomId)
      assert.equal(secondLease.place_id, rooms.eastRoomId)
    })

    await t.test('a hosted-chat wait with no seconds waits thirty; unmarked requests default to ten', async () => {
      await reset()
      const wake = async (body: string) => {
        const said = await call(cityApp, GROWER.secret, 'POST', '/api/line', {
          place_id: rooms.eastRoomId,
          body,
          request_id: nextRequestId(),
        })
        assert.equal(said.status, 201)
      }
      const hostedRequest = new Request('http://1f3d9.internal/api/wait-here', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + FOUNDER.secret,
          'content-type': 'application/json',
        },
        body: '{}',
      })
      allowOAuthForHostedConnectorRequest(hostedRequest)
      const hostedWait = cityApp.request(hostedRequest)
      const hostedLease = await waitForLease()
      const hostedDuration = await leaseDurationMilliseconds(hostedLease.lease_id)
      await wake('wake the marked hosted-chat wait')
      assert.equal((await hostedWait).status, 200)
      assert.equal(hostedDuration, 30_000)

      const unmarkedWait = cityApp.request(new Request('http://1f3d9.internal/api/wait-here', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + FOUNDER.secret,
          'content-type': 'application/json',
        },
        body: '{}',
      }))
      const unmarkedLease = await waitForLease()
      const unmarkedDuration = await leaseDurationMilliseconds(unmarkedLease.lease_id)
      await wake('wake the unmarked wait')
      assert.equal((await unmarkedWait).status, 200)
      assert.equal(unmarkedDuration, 10_000)

      const forgedHeaderWait = cityApp.request(new Request('http://1f3d9.internal/api/wait-here', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + FOUNDER.secret,
          'content-type': 'application/json',
          'x-1f3d9-hosted': '1',
        },
        body: '{}',
      }))
      const forgedHeaderLease = await waitForLease()
      const forgedHeaderDuration = await leaseDurationMilliseconds(forgedHeaderLease.lease_id)
      await wake('wake the request with a made-up header')
      assert.equal((await forgedHeaderWait).status, 200)
      assert.equal(forgedHeaderDuration, 10_000)
    })

    await t.test('tools/call wait_here with no seconds waits thirty through /mcp/connect and ten through /mcp', async () => {
      await reset()
      const previousHosted = process.env.HOSTED_CHAT_SIGNIN_ENABLED
      process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
      try {
        const postMcpWait = (path: '/mcp' | '/mcp/connect', outgoing: EventEmitter) => (
          boundApp.request('http://city.test' + path, {
            method: 'POST',
            headers: {
              ...bearer(FOUNDER.secret),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'wait_here', arguments: {} },
            }),
          }, { outgoing })
        )
        const hostedOutgoing = Object.assign(new EventEmitter(), { destroyed: false })
        const hostedWait = postMcpWait('/mcp/connect', hostedOutgoing)
        const hostedLease = await waitForLease()
        const hostedDuration = await leaseDurationMilliseconds(hostedLease.lease_id)
        hostedOutgoing.emit('close')
        assert.equal((await hostedWait).status, 200)
        await assertNoLease()
        assert.equal(hostedDuration, 30_000)

        const codingOutgoing = Object.assign(new EventEmitter(), { destroyed: false })
        const codingWait = postMcpWait('/mcp', codingOutgoing)
        const codingLease = await waitForLease()
        const codingDuration = await leaseDurationMilliseconds(codingLease.lease_id)
        codingOutgoing.emit('close')
        assert.equal((await codingWait).status, 200)
        await assertNoLease()
        assert.equal(codingDuration, 10_000)
      } finally {
        if (previousHosted === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
        else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHosted
      }
    })
  } finally {
    await postgres.stop()
  }
})
