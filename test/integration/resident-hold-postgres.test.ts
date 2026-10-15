// The founder's hold against real PostgreSQL (decisions #149, #150 and #151): the
// real schema, the real routes, one interactive transaction per engine action.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  call,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  seedThing,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const DAY = 24 * 60 * 60 * 1_000

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString()
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await connectedDatabase().query<{ n: number }>(sql, [...values])).rows[0]!.n)
}

async function hold(app: CityApp, body: Json) {
  return call(app, FOUNDER.secret, 'POST', '/api/moderation', {
    action: 'hold', target_type: 'hold', target_id: GROWER.id, rule_word: 'disruptive', ...body,
  })
}

async function endHold(app: CityApp, reason = 'the hold is lifted early') {
  return call(app, FOUNDER.secret, 'POST', '/api/moderation', {
    action: 'restore', target_type: 'hold', target_id: GROWER.id, reason,
  })
}

const FULL_HOLD = Object.freeze({
  reason: 'flooding the square after a warning; full hold for a week',
  ends_at: daysAhead(7),
  hold_notes: 0,
  hold_lines: 0,
  hold_things: 0,
  hold_agreements: 0,
  hold_stops_pings: true,
  hold_stops_building: true,
})

test('a founder hold limits one resident\'s writes and nothing else, against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('resident-hold')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    await t.test('a notes hold of 2 refuses the third note with the hold sentence, and restore ends it', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const set = await hold(app, { reason: 'too many notes after a warning', ends_at: daysAhead(3), hold_notes: 2 })
      assert.equal(set.status, 201, JSON.stringify(set.json))
      const holdId = Number((set.json.moderation as Json).id)
      for (const body of ['first note', 'second note']) {
        const note = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body })
        assert.equal(note.status, 201, JSON.stringify(note.json))
      }
      const third = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'third note' })
      assert.equal(third.status, 429)
      assert.match(String(third.json.error), new RegExp(`^Founder hold #${holdId} limits your notes to 2 a day until `, 'u'))
      assert.match(String(third.json.error), /Going home, moving, editing your own places and things/u)
      assert.doesNotMatch(String(third.json.error), /blocked|mute|safety|security|flag/iu)
      assert.equal(await count('SELECT count(*)::int AS n FROM notes WHERE author_id = $1', [GROWER.id]), 2)

      // Another resident is untouched by this hold.
      const other = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'not held' })
      assert.equal(other.status, 201)

      const ended = await endHold(app)
      assert.equal(ended.status, 201, JSON.stringify(ended.json))
      const fourth = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'after the hold' })
      assert.equal(fourth.status, 201, JSON.stringify(fourth.json))

      const again = await endHold(app, 'nothing to end')
      assert.equal(again.status, 409)
      assert.match(String(again.json.error), /has no active hold to end/u)
    })

    await t.test('a full hold refuses every new write, and the paid doors before anything is spent', async () => {
      const rooms = await resetCity(RESIDENTS)
      await db.query('UPDATE places SET open_to_building = TRUE, open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const set = await hold(app, FULL_HOLD)
      assert.equal(set.status, 201, JSON.stringify(set.json))
      const holdId = Number((set.json.moderation as Json).id)
      const limited = new RegExp(`^Founder hold #${holdId} limits your `, 'u')
      const stopped = new RegExp(`^Founder hold #${holdId} stops new `, 'u')
      const before = {
        attempts: await count('SELECT count(*)::int AS n FROM payment_attempts'),
        credit: await count('SELECT count(*)::int AS n FROM city_credit_entries'),
        places: await count('SELECT count(*)::int AS n FROM places'),
      }

      const note = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'held note' })
      assert.equal(note.status, 429)
      assert.match(String(note.json.error), limited)
      const line = await call(app, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId, body: 'held line', request_id: requestId(1),
      })
      assert.equal(line.status, 429, JSON.stringify(line.json))
      assert.match(String(line.json.error), limited)
      const thing = await call(app, GROWER.secret, 'POST', '/api/thing', { place_id: rooms.eastRoomId, name: 'held thing', body: '' })
      assert.equal(thing.status, 429, JSON.stringify(thing.json))
      assert.match(String(thing.json.error), limited)
      const agreement = await call(app, GROWER.secret, 'POST', '/api/agreement', {
        parties: [GROWER.handle, NEIGHBOUR.handle], body: 'held agreement',
      })
      assert.equal(agreement.status, 429, JSON.stringify(agreement.json))
      assert.match(String(agreement.json.error), limited)
      const ping = await call(app, GROWER.secret, 'POST', '/api/ping', { to_handle: NEIGHBOUR.handle, request_id: requestId(2) })
      assert.equal(ping.status, 403, JSON.stringify(ping.json))
      assert.match(String(ping.json.error), stopped)

      const insideOther = await call(app, GROWER.secret, 'POST', '/api/place', { parent_id: rooms.eastRoomId, name: 'held annex' })
      assert.equal(insideOther.status, 403, JSON.stringify(insideOther.json))
      assert.match(String(insideOther.json.error), stopped)
      const frontier = await call(app, GROWER.secret, 'POST', '/api/place', { parent_id: null, name: 'held frontier' })
      assert.equal(frontier.status, 403, JSON.stringify(frontier.json))
      assert.match(String(frontier.json.error), /Nothing was spent/u)
      const trait = await call(app, GROWER.secret, 'POST', '/api/trait', { name: 'held-trait', description: 'never coined' })
      assert.equal(trait.status, 403, JSON.stringify(trait.json))
      const kind = await call(app, GROWER.secret, 'POST', '/api/kind', { name: 'held-kind', description: 'never invented' })
      assert.equal(kind.status, 403, JSON.stringify(kind.json))
      assert.match(String(kind.json.error), /Nothing was spent/u)
      const revise = await call(app, GROWER.secret, 'POST', '/api/kind/1/revise', { description: 'never revised' })
      assert.equal(revise.status, 403, JSON.stringify(revise.json))

      assert.equal(await count('SELECT count(*)::int AS n FROM payment_attempts'), before.attempts)
      assert.equal(await count('SELECT count(*)::int AS n FROM city_credit_entries'), before.credit)
      assert.equal(await count('SELECT count(*)::int AS n FROM places'), before.places)
      assert.equal(await count('SELECT count(*)::int AS n FROM traits WHERE name = $1', ['held-trait']), 0)
      assert.equal(await count('SELECT count(*)::int AS n FROM room_lines WHERE resident_id = $1', [GROWER.id]), 0)
      assert.equal(await count('SELECT count(*)::int AS n FROM pings WHERE sender_id = $1', [GROWER.id]), 0)

      // The same full hold leaves the resident's own land, its own things and its own
      // movement alone (owner's choice 2).
      const ownPlaceId = Number((await db.query<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'place', 'Grower Yard', 'my own yard', $2) RETURNING id
      `, [rooms.continentId, GROWER.id])).rows[0]!.id)
      const ownThingId = await seedThing(GROWER.id, rooms.eastRoomId, null, 'own lamp')
      const giftThingId = await seedThing(GROWER.id, rooms.eastRoomId, null, 'lamp to give')
      const insideOwn = await call(app, GROWER.secret, 'POST', '/api/place', { parent_id: ownPlaceId, name: 'my shed' })
      assert.equal(insideOwn.status, 201, JSON.stringify(insideOwn.json))
      const placeEdit = await call(app, GROWER.secret, 'PATCH', `/api/place/${ownPlaceId}`, { description: 'still mine to describe' })
      assert.equal(placeEdit.status, 200, JSON.stringify(placeEdit.json))
      const laws = await call(app, GROWER.secret, 'PUT', `/api/place/${ownPlaceId}/laws`, { traits: [] })
      assert.equal(laws.status, 200, JSON.stringify(laws.json))
      const thingEdit = await call(app, GROWER.secret, 'PATCH', `/api/thing/${ownThingId}`, { name: 'own lamp renamed' })
      assert.equal(thingEdit.status, 200, JSON.stringify(thingEdit.json))
      const portrait = await call(app, GROWER.secret, 'PATCH', '/api/me/drawing', {
        drawing: 'REFUSE', drawing_description: 'no picture while held',
      })
      assert.equal(portrait.status, 200, JSON.stringify(portrait.json))
      const give = await call(app, GROWER.secret, 'POST', '/api/action', {
        action: 'give', thing_id: giftThingId, to_handle: NEIGHBOUR.handle,
      })
      assert.equal(give.status, 200, JSON.stringify(give.json))
      const move = await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      assert.equal(move.status, 200, JSON.stringify(move.json))
      await db.query('UPDATE resident_presence SET home_place_id = $2 WHERE resident_id = $1', [GROWER.id, ownPlaceId])
      const home = await call(app, GROWER.secret, 'POST', '/api/go-home')
      assert.equal(home.status, 200, JSON.stringify(home.json))
      const wait = await call(app, GROWER.secret, 'POST', '/api/wait-here', { seconds: 1 })
      assert.equal(wait.status, 200, JSON.stringify(wait.json))
      const reading = await call(app, GROWER.secret, 'GET', `/api/place/${rooms.eastRoomId}`)
      assert.equal(reading.status, 200)

      // me shows the hold and the lower numbers, lines included.
      const me = await call(app, GROWER.secret, 'GET', '/api/me')
      assert.equal(me.status, 200, JSON.stringify(me.json))
      const meHold = me.json.hold as Json
      assert.equal(meHold.id, holdId)
      assert.equal(meHold.reason, FULL_HOLD.reason)
      assert.equal(meHold.rule_word, 'disruptive')
      assert.equal(meHold.stops_pings, true)
      assert.equal(meHold.stops_building, true)
      assert.deepEqual(meHold.daily_limits, { notes: 0, lines: 0, things: 0, agreements: 0 })
      assert.deepEqual(me.json.quotas_left, { things: 0, notes: 0, agreements: 0, lines: 0 })
      assert.doesNotMatch(JSON.stringify(meHold), /blocked|mute|safety|security|flag/iu)
      const neighbourMe = await call(app, NEIGHBOUR.secret, 'GET', '/api/me')
      assert.equal(Object.hasOwn(neighbourMe.json, 'hold'), false)
      assert.deepEqual(neighbourMe.json.quotas_left, { things: 20, notes: 50, agreements: 5, lines: 300 })
    })

    await t.test('a partial hold lowers lines and things to its numbers and quotas_left counts them', async () => {
      const rooms = await resetCity(RESIDENTS)
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const set = await hold(app, { reason: 'slow down', ends_at: daysAhead(1), hold_lines: 1, hold_things: 1 })
      assert.equal(set.status, 201, JSON.stringify(set.json))
      const first = await call(app, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId, body: 'one line', request_id: requestId(10),
      })
      assert.equal(first.status, 201, JSON.stringify(first.json))
      assert.equal(((first.json.line_quota as Json).per_utc_day as Json).limit, 1)
      const second = await call(app, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId, body: 'two lines', request_id: requestId(11),
      })
      assert.equal(second.status, 429)
      assert.match(String(second.json.error), /limits your lines to 1 a day/u)
      const madeOne = await call(app, GROWER.secret, 'POST', '/api/thing', { place_id: rooms.eastRoomId, name: 'only thing', body: '' })
      assert.equal(madeOne.status, 201, JSON.stringify(madeOne.json))
      const madeTwo = await call(app, GROWER.secret, 'POST', '/api/thing', { place_id: rooms.eastRoomId, name: 'second thing', body: '' })
      assert.equal(madeTwo.status, 429)
      assert.match(String(madeTwo.json.error), /limits your new things to 1 a day/u)
      const me = await call(app, GROWER.secret, 'GET', '/api/me')
      assert.deepEqual(me.json.quotas_left, { things: 0, notes: 50, agreements: 5, lines: 0 })
      assert.deepEqual((me.json.hold as Json).daily_limits, { notes: 50, lines: 1, things: 1, agreements: 5 })
      assert.equal((me.json.hold as Json).stops_pings, false)
    })

    await t.test('the moderate request and the database both keep a hold dated, short and on target_type hold', async () => {
      await resetCity(RESIDENTS)
      const tooLong = await hold(app, { reason: 'too long', ends_at: daysAhead(91), hold_notes: 0 })
      assert.equal(tooLong.status, 400)
      assert.match(String(tooLong.json.error), /at most 90 days away/u)
      const onResident = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'hold', target_type: 'resident', target_id: GROWER.id, reason: 'wrong target',
        rule_word: 'harmful', ends_at: daysAhead(2), hold_notes: 0,
      })
      assert.equal(onResident.status, 400)
      assert.match(String(onResident.json.error), /a hold uses target_type hold/u)
      const empty = await hold(app, { reason: 'limits nothing', ends_at: daysAhead(2), hold_notes: 50 })
      assert.equal(empty.status, 400)
      assert.match(String(empty.json.error), /must lower at least one daily number/u)
      const noWord = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'hold', target_type: 'hold', target_id: GROWER.id, reason: 'no word', ends_at: daysAhead(2), hold_notes: 0,
      })
      assert.equal(noWord.status, 400)
      const notFounder = await call(app, NEIGHBOUR.secret, 'POST', '/api/moderation', {
        action: 'hold', target_type: 'hold', target_id: GROWER.id, reason: 'not mine', rule_word: 'harmful',
        ends_at: daysAhead(2), hold_notes: 0,
      })
      assert.equal(notFounder.status, 403)

      const insert = (sql: string) => db.query(sql).then(() => 'accepted', (error: { constraint?: string }) => error.constraint ?? 'refused')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, rule_word, ends_at,
          hold_notes, hold_stops_pings, hold_stops_building)
        VALUES ('hold', ${GROWER.id}, 'hold', 1, 'r', 'harmful', now() + interval '90 days 1 second', 0, false, false)
      `), 'moderation_actions_hold_fields')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, rule_word, ends_at,
          hold_notes, hold_stops_pings, hold_stops_building)
        VALUES ('resident', ${GROWER.id}, 'hold', 1, 'r', 'harmful', now() + interval '2 days', 0, false, false)
      `), 'moderation_actions_target_type_allowed')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('hold', ${GROWER.id}, 'remove', 1, 'r')
      `), 'moderation_actions_target_type_allowed')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, ends_at)
        VALUES ('resident', ${GROWER.id}, 'remove', 1, 'r', now() + interval '2 days')
      `), 'moderation_actions_hold_fields')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, rule_word)
        VALUES ('note', 1, 'remove', 1, 'r', 'rude')
      `), 'moderation_actions_rule_word_allowed')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, smaller_step_record_id)
        VALUES ('note', 1, 'remove', 1, 'r', 999999)
      `), 'moderation_actions_smaller_step_record_fk')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('hold', ${GROWER.id}, 'restore', 1, 'r')
      `), 'accepted')
      assert.equal(await insert(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, rule_word, ends_at,
          hold_notes, hold_stops_pings, hold_stops_building)
        VALUES ('hold', ${GROWER.id}, 'hold', 1, 'r', 'harmful', now() + interval '90 days', 0, false, false)
      `), 'accepted')
    })

    await t.test('a removed resident stays removed after a hold and after the hold\'s restore', async () => {
      await resetCity(RESIDENTS)
      const visible = await call(app, null, 'GET', `/api/drawing/resident/${GROWER.id}`)
      assert.equal(visible.status, 200, JSON.stringify(visible.json))
      const removed = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove', target_type: 'resident', target_id: GROWER.id, reason: 'scam drawing', at_once_for: 'fraud',
      })
      assert.equal(removed.status, 201, JSON.stringify(removed.json))
      const removalId = Number((removed.json.moderation as Json).id)
      const set = await hold(app, {
        reason: 'held while removed', ends_at: daysAhead(5), hold_notes: 0, smaller_step_record_id: removalId,
      })
      assert.equal(set.status, 201, JSON.stringify(set.json))
      assert.equal((set.json.moderation as Json).smaller_step_record_id, String(removalId))
      const ended = await endHold(app)
      assert.equal(ended.status, 201)

      const latest = await db.query<{ action: string }>(`
        SELECT action FROM moderation_actions
        WHERE target_type = 'resident' AND target_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 1
      `, [GROWER.id])
      assert.equal(latest.rows[0]!.action, 'remove')
      const portrait = await call(app, null, 'GET', `/api/drawing/resident/${GROWER.id}`)
      assert.equal(portrait.status, 404, JSON.stringify(portrait.json))
    })

    await t.test('the public moderation log, the events feed and the window show the hold with its fields', async () => {
      await resetCity(RESIDENTS)
      const set = await hold(app, {
        reason: 'public hold reason', ends_at: daysAhead(10), hold_notes: 1, hold_stops_pings: true,
        smaller_step: 'asked twice in the square, then warned',
      })
      assert.equal(set.status, 201)
      const holdId = Number((set.json.moderation as Json).id)
      const log = await call(app, null, 'GET', '/api/moderation?limit=5')
      assert.equal(log.status, 200)
      const row = (log.json.moderation as Json[]).find(entry => entry.id === holdId)!
      assert.equal(row.action, 'hold')
      assert.equal(row.target_type, 'hold')
      assert.equal(row.target_id, GROWER.id)
      assert.equal(row.rule_word, 'disruptive')
      assert.equal(row.hold_notes, 1)
      assert.equal(row.hold_stops_pings, true)
      assert.equal(row.hold_stops_building, false)
      assert.equal(row.smaller_step, 'asked twice in the square, then warned')
      assert.equal(typeof row.ends_at, 'string')
      const events = await call(app, null, 'GET', '/api/events?kind=moderation&limit=5')
      const event = (events.json.events as Json[]).find(entry => (entry.detail as Json).moderation_id === holdId)!
      assert.deepEqual(Object.keys(event.detail as Json).sort(), ['action', 'moderation_id', 'reason', 'target_id', 'target_type'])
      assert.equal((event.detail as Json).action, 'hold')
      const window = await app.request('http://city.test/api/window')
      const windowJson = await window.json() as Json
      const windowEvent = (windowJson.events as Json[]).find(entry => entry.kind === 'moderation')
      assert.equal((windowEvent?.detail as Json | undefined)?.action, 'hold', JSON.stringify(windowEvent))
    })
  } finally {
    await postgres.stop()
  }
})
