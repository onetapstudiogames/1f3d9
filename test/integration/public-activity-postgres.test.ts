import assert from 'node:assert/strict'
import test from 'node:test'
import { call, FOUNDER, GROWER, NEIGHBOUR, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import { bearer, connectedDatabase, resetCity, standIn, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'

const OTHER = Object.freeze({ id: 5, handle: 'quiet-reader', secret: `1f3d9_sk_${'4'.repeat(48)}` })
const QUIET = Object.freeze({ id: 6, handle: 'long-quiet', secret: `1f3d9_sk_${'6'.repeat(48)}` })
const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR, OTHER, QUIET]
const PRIVATE_ACTIVITY_FIELDS = ['show_activity', 'last_public_action_at', 'last_active_at', 'last_seen', 'last_actor', 'activity_hidden']

async function read(app: CityApp, path: string, secret: string | null = null) {
  const response = await app.request(`http://city.test${path}`, {
    headers: secret === null ? {} : bearer(secret),
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, json: JSON.parse(text) as Json }
}

async function mcp(app: CityApp, secret: string | null, name: string, args: Json): Promise<Json> {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: { ...(secret === null ? { 'content-type': 'application/json' } : bearer(secret)), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  assert.equal(response.status, 200)
  const rpc = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
  assert.notEqual(rpc.result.isError, true, rpc.result.content[0]?.text)
  return JSON.parse(rpc.result.content[0]!.text) as Json
}

function assertNoActivity(value: unknown, path = 'answer'): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['last_active', 'last_active_unavailable', ...PRIVATE_ACTIVITY_FIELDS].includes(key), `${path}.${key}`)
    assertNoActivity(child, `${path}.${key}`)
  }
}

function assertPublicBand(row: Json, expected: string | undefined): void {
  assert.equal(row.last_active, expected)
  assert.equal(Object.hasOwn(row, 'last_active'), expected !== undefined)
  for (const key of PRIVATE_ACTIVITY_FIELDS) assert.equal(Object.hasOwn(row, key), false, key)
}

function resident(answer: Json, handle: string): Json {
  const row = (answer.residents as Json[]).find(item => item.handle === handle)
  assert.ok(row, `resident ${handle} must be returned`)
  return row
}

