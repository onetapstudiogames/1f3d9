// A label's life chosen by its maker (decision #168) and the founder's ending of a
// resident's label at its own request (decision #169), against real PostgreSQL: the
// additive migration, coining through src/index.ts, an old stored recipe still running,
// a chosen life ending, the wake and reach ceilings, the before-use sentence, me's end
// times, and an ending that every label reader honours with a public record that never
// names the label.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20261031_label_endings.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'mirror-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const VISITOR = Object.freeze({ id: 3, handle: 'night-visitor', secret: `1f3d9_sk_${'3'.repeat(48)}` })

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>

async function call(
  app: CityApp,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; json: Json; text: string }>> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: secret === null ? {} : bearer(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {}, text })
}

async function coin(app: CityApp, secret: string, name: string, recipe: unknown) {
  return call(app, secret, 'POST', '/api/trait', { name, description: `${name} for the label life suite`, recipe })
}

async function traitId(name: string): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(
    'SELECT id FROM traits WHERE name = $1', [name],
  )).rows[0]!.id)
}

/** A trait stored as it was coined before decision #168, without passing today's coining rule. */
async function storeOldTrait(name: string, recipe: unknown): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(
    `INSERT INTO traits (name, description, recipe, coiner_id) VALUES ($1, 'coined before the label life rule', $2::jsonb, $3) RETURNING id`,
    [name, JSON.stringify(recipe), MAKER.id],
  )).rows[0]!.id)
}

async function seedKind(ownerId: number, name: string, traitIds: readonly number[]): Promise<number> {
  const db = connectedDatabase()
  const kindId = Number((await db.query<{ id: number }>(
    `INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id`, [name, ownerId],
  )).rows[0]!.id)
  const names = (await db.query<{ name: string }>(
    `SELECT name FROM traits WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`, [traitIds],
  )).rows.map(row => row.name)
  await db.query(
    `INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, $2::text[])`, [kindId, names],
  )
  return kindId
}

