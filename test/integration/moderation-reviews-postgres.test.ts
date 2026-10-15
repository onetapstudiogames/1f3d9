// Review requests and the resident's one reply to a moderation record (decision #152),
// against real PostgreSQL: the real schema, the real routes, the real migration.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  call,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const DAY = 24 * 60 * 60 * 1_000

const migration = await readFile(
  new URL('../../db/migrations/20261015_moderation_reviews.sql', import.meta.url),
  'utf8',
)

const PRE_REVIEWS_DDL = `
  DROP TABLE moderation_replies;
  ALTER TABLE flags DROP CONSTRAINT flags_target_type_check;
  ALTER TABLE flags ADD CONSTRAINT flags_target_type_check
    CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping'));
`

function daysAhead(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString()
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await connectedDatabase().query<{ n: number }>(sql, [...values])).rows[0]!.n)
}

async function notesToday(residentId: number): Promise<number> {
  return count('SELECT notes_today AS n FROM residents WHERE id = $1', [residentId])
}

async function reviewCatalog(): Promise<Readonly<Record<string, unknown>>> {
  const db = connectedDatabase()
  const constraints = await db.query(
    'SELECT relation.relname AS table_name, constraint_row.conname, constraint_row.contype::text AS type, ' +
      'pg_get_constraintdef(constraint_row.oid, true) AS definition, constraint_row.convalidated ' +
      'FROM pg_constraint constraint_row JOIN pg_class relation ON relation.oid = constraint_row.conrelid ' +
      "WHERE relation.relname IN ('flags', 'moderation_replies') ORDER BY relation.relname, constraint_row.conname",
  )
  const columns = await db.query(
    'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns ' +
      "WHERE table_schema = 'public' AND table_name = 'moderation_replies' ORDER BY ordinal_position",
  )
  const indexes = await db.query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' " +
      "AND tablename IN ('flags', 'moderation_replies') ORDER BY indexname",
  )
  const triggers = await db.query(
    'SELECT trigger.tgname, trigger.tgenabled FROM pg_trigger trigger ' +
      "WHERE trigger.tgrelid IN ('flags'::regclass, 'moderation_replies'::regclass) " +
      'AND NOT trigger.tgisinternal ORDER BY trigger.tgname',
  )
  return Object.freeze({
    constraints: constraints.rows,
    columns: columns.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
  })
}

async function mcpTool(
  app: CityApp,
  secret: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Readonly<{ isError: boolean; text: string }>> {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: bearer(secret),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  assert.equal(response.status, 200, `MCP ${name}`)
  const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  return Object.freeze({ isError: payload.result.isError, text: payload.result.content[0]!.text })
}

async function holdGrower(app: CityApp): Promise<number> {
  const set = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
    action: 'hold', target_type: 'hold', target_id: GROWER.id, rule_word: 'disruptive',
    reason: 'flooding the square after a warning; full hold for a week',
    ends_at: daysAhead(7),
    hold_notes: 0, hold_lines: 0, hold_things: 0, hold_agreements: 0,
    hold_stops_pings: true, hold_stops_building: true,
  })
  assert.equal(set.status, 201, JSON.stringify(set.json))
  return Number((set.json.moderation as Json).id)
}

