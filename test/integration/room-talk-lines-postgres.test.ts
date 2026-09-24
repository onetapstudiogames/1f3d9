import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  call,
  coin,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  seedKind,
  seedThing,
  traitId,
  type CityApp,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

async function waitForUtcSecondBelow45(): Promise<void> {
  while (new Date().getUTCSeconds() >= 45) await delay(200)
}

async function avoidLastTenSecondsOfUtcDay(): Promise<void> {
  while (new Date().getUTCHours() === 23
    && new Date().getUTCMinutes() === 59
    && new Date().getUTCSeconds() >= 50) {
    await delay(200)
  }
}

async function waitForPresenceLockWait(): Promise<void> {
  const db = connectedDatabase()
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = await db.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR SHARE OF presence%'
      ) AS waiting
    `)
    if (waiting.rows[0]!.waiting) return
    await delay(10)
  }
  assert.fail('the line did not wait for the move lock')
}

test('room lines use their own per-resident allowances against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-lines')
  try {
    let rooms = await resetCity(RESIDENTS)
    await standIn(NEIGHBOUR.id, rooms.eastRoomId)
    const { sayLine } = await import('../../src/room-line-store.ts')
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    let requestNumber = 1

    const prepare = async () => {
      rooms = await resetCity(RESIDENTS)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      return rooms
    }
    const input = (
      resident: Readonly<{ id: number; handle: string }>,
      placeId: unknown,
      body: unknown,
      id = requestId(requestNumber++),
    ) => ({
      residentId: resident.id,
      residentHandle: resident.handle,
      placeId,
      body,
      requestId: id,
    })
    const say = (
      placeId: unknown = rooms.eastRoomId,
      body: unknown = 'hello from the room',
      resident: Readonly<{ id: number; handle: string }> = NEIGHBOUR,
    ) => sayLine(input(resident, placeId, body))
    const count = async (sql: string, values: readonly unknown[] = []) => Number(
      (await connectedDatabase().query<{ count: number }>(sql, [...values])).rows[0]!.count,
    )

    await t.test('a resident standing in a place says a line and gets its record, allowance, and one line_said event', async () => {
      const result = await say()
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.status, 201)
      assert.equal(result.answer.replayed, false)
      assert.equal(result.answer.line.place_id, rooms.eastRoomId)
      assert.equal(result.answer.line.author_id, NEIGHBOUR.id)
      assert.equal(result.answer.line.author, NEIGHBOUR.handle)
      assert.equal(result.answer.line.body, 'hello from the room')
      assert.equal(result.answer.line.body_bytes, Buffer.byteLength('hello from the room', 'utf8'))
      assert.ok(result.answer.line.id > 0)
      assert.equal(typeof result.answer.line.created_at, 'string')
      assert.deepEqual(result.answer.line_quota, {
        per_utc_minute: {
          used: 1,
          limit: 12,
          reset_at: result.answer.line_quota.per_utc_minute.reset_at,
        },
        per_utc_day: {
          used: 1,
          limit: 300,
          reset_at: result.answer.line_quota.per_utc_day.reset_at,
        },
      })
      const events = (await connectedDatabase().query<{
        at: Date
        kind: string
        actor: string
        detail: Record<string, unknown>
      }>("SELECT at, kind, actor, detail FROM events WHERE kind = 'line_said'")).rows
      assert.equal(events.length, 1)
      assert.equal(events[0]!.kind, 'line_said')
      assert.equal(events[0]!.actor, NEIGHBOUR.handle)
      assert.deepEqual(events[0]!.detail, {
        line_id: result.answer.line.id,
        place_id: rooms.eastRoomId,
      })
      assert.equal(events[0]!.at.toISOString(), result.answer.line.created_at)
    })

    await t.test('standing is enough: a room closed to notes, another owner room, and the world root all take lines', async () => {
      rooms = await prepare()
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_notes = FALSE WHERE id = $1', [rooms.eastRoomId])
      await db.query('UPDATE places SET owner_id = $2 WHERE id = $1', [rooms.westRoomId, GROWER.id])
      const worldId = Number((await db.query<{ id: number }>(
        "SELECT id FROM places WHERE place_kind = 'world' AND retired_at IS NULL",
      )).rows[0]!.id)

      const east = await say(rooms.eastRoomId, 'closed to notes')
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      const west = await say(rooms.westRoomId, 'another owner room')
      await standIn(NEIGHBOUR.id, worldId)
      const world = await say(worldId, 'the world root')

      for (const result of [east, west, world]) {
        assert.equal(result.ok, true)
        if (result.ok) assert.equal(result.status, 201)
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 3)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 3)
    })

    await t.test('a resident elsewhere is refused with the exact sentence and nothing is written', async () => {
      rooms = await prepare()
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      const result = await say(rooms.eastRoomId)
      assert.deepEqual(result, {
        ok: false,
        refusal: { status: 403, error: 'Stand in this place to say its line.' },
      })
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_minute_quota'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 0)
    })

    await t.test('a line is never a note and spends no note allowance, even when the note allowance is used up', async () => {
      rooms = await prepare()
      await connectedDatabase().query(
        "UPDATE residents SET quota_day = (clock_timestamp() AT TIME ZONE 'UTC')::date, notes_today = 50 WHERE id = $1",
        [NEIGHBOUR.id],
      )
      const result = await say()
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.status, 201)
      assert.equal(await count('SELECT count(*)::int AS count FROM notes'), 0)
      const resident = (await connectedDatabase().query<{ notes_today: number }>(
        'SELECT notes_today FROM residents WHERE id = $1', [NEIGHBOUR.id],
      )).rows[0]!
      assert.equal(resident.notes_today, 50)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota WHERE resident_id = $1', [NEIGHBOUR.id]), 1)
    })

    await t.test('a line settles nothing and wakes nothing, while a note wakes the same listening thing', async () => {
      rooms = await prepare()
      const db = connectedDatabase()
      assert.equal((await coin(app, FOUNDER.secret, 'line-ear', {
        wake: { on: ['talk'], then: [{ effect: 'write', key: 'heard', op: 'add' }] },
      })).status, 201)
      const kindId = await seedKind(FOUNDER.id, 'line-ears', [await traitId('line-ear')])
      const earId = await seedThing(FOUNDER.id, rooms.eastRoomId, kindId, 'line ear')
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [earId])
      const beforeEventId = Number((await db.query<{ id: number | null }>(
        'SELECT max(id) AS id FROM events',
      )).rows[0]!.id ?? 0)

      const line = await say()
      assert.equal(line.ok, true)
      if (!line.ok) return
      assert.equal(line.status, 201)
      assert.equal(await count('SELECT count(*)::int AS count FROM wake_settles'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM wake_tries'), 0)
      assert.deepEqual((await db.query<{ state: Record<string, unknown> }>(
        'SELECT state FROM things WHERE id = $1', [earId],
      )).rows[0]!.state, {})
      assert.deepEqual((await db.query<{ kind: string }>(
        'SELECT kind FROM events WHERE id > $1 ORDER BY id', [beforeEventId],
      )).rows.map(row => row.kind), ['line_said'])

      const note = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId,
        body: 'does the listening thing hear this note',
      })
      assert.equal(note.status, 201, JSON.stringify(note.json))
      assert.equal((note.json.settle as Record<string, unknown>).woke, 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM wake_settles'), 1)
      assert.deepEqual((await db.query<{ state: Record<string, unknown> }>(
        'SELECT state FROM things WHERE id = $1', [earId],
      )).rows[0]!.state, { heard: 1 })
    })

    await t.test('text is stored exactly as supplied, up to 240 UTF-8 bytes', async () => {
      rooms = await prepare()
      const body = '  café 🪴  ' + 'x'.repeat(226)
      assert.equal(Buffer.byteLength(body, 'utf8'), 240)
      const result = await say(rooms.eastRoomId, body)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.answer.line.body, body)
      assert.equal(result.answer.line.body_bytes, 240)
      const stored = (await connectedDatabase().query<{ body: string; body_bytes: number }>(
        'SELECT body, body_bytes FROM room_lines WHERE id = $1', [result.answer.line.id],
      )).rows[0]!
      assert.equal(stored.body, body)
      assert.equal(stored.body_bytes, 240)
    })

    await t.test('oversize, blank, multi-line, control, garbled, and credential text are refused before anything is written', async () => {
      rooms = await prepare()
      const invalidBodies = [
        'é'.repeat(121),
        '   ',
        'first\nsecond',
        'before' + String.fromCharCode(1) + 'after',
        '\uD800',
        '1f3d9_sk_' + 'a'.repeat(48),
      ]
      for (const body of invalidBodies) {
        const result = await say(rooms.eastRoomId, body)
        assert.equal(result.ok, false, 'refused body ' + String(invalidBodies.indexOf(body) + 1))
        if (!result.ok) assert.equal(result.refusal.status, 400)
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_minute_quota'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 0)
    })

    await t.test('twenty concurrent lines in one minute admit exactly twelve', async () => {
      rooms = await prepare()
      await waitForUtcSecondBelow45()
      const results = await Promise.all(Array.from({ length: 20 }, () => say()))
      assert.equal(results.filter(result => result.ok && result.status === 201).length, 12)
      assert.equal(results.filter(result => !result.ok && result.refusal.status === 429).length, 8)
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 12)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 12)
      const quota = (await connectedDatabase().query<{ used: number }>(
        'SELECT used FROM line_minute_quota WHERE resident_id = $1', [NEIGHBOUR.id],
      )).rows[0]!
      assert.equal(quota.used, 12)
    })

    await t.test('the 300th line of a UTC day is the last one that day', async () => {
      rooms = await prepare()
      await avoidLastTenSecondsOfUtcDay()
      await connectedDatabase().query(
        "INSERT INTO line_quota (resident_id, utc_day, used) VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date, 299)",
        [NEIGHBOUR.id],
      )
      const last = await say()
      assert.equal(last.ok, true)
      if (!last.ok) return
      assert.equal(last.answer.line_quota.per_utc_day.used, 300)
      const refused = await say()
      assert.equal(refused.ok, false)
      if (!refused.ok) {
        assert.equal(refused.refusal.status, 429)
        assert.equal(refused.refusal.reset_at, last.answer.line_quota.per_utc_day.reset_at)
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 1)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 1)
      assert.equal(Number((await connectedDatabase().query<{ used: number }>(
        'SELECT used FROM line_quota WHERE resident_id = $1', [NEIGHBOUR.id],
      )).rows[0]!.used), 300)
    })

    await t.test('a refused line spends neither allowance', async () => {
      rooms = await prepare()
      const db = connectedDatabase()
      await db.query(
        "INSERT INTO line_quota (resident_id, utc_day, used) VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date, 1)",
        [NEIGHBOUR.id],
      )
      await db.query(
        "INSERT INTO line_minute_quota (resident_id, minute_start, used) VALUES ($1, date_trunc('minute', clock_timestamp(), 'UTC'), 12)",
        [NEIGHBOUR.id],
      )
      const refused = await say()
      assert.equal(refused.ok, false)
      if (!refused.ok) assert.equal(refused.refusal.status, 429)
      assert.equal(Number((await db.query<{ used: number }>(
        'SELECT used FROM line_quota WHERE resident_id = $1', [NEIGHBOUR.id],
      )).rows[0]!.used), 1)
      assert.equal(Number((await db.query<{ used: number }>(
        'SELECT used FROM line_minute_quota WHERE resident_id = $1', [NEIGHBOUR.id],
      )).rows[0]!.used), 12)
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 0)
    })

    await t.test('each resident keeps a separate allowance', async () => {
      rooms = await prepare()
      const db = connectedDatabase()
      await db.query(
        "INSERT INTO line_quota (resident_id, utc_day, used) VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date, 300)",
        [GROWER.id],
      )
      await db.query(
        "INSERT INTO line_minute_quota (resident_id, minute_start, used) VALUES ($1, date_trunc('minute', clock_timestamp(), 'UTC'), 12)",
        [GROWER.id],
      )
      const result = await say(rooms.eastRoomId, 'a different resident can speak', NEIGHBOUR)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.answer.line_quota.per_utc_day.used, 1)
      assert.equal(result.answer.line_quota.per_utc_minute.used, 1)
      assert.equal(Number((await db.query<{ used: number }>(
        'SELECT used FROM line_quota WHERE resident_id = $1', [GROWER.id],
      )).rows[0]!.used), 300)
      assert.equal(Number((await db.query<{ used: number }>(
        'SELECT used FROM line_minute_quota WHERE resident_id = $1', [GROWER.id],
      )).rows[0]!.used), 12)
    })

    await t.test('an exact retry returns the first line, replayed, and spends nothing', async () => {
      rooms = await prepare()
      const retry = input(NEIGHBOUR, rooms.eastRoomId, 'same line', requestId(requestNumber++))
      const first = await sayLine(retry)
      const again = await sayLine(retry)
      assert.equal(first.ok, true)
      assert.equal(again.ok, true)
      if (!first.ok || !again.ok) return
      assert.equal(first.status, 201)
      assert.equal(again.status, 200)
      assert.equal(first.answer.replayed, false)
      assert.equal(again.answer.replayed, true)
      assert.deepEqual(again.answer.line, first.answer.line)
      assert.deepEqual(again.answer.line_quota, first.answer.line_quota)
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_minute_quota'), 1)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 1)
    })

    await t.test('reusing a request_id with a different body or place is refused 409 naming a line', async () => {
      rooms = await prepare()
      const id = requestId(requestNumber++)
      const first = await sayLine(input(NEIGHBOUR, rooms.eastRoomId, 'original line', id))
      assert.equal(first.ok, true)
      const bodyReuse = await sayLine(input(NEIGHBOUR, rooms.eastRoomId, 'changed line', id))
      const placeReuse = await sayLine(input(NEIGHBOUR, rooms.westRoomId, 'original line', id))
      for (const result of [bodyReuse, placeReuse]) {
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.equal(result.refusal.status, 409)
          assert.match(result.refusal.error, /different line/u)
        }
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_minute_quota'), 1)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 1)
    })

    await t.test('ten concurrent identical retries write one line', async () => {
      rooms = await prepare()
      await waitForUtcSecondBelow45()
      const same = input(NEIGHBOUR, rooms.eastRoomId, 'one request repeated', requestId(requestNumber++))
      const results = await Promise.all(Array.from({ length: 10 }, () => sayLine(same)))
      assert.equal(results.filter(result => result.ok && result.status === 201).length, 1)
      assert.equal(results.filter(result => result.ok && result.status === 200).length, 9)
      assert.equal(results.filter(result => !result.ok).length, 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_minute_quota'), 1)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 1)
    })

    await t.test('a request_id already used for a ping cannot name a line', async () => {
      rooms = await prepare()
      const id = requestId(requestNumber++)
      await connectedDatabase().query(
        "INSERT INTO ping_operations (resident_id, request_id, operation, ping_id, payload_fingerprint, response_status, response_json) " +
          "VALUES ($1, $2::uuid, 'invite', NULL, repeat('a', 64), 201, '{\"ok\":true}'::jsonb)",
        [NEIGHBOUR.id, id],
      )
      const result = await sayLine(input(NEIGHBOUR, rooms.eastRoomId, 'try to reuse ping id', id))
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.refusal.status, 409)
        assert.match(result.refusal.error, /ping invite/u)
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 0)
    })

    await t.test('a line racing a move commits only if the speaker still stands there', async () => {
      rooms = await prepare()
      const db = connectedDatabase()
      const holder = await db.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(
          'UPDATE resident_presence SET current_place_id = $2 WHERE resident_id = $1',
          [NEIGHBOUR.id, rooms.westRoomId],
        )
        const speaking = say(rooms.eastRoomId, 'the move wins')
        await waitForPresenceLockWait()
        await holder.query('COMMIT')
        const result = await speaking
        assert.deepEqual(result, {
          ok: false,
          refusal: { status: 403, error: 'Stand in this place to say its line.' },
        })
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM room_lines'), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM line_quota'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 0)
    })

    await t.test('a quiet room takes lines', async () => {
      rooms = await prepare()
      await connectedDatabase().query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const result = await say()
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.status, 201)
      assert.equal(result.answer.line.place_id, rooms.eastRoomId)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'line_said'"), 1)
    })
  } finally {
    await postgres.stop()
  }
})
