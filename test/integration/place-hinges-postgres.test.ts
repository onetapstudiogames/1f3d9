// Place hinges persist as an owner-controlled one-step link, against real PostgreSQL.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260928_place_hinges.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const NEIGHBOR = Object.freeze({ id: 2, handle: 'far-neighbor', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const WALKER = Object.freeze({ id: 3, handle: 'hinge-walker', secret: `1f3d9_sk_${'3'.repeat(48)}` })

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>

function closedHingeRefusal(destinationId: number, currentPlaceId: number): string {
  return `place_id ${destinationId} exists, but entry is closed from your current place_id ${currentPlaceId}; entry opens when you stand in its parent, one of its direct children, or a place with an open hinge to it, so use the public map outline to move one edge at a time`
}

async function openHinge(eastRoomId: number, westRoomId: number): Promise<void> {
  const db = connectedDatabase()
  await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [westRoomId, eastRoomId])
  await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [eastRoomId, westRoomId])
}

function walkTo(
  app: CityApp,
  secret: string,
  destinationId: number,
  carryThingId?: number,
): Promise<Readonly<{ status: number; json: Json }>> {
  return call(app, secret, 'POST', '/api/action', {
    action: 'move',
    to_place_id: destinationId,
    ...(carryThingId === undefined ? {} : { carry_thing_id: carryThingId }),
  })
}

async function waitForDatabaseLock(db: Pool, sqlFragment: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const waiting = await db.query<{ query: string }>(`
      SELECT query FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
    `)
    if (waiting.rows.some(row => row.query.toLowerCase().includes(sqlFragment.toLowerCase()))) return
    await delay(10)
  }
  assert.fail(`PostgreSQL did not report a lock wait for ${sqlFragment}`)
}

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

