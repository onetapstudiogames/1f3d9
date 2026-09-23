// Wake on arrival, chance, and write (docs/DECISIONS.md rows 104 to 110) against real
// PostgreSQL: the additive migration, the real routes through src/index.ts, and one
// interactive transaction per engine action, settle claim, and wake try.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260922_abilities_wake_chance_write.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })

// Put the database back to how it stood before this change, so the migration meets
// existing rows exactly as production will.
const PRE_ABILITIES_DDL = `
  DROP TABLE thing_state_changes, chance_rolls, chance_days, wake_tries, wake_settles, thing_wake_state;
  DROP SEQUENCE chance_rolls_id_seq;
  DROP TRIGGER things_sleep_on_owner_change ON things;
  DROP FUNCTION sleep_thing_on_owner_change();
  ALTER TABLE things DROP COLUMN wake_enabled, DROP COLUMN state, DROP COLUMN state_version;
  ALTER TABLE places DROP COLUMN wake_visitors, DROP COLUMN wake_pins,
    DROP COLUMN wake_block_thing_ids, DROP COLUMN wake_block_resident_ids,
    DROP COLUMN wake_random_cap, DROP COLUMN rough_room;
`

test('things wake, roll, and write against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('abilities')
  try {
    await t.test('the abilities migration is additive and repeatable', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      const db = connectedDatabase()
      await db.query(PRE_ABILITIES_DDL)
      const thingId = Number((await db.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'old bell', 'made before abilities', 2, 2) RETURNING id
      `, [rooms.eastRoomId])).rows[0]!.id)

      await db.query(migrationDdl)
      await db.query(migrationDdl)

      const thing = (await db.query(`
        SELECT wake_enabled, state, state_version FROM things WHERE id = $1
      `, [thingId])).rows[0]
      assert.deepEqual(thing, { wake_enabled: false, state: {}, state_version: 0 })
      const place = (await db.query(`
        SELECT wake_visitors, wake_pins, wake_block_thing_ids, wake_block_resident_ids,
          wake_random_cap, rough_room
        FROM places WHERE id = $1
      `, [rooms.eastRoomId])).rows[0]
      assert.deepEqual(place, {
        wake_visitors: false,
        wake_pins: [],
        wake_block_thing_ids: [],
        wake_block_resident_ids: [],
        wake_random_cap: 8,
        rough_room: false,
      })
      const columns = (await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'things' AND column_name IN ('wake_enabled', 'state', 'state_version'))
            OR (table_name = 'places' AND column_name IN ('wake_visitors', 'wake_random_cap', 'rough_room')))
        ORDER BY table_name, column_name
      `)).rows
      assert.deepEqual(columns, [
        { table_name: 'places', column_name: 'rough_room', data_type: 'boolean', is_nullable: 'NO' },
        { table_name: 'places', column_name: 'wake_random_cap', data_type: 'smallint', is_nullable: 'NO' },
        { table_name: 'places', column_name: 'wake_visitors', data_type: 'boolean', is_nullable: 'NO' },
        { table_name: 'things', column_name: 'state', data_type: 'jsonb', is_nullable: 'NO' },
        { table_name: 'things', column_name: 'state_version', data_type: 'integer', is_nullable: 'NO' },
        { table_name: 'things', column_name: 'wake_enabled', data_type: 'boolean', is_nullable: 'NO' },
      ])

      // The owner-change trigger puts a received thing to sleep in every path that changes an owner.
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [thingId])
      await db.query('UPDATE things SET owner_id = 1 WHERE id = $1', [thingId])
      assert.equal((await db.query('SELECT wake_enabled FROM things WHERE id = $1', [thingId])).rows[0]!.wake_enabled, false)

      // History tables refuse edits like the rest of the public record.
      await db.query(`INSERT INTO chance_days (day, secret, commitment) VALUES ('2026-01-01', decode(repeat('ab', 32), 'hex'), repeat('0', 64))`)
      await assert.rejects(db.query(`DELETE FROM chance_days`), /append-only/)
    })
  } finally {
    await postgres.stop()
  }
})