async function action(handle: string, placeId: number, age: string, status = 'applied'): Promise<void> {
  const db = connectedDatabase()
  if (status === 'applied') {
    await db.query("UPDATE residents SET last_public_action_at = statement_timestamp() - $2::interval WHERE handle = $1", [handle, age])
    await db.query("UPDATE places SET last_public_action_at = statement_timestamp() - $2::interval WHERE id = $1", [placeId, age])
  }
  await db.query(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('action', $1, jsonb_build_object('status', 'failed', 'place_id', $2::integer), now() - $3::interval)
  `, [handle, placeId, age])
}

async function toggle(app: CityApp, secret: string, show: boolean): Promise<void> {
  const answer = await call(app, secret, 'PATCH', '/api/me/settings', { show_activity: show })
  assert.equal(answer.status, 200, JSON.stringify(answer.json))
}

async function checkpoint(): Promise<string> {
  const rows = await connectedDatabase().query('SELECT current_change_id::text AS marker FROM public_change_state WHERE singleton')
  return String(rows.rows[0]!.marker)
}

test('public activity routes and MCP use fresh applied facts with a whole private switch', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('public-activity-routes')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    await t.test('census, bounded presence and focused presence expose the same bands and preserve asleep', async () => {
      const rooms = await resetCity(RESIDENTS)
      await db.query("UPDATE residents SET joined_at = now() - interval '20 days'")
      await action(GROWER.handle, rooms.eastRoomId, '2 hours')
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '2 days')
      await action(FOUNDER.handle, rooms.eastRoomId, '30 minutes')
      await action(OTHER.handle, rooms.eastRoomId, '1 minute', 'failed')
      for (const path of ['/api/residents?limit=200', '/api/residents?view=presence&limit=200']) {
        const answer = await read(app, path)
        assert.equal(answer.status, 200)
        for (const [who, band] of [[FOUNDER, 'active now'], [GROWER, 'today'], [NEIGHBOUR, 'this week'], [OTHER, undefined]] as const) {
          assertPublicBand(resident(answer.json, who.handle), band)
        }
      }
      for (const who of [FOUNDER, GROWER, NEIGHBOUR, OTHER]) {
        const answer = await read(app, `/api/residents?view=presence&handle=${who.handle}`)
        assert.equal((answer.json.resident as Json).asleep, false, 'existing asleep includes recent refused public rows')
      }
      const quiet = await read(app, `/api/residents?view=presence&handle=${QUIET.handle}`)
      assert.equal((quiet.json.resident as Json).asleep, true)
      assertPublicBand(quiet.json.resident as Json, undefined)
      const room = await read(app, `/api/place/${rooms.eastRoomId}`)
      assertPublicBand(room.json.place as Json, 'active now')
    })

    await t.test('every current-fact response is no-store even without a marker checkpoint', async () => {
      const rooms = await resetCity(RESIDENTS)
      for (const path of [
        '/api/residents', '/api/residents?view=presence',
        `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`,
        `/api/place/${rooms.eastRoomId}`, `/api/place/${rooms.eastRoomId}?view=full`,
      ]) {
        const answer = await read(app, path)
        assert.equal(answer.status, 200, path)
        assert.match(answer.headers.get('cache-control') ?? '', /(?:^|, )no-store(?:$|,)/u, path)
      }
    })

    await t.test('on/off/on is fresh at an unchanged checkpoint for anonymous, self, unrelated and both founders', async () => {
      const rooms = await resetCity(RESIDENTS)
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '30 minutes')
      const marker = await checkpoint()
      for (const show of [true, false, true]) {
        await toggle(app, NEIGHBOUR.secret, show)
        assert.equal(await checkpoint(), marker, 'settings must not advance the public checkpoint')
        for (const secret of [null, NEIGHBOUR.secret, OTHER.secret, FOUNDER.secret, GROWER.secret]) {
          const expected = show ? 'active now' : undefined
          for (const path of [
            `/api/residents?limit=200&after_change_marker=${marker}`,
            `/api/residents?view=presence&limit=200&after_change_marker=${marker}`,
          ]) {
            const answer = await read(app, path, secret)
            assert.equal(answer.status, 200)
            assertPublicBand(resident(answer.json, NEIGHBOUR.handle), expected)
            assert.match(answer.headers.get('cache-control') ?? '', /no-store/u)
          }
          const focused = await read(app, `/api/residents?view=presence&handle=${NEIGHBOUR.handle}&after_change_marker=${marker}`, secret)
          assertPublicBand(focused.json.resident as Json, expected)
          for (const view of ['full', 'outline']) {
            const room = await read(app, `/api/place/${rooms.eastRoomId}?view=${view}&show_everything=true`, secret)
            assertPublicBand(room.json.place as Json, 'active now')
            assertNoActivity(room.json.looking_residents)
            assertNoActivity(room.json.listening_residents)
          }
        }
      }
    })

    await t.test('MCP browse and look enforce off even for an opted-out founder', async () => {
      const rooms = await resetCity(RESIDENTS)
      await action(FOUNDER.handle, rooms.eastRoomId, '30 minutes')
      await mcp(app, FOUNDER.secret, 'me', { settings: { show_activity: false } })
      for (const secret of [null, FOUNDER.secret, GROWER.secret, NEIGHBOUR.secret]) {
        for (const args of [{ view: 'residents' }, { view: 'residents', resident_view: 'presence' }]) {
          const answer = await mcp(app, secret, 'browse', args)
          assertPublicBand(resident(answer, FOUNDER.handle), undefined)
        }
        const focused = await mcp(app, secret, 'browse', { view: 'residents', resident_view: 'presence', handle: FOUNDER.handle })
        assertPublicBand(focused.resident as Json, undefined)
        for (const view of ['full', 'outline']) {
          const room = await mcp(app, secret, 'look', { place_id: rooms.eastRoomId, view, show_everything: true })
          assertPublicBand(room.place as Json, 'active now')
          assertNoActivity(room.looking_residents)
          assertNoActivity(room.listening_residents)
        }
      }
    })

    await t.test('critic probe: off has no trace whether the same resident has activity or no activity', async () => {
      const rooms = await resetCity(RESIDENTS)
      await toggle(app, NEIGHBOUR.secret, false)
      const paths = ['/api/residents?limit=200', '/api/residents?view=presence&limit=200', `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`]
      const noHistory = await Promise.all(paths.map(async path => {
        const answer = (await read(app, path)).json
        return (answer.resident ?? resident(answer, NEIGHBOUR.handle)) as Json
      }))
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '30 minutes')
      for (const [index, path] of paths.entries()) {
        const answer = (await read(app, path)).json
        const row = (answer.resident ?? resident(answer, NEIGHBOUR.handle)) as Json
        assertNoActivity(row)
        assert.deepEqual(row, noHistory[index], path)
      }
    })

    await t.test('the off branch never evaluates a timestamp and wake summaries do not change asleep', async () => {
      await resetCity(RESIDENTS)
      const { publicActivitySql } = await import('../../src/public-activity.ts')
      const guarded = publicActivitySql('resident', true).replaceAll('resident.last_public_action_at', 'pg_temp.fail_activity_read()')
      await db.query("UPDATE residents SET show_activity = false, joined_at = now() - interval '20 days' WHERE id = $1", [QUIET.id])
      const client = await db.connect()
      try {
        await client.query("CREATE OR REPLACE FUNCTION pg_temp.fail_activity_read() RETURNS timestamptz LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''activity timestamp was evaluated''; END'")
        assert.equal((await client.query(`SELECT ${guarded} AS last_active FROM residents resident WHERE id = $1`, [QUIET.id])).rows[0]!.last_active, null)
      } finally { client.release() }
      await db.query("INSERT INTO events (kind, actor, detail) VALUES ('wake_try_applied', $1, '{}'::jsonb)", [QUIET.handle])
      assert.equal(((await read(app, `/api/residents?view=presence&handle=${QUIET.handle}`)).json.resident as Json).asleep, true)
      for (const path of ['/api/window?view=full', '/api/window?view=outline']) {
        assert.equal(resident((await read(app, path)).json, QUIET.handle).asleep, true, path)
      }
    })

    await t.test('on with no history and off with history have identical public bytes for every viewer', async () => {
      const rooms = await resetCity(RESIDENTS)
      const paths = [
        '/api/residents?limit=200', '/api/residents?view=presence&limit=200',
        `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`,
        `/api/place/${rooms.eastRoomId}?view=outline`, `/api/place/${rooms.eastRoomId}?view=full`,
        '/api/map?view=outline', '/api/map?view=full',
      ]
      for (const secret of [null, NEIGHBOUR.secret, FOUNDER.secret, GROWER.secret, OTHER.secret]) {
        await db.query('UPDATE residents SET show_activity = true, last_public_action_at = NULL WHERE id = $1', [NEIGHBOUR.id])
        const before = await Promise.all(paths.map(path => read(app, path, secret)))
        const tools = [
          ['browse', { view: 'residents' }],
          ['browse', { view: 'residents', resident_view: 'presence' }],
          ['browse', { view: 'residents', resident_view: 'presence', handle: NEIGHBOUR.handle }],
          ['look', { place_id: rooms.eastRoomId, view: 'outline' }],
          ['look', { place_id: rooms.eastRoomId, view: 'full' }],
        ] as const
        const toolBefore = await Promise.all(tools.map(([name, args]) => mcp(app, secret, name, args)))
        await db.query("UPDATE residents SET show_activity = false, last_public_action_at = now() - interval '1 minute' WHERE id = $1", [NEIGHBOUR.id])
        for (const [index, path] of paths.entries()) {
          const after = await read(app, path, secret)
          assert.equal(after.status, 200, path)
          assert.equal(after.text, before[index]!.text, `${path}: ${secret === null ? 'anonymous' : 'signed in'}`)
        }
        for (const [index, [name, args]] of tools.entries()) {
          assert.equal(JSON.stringify(await mcp(app, secret, name, args)), JSON.stringify(toolBefore[index]), `${name}: public result bytes`)
        }
      }
      for (const path of ['/api/window?view=full', '/api/window?view=outline', '/api/window?view=directory']) {
        await db.query('UPDATE residents SET show_activity = true, last_public_action_at = NULL WHERE id = $1', [NEIGHBOUR.id])
        const before = await read(app, path)
        await db.query("UPDATE residents SET show_activity = false, last_public_action_at = now() - interval '1 minute' WHERE id = $1", [NEIGHBOUR.id])
        assert.equal((await read(app, path)).text, before.text, path)
      }
    })

    await t.test('quiet reads and settings changes never write activity or the public checkpoint', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const note = await db.query("INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, 'Quiet record') RETURNING id", [rooms.eastRoomId, FOUNDER.id])
      const stamps = async () => (await db.query(`
        SELECT 'resident' AS kind, id, last_public_action_at FROM residents
        UNION ALL SELECT 'place', id, last_public_action_at FROM places ORDER BY kind, id
      `)).rows
      const before = await stamps()
      const marker = await checkpoint()
      for (const path of ['/api/me', `/api/place/${rooms.eastRoomId}`, `/api/note/${note.rows[0]!.id}/here`, '/api/me/settings']) {
        const answer = await read(app, path, NEIGHBOUR.secret)
        assert.equal(answer.status, 200, path)
        if (path === '/api/me') assertNoActivity(answer.json)
        assert.deepEqual(await stamps(), before, path)
      }
      for (const show of [false, false, true]) {
        await toggle(app, NEIGHBOUR.secret, show)
        assert.deepEqual(await stamps(), before)
        assert.equal(await checkpoint(), marker)
      }
      const settingsBefore = await read(app, '/api/me/settings', NEIGHBOUR.secret)
      const repeated = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/settings', { show_activity: true })
      assert.equal(repeated.status, 200)
      assert.equal(repeated.json.changed, false)
      assert.equal(repeated.json.updated_at, settingsBefore.json.updated_at)
      await db.query('UPDATE residents SET show_activity = false WHERE id = $1', [NEIGHBOUR.id])
      await db.query('DELETE FROM resident_settings WHERE resident_id = $1', [NEIGHBOUR.id])
      const unchanged = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/settings', { show_activity: false })
      assert.equal(unchanged.status, 200)
      assert.equal(unchanged.json.changed, false)
      assert.equal((unchanged.json.settings as Json).show_activity, false)
      assert.equal((await db.query('SELECT count(*)::int AS n FROM resident_settings WHERE resident_id = $1', [NEIGHBOUR.id])).rows[0]!.n, 0)
    })

    await t.test('rolling SQL boundaries use the older band and omit unknown or future facts', async () => {
      const { publicActivitySql } = await import('../../src/public-activity.ts')
      const rows = await db.query(`
        SELECT resident.ordinal, ${publicActivitySql('resident', true)} AS last_active
        FROM (VALUES
          (1, true, statement_timestamp() - interval '3599 seconds'),
          (2, true, statement_timestamp() - interval '1 hour'),
          (3, true, statement_timestamp() - interval '24 hours'),
          (4, true, statement_timestamp() - interval '7 days'),
          (5, true, NULL::timestamptz),
          (6, true, statement_timestamp() + interval '1 second')
        ) resident(ordinal, show_activity, last_public_action_at)
        ORDER BY resident.ordinal
      `)
      assert.deepEqual(rows.rows.map(row => row.last_active), ['active now', 'today', 'this week', 'longer', null, null])
    })

    await t.test('a new public note advances stored facts while off without changing the public resident shape', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await toggle(app, NEIGHBOUR.secret, false)
      const stamps = async () => (await db.query(`
        SELECT resident.last_public_action_at AS resident_at, place.last_public_action_at AS place_at
        FROM residents resident, places place WHERE resident.id = $1 AND place.id = $2
      `, [NEIGHBOUR.id, rooms.eastRoomId])).rows[0]!
      assert.deepEqual(await stamps(), { resident_at: null, place_at: null })
      const note = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'An applied public note.' })
      assert.equal(note.status, 201, JSON.stringify(note.json))
      assertNoActivity(note.json)
      const after = await stamps()
      assert.ok(after.resident_at instanceof Date)
      assert.equal(after.resident_at.getTime(), after.place_at.getTime())
      assertPublicBand((await read(app, `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`)).json.resident as Json, undefined)
      assertPublicBand((await read(app, `/api/place/${rooms.eastRoomId}`)).json.place as Json, 'active now')
      await toggle(app, NEIGHBOUR.secret, true)
      assert.deepEqual(await stamps(), after, 'turning the marker on does not create activity')
      assertPublicBand((await read(app, `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`)).json.resident as Json, 'active now')
    })

    await t.test('warm window, directory and map caches remain entirely marker-free through on/off/on', async () => {
      const rooms = await resetCity(RESIDENTS)
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '30 minutes')
      const paths = ['/api/window?view=full', '/api/window?view=outline', '/api/window?view=directory', '/api/map?view=full', '/api/map?view=outline']
      for (const show of [true, false, true]) {
        await toggle(app, NEIGHBOUR.secret, show)
        for (const path of paths) {
          const answer = await read(app, path)
          assert.equal(answer.status, 200, path)
          assertNoActivity(answer.json, path)
        }
      }
    })

    await t.test('populated looking and listening subsets and retired tombstones carry no activity', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '30 minutes')
      const { recordResidentLooking } = await import('../../src/resident-looking.ts')
      const { openWait } = await import('../../src/room-wait-store.ts')
      const { leaseSeconds } = await import('../../src/room-talk-contract.ts')
      await recordResidentLooking(NEIGHBOUR)
      assert.equal((await openWait({ residentId: NEIGHBOUR.id, seconds: leaseSeconds(30)! })).ok, true)
      const answer = await read(app, `/api/place/${rooms.eastRoomId}`)
      assert.equal((answer.json.looking_residents as Json[]).length, 1)
      assert.equal((answer.json.listening_residents as Json[]).length, 1)
      assertNoActivity(answer.json.looking_residents)
      assertNoActivity(answer.json.listening_residents)
      await db.query('UPDATE places SET retired_at = now() WHERE id = $1', [rooms.westRoomId])
      const retired = await read(app, `/api/place/${rooms.westRoomId}`)
      assert.equal(retired.status, 200)
      assertNoActivity(retired.json)
    })

    await t.test('failed stored activity reads never return a previously visible resident band', async () => {
      const rooms = await resetCity(RESIDENTS)
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '30 minutes')
      const path = `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`
      assertPublicBand((await read(app, path)).json.resident as Json, 'active now')
      await db.query('ALTER TABLE residents RENAME COLUMN show_activity TO unavailable_show_activity')
      try {
        for (const route of [path, '/api/residents', '/api/residents?view=presence']) {
          const answer = await read(app, route)
          assert.equal(answer.status, 500)
          assertNoActivity(answer.json)
        }
      } finally {
        await db.query('ALTER TABLE residents RENAME COLUMN unavailable_show_activity TO show_activity')
      }
    })

    await t.test('snapshot export records and grants exclude private settings and every derived band', async () => {
      const rooms = await resetCity(RESIDENTS)
      await action(NEIGHBOUR.handle, rooms.eastRoomId, '30 minutes')
      const before = (await db.query('SELECT * FROM city_snapshot.public_records_v3 ORDER BY class_name, record_id')).rows
      await toggle(app, NEIGHBOUR.secret, false)
      const after = (await db.query('SELECT * FROM city_snapshot.public_records_v3 ORDER BY class_name, record_id')).rows
      assert.deepEqual(after, before)
      assertNoActivity(after)
      const grant = await db.query("SELECT has_table_privilege('city_snapshot_export', 'resident_settings', 'SELECT') AS allowed")
      assert.equal(grant.rows[0]!.allowed, false)
    })
  } finally {
    await postgres.stop()
  }
})