test('places keep owner-controlled hinges against real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('place-hinges')
  try {
    await t.test('the place hinges migration is additive and repeatable', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await db.query('DROP TRIGGER IF EXISTS places_close_hinge_on_owner_change ON places')
      await db.query('DROP FUNCTION IF EXISTS close_place_hinge_on_owner_change()')
      await db.query('ALTER TABLE places DROP CONSTRAINT IF EXISTS places_hinge_to_shape')
      await db.query('ALTER TABLE places DROP COLUMN IF EXISTS hinge_to')

      await db.query(migrationDdl)
      await db.query(migrationDdl)

      const columns = (await db.query(`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'places' AND column_name = 'hinge_to'
      `)).rows
      assert.deepEqual(columns, [{ data_type: 'integer', is_nullable: 'YES', column_default: null }])

      const checks = (await db.query(`
        SELECT count(*)::int AS checks FROM pg_constraint
        WHERE conrelid = 'places'::regclass AND conname = 'places_hinge_to_shape'
      `)).rows
      assert.deepEqual(checks, [{ checks: 1 }])

      const triggers = (await db.query(`
        SELECT count(*)::int AS triggers FROM pg_trigger
        WHERE tgrelid = 'places'::regclass AND tgname = 'places_close_hinge_on_owner_change'
          AND NOT tgisinternal
      `)).rows
      assert.deepEqual(triggers, [{ triggers: 1 }])

      const placesWithHinges = (await db.query(
        'SELECT count(*)::int AS places FROM places WHERE hinge_to IS NOT NULL',
      )).rows
      assert.deepEqual(placesWithHinges, [{ places: 0 }])
      await assert.rejects(
        db.query('UPDATE places SET hinge_to = id WHERE id = $1', [rooms.eastRoomId]),
        /places_hinge_to_shape/u,
      )
    })

    await t.test("a change of owner or a retirement clears only that place's own hinge_to", async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.westRoomId, rooms.eastRoomId])
      await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.eastRoomId, rooms.westRoomId])

      await db.query('UPDATE places SET owner_id = 2 WHERE id = $1', [rooms.eastRoomId])
      let places = (await db.query<{ id: number; hinge_to: number | null }>(
        'SELECT id, hinge_to FROM places WHERE id = ANY($1::int[]) ORDER BY id',
        [[rooms.eastRoomId, rooms.westRoomId]],
      )).rows
      assert.deepEqual(places, [
        { id: rooms.eastRoomId, hinge_to: null },
        { id: rooms.westRoomId, hinge_to: rooms.eastRoomId },
      ])

      await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.westRoomId, rooms.eastRoomId])
      await db.query('UPDATE places SET owner_id = 2 WHERE id = $1', [rooms.eastRoomId])
      places = (await db.query<{ id: number; hinge_to: number | null }>(
        'SELECT id, hinge_to FROM places WHERE id = ANY($1::int[]) ORDER BY id',
        [[rooms.eastRoomId]],
      )).rows
      assert.deepEqual(places, [{ id: rooms.eastRoomId, hinge_to: rooms.westRoomId }])

      await db.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [rooms.westRoomId])
      places = (await db.query<{ id: number; hinge_to: number | null }>(
        'SELECT id, hinge_to FROM places WHERE id = ANY($1::int[]) ORDER BY id',
        [[rooms.eastRoomId, rooms.westRoomId]],
      )).rows
      assert.deepEqual(places, [
        { id: rooms.eastRoomId, hinge_to: rooms.westRoomId },
        { id: rooms.westRoomId, hinge_to: null },
      ])

      await db.query('UPDATE places SET retired_at = NULL WHERE id = $1', [rooms.westRoomId])
      await db.query("UPDATE places SET name = 'East Hall', retired_at = retired_at WHERE id = $1", [rooms.eastRoomId])
      places = (await db.query<{ id: number; hinge_to: number | null }>(
        'SELECT id, hinge_to FROM places WHERE id = ANY($1::int[]) ORDER BY id',
        [[rooms.eastRoomId, rooms.westRoomId]],
      )).rows
      assert.deepEqual(places, [
        { id: rooms.eastRoomId, hinge_to: rooms.westRoomId },
        { id: rooms.westRoomId, hinge_to: null },
      ])
    })

    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('place_edit opens and clears a hinge, and each side shows at once whether it opened', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const edit = (placeId: number, body: Json) => call(app, FOUNDER.secret, 'PATCH', `/api/place/${placeId}`, body)
      const placeEdits = async () => Number((await connectedDatabase().query<{ edits: number }>(
        `SELECT count(*)::int AS edits FROM events WHERE kind = 'place_edited'`,
      )).rows[0]!.edits)

      const oneSide = await edit(rooms.eastRoomId, { hinge_to: rooms.westRoomId })
      assert.equal(oneSide.status, 200, JSON.stringify(oneSide.json))
      assert.equal((oneSide.json.place as Json).hinge_to, rooms.westRoomId)
      assert.equal((oneSide.json.place as Json).hinge, null)

      const opened = await edit(rooms.westRoomId, { hinge_to: rooms.eastRoomId })
      assert.equal(opened.status, 200, JSON.stringify(opened.json))
      assert.deepEqual((opened.json.place as Json).hinge, {
        place_id: rooms.eastRoomId,
        name: 'East Room',
        parent_id: rooms.continentId,
        rough_room: false,
      })
      let details = (await connectedDatabase().query<{ detail: Json }>(
        `SELECT detail FROM events WHERE kind = 'place_edited' ORDER BY id`,
      )).rows.map(row => row.detail)
      assert.deepEqual(details.at(-1), { place_id: rooms.westRoomId, hinge_to: rooms.eastRoomId })

      const described = await edit(rooms.eastRoomId, { description: 'a revised east room' })
      assert.equal(described.status, 200, JSON.stringify(described.json))
      details = (await connectedDatabase().query<{ detail: Json }>(
        `SELECT detail FROM events WHERE kind = 'place_edited' ORDER BY id`,
      )).rows.map(row => row.detail)
      assert.deepEqual(details.at(-1), { place_id: rooms.eastRoomId })
      const afterDescription = await placeEdits()
      const unchanged = await edit(rooms.westRoomId, { hinge_to: rooms.eastRoomId })
      assert.equal(unchanged.status, 200, JSON.stringify(unchanged.json))
      assert.equal(await placeEdits(), afterDescription)

      const cleared = await edit(rooms.eastRoomId, { hinge_to: null })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      assert.equal((cleared.json.place as Json).hinge_to, null)
      assert.equal((cleared.json.place as Json).hinge, null)
      details = (await connectedDatabase().query<{ detail: Json }>(
        `SELECT detail FROM events WHERE kind = 'place_edited' ORDER BY id`,
      )).rows.map(row => row.detail)
      assert.deepEqual(details.at(-1), { place_id: rooms.eastRoomId, hinge_to: null })

      const history = await call(app, null, 'GET', `/api/events?place_id=${rooms.westRoomId}&limit=100`)
      assert.equal(history.status, 200, JSON.stringify(history.json))
      const events = history.json.events as Json[]
      assert.ok(events.some(event => {
        const detail = event.detail as Json
        return detail.place_id === rooms.eastRoomId && detail.hinge_to === rooms.westRoomId
      }))
    })

    await t.test('place_edit refuses each hinge_to it cannot open', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      const worldId = Number((await db.query<{ id: number }>(
        `SELECT id FROM places WHERE place_kind = 'world'`,
      )).rows[0]!.id)
      const edit = (secret: string, body: Json) => call(app, secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, body)
      const wrongShape = await edit(FOUNDER.secret, { hinge_to: 0 })
      assert.equal(wrongShape.status, 400, JSON.stringify(wrongShape.json))
      assert.equal(wrongShape.json.error, 'hinge_to must be one positive place id, or null to close your side of the hinge')
      const samePlace = await edit(FOUNDER.secret, { hinge_to: rooms.eastRoomId })
      assert.equal(samePlace.status, 400, JSON.stringify(samePlace.json))
      assert.equal(samePlace.json.error, 'hinge_to cannot name this same place; name another place, or send null to close your side')
      const gazette = await edit(FOUNDER.secret, { hinge_to: 454 })
      assert.equal(gazette.status, 409, JSON.stringify(gazette.json))
      assert.equal(gazette.json.error, 'hinge_to cannot name protected Gazette room #454; name another place')
      const missing = await edit(FOUNDER.secret, { hinge_to: 999_999 })
      assert.equal(missing.status, 404, JSON.stringify(missing.json))
      assert.equal(missing.json.error, 'hinge_to place_id 999999 was not found; name a current place id from the public map')
      const world = await edit(FOUNDER.secret, { hinge_to: worldId })
      assert.equal(world.status, 409, JSON.stringify(world.json))
      assert.equal(world.json.error, 'hinge_to cannot name the world: it has no owner who could agree; name an owned place')
      const continent = await edit(FOUNDER.secret, { hinge_to: rooms.continentId })
      assert.equal(continent.status, 409, JSON.stringify(continent.json))
      assert.equal(continent.json.error, `hinge_to place_id ${rooms.continentId} is inside this place or contains it, and walking already joins them; a hinge joins two places where neither holds the other`)

      await db.query('UPDATE places SET parent_id = $1 WHERE id = $2', [rooms.eastRoomId, rooms.westRoomId])
      const child = await edit(FOUNDER.secret, { hinge_to: rooms.westRoomId })
      assert.equal(child.status, 409, JSON.stringify(child.json))
      assert.equal(child.json.error, `hinge_to place_id ${rooms.westRoomId} is inside this place or contains it, and walking already joins them; a hinge joins two places where neither holds the other`)

      await db.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [rooms.westRoomId])
      const retired = await edit(FOUNDER.secret, { hinge_to: rooms.westRoomId })
      assert.equal(retired.status, 409, JSON.stringify(retired.json))
      assert.equal(retired.json.error, `hinge_to place_id ${rooms.westRoomId} is retired; its owner must restore it first, or name another place`)

      const notOwner = await edit(NEIGHBOR.secret, { hinge_to: rooms.westRoomId })
      assert.equal(notOwner.status, 403, JSON.stringify(notOwner.json))
      assert.equal(notOwner.json.error, 'only the place owner may edit it')

      await db.query(`
        INSERT INTO transfer_offers (
          channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet, status
        ) VALUES ('direct', 'place', $1, 1, 2, 1.000000, $2, 'open')
      `, [rooms.eastRoomId, `0x${'a'.repeat(40)}`])
      const offered = await edit(FOUNDER.secret, { hinge_to: null })
      assert.equal(offered.status, 409, JSON.stringify(offered.json))
      assert.equal(offered.json.error, 'place cannot be edited while it has an open sale offer; close that offer before editing the place')
    })

    await t.test("a gift clears the given place's side and leaves the other as a request", async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const east = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { hinge_to: rooms.westRoomId })
      assert.equal(east.status, 200, JSON.stringify(east.json))
      const west = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { hinge_to: rooms.eastRoomId })
      assert.equal(west.status, 200, JSON.stringify(west.json))

      const gift = await call(app, FOUNDER.secret, 'POST', '/api/transfer', {
        type: 'place', id: rooms.eastRoomId, to_handle: 'far-neighbor',
      })
      assert.equal(gift.status, 200, JSON.stringify(gift.json))
      const places = (await connectedDatabase().query<{ id: number; owner_id: number; hinge_to: number | null }>(
        'SELECT id, owner_id, hinge_to FROM places WHERE id = ANY($1::int[]) ORDER BY id',
        [[rooms.eastRoomId, rooms.westRoomId]],
      )).rows
      assert.deepEqual(places, [
        { id: rooms.eastRoomId, owner_id: NEIGHBOR.id, hinge_to: null },
        { id: rooms.westRoomId, owner_id: FOUNDER.id, hinge_to: rooms.eastRoomId },
      ])
    })

    await t.test('a moderated far place shows the moderated name in the edit answer', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const east = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { hinge_to: rooms.westRoomId })
      assert.equal(east.status, 200, JSON.stringify(east.json))
      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('place', $1, 'remove', 1, 'removed by maintainer')
      `, [rooms.eastRoomId])
      const west = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { hinge_to: rooms.eastRoomId })
      assert.equal(west.status, 200, JSON.stringify(west.json))
      assert.deepEqual((west.json.place as Json).hinge, {
        place_id: rooms.eastRoomId,
        name: '[removed by maintainer]',
        parent_id: rooms.continentId,
        rough_room: false,
      })
    })

    await t.test('a resident walks through a mutual hinge, and a restored place stays closed until reopened', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await openHinge(rooms.eastRoomId, rooms.westRoomId)
      const homePlaceId = Number((await db.query<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'place', 'Walkers Home', 'a place WALKER owns', $2)
        RETURNING id
      `, [rooms.continentId, WALKER.id])).rows[0]!.id)
      await standIn(WALKER.id, rooms.eastRoomId)
      await db.query('UPDATE resident_presence SET home_place_id = $1 WHERE resident_id = $2', [homePlaceId, WALKER.id])
      await db.query("UPDATE resident_presence SET arrived_at = '2000-01-01T00:00:00Z' WHERE resident_id = $1", [WALKER.id])
      const arrivedBefore = (await db.query<{ arrived_at: Date }>(
        'SELECT arrived_at FROM resident_presence WHERE resident_id = $1', [WALKER.id],
      )).rows[0]!.arrived_at

      const eastToWest = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(eastToWest.status, 200, JSON.stringify(eastToWest.json))
      assert.equal((eastToWest.json.action as Json).place_id, rooms.westRoomId)
      const arrivedAfter = (await db.query<{ arrived_at: Date }>(
        'SELECT arrived_at FROM resident_presence WHERE resident_id = $1', [WALKER.id],
      )).rows[0]!.arrived_at
      assert.ok(arrivedAfter > arrivedBefore, 'a hinge step advances arrived_at')

      const westToEast = await walkTo(app, WALKER.secret, rooms.eastRoomId)
      assert.equal(westToEast.status, 200, JSON.stringify(westToEast.json))
      assert.equal((westToEast.json.action as Json).place_id, rooms.eastRoomId)

      await db.query('UPDATE places SET hinge_to = NULL WHERE id = $1', [rooms.westRoomId])
      const cleared = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(cleared.status, 403)
      assert.equal(cleared.json.error, closedHingeRefusal(rooms.westRoomId, rooms.eastRoomId))

      await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.eastRoomId, rooms.westRoomId])
      await db.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [rooms.westRoomId])
      const retired = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(retired.status, 409)
      assert.equal(retired.json.error, 'destination place is retired; restore it before moving there')

      await db.query('UPDATE places SET retired_at = NULL WHERE id = $1', [rooms.westRoomId])
      const restoredClosed = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(restoredClosed.status, 403)
      assert.equal(restoredClosed.json.error, closedHingeRefusal(rooms.westRoomId, rooms.eastRoomId))

      await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.eastRoomId, rooms.westRoomId])
      const reopened = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(reopened.status, 200, JSON.stringify(reopened.json))
      assert.equal((reopened.json.action as Json).place_id, rooms.westRoomId)

      await db.query('UPDATE places SET hinge_to = NULL WHERE id = $1', [rooms.westRoomId])
      const home = await call(app, WALKER.secret, 'POST', '/api/go-home', {})
      assert.equal(home.status, 200, JSON.stringify(home.json))
      assert.equal((home.json.action as Json).place_id, homePlaceId)
    })

    await t.test('clearing the origin side refuses when the destination still names it', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await openHinge(rooms.eastRoomId, rooms.westRoomId)
      await db.query('UPDATE places SET hinge_to = NULL WHERE id = $1', [rooms.eastRoomId])
      await standIn(WALKER.id, rooms.eastRoomId)

      const refused = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(refused.status, 403)
      assert.equal(refused.json.error, closedHingeRefusal(rooms.westRoomId, rooms.eastRoomId))
    })

    await t.test('WALKER carries an owned thing through a hinge', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await openHinge(rooms.eastRoomId, rooms.westRoomId)
      await standIn(WALKER.id, rooms.eastRoomId)
      const thingId = Number((await db.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'Walkers parcel', 'carried across the hinge', $2, $2)
        RETURNING id
      `, [rooms.eastRoomId, WALKER.id])).rows[0]!.id)

      const carried = await walkTo(app, WALKER.secret, rooms.westRoomId, thingId)
      assert.equal(carried.status, 200, JSON.stringify(carried.json))
      assert.equal((carried.json.action as Json).place_id, rooms.westRoomId)
      assert.equal((carried.json.action as Json).carried_thing_id, thingId)
      const thing = (await db.query<{ place_id: number; held_by: number | null }>(
        'SELECT place_id, held_by FROM things WHERE id = $1', [thingId],
      )).rows[0]!
      assert.deepEqual(thing, { place_id: rooms.westRoomId, held_by: WALKER.id })
    })

    await t.test('opposite place_edit openings sent together both succeed', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [NEIGHBOR.id, rooms.westRoomId])
      const [east, west] = await Promise.all([
        call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, { hinge_to: rooms.westRoomId }),
        call(app, NEIGHBOR.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { hinge_to: rooms.eastRoomId }),
      ])
      assert.equal(east.status, 200, JSON.stringify(east.json))
      assert.equal(west.status, 200, JSON.stringify(west.json))
    })

    await t.test('a step waiting on a hinge close returns the closed-hinge refusal', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      await openHinge(rooms.eastRoomId, rooms.westRoomId)
      await standIn(WALKER.id, rooms.eastRoomId)
      const db = connectedDatabase()
      const closer = await db.connect()
      let step: ReturnType<typeof walkTo> | null = null
      let committed = false
      await closer.query('BEGIN')
      try {
        await closer.query('UPDATE places SET hinge_to = NULL WHERE id = $1', [rooms.westRoomId])
        step = walkTo(app, WALKER.secret, rooms.westRoomId)
        await waitForDatabaseLock(db, 'FOR SHARE')
        await closer.query('COMMIT')
        committed = true
        const result = await step
        assert.equal(result.status, 403, JSON.stringify(result.json))
        assert.equal(result.json.error, closedHingeRefusal(rooms.westRoomId, rooms.eastRoomId))
        assert.equal((await db.query<{ current_place_id: number }>(
          'SELECT current_place_id FROM resident_presence WHERE resident_id = $1', [WALKER.id],
        )).rows[0]!.current_place_id, rooms.eastRoomId)
      } finally {
        if (!committed) {
          await closer.query('ROLLBACK').catch(() => undefined)
          await step?.catch(() => undefined)
        }
        closer.release()
      }
    })

    await t.test('a carry waiting on the second opening moves through the hinge', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.westRoomId, rooms.eastRoomId])
      await standIn(WALKER.id, rooms.eastRoomId)
      const thingId = Number((await db.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'Racing parcel', 'waits for both sides', $2, $2)
        RETURNING id
      `, [rooms.eastRoomId, WALKER.id])).rows[0]!.id)
      const opener = await db.connect()
      let carry: ReturnType<typeof walkTo> | null = null
      let committed = false
      await opener.query('BEGIN')
      try {
        await opener.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.eastRoomId, rooms.westRoomId])
        carry = walkTo(app, WALKER.secret, rooms.westRoomId, thingId)
        await waitForDatabaseLock(db, 'FOR UPDATE OF destination')
        await opener.query('COMMIT')
        committed = true
        const result = await carry
        assert.equal(result.status, 200, JSON.stringify(result.json))
        assert.equal((result.json.action as Json).status, 'applied')
        assert.equal((result.json.action as Json).place_id, rooms.westRoomId)
        const presence = (await db.query<{ current_place_id: number }>(
          'SELECT current_place_id FROM resident_presence WHERE resident_id = $1', [WALKER.id],
        )).rows[0]!.current_place_id
        const thing = (await db.query<{ place_id: number }>(
          'SELECT place_id FROM things WHERE id = $1', [thingId],
        )).rows[0]!.place_id
        assert.equal(presence, rooms.westRoomId)
        assert.equal(thing, rooms.westRoomId)
      } finally {
        if (!committed) {
          await opener.query('ROLLBACK').catch(() => undefined)
          await carry?.catch(() => undefined)
        }
        opener.release()
      }
    })

    await t.test('an unexpired move block still refuses a hinge step', async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOR, WALKER])
      const db = connectedDatabase()
      await openHinge(rooms.eastRoomId, rooms.westRoomId)
      await standIn(WALKER.id, rooms.eastRoomId)
      await db.query(`
        INSERT INTO active_blocks (resident_id, action_name, actor_id, source_place_id, expires_at)
        VALUES ($1, 'move', 1, $2, now() + INTERVAL '10 minutes')
      `, [WALKER.id, rooms.eastRoomId])

      const refused = await walkTo(app, WALKER.secret, rooms.westRoomId)
      assert.equal(refused.status, 403)
      assert.match(String(refused.json.error), /move is temporarily blocked/u)
      assert.equal((await db.query<{ current_place_id: number }>(
        'SELECT current_place_id FROM resident_presence WHERE resident_id = $1', [WALKER.id],
      )).rows[0]!.current_place_id, rooms.eastRoomId)
    })
  } finally {
    await postgres.stop()
  }
})
