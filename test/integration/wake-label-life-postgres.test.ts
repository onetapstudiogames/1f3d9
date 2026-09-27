// How long a sticker a wake try puts on a resident lasts in a room, set by the room's owner
// (decision #131), against real PostgreSQL: the additive migration, place_edit and the place
// read through src/index.ts, and the sticker a wake try or a reach writes in one engine
// transaction.
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
  new URL('../../db/migrations/20260927_wake_label_life.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })

const MAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })

const VISITOR = Object.freeze({ id: 3, handle: 'far-walker', secret: `1f3d9_sk_${'3'.repeat(48)}` })

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>

async function call(
  app: CityApp,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: secret === null ? {} : bearer(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

async function coin(app: CityApp, secret: string, name: string, recipe: unknown) {
  return call(app, secret, 'POST', '/api/trait', { name, description: `${name} for the wake label life suite`, recipe })
}

/** A kind at revision 1 listing the given traits, owned by `ownerId`, without a fee. */
async function seedKind(ownerId: number, name: string, traitIds: readonly number[]): Promise<number> {
  const db = connectedDatabase()
  const kindId = Number((await db.query<{ id: number }>(
    `INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id`, [name, ownerId],
  )).rows[0]!.id)
  const names = (await db.query<{ name: string }>(
    `SELECT name FROM traits WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`, [traitIds],
  )).rows.map(row => row.name)
  // The kind_revision_trait_links trigger links each named trait in order.
  await db.query(
    `INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, $2::text[])`, [kindId, names],
  )
  return kindId
}

/** One thing of the kind, owned and made by `ownerId`, standing in `placeId`. */
async function seedThing(
  ownerId: number,
  placeId: number,
  kindId: number,
  name: string,
  options: Readonly<{ wakeEnabled?: boolean }> = {},
): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled)
    VALUES ($1, $2, '', $3, $3, $4, 1, 1, $5) RETURNING id
  `, [placeId, name, ownerId, kindId, options.wakeEnabled === true])).rows[0]!.id)
}

async function traitId(name: string): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(
    'SELECT id FROM traits WHERE name = $1', [name],
  )).rows[0]!.id)
}

/**
 * Move a room's recent settles and its things' last tries into the past, so a test can
 * step past the ten-second quiet and "not more often than" without waiting. The
 * append-only guard is paused only for this test-time shift.
 */
async function ageRoom(placeId: number, seconds: number): Promise<void> {
  const db = connectedDatabase()
  await db.query('ALTER TABLE wake_settles DISABLE TRIGGER wake_settles_append_only')
  try {
    await db.query(
      'UPDATE wake_settles SET created_at = created_at - make_interval(secs => $2) WHERE place_id = $1',
      [placeId, seconds],
    )
  } finally {
    await db.query('ALTER TABLE wake_settles ENABLE TRIGGER wake_settles_append_only')
  }
  await db.query(`
    UPDATE thing_wake_state SET last_try_at = last_try_at - make_interval(secs => $2)
    WHERE thing_id IN (SELECT id FROM things WHERE place_id = $1)
  `, [placeId, seconds])
}

/** Every sticker with this label on a resident, oldest first, with how many seconds it was given. */
async function stickers(label: string): Promise<Json[]> {
  return (await connectedDatabase().query<Json>(`
    SELECT target_id, source_thing_id, extract(epoch FROM expires_at - created_at)::int AS seconds
    FROM active_labels WHERE target_type = 'resident' AND label = $1 ORDER BY id
  `, [label])).rows
}

/** A room inside `parentId`, owned by the founder, so a dial on its parent can be shown not to reach it. */
async function seedInnerRoom(parentId: number): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes)
    VALUES ($1, 'place', 'Inner Room', 'a room inside the east room', 1, TRUE)
    RETURNING id
  `, [parentId])).rows[0]!.id)
}

