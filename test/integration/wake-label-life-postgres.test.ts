// How long a sticker a wake try puts on a resident lasts in a room, set by the room's owner
// (decision #131), against real PostgreSQL: the additive migration, place_edit and the place
// read through src/index.ts, and the sticker a wake try or a reach writes in one engine
// transaction.
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
  new URL('../../db/migrations/20260927_wake_label_life.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })

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
  } finally {
    await postgres.stop()
  }
})
