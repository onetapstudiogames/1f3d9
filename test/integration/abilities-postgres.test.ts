// Wake on arrival, chance, and write (docs/DECISIONS.md rows 104 to 110) against real
// PostgreSQL: the additive migration, the real routes through src/index.ts, and one
// interactive transaction per engine action, settle claim, and wake try.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260922_abilities_wake_chance_write.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })

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
  return call(app, secret, 'POST', '/api/trait', { name, description: `${name} for the abilities suite`, recipe })
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
  await db.query(
    `INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, $2::text[])`, [kindId, names],
  )
  for (const [position, traitId] of traitIds.entries()) {
    await db.query(
      `INSERT INTO kind_revision_traits (kind_id, revision, trait_id, position) VALUES ($1, 1, $2, $3)`,
      [kindId, traitId, position],
    )
  }
  return kindId
}

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

    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('the doors refuse what a wake program or a law may never carry', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)

      const handOver = await coin(app, MAKER.secret, 'gift-giver', {
        wake: { then: [{ effect: 'chance', percent: 50, then: [{ effect: 'transfer', target: 'source', to: 'actor' }] }] },
      })
      assert.equal(handOver.status, 400)
      assert.equal(handOver.json.error, 'a wake program may never hand a thing over, because nobody who arrives or speaks asked for it; drop the transfer step')

      const outside = await coin(app, MAKER.secret, 'far-reacher', {
        wake: { then: [{ effect: 'label', target: 'target', label: 'touched' }] },
      })
      assert.equal(outside.status, 400)
      assert.equal(outside.json.error, 'a wake try has no target or destination of its own; name actor, source, or place, and move only to home')

      const outOfRange = await coin(app, MAKER.secret, 'sure-thing', {
        use: [{ effect: 'chance', percent: 100, then: [] }],
      })
      assert.equal(outOfRange.status, 400)
      assert.equal(outOfRange.json.error, "recipe must use only the frozen actions, the wake key, and the effect bricks, each within its stated range; call physics for every brick's fields, defaults, and limits")

      const counter = await coin(app, MAKER.secret, 'counter', { use: [{ effect: 'write', key: 'visits', op: 'add' }] })
      assert.equal(counter.status, 201, JSON.stringify(counter.json))
      const greeter = await coin(app, MAKER.secret, 'greeter', {
        wake: { then: [{ effect: 'label', target: 'actor', label: 'greeted' }] },
      })
      assert.equal(greeter.status, 201, JSON.stringify(greeter.json))
      assert.deepEqual((greeter.json.trait as Json).recipe, {
        wake: { on: ['arrive'], every_seconds: 60, then: [{ effect: 'label', target: 'actor', label: 'greeted' }] },
      })
      const doorman = await coin(app, MAKER.secret, 'doorman', {
        wake: { on: ['talk'], then: [{ effect: 'block', target: 'actor', action: 'talk', seconds: 30 }] },
      })
      assert.equal(doorman.status, 201, 'coining allows a hold; the room decides when it runs')
      const lucky = await coin(app, MAKER.secret, 'lucky-floor', {
        talk: [{ effect: 'chance', percent: 50, then: [{ effect: 'label', target: 'actor', label: 'lucky' }] }],
      })
      assert.equal(lucky.status, 201)

      await connectedDatabase().query('UPDATE places SET owner_id = $1 WHERE id = $2', [MAKER.id, rooms.eastRoomId])
      for (const name of ['counter', 'greeter']) {
        const law = await call(app, MAKER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: [name] })
        assert.equal(law.status, 400, name)
        assert.equal(law.json.error, `trait ${name} carries write or a wake key, which work only in a kind's traits; put it on a kind, or adopt a law trait without them`)
      }
      const chanceLaw = await call(app, MAKER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['lucky-floor'] })
      assert.equal(chanceLaw.status, 200, 'chance works as a law')

      const twoClocks = await call(app, MAKER.secret, 'POST', '/api/kind', {
        name: 'two-clocks', description: 'two wake keys', traits: ['greeter', 'counter', 'doorman'],
      })
      assert.equal(twoClocks.status, 400)
      assert.equal(twoClocks.json.error, 'a kind may list only one trait with a wake key; greeter and doorman both carry one, so keep one of them')
    })
  } finally {
    await postgres.stop()
  }
})