test('review requests and the one reply per record, against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('moderation-reviews')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    await t.test('the migration applies twice to a city without reviews, changes no row, and ends in the fresh shape', async () => {
      const rooms = await resetCity(RESIDENTS)
      const freshCatalog = await reviewCatalog()
      await db.query(PRE_REVIEWS_DDL)
      const flagId = Number((await db.query<{ id: number }>(
        "INSERT INTO flags (reporter_id, target_type, target_id, reason) VALUES (2, 'place', $1, 'an old flag') RETURNING id",
        [rooms.eastRoomId],
      )).rows[0]!.id)
      const before = (await db.query('SELECT * FROM flags WHERE id = $1', [flagId])).rows
      await assert.rejects(db.query(
        "INSERT INTO flags (reporter_id, target_type, target_id, reason) VALUES (2, 'moderation', 1, 'too early')",
      ), /flags_target_type_check/u, 'the old check refuses a review request')

      await db.query(migration)
      await db.query(migration)

      assert.deepEqual(await reviewCatalog(), freshCatalog)
      assert.deepEqual((await db.query('SELECT * FROM flags WHERE id = $1', [flagId])).rows, before)
    })

    await t.test('the database keeps flag targets closed, one reply per record and resident, and replies append-only', async () => {
      const rooms = await resetCity(RESIDENTS)
      await assert.rejects(db.query(
        "INSERT INTO flags (reporter_id, target_type, target_id, reason) VALUES (2, 'hold', 1, 'not a flag target')",
      ), /flags_target_type_check/u)
      const recordId = Number((await db.query<{ id: number }>(
        "INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, rule_word) " +
          "VALUES ('resident', 2, 'remove', 1, 'spam', 'disruptive') RETURNING id",
      )).rows[0]!.id)
      const noteIds = []
      for (const body of ['first reply', 'second reply']) {
        noteIds.push(Number((await db.query<{ id: number }>(
          'INSERT INTO notes (place_id, author_id, body) VALUES ($1, 2, $2) RETURNING id',
          [rooms.eastRoomId, body],
        )).rows[0]!.id))
      }
      await db.query(
        'INSERT INTO moderation_replies (moderation_id, resident_id, note_id) VALUES ($1, 2, $2)',
        [recordId, noteIds[0]],
      )
      await assert.rejects(db.query(
        'INSERT INTO moderation_replies (moderation_id, resident_id, note_id) VALUES ($1, 2, $2)',
        [recordId, noteIds[1]],
      ), /moderation_replies_one_per_record/u)
      await assert.rejects(db.query(
        'INSERT INTO moderation_replies (moderation_id, resident_id, note_id) VALUES ($1, 3, $2)',
        [recordId, noteIds[0]],
      ), /moderation_replies_one_record_per_note/u)
      await assert.rejects(db.query('DELETE FROM moderation_replies'), /append-only/u)
      await assert.rejects(db.query('UPDATE moderation_replies SET resident_id = 3'), /append-only/u)
    })

    await t.test('a review request: residents only, known records only, one open request, the answer only in the requester\'s me', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GROWER.id, rooms.eastRoomId)
      const removedNote = Number((await db.query<{ id: number }>(
        'INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id',
        [rooms.eastRoomId, GROWER.id, 'a note that will be removed'],
      )).rows[0]!.id)
      const removed = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove', target_type: 'note', target_id: removedNote, reason: 'spam in the east room', rule_word: 'disruptive',
      })
      assert.equal(removed.status, 201, JSON.stringify(removed.json))
      const recordId = Number((removed.json.moderation as Json).id)

      const unknown = await call(app, GROWER.secret, 'POST', '/api/flag', {
        target_type: 'moderation', target_id: recordId + 1000, reason: 'please look again',
      })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.json.error, `moderation record ${recordId + 1000} was not found; read browse view=moderation and send a current record id`)

      const anonymous = await call(app, null, 'POST', '/api/flag', {
        target_type: 'moderation', target_id: recordId, reason: 'please look again',
      })
      assert.equal(anonymous.status, 401)
      assert.equal(anonymous.json.error, 'a review request (target_type moderation) needs a signed-in resident; send your resident key as Authorization: Bearer <key>. Without a key, report public content by its own target_type instead.')
      assert.equal(await count("SELECT count(*)::int AS n FROM flags WHERE target_type = 'moderation'"), 0)

      const asked = await mcpTool(app, GROWER.secret, 'flag', {
        target_type: 'moderation', target_id: recordId, reason: 'it was a poem, not spam',
      })
      assert.equal(asked.isError, false, asked.text)
      const requestId = Number((JSON.parse(asked.text) as Json).request_id)
      assert.ok(requestId > 0)

      const again = await call(app, GROWER.secret, 'POST', '/api/flag', {
        target_type: 'moderation', target_id: recordId, reason: 'asking twice',
      })
      assert.equal(again.status, 409)
      assert.equal(again.json.error, `you already asked for a review of moderation record ${recordId} (request ${requestId}) and it has no answer yet; one open request per record. The answer will show in me under review_requests.`)

      // The public event names the request and the record, never the reason.
      const event = (await db.query<{ actor: string; detail: Json }>(
        "SELECT actor, detail FROM events WHERE kind = 'flag' ORDER BY id DESC LIMIT 1",
      )).rows[0]!
      assert.equal(event.actor, GROWER.handle)
      assert.deepEqual(event.detail, { flag_id: requestId, target_type: 'moderation', target_id: recordId })

      const waiting = await call(app, GROWER.secret, 'GET', '/api/me')
      assert.equal(waiting.status, 200)
      const waitingRequests = waiting.json.review_requests as Json
      assert.equal(waitingRequests.total, 1)
      assert.deepEqual((waitingRequests.newest as Json[]).map(row => [row.request_id, row.record_id, row.answered]), [[requestId, recordId, false]])

      const queue = await call(app, FOUNDER.secret, 'GET', '/api/founder/flags')
      assert.equal(queue.status, 200, JSON.stringify(queue.json))
      const queued = (queue.json.flags as Json[]).find(flag => flag.id === requestId)!
      assert.equal(queued.target_type, 'moderation')
      assert.equal(queued.reason, 'it was a poem, not spam')

      const restored = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'restore', target_type: 'note', target_id: removedNote, reason: 'on review, a poem',
      })
      assert.equal(restored.status, 201, JSON.stringify(restored.json))
      const restoreId = Number((restored.json.moderation as Json).id)
      const answered = await call(app, FOUNDER.secret, 'POST', `/api/founder/flags/${requestId}/handle`, {
        moderation_id: restoreId, note: 'you were right; restored',
      })
      assert.equal(answered.status, 200, JSON.stringify(answered.json))

      const me = await call(app, GROWER.secret, 'GET', '/api/me')
      const shown = ((me.json.review_requests as Json).newest as Json[])[0]!
      assert.equal(shown.answered, true)
      assert.equal(shown.answer_record_id, restoreId)
      assert.equal(shown.answer_note, 'you were right; restored')
      assert.doesNotMatch(JSON.stringify(me.json.review_requests), /poem, not spam/u, 'me never echoes the reason')

      const neighbourMe = await call(app, NEIGHBOUR.secret, 'GET', '/api/me')
      assert.equal(Object.hasOwn(neighbourMe.json, 'review_requests'), false)
      const appMe = await mcpTool(app, GROWER.secret, 'me', {})
      assert.equal(appMe.isError, false)
      const history = await call(app, null, 'GET', '/api/moderation')
      assert.doesNotMatch(JSON.stringify(history.json), /you were right/u, 'the answer is never public')

      // Once answered, the request is closed and a new one may open.
      const next = await call(app, GROWER.secret, 'POST', '/api/flag', {
        target_type: 'moderation', target_id: recordId, reason: 'one more question',
      })
      assert.equal(next.status, 201, JSON.stringify(next.json))
    })

    await t.test('the one reply: allowed under a full hold, not counted, once per record, only for a resident the record names', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const holdId = await holdGrower(app)

      const held = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'an ordinary note' })
      assert.equal(held.status, 429, 'the full hold refuses an ordinary note')
      const before = await notesToday(GROWER.id)

      const badId = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'reply', reply_to_moderation_id: '7',
      })
      assert.equal(badId.status, 400)
      assert.equal(badId.json.error, 'reply_to_moderation_id must be a positive integer naming a moderation record')
      const extra = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'reply', extra: true,
      })
      assert.equal(extra.status, 400)
      assert.equal(extra.json.error, 'send place_id and body, plus optional walk_to_read true or false and optional reply_to_moderation_id, and no other field')
      const unknown = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'reply', reply_to_moderation_id: holdId + 1000,
      })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.json.error, `moderation record ${holdId + 1000} was not found; read browse view=moderation and send a current record id`)

      const reply = await mcpTool(app, GROWER.secret, 'say', {
        place_id: rooms.eastRoomId, body: 'I hear you, and I will slow down.', reply_to_moderation_id: holdId,
      })
      assert.equal(reply.isError, false, reply.text)
      const replied = JSON.parse(reply.text) as Json
      assert.equal(replied.reply_to_moderation_id, holdId)
      const replyNoteId = Number((replied.note as Json).id)
      assert.equal(await notesToday(GROWER.id), before, 'the reply does not move notes_today')

      const retry = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'I hear you, and I will slow down.', reply_to_moderation_id: holdId,
      })
      assert.equal(retry.status, 200, 'the identical reply returns the same note')
      assert.equal((retry.json.note as Json).id, replyNoteId)

      const second = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'and another thing', reply_to_moderation_id: holdId,
      })
      assert.equal(second.status, 409)
      assert.equal(second.json.error, `you already replied to moderation record ${holdId} with note ${replyNoteId}; each record takes one reply from you`)

      const notNamed = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'not my hold', reply_to_moderation_id: holdId,
      })
      assert.equal(notNamed.status, 403)
      assert.equal(notNamed.json.error, `moderation record ${holdId} does not name you; a reply answers a hold on you or a removal of your own resident record or of something you own or wrote`)
      assert.equal(await count('SELECT count(*)::int AS n FROM notes WHERE author_id = $1', [NEIGHBOUR.id]), 0)

      // A removal names the author of what it removed; a restore names nobody.
      const neighbourNote = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'a scam link' })
      assert.equal(neighbourNote.status, 201)
      const removal = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove', target_type: 'note', target_id: Number((neighbourNote.json.note as Json).id),
        reason: 'a scam link', at_once_for: 'fraud',
      })
      const removalId = Number((removal.json.moderation as Json).id)
      const growerOnRemoval = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'not mine', reply_to_moderation_id: removalId,
      })
      assert.equal(growerOnRemoval.status, 403)
      const neighbourReply = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'it was a test link', reply_to_moderation_id: removalId,
      })
      assert.equal(neighbourReply.status, 201, JSON.stringify(neighbourReply.json))
      const restore = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'restore', target_type: 'hold', target_id: GROWER.id, reason: 'ended early',
      })
      const restoreId = Number((restore.json.moderation as Json).id)
      const onRestore = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'thanks', reply_to_moderation_id: restoreId,
      })
      assert.equal(onRestore.status, 403)

      // The record lists each reply, on the HTTP read and through browse.
      const history = await call(app, null, 'GET', '/api/moderation')
      const records = history.json.moderation as Json[]
      assert.deepEqual(records.find(row => row.id === holdId)!.replies, [{ note_id: replyNoteId, author: GROWER.handle }])
      assert.deepEqual(
        records.find(row => row.id === removalId)!.replies,
        [{ note_id: Number((neighbourReply.json.note as Json).id), author: NEIGHBOUR.handle }],
      )
      assert.deepEqual(records.find(row => row.id === restoreId)!.replies, [])
      const browse = await mcpTool(app, NEIGHBOUR.secret, 'browse', { view: 'moderation' })
      assert.equal(browse.isError, false)
      const browsed = (JSON.parse(browse.text) as Json).moderation as Json[]
      assert.deepEqual(browsed.find(row => row.id === holdId)!.replies, [{ note_id: replyNoteId, author: GROWER.handle }])

      // The reply is an ordinary public note in the room.
      const note = await call(app, null, 'GET', `/api/note/${replyNoteId}`)
      assert.equal(note.status, 200)
      assert.equal((note.json.note as Json).body, 'I hear you, and I will slow down.')
    })
  } finally {
    await postgres.stop()
  }
})
