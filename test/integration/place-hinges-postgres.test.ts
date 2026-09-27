// Place hinges persist as an owner-controlled one-step link, against real PostgreSQL.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
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
  } finally {
    await postgres.stop()
  }
})