test('a room owner shortens wake stickers against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('wake-label-life')
  try {
    await t.test('the wake label life migration is additive and repeatable', async () => {
      const rooms = await resetCity([FOUNDER])
      const db = connectedDatabase()
      await db.query('ALTER TABLE places DROP COLUMN wake_label_seconds')

      await db.query(migrationDdl)
      await db.query(migrationDdl)

      const places = (await db.query(
        'SELECT id, wake_label_seconds FROM places WHERE id = ANY($1::int[]) ORDER BY id',
        [[rooms.continentId, rooms.eastRoomId, rooms.westRoomId]],
      )).rows
      assert.deepEqual(places.map(place => place.wake_label_seconds), [86_400, 86_400, 86_400],
        'every place that existed before reads 24 hours, so nothing changes the day the column lands')
      const column = (await db.query(`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'places' AND column_name = 'wake_label_seconds'
      `)).rows
      assert.deepEqual(column, [{ data_type: 'integer', is_nullable: 'NO', column_default: '86400' }])
      const checks = (await db.query(`
        SELECT count(*)::int AS checks FROM pg_constraint
        WHERE conrelid = 'places'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%wake_label_seconds%'
      `)).rows
      assert.deepEqual(checks, [{ checks: 1 }], 'running the migration twice adds one range check, not two')
      for (const outside of [9, 86_401]) {
        await assert.rejects(
          db.query('UPDATE places SET wake_label_seconds = $1 WHERE id = $2', [outside, rooms.eastRoomId]),
          /places_wake_label_seconds_check/u,
        )
      }
      await db.query('UPDATE places SET wake_label_seconds = 10 WHERE id = $1', [rooms.eastRoomId])
      await db.query('UPDATE places SET wake_label_seconds = 86400 WHERE id = $1', [rooms.eastRoomId])
    })

    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('place_edit sets wake_label_seconds, refuses a value outside 10 to 86400, and every place read shows it', async () => {
      const rooms = await resetCity([FOUNDER, VISITOR])
      const innerRoomId = await seedInnerRoom(rooms.eastRoomId)
      const edit = (body: Json) => call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, body)
      const placeEdits = async () => Number((await connectedDatabase().query<{ edits: number }>(
        `SELECT count(*)::int AS edits FROM events WHERE kind = 'place_edited'`,
      )).rows[0]!.edits)

      const untouched = (await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).json.place as Json
      assert.equal(untouched.wake_label_seconds, 86_400, 'a room nobody changed reads 24 hours')
      for (const wrong of [9, 86_401, 1_200.5, '1200']) {
        const refused = await edit({ wake_label_seconds: wrong })
        assert.equal(refused.status, 400, JSON.stringify(wrong))
        // The city adds a reminder line when the same resident repeats a refusal, so compare the first line.
        assert.equal(String(refused.json.error).split('\n')[0], 'wake_label_seconds must be a whole number from 10 to 86400')
      }
      assert.equal(await placeEdits(), 0, 'a refused edit changes nothing')

      const saved = await edit({ wake_label_seconds: 1_200 })
      assert.equal(saved.status, 200, JSON.stringify(saved.json))
      assert.equal((saved.json.place as Json).wake_label_seconds, 1_200, 'the place_edit answer shows the new dial')
      assert.equal(await placeEdits(), 1)
      const repeated = await edit({ wake_label_seconds: 1_200 })
      assert.equal(repeated.status, 200, JSON.stringify(repeated.json))
      assert.equal(await placeEdits(), 1, 'the same value again is no change and adds no place_edited notice')

      for (const path of [`/api/place/${rooms.eastRoomId}`, `/api/place/${rooms.eastRoomId}?view=full`]) {
        const read = await call(app, null, 'GET', path)
        assert.equal(read.status, 200)
        assert.equal((read.json.place as Json).wake_label_seconds, 1_200, `${path}: a visitor reads the dial before walking in`)
      }
      for (const other of [innerRoomId, rooms.westRoomId]) {
        const read = await call(app, null, 'GET', `/api/place/${other}`)
        assert.equal(read.status, 200)
        assert.equal((read.json.place as Json).wake_label_seconds, 86_400, `place ${other} keeps its own dial`)
      }
      const notOwner = await call(app, VISITOR.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { wake_label_seconds: 60 })
      assert.equal(notOwner.status, 403)
      assert.equal(notOwner.json.error, 'only the place owner may edit it')
    })

    await t.test("a sticker a waking thing puts on a resident lasts its room's wake_label_seconds, and rooms inside it or beside it keep 24 hours", async () => {
      const rooms = await resetCity([FOUNDER, VISITOR])
      const innerRoomId = await seedInnerRoom(rooms.eastRoomId)
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'wet-feet', {
        wake: { then: [{ effect: 'label', target: 'actor', label: 'wet_feet' }] },
      })).status, 201)
      const streams = await seedKind(FOUNDER.id, 'streams', [await traitId('wet-feet')])
      const eastStream = await seedThing(FOUNDER.id, rooms.eastRoomId, streams, 'east stream', { wakeEnabled: true })
      const innerStream = await seedThing(FOUNDER.id, innerRoomId, streams, 'inner stream', { wakeEnabled: true })
      const westStream = await seedThing(FOUNDER.id, rooms.westRoomId, streams, 'west stream', { wakeEnabled: true })
      const shortened = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { wake_label_seconds: 1_200 })
      assert.equal(shortened.status, 200, JSON.stringify(shortened.json))

      for (const placeId of [rooms.eastRoomId, innerRoomId, rooms.eastRoomId, rooms.continentId, rooms.westRoomId]) {
        const moved = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: placeId })
        assert.equal(moved.status, 200, JSON.stringify(moved.json))
      }
      assert.deepEqual(await stickers('wet_feet'), [
        { target_id: VISITOR.id, source_thing_id: eastStream, seconds: 1_200 },
        { target_id: VISITOR.id, source_thing_id: innerStream, seconds: 86_400 },
        { target_id: VISITOR.id, source_thing_id: westStream, seconds: 86_400 },
      ], 'the shortened room gives 20 minutes; the room inside it and the room beside it keep 24 hours')
    })

    await t.test("a waking thing's reach follows the room's wake_label_seconds, and a reach from a plain use keeps 24 hours", async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await standIn(MAKER.id, rooms.eastRoomId)
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'splash-all', {
        wake: { then: [{ effect: 'reach', over: 'residents', then: [{ effect: 'label', target: 'target', label: 'splashed' }] }] },
      })).status, 201)
      assert.equal((await coin(app, FOUNDER.secret, 'drizzle', {
        use: [{ effect: 'reach', over: 'residents', then: [{ effect: 'label', target: 'target', label: 'damp' }] }],
      })).status, 201)
      const fountain = await seedThing(FOUNDER.id, rooms.eastRoomId,
        await seedKind(FOUNDER.id, 'fountains', [await traitId('splash-all')]), 'a fountain', { wakeEnabled: true })
      const cloud = await seedThing(FOUNDER.id, rooms.eastRoomId,
        await seedKind(FOUNDER.id, 'clouds', [await traitId('drizzle')]), 'a small cloud')
      const shortened = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { wake_label_seconds: 600 })
      assert.equal(shortened.status, 200, JSON.stringify(shortened.json))

      const arrived = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      assert.equal(((arrived.json.action as Json).settle as Json).woke, 1)
      assert.deepEqual(await stickers('splashed'), [FOUNDER, MAKER, VISITOR].map(resident => ({
        target_id: resident.id, source_thing_id: fountain, seconds: 600,
      })), "a waking thing's reach stickers everyone here for the room's 10 minutes")

      const used = await call(app, FOUNDER.secret, 'POST', '/api/action', { action: 'use', thing_id: cloud })
      assert.equal(used.status, 200, JSON.stringify(used.json))
      assert.deepEqual(await stickers('damp'), [FOUNDER, MAKER, VISITOR].map(resident => ({
        target_id: resident.id, source_thing_id: cloud, seconds: 86_400,
      })), 'a reach from a plain use is not a wake, so it keeps 24 hours in the same room')
    })

    await t.test('a sticker keeps the end it was given when the room owner turns the dial down or up', async () => {
      const rooms = await resetCity([FOUNDER, VISITOR])
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'wet-feet', {
        wake: { then: [{ effect: 'label', target: 'actor', label: 'wet_feet' }] },
      })).status, 201)
      await seedThing(FOUNDER.id, rooms.eastRoomId,
        await seedKind(FOUNDER.id, 'streams', [await traitId('wet-feet')]), 'a stream', { wakeEnabled: true })
      const setDial = async (seconds: number) => {
        const edited = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { wake_label_seconds: seconds })
        assert.equal(edited.status, 200, JSON.stringify(edited.json))
      }
      const moveTo = async (placeId: number) => {
        const moved = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: placeId })
        assert.equal(moved.status, 200, JSON.stringify(moved.json))
      }
      const ends = async () => (await connectedDatabase().query<{ id: number; expires_at: Date }>(
        `SELECT id, expires_at FROM active_labels WHERE label = 'wet_feet' ORDER BY id`,
      )).rows.map(row => `${row.id} ${row.expires_at.toISOString()}`)

      await setDial(1_200)
      await moveTo(rooms.eastRoomId)
      const first = await ends()
      assert.equal(first.length, 1)

      await setDial(60)
      assert.deepEqual(await ends(), first, 'turning the dial down leaves the sticker already on as it was')
      await ageRoom(rooms.eastRoomId, 120)
      await moveTo(rooms.continentId)
      await moveTo(rooms.eastRoomId)
      assert.deepEqual((await stickers('wet_feet')).map(sticker => sticker.seconds), [1_200, 60],
        'only a sticker put on after the change gets the shorter life')
      const both = await ends()
      assert.equal(both[0], first[0])

      await setDial(86_400)
      assert.deepEqual(await ends(), both, 'turning the dial up does not lengthen a sticker already on either')
    })

    await t.test("a wake program's delayed step follows the room's wake_label_seconds when it fires", async () => {
      const rooms = await resetCity([FOUNDER, VISITOR])
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'late-drip', {
        wake: { then: [{ effect: 'wait', seconds: 1, then: [{ effect: 'label', target: 'actor', label: 'late_drip' }] }] },
      })).status, 201)
      const pool = await seedThing(FOUNDER.id, rooms.eastRoomId,
        await seedKind(FOUNDER.id, 'pools', [await traitId('late-drip')]), 'a slow pool', { wakeEnabled: true })
      const shortened = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { wake_label_seconds: 600 })
      assert.equal(shortened.status, 200, JSON.stringify(shortened.json))

      const arrived = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      assert.deepEqual((await connectedDatabase().query<Json>(
        `SELECT place_id, payload->'from_wake' AS from_wake FROM pending_effects`,
      )).rows, [{ place_id: rooms.eastRoomId, from_wake: true }], 'the delayed step keeps its room and that it came from a wake')
      assert.deepEqual(await stickers('late_drip'), [], 'nothing is stuck on before the step fires')

      await delay(1_500)
      assert.equal((await call(app, VISITOR.secret, 'GET', '/api/me')).status, 200)
      assert.deepEqual(await stickers('late_drip'), [
        { target_id: VISITOR.id, source_thing_id: pool, seconds: 600 },
      ], "the delayed step's sticker gets the room's 10 minutes, not 24 hours")
    })
  } finally {
    await postgres.stop()
  }
})
