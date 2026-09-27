// Place hinges persist as an owner-controlled one-step link, against real PostgreSQL.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
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
  } finally {
    await postgres.stop()
  }
})
