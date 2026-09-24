import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migration = await readFile(
  new URL('../../db/migrations/20260924_same_room_talk.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: '1f3d9_sk_' + '1'.repeat(48) })
const SPEAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: '1f3d9_sk_' + '2'.repeat(48) })
const TARGET = Object.freeze({ id: 3, handle: 'far-walker', secret: '1f3d9_sk_' + '3'.repeat(48) })

type CityApp = Readonly<{
  request: (input: string, init?: RequestInit) => Response | Promise<Response>
}>
type Json = Record<string, unknown>
type SeededRooms = Awaited<ReturnType<typeof resetCity>>

const PRE_TALK_DDL = `
  DROP VIEW city_snapshot.public_records_v3;
  DROP TABLE wait_leases, ping_operations, ping_receipts, pings, line_minute_quota, line_quota, room_lines;
  DROP FUNCTION pings_answer_once();
  DROP FUNCTION ping_receipts_mark_once();
  ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_target_type_allowed;
  ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_target_type_allowed
    CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement'));
  ALTER TABLE flags DROP CONSTRAINT flags_target_type_check;
  ALTER TABLE flags ADD CONSTRAINT flags_target_type_check
    CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement'));
`

async function call(
  app: CityApp,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request('http://city.test' + path, {
    method,
    headers: secret === null ? {} : bearer(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

async function prepareCity(): Promise<SeededRooms> {
  const rooms = await resetCity([FOUNDER, SPEAKER, TARGET])
  await standIn(FOUNDER.id, rooms.eastRoomId)
  await standIn(SPEAKER.id, rooms.eastRoomId)
  await standIn(TARGET.id, rooms.eastRoomId)
  return rooms
}

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

async function seedLine(
  placeId: number,
  residentId: number,
  body: string,
  requestNumber = 1,
): Promise<number> {
  const rows = await connectedDatabase().query<{ id: number }>(
    'INSERT INTO room_lines (place_id, resident_id, body, body_bytes, request_id) ' +
      'VALUES ($1, $2, $3, octet_length($3), $4::uuid) RETURNING id',
    [placeId, residentId, body, requestId(requestNumber)],
  )
  return Number(rows.rows[0]!.id)
}

async function seedPing(
  placeId: number,
  senderId: number,
  targetId: number,
  options: Readonly<{
    sentAt?: string
    expiresAt?: string
    answer?: string | null
    answeredAt?: string | null
  }> = {},
): Promise<number> {
  const rows = await connectedDatabase().query<{ id: number }>(
    'INSERT INTO pings (' +
      'place_id, sender_id, target_id, sent_at, expires_at, sender_arrived_at, target_arrived_at, answer, answered_at' +
      ') ' +
      'SELECT $1, $2, $3, $4::timestamptz, $5::timestamptz, sender_presence.arrived_at, ' +
      'target_presence.arrived_at, $6::text, $7::timestamptz ' +
      'FROM resident_presence sender_presence ' +
      'JOIN resident_presence target_presence ON target_presence.resident_id = $3 ' +
      'WHERE sender_presence.resident_id = $2 RETURNING id',
    [
      placeId,
      senderId,
      targetId,
      options.sentAt ?? '2026-01-01T00:00:00Z',
      options.expiresAt ?? '2026-01-01T00:10:00Z',
      options.answer ?? null,
      options.answeredAt ?? null,
    ],
  )
  assert.equal(rows.rows.length, 1, 'both residents have a presence row for the ping')
  return Number(rows.rows[0]!.id)
}

async function seedLineEvent(
  lineId: number,
  placeId: number,
  actor: string,
): Promise<number> {
  const rows = await connectedDatabase().query<{ id: number }>(
    "INSERT INTO events (at, kind, actor, detail) " +
      "VALUES (clock_timestamp(), 'line_said', $1, jsonb_build_object('line_id', $2::integer, 'place_id', $3::integer)) " +
      'RETURNING id',
    [actor, lineId, placeId],
  )
  return Number(rows.rows[0]!.id)
}

async function seedPingSentEvent(
  pingId: number,
  placeId: number,
  targetId: number,
  actor: string,
): Promise<number> {
  const rows = await connectedDatabase().query<{ id: number }>(
    "INSERT INTO events (at, kind, actor, detail) " +
      "VALUES (clock_timestamp(), 'ping_sent', $1, " +
      "jsonb_build_object('ping_id', $2::integer, 'place_id', $3::integer, " +
      "'target_type', 'resident', 'target_id', $4::integer)) RETURNING id",
    [actor, pingId, placeId, targetId],
  )
  return Number(rows.rows[0]!.id)
}

async function seedPingAnsweredEvent(
  pingId: number,
  placeId: number,
  targetId: number,
  answer: string,
  actor: string,
): Promise<number> {
  const rows = await connectedDatabase().query<{ id: number }>(
    "INSERT INTO events (at, kind, actor, detail) " +
      "VALUES (clock_timestamp(), 'ping_answered', $1, " +
      "jsonb_build_object('ping_id', $2::integer, 'place_id', $3::integer, " +
      "'target_type', 'resident', 'target_id', $4::integer, 'answer', $5::text)) RETURNING id",
    [actor, pingId, placeId, targetId, answer],
  )
  return Number(rows.rows[0]!.id)
}

async function seedModeration(
  targetType: 'line' | 'ping',
  targetId: number,
  action: 'remove' | 'restore',
): Promise<Readonly<{ id: number; eventId: number }>> {
  const db = connectedDatabase()
  const actionRows = await db.query<{ id: number }>(
    "INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) " +
      'VALUES ($1, $2, $3, 1, $4) RETURNING id',
    [targetType, targetId, action, 'same-room talk snapshot regression'],
  )
  const id = Number(actionRows.rows[0]!.id)
  const eventRows = await db.query<{ id: number }>(
    "INSERT INTO events (at, kind, actor, detail) " +
      "VALUES (clock_timestamp(), 'moderation', 'founder', " +
      "jsonb_build_object('target_type', $1::text, 'target_id', $2::integer, 'action', $3::text)) " +
      'RETURNING id',
    [targetType, targetId, action],
  )
  return Object.freeze({ id, eventId: Number(eventRows.rows[0]!.id) })
}

async function talkCatalog(): Promise<Readonly<Record<string, unknown>>> {
  const db = connectedDatabase()
  const tables = [
    'room_lines',
    'line_quota',
    'line_minute_quota',
    'pings',
    'ping_receipts',
    'ping_operations',
    'wait_leases',
  ]
  const columns = await db.query(
    "SELECT table_schema, table_name, column_name, ordinal_position, data_type, udt_name, " +
      "is_nullable, column_default FROM information_schema.columns " +
      "WHERE (table_schema = 'public' AND table_name = ANY($1::text[])) " +
      "OR (table_schema = 'city_snapshot' AND table_name = 'public_records_v3') " +
      'ORDER BY table_schema, table_name, ordinal_position',
    [tables],
  )
  const constraints = await db.query(
    "SELECT relation.relname AS table_name, constraint_row.conname, constraint_row.contype::text AS type, " +
      'pg_get_constraintdef(constraint_row.oid, true) AS definition, constraint_row.convalidated, ' +
      'constraint_row.condeferrable, constraint_row.condeferred ' +
      'FROM pg_constraint constraint_row ' +
      'JOIN pg_class relation ON relation.oid = constraint_row.conrelid ' +
      "JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace " +
      "WHERE namespace.nspname = 'public' AND (" +
      'relation.relname = ANY($1::text[]) OR ' +
      "(relation.relname IN ('moderation_actions', 'flags') " +
      "AND pg_get_constraintdef(constraint_row.oid, true) LIKE '%target_type%')) " +
      'ORDER BY relation.relname, constraint_row.conname',
    [tables],
  )
  const indexes = await db.query(
    "SELECT tablename, indexname, indexdef FROM pg_indexes " +
      "WHERE schemaname = 'public' AND tablename = ANY($1::text[]) " +
      'ORDER BY tablename, indexname',
    [tables],
  )
  const triggers = await db.query(
    "SELECT relation.relname AS table_name, trigger.tgname, trigger.tgenabled, " +
      'pg_get_triggerdef(trigger.oid, true) AS definition ' +
      'FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid ' +
      "JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace " +
      "WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[]) " +
      'AND NOT trigger.tgisinternal ORDER BY relation.relname, trigger.tgname',
    [tables],
  )
  const functions = await db.query(
    "SELECT procedure.proname, procedure.provolatile, procedure.prosecdef, " +
      'pg_get_functiondef(procedure.oid) AS definition ' +
      'FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace ' +
      "WHERE namespace.nspname = 'public' AND procedure.proname = ANY($1::text[]) " +
      'ORDER BY procedure.proname',
    [['pings_answer_once', 'ping_receipts_mark_once']],
  )
  const viewGrant = await db.query(
    "SELECT grantor, grantee, privilege_type, is_grantable " +
      "FROM information_schema.role_table_grants " +
      "WHERE table_schema = 'city_snapshot' AND table_name = 'public_records_v3' " +
      'ORDER BY grantee, privilege_type, grantor',
  )
  return Object.freeze({
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    functions: functions.rows,
    viewGrant: viewGrant.rows,
  })
}

async function snapshotRowsFor(
  lineId: number,
  pingId: number,
  eventIds: readonly number[],
): Promise<readonly Record<string, unknown>[]> {
  return (await connectedDatabase().query(
    "SELECT class_name, record_id, payload FROM city_snapshot.public_records_v3 " +
      "WHERE (class_name = 'lines' AND record_id = $1::text) " +
      "OR (class_name = 'pings' AND record_id = $2::text) " +
      "OR (class_name = 'events' AND record_id = ANY($3::text[])) " +
      'ORDER BY class_name, sort_key',
    [lineId, pingId, eventIds.map(String)],
  )).rows
}

test('same-room talk migration, snapshot v3, and feed markers use real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-migration')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('the same-room-talk migration applies twice to a city without talk objects and changes no existing row', async () => {
      const rooms = await resetCity([FOUNDER, SPEAKER, TARGET])
      const db = connectedDatabase()
      const installedCatalog = await talkCatalog()
      await db.query(PRE_TALK_DDL)

      const noteId = Number((await db.query<{ id: number }>(
        "INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'before talk') RETURNING id",
        [rooms.eastRoomId],
      )).rows[0]!.id)
      const flagId = Number((await db.query<{ id: number }>(
        "INSERT INTO flags (reporter_id, target_type, target_id, reason) " +
          "VALUES (1, 'note', $1, 'an old flag') RETURNING id",
        [noteId],
      )).rows[0]!.id)
      const moderationId = Number((await db.query<{ id: number }>(
        "INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) " +
          "VALUES ('note', $1, 'remove', 1, 'an old moderation action') RETURNING id",
        [noteId],
      )).rows[0]!.id)
      const originalRows = {
        notes: (await db.query('SELECT id, place_id, author_id, body, created_at, walk_to_read FROM notes WHERE id = $1', [noteId])).rows,
        flags: (await db.query('SELECT id, reporter_id, target_type, target_id, reason, created_at FROM flags WHERE id = $1', [flagId])).rows,
        moderation: (await db.query('SELECT id, target_type, target_id, action, actor_id, reason, created_at FROM moderation_actions WHERE id = $1', [moderationId])).rows,
      }

      await db.query(migration)
      await db.query(migration)

      assert.deepEqual(await talkCatalog(), installedCatalog)
      assert.deepEqual({
        notes: (await db.query('SELECT id, place_id, author_id, body, created_at, walk_to_read FROM notes WHERE id = $1', [noteId])).rows,
        flags: (await db.query('SELECT id, reporter_id, target_type, target_id, reason, created_at FROM flags WHERE id = $1', [flagId])).rows,
        moderation: (await db.query('SELECT id, target_type, target_id, action, actor_id, reason, created_at FROM moderation_actions WHERE id = $1', [moderationId])).rows,
      }, originalRows)
    })

    await t.test('line rows refuse more than 240 bytes, line breaks, tabs, controls, and blank text at the database', async () => {
      const rooms = await prepareCity()
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'visible text', 1)
      assert.ok(lineId > 0)
      const invalidBodies = [
        'é'.repeat(121),
        'line' + String.fromCharCode(10) + 'break',
        'a' + String.fromCharCode(9) + 'tab',
        'control' + String.fromCharCode(1),
        '   ',
      ]
      for (const [index, body] of invalidBodies.entries()) {
        await assert.rejects(
          seedLine(rooms.eastRoomId, SPEAKER.id, body, index + 2),
          { code: '23514' },
          'the database rejects body ' + String(index + 1),
        )
      }
    })

    await t.test('pings refuse a self ping, an end not after the start, an unknown answer, an answer after the end, and a second answer', async () => {
      const rooms = await prepareCity()
      const base = {
        placeId: rooms.eastRoomId,
        senderId: SPEAKER.id,
        targetId: TARGET.id,
      }
      await assert.rejects(seedPing(rooms.eastRoomId, SPEAKER.id, SPEAKER.id), { code: '23514' })
      await assert.rejects(seedPing(base.placeId, base.senderId, base.targetId, {
        sentAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:00:00Z',
      }), { code: '23514' })
      await assert.rejects(seedPing(base.placeId, base.senderId, base.targetId, {
        answer: 'maybe',
        answeredAt: '2026-01-01T00:01:00Z',
      }), { code: '23514' })
      await assert.rejects(seedPing(base.placeId, base.senderId, base.targetId, {
        answer: 'yes',
        answeredAt: '2026-01-01T00:11:00Z',
      }), { code: '23514' })

      const pingId = await seedPing(base.placeId, base.senderId, base.targetId)
      await connectedDatabase().query(
        "UPDATE pings SET answer = 'yes', answered_at = sent_at + interval '1 minute' WHERE id = $1",
        [pingId],
      )
      await assert.rejects(
        connectedDatabase().query(
          "UPDATE pings SET answer = 'no', answered_at = sent_at + interval '2 minutes' WHERE id = $1",
          [pingId],
        ),
        { code: '55000' },
      )
    })

    await t.test('room_lines and ping_operations refuse update and delete, a ping refuses changes to its arrival marks, and a receipt is marked once', async () => {
      const rooms = await prepareCity()
      const db = connectedDatabase()
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'permanent line')
      const pingId = await seedPing(rooms.eastRoomId, SPEAKER.id, TARGET.id)
      await db.query(
        "INSERT INTO ping_operations (resident_id, request_id, operation, ping_id, payload_fingerprint, response_status, response_json) " +
          "VALUES (2, $1::uuid, 'invite', $2, repeat('a', 64), 201, '{\"ok\":true}'::jsonb)",
        [requestId(50), pingId],
      )

      await assert.rejects(db.query("UPDATE room_lines SET body = 'changed' WHERE id = $1", [lineId]), { code: '55000' })
      await assert.rejects(db.query('DELETE FROM room_lines WHERE id = $1', [lineId]), { code: '55000' })
      await assert.rejects(db.query('UPDATE ping_operations SET response_status = 200 WHERE resident_id = 2'), { code: '55000' })
      await assert.rejects(db.query('DELETE FROM ping_operations WHERE resident_id = 2'), { code: '55000' })
      await assert.rejects(
        db.query("UPDATE pings SET sender_arrived_at = sender_arrived_at + interval '1 second' WHERE id = $1", [pingId]),
        { code: '55000' },
      )

      await db.query('INSERT INTO ping_receipts (ping_id, recipient_id) VALUES ($1, $2)', [pingId, TARGET.id])
      await db.query('UPDATE ping_receipts SET seen_at = clock_timestamp() WHERE ping_id = $1', [pingId])
      await assert.rejects(
        db.query("UPDATE ping_receipts SET seen_at = seen_at + interval '1 second' WHERE ping_id = $1", [pingId]),
        { code: '55000' },
      )
    })

    await t.test('moderation and flags accept line and ping targets at the database and still refuse unknown ones', async () => {
      await prepareCity()
      const db = connectedDatabase()
      for (const targetType of ['line', 'ping']) {
        await db.query(
          'INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) ' +
            'VALUES ($1, 700, $2, 1, $3)',
          [targetType, 'remove', 'database target check'],
        )
        await db.query(
          'INSERT INTO flags (reporter_id, target_type, target_id, reason) VALUES (1, $1, 700, $2)',
          [targetType, 'database target check'],
        )
      }
      await assert.rejects(
        db.query(
          "INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) " +
            "VALUES ('unknown', 701, 'remove', 1, 'unknown type')",
        ),
        { code: '23514' },
      )
      await assert.rejects(
        db.query("INSERT INTO flags (reporter_id, target_type, target_id, reason) VALUES (1, 'unknown', 701, 'unknown type')"),
        { code: '23514' },
      )
    })

    await t.test('snapshot v3 equals v2 plus nothing before anyone talks', async () => {
      await resetCity([FOUNDER, SPEAKER, TARGET])
      const differences = await connectedDatabase().query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM (' +
          '(SELECT class_name, record_id, sort_key, payload FROM city_snapshot.public_records_v2 ' +
          'EXCEPT ALL SELECT class_name, record_id, sort_key, payload FROM city_snapshot.public_records_v3) ' +
          'UNION ALL ' +
          '(SELECT class_name, record_id, sort_key, payload FROM city_snapshot.public_records_v3 ' +
          'EXCEPT ALL SELECT class_name, record_id, sort_key, payload FROM city_snapshot.public_records_v2)' +
          ') difference',
      )
      assert.equal(differences.rows[0]!.count, 0)
    })

    await t.test('snapshot v3 exports lines, pings, and talk events with safe references only', async () => {
      const rooms = await prepareCity()
      const db = connectedDatabase()
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'a public room line')
      const pingId = await seedPing(rooms.eastRoomId, SPEAKER.id, TARGET.id, {
        answer: 'yes',
        answeredAt: '2026-01-01T00:01:00Z',
      })
      const lineEventId = await seedLineEvent(lineId, rooms.eastRoomId, SPEAKER.handle)
      const pingSentEventId = await seedPingSentEvent(pingId, rooms.eastRoomId, TARGET.id, SPEAKER.handle)
      const pingAnsweredEventId = await seedPingAnsweredEvent(
        pingId,
        rooms.eastRoomId,
        TARGET.id,
        'yes',
        TARGET.handle,
      )
      const rows = (await db.query<{ class_name: string; record_id: string; payload: Json }>(
        'SELECT class_name, record_id, payload FROM city_snapshot.public_records_v3 ' +
          'WHERE (class_name = $1 AND record_id = $2::text) ' +
          'OR (class_name = $3 AND record_id = $4::text) ' +
          'OR (class_name = $5 AND record_id = ANY($6::text[])) ' +
          'ORDER BY class_name, sort_key',
        ['lines', lineId, 'pings', pingId, 'events', [lineEventId, pingSentEventId, pingAnsweredEventId].map(String)],
      )).rows
      const row = (className: string, id: number) => rows.find(
        item => item.class_name === className && item.record_id === String(id),
      )!.payload
      const line = row('lines', lineId)
      const ping = row('pings', pingId)
      const lineEvent = row('events', lineEventId)
      const pingSentEvent = row('events', pingSentEventId)
      const pingAnsweredEvent = row('events', pingAnsweredEventId)

      assert.deepEqual(Object.keys(line).sort(), [
        'author', 'author_id', 'body', 'body_bytes', 'created_at', 'id', 'place_id', 'status',
      ].sort())
      assert.equal(line.status, 'exported')
      assert.equal(line.body, 'a public room line')
      assert.deepEqual(Object.keys(ping).sort(), [
        'answered_at', 'answer', 'expires_at', 'id', 'place_id', 'sender', 'sender_id',
        'sent_at', 'status', 'target', 'target_id',
      ].sort())
      assert.equal(ping.status, 'exported')
      assert.equal(ping.answer, 'yes')

      for (const event of [lineEvent, pingSentEvent, pingAnsweredEvent]) {
        assert.deepEqual(Object.keys(event).sort(), [
          'actor', 'at', 'detail', 'detail_policy', 'id', 'kind', 'status',
        ].sort())
        assert.equal(event.status, 'exported')
        const serialized = JSON.stringify(event)
        assert.equal(serialized.includes('request_id'), false)
        assert.equal(serialized.includes('sender_arrived_at'), false)
        assert.equal(serialized.includes('target_arrived_at'), false)
      }
      assert.deepEqual(Object.keys(lineEvent.detail as Json).sort(), ['line_id', 'place_id'])
      assert.deepEqual(Object.keys(pingSentEvent.detail as Json).sort(), [
        'ping_id', 'place_id', 'target_id', 'target_type',
      ].sort())
      assert.deepEqual(Object.keys(pingAnsweredEvent.detail as Json).sort(), [
        'answer', 'ping_id', 'place_id', 'target_id', 'target_type',
      ].sort())
    })

    await t.test('a removed line or ping leaves only hidden markers in snapshot v3 and a restore brings it back', async () => {
      const rooms = await prepareCity()
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'moderated line')
      const pingId = await seedPing(rooms.eastRoomId, SPEAKER.id, TARGET.id, {
        answer: 'no',
        answeredAt: '2026-01-01T00:01:00Z',
      })
      const lineEventId = await seedLineEvent(lineId, rooms.eastRoomId, SPEAKER.handle)
      const pingSentEventId = await seedPingSentEvent(pingId, rooms.eastRoomId, TARGET.id, SPEAKER.handle)
      const pingAnsweredEventId = await seedPingAnsweredEvent(
        pingId,
        rooms.eastRoomId,
        TARGET.id,
        'no',
        TARGET.handle,
      )
      const removedLine = await seedModeration('line', lineId, 'remove')
      const removedPing = await seedModeration('ping', pingId, 'remove')
      const initialEvents = [lineEventId, pingSentEventId, pingAnsweredEventId]
      const hiddenRows = await snapshotRowsFor(lineId, pingId, [
        ...initialEvents, removedLine.eventId, removedPing.eventId,
      ])
      const hiddenByKey = new Map(hiddenRows.map(row => [
        String(row.class_name) + ':' + String(row.record_id),
        row.payload as Json,
      ]))

      for (const [className, id] of [['lines', lineId], ['pings', pingId]] as const) {
        const hidden = hiddenByKey.get(className + ':' + String(id))!
        assert.deepEqual(hidden, { id, status: 'maintainer_hidden' })
      }
      for (const eventId of initialEvents) {
        assert.deepEqual(hiddenByKey.get('events:' + String(eventId)), {
          id: eventId,
          status: 'maintainer_hidden',
        })
      }
      for (const moderation of [removedLine, removedPing]) {
        const event = hiddenByKey.get('events:' + String(moderation.eventId))!
        assert.equal(event.kind, 'moderation')
        assert.equal(event.status, 'exported')
      }

      const restoredLine = await seedModeration('line', lineId, 'restore')
      const restoredPing = await seedModeration('ping', pingId, 'restore')
      const restoredRows = await snapshotRowsFor(lineId, pingId, [
        ...initialEvents,
        removedLine.eventId,
        removedPing.eventId,
        restoredLine.eventId,
        restoredPing.eventId,
      ])
      const restoredByKey = new Map(restoredRows.map(row => [
        String(row.class_name) + ':' + String(row.record_id),
        row.payload as Json,
      ]))
      assert.equal(restoredByKey.get('lines:' + String(lineId))!.status, 'exported')
      assert.equal(restoredByKey.get('pings:' + String(pingId))!.status, 'exported')
      for (const eventId of initialEvents) {
        assert.equal(restoredByKey.get('events:' + String(eventId))!.status, 'exported')
      }
      for (const moderation of [removedLine, removedPing, restoredLine, restoredPing]) {
        assert.equal(restoredByKey.get('events:' + String(moderation.eventId))!.kind, 'moderation')
      }
    })

    await t.test('snapshot v2 keeps talk events as not-public markers', async () => {
      const rooms = await prepareCity()
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'version two line')
      const pingId = await seedPing(rooms.eastRoomId, SPEAKER.id, TARGET.id)
      const lineEventId = await seedLineEvent(lineId, rooms.eastRoomId, SPEAKER.handle)
      const pingSentEventId = await seedPingSentEvent(pingId, rooms.eastRoomId, TARGET.id, SPEAKER.handle)
      const pingAnsweredEventId = await seedPingAnsweredEvent(
        pingId,
        rooms.eastRoomId,
        TARGET.id,
        'yes',
        TARGET.handle,
      )
      const events = (await connectedDatabase().query<{ record_id: string; payload: Json }>(
        "SELECT record_id, payload FROM city_snapshot.public_records_v2 " +
          "WHERE class_name = 'events' AND record_id = ANY($1::text[]) ORDER BY sort_key",
        [[lineEventId, pingSentEventId, pingAnsweredEventId].map(String)],
      )).rows
      assert.equal(events.length, 3)
      for (const event of events) {
        assert.deepEqual(event.payload, {
          id: Number(event.record_id),
          status: 'not_public_or_sequence_gap',
        })
      }
    })

    await t.test('a quiet room lines and pings still export in snapshot v3', async () => {
      const rooms = await prepareCity()
      await connectedDatabase().query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'quiet room line')
      const pingId = await seedPing(rooms.eastRoomId, SPEAKER.id, TARGET.id)
      const rows = (await connectedDatabase().query<{ class_name: string; payload: Json }>(
        "SELECT class_name, payload FROM city_snapshot.public_records_v3 " +
          "WHERE (class_name = 'lines' AND record_id = $1::text) " +
          "OR (class_name = 'pings' AND record_id = $2::text)",
        [lineId, pingId],
      )).rows
      assert.deepEqual(rows.map(row => [row.class_name, row.payload.status]).sort(), [
        ['lines', 'exported'],
        ['pings', 'exported'],
      ])
    })

    await t.test('a resident whose only recent act is a line is awake in snapshot v3', async () => {
      const rooms = await prepareCity()
      const db = connectedDatabase()
      await db.query("UPDATE residents SET joined_at = clock_timestamp() - interval '30 days' WHERE id = $1", [SPEAKER.id])
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'recent line only')
      await seedLineEvent(lineId, rooms.eastRoomId, SPEAKER.handle)
      const asleep = (await db.query<{ payload: Json }>(
        "SELECT payload FROM city_snapshot.public_records_v2 " +
          "WHERE class_name = 'public_presence' AND record_id = $1::text",
        [SPEAKER.id],
      )).rows[0]!.payload
      const awake = (await db.query<{ payload: Json }>(
        "SELECT payload FROM city_snapshot.public_records_v3 " +
          "WHERE class_name = 'public_presence' AND record_id = $1::text",
        [SPEAKER.id],
      )).rows[0]!.payload
      assert.equal(asleep.asleep, true)
      assert.equal(awake.asleep, false)
    })

    await t.test('the export role may read v3 and v2 and no talk table', async () => {
      await prepareCity()
      const db = connectedDatabase()
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        // resetCity recreates the public schema, which drops the USAGE grant to
        // PUBLIC that every fresh database (and production) has. The snapshot
        // views call drawing functions that live in public, so restore that
        // default for this transaction only; table rights stay revoked.
        await client.query('GRANT USAGE ON SCHEMA public TO PUBLIC')
        await client.query('SET LOCAL ROLE city_snapshot_export')
        const views = await client.query(
          'SELECT (SELECT count(*) FROM city_snapshot.public_records_v2)::integer AS v2, ' +
            '(SELECT count(*) FROM city_snapshot.public_records_v3)::integer AS v3',
        )
        assert.ok(views.rows[0]!.v2 > 0)
        assert.ok(views.rows[0]!.v3 > 0)
        for (const table of [
          'room_lines', 'line_quota', 'line_minute_quota', 'pings',
          'ping_receipts', 'ping_operations', 'wait_leases',
        ]) {
          await client.query('SAVEPOINT talk_table_probe')
          await assert.rejects(
            client.query('SELECT * FROM public.' + table + ' LIMIT 0'),
            { code: '42501' },
            'the export role cannot read ' + table,
          )
          await client.query('ROLLBACK TO SAVEPOINT talk_table_probe')
        }
        await client.query('ROLLBACK')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    })

    await t.test('GET /api/events shows safe talk references, passes an unmoderated event through, and shows a removed one only as a marker', async () => {
      const rooms = await prepareCity()
      const plainLineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'unmoderated line', 1)
      const removedLineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'removed line', 2)
      const plainEventId = await seedLineEvent(plainLineId, rooms.eastRoomId, SPEAKER.handle)
      const removedEventId = await seedLineEvent(removedLineId, rooms.eastRoomId, SPEAKER.handle)
      await connectedDatabase().query(
        "INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) " +
          "VALUES ('line', $1, 'remove', 1, 'hide the line from public reads')",
        [removedLineId],
      )
      const stored = (await connectedDatabase().query<{
        id: number
        at: Date
        kind: string
        actor: string
        detail: Json
      }>(
        'SELECT id, at, kind, actor, detail FROM events WHERE id = $1',
        [plainEventId],
      )).rows[0]!

      const response = await call(app, null, 'GET', '/api/events?kind=line_said&limit=20')
      assert.equal(response.status, 200, JSON.stringify(response.json))
      const events = response.json.events as Json[]
      assert.deepEqual(events.filter(event => event.kind === 'line_said').map(event => event.id), [
        removedEventId, plainEventId,
      ])
      const plain = events.find(event => event.id === plainEventId)!
      assert.deepEqual({
        id: plain.id,
        at: plain.at,
        kind: plain.kind,
        actor: plain.actor,
        detail: plain.detail,
      }, {
        id: stored.id,
        at: stored.at.toISOString(),
        kind: stored.kind,
        actor: stored.actor,
        detail: stored.detail,
      })
      const marker = events.find(event => event.id === removedEventId)!
      assert.equal(marker.actor, '')
      assert.equal(marker.kind, 'line_said')
      assert.equal(typeof marker.at, 'string')
      assert.deepEqual(Object.keys(marker.detail as Json).sort(), ['line_id', 'moderated', 'moderation'].sort())
      for (const key of ['place_id', 'target_id', 'answer']) {
        assert.equal(Object.hasOwn(marker, key), false)
        assert.equal(Object.hasOwn(marker.detail as Json, key), false)
      }
    })

    await t.test('the change feed, the window, and replay carry no talk event yet', async () => {
      const rooms = await prepareCity()
      const lineId = await seedLine(rooms.eastRoomId, SPEAKER.id, 'not in the current feeds')
      const pingId = await seedPing(rooms.eastRoomId, SPEAKER.id, TARGET.id)
      await seedLineEvent(lineId, rooms.eastRoomId, SPEAKER.handle)
      await seedPingSentEvent(pingId, rooms.eastRoomId, TARGET.id, SPEAKER.handle)
      await seedPingAnsweredEvent(pingId, rooms.eastRoomId, TARGET.id, 'yes', TARGET.handle)

      for (const path of [
        '/api/changes?since=0',
        '/api/window',
        '/api/replay?span=1h',
      ]) {
        const response = await call(app, null, 'GET', path)
        assert.equal(response.status, 200, path + ': ' + JSON.stringify(response.json))
        const serialized = JSON.stringify(response.json)
        assert.equal(serialized.includes('line_said'), false, path)
        assert.equal(serialized.includes('ping_sent'), false, path)
        assert.equal(serialized.includes('ping_answered'), false, path)
      }
    })

    await t.test('the founder moderation route still refuses a line target', async () => {
      await prepareCity()
      const db = connectedDatabase()
      const before = Number((await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM moderation_actions WHERE target_type = 'line'",
      )).rows[0]!.count)
      const response = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove',
        target_type: 'line',
        target_id: 1,
        reason: 'test route vocabulary',
      })
      assert.equal(response.status, 400)
      assert.equal(
        response.json.error,
        'need exactly action (remove|restore), target_type, target_id, and a safe reason',
      )
      const after = Number((await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM moderation_actions WHERE target_type = 'line'",
      )).rows[0]!.count)
      assert.equal(after, before)
    })
  } finally {
    await postgres.stop()
  }
})