async function seedThing(
  ownerId: number,
  placeId: number,
  kindId: number,
  name: string,
  options: Readonly<{ wakeEnabled?: boolean; openToUse?: boolean }> = {},
): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled, open_to_use)
    VALUES ($1, $2, '', $3, $3, $4, 1, 1, $5, $6) RETURNING id
  `, [placeId, name, ownerId, kindId, options.wakeEnabled === true, options.openToUse === true])).rows[0]!.id)
}

/** Every row of this label on a resident, oldest first, with the life it was given (null when it never ends). */
async function residentRows(label: string): Promise<Json[]> {
  return (await connectedDatabase().query<Json>(`
    SELECT target_id, source_thing_id,
      CASE WHEN expires_at IS NULL THEN NULL ELSE round(extract(epoch FROM expires_at - created_at))::int END AS seconds
    FROM active_labels WHERE target_type = 'resident' AND label = $1 ORDER BY id
  `, [label])).rows
}

async function use(app: CityApp, secret: string, thingId: number): Promise<void> {
  const used = await call(app, secret, 'POST', '/api/action', { action: 'use', thing_id: thingId })
  assert.equal(used.status, 200, used.text)
  assert.equal((used.json.action as Json).status, 'applied', used.text)
}

async function me(app: CityApp, secret: string): Promise<Json> {
  const read = await call(app, secret, 'GET', '/api/me')
  assert.equal(read.status, 200, read.text)
  return read.json
}

test('label life and the founder ending against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('label-life')
  try {
    await t.test('the label endings migration is additive, repeatable, append-only and checks its request', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await db.query('DROP TABLE label_endings')
      await db.query(migrationDdl)
      await db.query(migrationDdl)
      const label = Number((await db.query<{ id: number }>(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('resident', $1, 'worn', $1) RETURNING id
      `, [VISITOR.id])).rows[0]!.id)
      const otherLabel = Number((await db.query<{ id: number }>(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('resident', $1, 'worn', $1) RETURNING id
      `, [MAKER.id])).rows[0]!.id)
      const note = Number((await db.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, 'please end it') RETURNING id
      `, [rooms.eastRoomId, VISITOR.id])).rows[0]!.id)
      const makerNote = Number((await db.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, 'not the wearer') RETURNING id
      `, [rooms.eastRoomId, MAKER.id])).rows[0]!.id)
      const insert = (labelId: number, noteId: number, founderId = 1) => db.query(`
        INSERT INTO label_endings (label_id, resident_id, request_note_id, founder_id) VALUES ($1, $2, $3, $4)
      `, [labelId, VISITOR.id, noteId, founderId])
      await assert.rejects(insert(otherLabel, note), /must name a label on that resident and that resident's own note/u, 'a label on someone else')
      await assert.rejects(insert(label, makerNote), /must name a label on that resident and that resident's own note/u, 'a note the wearer did not write')
      await assert.rejects(insert(label, note, 2), /label_endings_founder_only/u)
      await insert(label, note)
      await assert.rejects(db.query('UPDATE label_endings SET founder_id = 1'), /append-only/u)
      await assert.rejects(db.query('DELETE FROM label_endings'), /append-only/u)
      await assert.rejects(insert(label, note), /label_endings_pkey/u, 'one ending per label row')
    })

    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('a new trait must choose the life of a label on actor or target; an old stored recipe still runs', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      await standIn(VISITOR.id, rooms.eastRoomId)
      const refused = await coin(app, MAKER.secret, 'mirror-forever', {
        use: [{ effect: 'label', target: 'actor', label: 'mirror-title' }],
      })
      assert.equal(refused.status, 400)
      assert.equal(String(refused.json.error).split('\n')[0],
        'recipe refused at use, step 1: a label on actor or target must say how long it lasts: add seconds, a whole number from 1 to 86400, or permanent: true; call physics for every brick\'s fields, defaults, and limits')
      assert.equal(Number((await connectedDatabase().query('SELECT count(*)::int AS n FROM traits')).rows[0]!.n), 0,
        'a refused trait stores nothing')

      const coined = await coin(app, MAKER.secret, 'mirror-day', {
        use: [
          { effect: 'label', target: 'actor', label: 'mirror-used', seconds: 60 },
          { effect: 'label', target: 'actor', label: 'mirror-title', permanent: true },
          { effect: 'label', target: 'source', label: 'mirror-warm', seconds: 1 },
        ],
      })
      assert.equal(coined.status, 201, coined.text)
      const old = await storeOldTrait('old-mirror', { use: [{ effect: 'label', target: 'actor', label: 'old-title' }] })
      const mirror = await seedThing(MAKER.id, rooms.eastRoomId,
        await seedKind(MAKER.id, 'mirrors', [await traitId('mirror-day'), old]), 'a halloween mirror', { openToUse: true })

      const before = await call(app, null, 'GET', `/api/thing/${mirror}`)
      assert.equal(before.status, 200, before.text)
      assert.equal((before.json.thing as Json).on_use,
        'Using it puts a label on you that lasts 1 minute and puts 2 permanent labels on you.',
        'the thing says what using it does to you before you use it, without naming the labels')
      assert.equal(before.text.includes('mirror-title'), false)

      await use(app, VISITOR.secret, mirror)
      assert.deepEqual(await residentRows('mirror-used'), [{ target_id: VISITOR.id, source_thing_id: mirror, seconds: 60 }])
      assert.deepEqual(await residentRows('mirror-title'), [{ target_id: VISITOR.id, source_thing_id: mirror, seconds: null }])
      assert.deepEqual(await residentRows('old-title'), [{ target_id: VISITOR.id, source_thing_id: mirror, seconds: null }],
        'a trait stored before the rule still runs, and its unstated label stays permanent')

      const mine = await me(app, VISITOR.secret)
      assert.deepEqual(mine.labels, ['mirror-title', 'mirror-used', 'old-title'], 'me.labels keeps its old shape')
      const ends = mine.label_ends as Array<{ label: string; expires_at: string | null }>
      assert.deepEqual(ends.map(entry => entry.label), ['mirror-title', 'mirror-used', 'old-title'])
      assert.equal(ends[0]!.expires_at, null)
      assert.equal(ends[2]!.expires_at, null)
      const usedEnds = Date.parse(ends[1]!.expires_at!) - Date.now()
      assert.ok(usedEnds > 50_000 && usedEnds < 65_000, `mirror-used ends in about a minute (the container clock may differ a little), not ${usedEnds} ms`)

      const warm = ((await call(app, null, 'GET', `/api/thing/${mirror}`)).json.thing as Json).labels as Json[]
      assert.deepEqual(warm.map(entry => entry.label), ['mirror-warm'])
      assert.equal(typeof warm[0]!.expires_at, 'string', 'a chosen life on a thing shows its end')
      await delay(1_200)
      const cooled = (await call(app, null, 'GET', `/api/thing/${mirror}`)).json.thing as Json
      assert.deepEqual(cooled.labels, [], 'a chosen life on a thing ends that label then')
    })

    await t.test('inside a reach or a wake try a sticker on a resident still ends within a day, and a shorter chosen life wins', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      await standIn(MAKER.id, rooms.eastRoomId)
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'drizzle', {
        use: [{ effect: 'reach', over: 'residents', then: [
          { effect: 'label', target: 'target', label: 'damp', permanent: true },
          { effect: 'label', target: 'target', label: 'misted', seconds: 600 },
        ] }],
      })).status, 201)
      assert.equal((await coin(app, FOUNDER.secret, 'cold-step', {
        wake: { then: [
          { effect: 'label', target: 'actor', label: 'chilled', seconds: 30 },
          { effect: 'label', target: 'actor', label: 'frosted', permanent: true },
        ] },
      })).status, 201)
      const cloud = await seedThing(FOUNDER.id, rooms.eastRoomId,
        await seedKind(FOUNDER.id, 'clouds', [await traitId('drizzle')]), 'a small cloud')
      const step = await seedThing(FOUNDER.id, rooms.eastRoomId,
        await seedKind(FOUNDER.id, 'steps', [await traitId('cold-step')]), 'a cold step', { wakeEnabled: true })
      assert.equal((await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { wake_label_seconds: 1_200 })).status, 200)
      assert.equal(((await call(app, null, 'GET', `/api/thing/${cloud}`)).json.thing as Json).on_use,
        'Using it may put a label on you that lasts 1 day and may put a label on you that lasts 10 minutes.')

      await standIn(FOUNDER.id, rooms.eastRoomId)
      await use(app, FOUNDER.secret, cloud)
      assert.deepEqual((await residentRows('damp')).map(row => row.seconds), [86_400, 86_400],
        'permanent inside a reach is capped at a day')
      assert.deepEqual((await residentRows('misted')).map(row => row.seconds), [600, 600], 'a shorter chosen life wins')

      const arrived = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(arrived.status, 200, arrived.text)
      assert.deepEqual(await residentRows('chilled'), [{ target_id: VISITOR.id, source_thing_id: step, seconds: 30 }],
        'a chosen life shorter than the room dial wins')
      assert.deepEqual(await residentRows('frosted'), [{ target_id: VISITOR.id, source_thing_id: step, seconds: 1_200 }],
        "permanent in a wake ends with the room's wake_label_seconds")
    })

    await t.test('the founder ends a label at the wearer\'s request; every reader honours it and the public record never names it', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await standIn(VISITOR.id, rooms.eastRoomId)
      await standIn(MAKER.id, rooms.eastRoomId)
      const titleTrait = await storeOldTrait('old-mirror', { use: [{ effect: 'label', target: 'actor', label: 'mirror-title' }] })
      const mirror = await seedThing(MAKER.id, rooms.eastRoomId, await seedKind(MAKER.id, 'mirrors', [titleTrait]), 'a mirror', { openToUse: true })
      const lamp = await seedThing(MAKER.id, rooms.eastRoomId, await seedKind(MAKER.id, 'lamps', [titleTrait]), 'a lamp', { openToUse: true })
      assert.equal((await coin(app, FOUNDER.secret, 'title-check', {
        talk: [{
          effect: 'check_label', target: 'actor', label: 'mirror-title',
          then: [{ effect: 'label', target: 'place', label: 'title-seen', seconds: 600 }],
          else: [{ effect: 'label', target: 'place', label: 'title-absent', seconds: 600 }],
        }],
      })).status, 201)
      assert.equal((await call(app, FOUNDER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['title-check'] })).status, 200)
      await use(app, VISITOR.secret, mirror)
      await use(app, VISITOR.secret, lamp)
      await use(app, MAKER.secret, mirror)

      const placeLabels = async () => ((await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).json.place as Json).labels
      const talk = async (body: string) => {
        const said = await call(app, VISITOR.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body })
        assert.equal(said.status, 201, said.text)
        return Number((said.json.note as Json).id)
      }
      const request = await talk('Please end my mirror label.')
      assert.deepEqual(await placeLabels(), ['title-seen'], 'before the ending, check_label sees the label')
      const makerNote = Number(((await call(app, MAKER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'mine' })).json.note as Json).id)

      const end = (secret: string, body: Json) => call(app, secret, 'POST', '/api/founder/labels/end', body)
      const body = { resident_handle: VISITOR.handle, label: 'mirror-title', request_note_id: request }
      assert.equal((await end(VISITOR.secret, body)).status, 403)
      assert.equal((await end(MAKER.secret, body)).json.error, "only founder resident #1 may end a resident's label")
      const notTheirs = await end(FOUNDER.secret, { ...body, request_note_id: makerNote })
      assert.equal(notTheirs.status, 404)
      assert.equal(notTheirs.json.error, `request_note_id ${makerNote} is not a note written by ${VISITOR.handle}; send the id of that resident's own note asking for the label to end`)
      const wrongSource = await end(FOUNDER.secret, { ...body, source_thing_id: 999 })
      assert.equal(wrongSource.status, 404)
      assert.equal(wrongSource.json.error, `${VISITOR.handle} has no current label mirror-title from thing 999; nothing was ended`)
      const rowsBefore = Number((await db.query('SELECT count(*)::int AS n FROM active_labels')).rows[0]!.n)
      const eventsBefore = Number((await db.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'moderation'`)).rows[0]!.n)
      assert.equal(eventsBefore, 0, 'a refused ending writes no record')

      const fromMirror = await end(FOUNDER.secret, { ...body, source_thing_id: mirror })
      assert.equal(fromMirror.status, 200, fromMirror.text)
      assert.equal(fromMirror.json.ended, 1)
      assert.deepEqual((await me(app, VISITOR.secret)).labels, ['mirror-title'], 'the lamp still wears it on the visitor')
      const ended = await end(FOUNDER.secret, body)
      assert.equal(ended.status, 200, ended.text)
      assert.equal(ended.json.ended, 1)
      assert.deepEqual(ended.json.record && Object.keys(ended.json.record as Json).sort(), ['at', 'event_id'])
      const again = await end(FOUNDER.secret, body)
      assert.equal(again.status, 404)
      assert.equal(again.json.error, `${VISITOR.handle} has no current label mirror-title; nothing was ended`)

      const mine = await me(app, VISITOR.secret)
      assert.deepEqual(mine.labels, [])
      assert.deepEqual(mine.label_ends, [])
      assert.deepEqual((await me(app, MAKER.secret)).labels, ['mirror-title'], "another resident's label is untouched")
      await talk('Checking again after the ending.')
      assert.deepEqual(await placeLabels(), ['title-absent', 'title-seen'], 'after the ending, check_label no longer sees it')
      assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM active_labels')).rows[0]!.n) - rowsBefore, 1,
        'the ended rows stay; only the new place label row was added')

      const records = (await db.query<Json>(`SELECT actor, detail FROM events WHERE kind = 'moderation' ORDER BY id`)).rows
      assert.deepEqual(records, [
        { actor: FOUNDER.handle, detail: { action: 'end_labels', resident_id: VISITOR.id, note_id: request } },
        { actor: FOUNDER.handle, detail: { action: 'end_labels', resident_id: VISITOR.id, note_id: request } },
      ])
      // The room's law names the label in its public check_label recipe, so the place read
      // shows the law; it never lists the resident's label among the place's labels.
      assert.deepEqual(await placeLabels(), ['title-absent', 'title-seen'])
      for (const path of [
        '/api/events?kind=moderation', '/api/changes?since=0', `/api/thing/${mirror}`, `/api/thing/${lamp}`,
      ]) {
        const read = await call(app, null, 'GET', path)
        assert.equal(read.status, 200, `${path}: ${read.text}`)
        assert.equal(read.text.includes('mirror-title'), false, `${path} never names a resident's label`)
      }
      const published = (await call(app, null, 'GET', '/api/events?kind=moderation')).json.events as Json[]
      assert.equal(published.length, 2)
      assert.deepEqual(published.map(event => (event.detail as Json).action), ['end_labels', 'end_labels'])
      assert.deepEqual(published.map(event => (event.detail as Json).note_id), [request, request])
    })
  } finally {
    await postgres.stop()
  }
})
