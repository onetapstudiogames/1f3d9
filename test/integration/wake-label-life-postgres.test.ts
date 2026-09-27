// How long a sticker a wake try puts on a resident lasts in a room, set by the room's owner
// (decision #131), against real PostgreSQL: the additive migration, place_edit and the place
// read through src/index.ts, and the sticker a wake try or a reach writes in one engine
// transaction.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260927_wake_label_life.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })

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
  } finally {
    await postgres.stop()
  }
})
