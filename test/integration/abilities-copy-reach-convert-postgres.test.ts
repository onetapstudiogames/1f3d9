// Copy, reach, and convert (docs/DECISIONS.md rows 111 to 115) against real PostgreSQL:
// the additive migration, the real routes through src/index.ts, and one interactive
// transaction per engine action, timer resolution, and wake try.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260922_abilities_copy_reach_convert.sql', import.meta.url),
  'utf8',
)
// db/schema.sql ends with this change's statements; everything before them is the
// database exactly as production holds it once abilities-wake-chance-write has run.
const CHANGE_MARKER = '-- Things gain copy, reach, and convert'
const schemaBeforeChange = schemaDdl.slice(0, schemaDdl.indexOf(CHANGE_MARKER))

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const GROWER = Object.freeze({ id: 2, handle: 'seed-keeper', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const NEIGHBOUR = Object.freeze({ id: 3, handle: 'next-door', secret: `1f3d9_sk_${'3'.repeat(48)}` })

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
  return call(app, secret, 'POST', '/api/trait', { name, description: `${name} for the copy, reach, and convert suite`, recipe })
}

async function traitId(name: string): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(
    'SELECT id FROM traits WHERE name = $1', [name],
  )).rows[0]!.id)
}

/** A kind at revision 1 listing the given traits, owned by `ownerId`, without a fee. */
async function seedKind(ownerId: number, name: string, traitIds: readonly number[]): Promise<number> {
  const db = connectedDatabase()
  const kindId = Number((await db.query<{ id: number }>(
    'INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', [name, ownerId],
  )).rows[0]!.id)
  await addRevision(kindId, 1, traitIds)
  return kindId
}

/** Add one more revision of a kind listing the given traits, and make it current. */
async function addRevision(kindId: number, revision: number, traitIds: readonly number[]): Promise<void> {
  const db = connectedDatabase()
  const names = (await db.query<{ name: string }>(
    'SELECT name FROM traits WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)', [traitIds],
  )).rows.map(row => row.name)
  await db.query(
    'INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, $2, $3::text[])', [kindId, revision, names],
  )
  await db.query('UPDATE kinds SET current_revision = $2 WHERE id = $1', [kindId, revision])
}

/** One thing of the kind, owned and made by `ownerId`, standing in `placeId`. */
async function seedThing(
  ownerId: number,
  placeId: number,
  kindId: number | null,
  name: string,
  switches: Readonly<{ openToReach?: boolean; openToConvert?: boolean; openToUse?: boolean }> = {},
): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision,
      open_to_reach, open_to_convert, open_to_use
    )
    VALUES ($1, $2, '', $3, $3, $4, $5, $5, $6, $7, $8) RETURNING id
  `, [
    placeId, name, ownerId, kindId, kindId === null ? null : 1,
    switches.openToReach === true, switches.openToConvert === true, switches.openToUse === true,
  ])).rows[0]!.id)
}

async function use(app: CityApp, secret: string, thingId: number, target?: Json) {
  return call(app, secret, 'POST', '/api/action', { action: 'use', thing_id: thingId, ...(target ?? {}) })
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** The catalog facts this change touches, normalized so a migrated and a fresh database compare equal. */
async function catalog(): Promise<Json> {
  const db = connectedDatabase()
  const columns = (await db.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('things', 'places', 'thing_conversions', 'place_copy_counts',
        'family_growth_marks', 'chance_rolls', 'thing_state_changes')
    ORDER BY table_name, column_name
  `)).rows
  const checks = (await db.query(`
    SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE contype IN ('c', 'f', 'u') AND conrelid::regclass::text IN (
      'things', 'places', 'thing_conversions', 'place_copy_counts', 'family_growth_marks',
      'chance_rolls', 'thing_state_changes'
    )
    ORDER BY 1, 2
  `)).rows
  const indexes = (await db.query(`
    SELECT tablename, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ('things', 'thing_conversions',
      'place_copy_counts', 'family_growth_marks')
    ORDER BY 1, 2
  `)).rows
  const triggers = (await db.query(`
    SELECT event_object_table, trigger_name, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE event_object_table IN ('things', 'thing_conversions')
    ORDER BY 1, 2, 4
  `)).rows
  return { columns, checks, indexes, triggers }
}

test('things copy, reach, and convert against real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('abilities-copy-reach-convert')
  try {
    await t.test('the abilities-copy-reach-convert migration is additive and repeatable', async () => {
      const fresh = await resetCity([FOUNDER, GROWER])
      const freshCatalog = await catalog()

      // Rebuild the database exactly as it stands before this change, with rows in it.
      const db = connectedDatabase()
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schemaBeforeChange)
      await db.query(
        `INSERT INTO residents (id, handle, model, secret_hash) VALUES (2, 'seed-keeper', 'suite', $1)`,
        [secretHash(GROWER.secret)],
      )
      const worldId = Number((await db.query(`SELECT id FROM places WHERE place_kind = 'world'`)).rows[0]!.id)
      const roomId = Number((await db.query(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'continent', 'Old Continent', 'made before copies', 2) RETURNING id
      `, [worldId])).rows[0]!.id)
      const kindId = Number((await db.query(`INSERT INTO kinds (name, owner_id) VALUES ('old-oak', 2) RETURNING id`)).rows[0]!.id)
      await db.query(`INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, '{}'::text[])`, [kindId])
      const thingId = Number((await db.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision)
        VALUES ($1, 'old oak', 'grown before copies', 2, 2, $2, 1, 1) RETURNING id
      `, [roomId, kindId])).rows[0]!.id)
      await db.query(`INSERT INTO chance_days (day, secret, commitment) VALUES ('2026-01-01', decode(repeat('ab', 32), 'hex'), repeat('0', 64))`)
      await db.query(`
        INSERT INTO chance_rolls (id, day, purpose, place_id, authority_id, percent, sides, roll, branch)
        VALUES (nextval('chance_rolls_id_seq'), '2026-01-01', 'chance', $1, 2, 40, 100, 7, 'then')
      `, [roomId])
      await assert.rejects(db.query(`
        INSERT INTO chance_rolls (id, day, purpose, place_id, authority_id, sides, roll)
        VALUES (nextval('chance_rolls_id_seq'), '2026-01-01', 'copy_place', $1, 2, 2, 1)
      `, [roomId]), /check constraint/, 'before this change a roll may not pick a copy place')

      await db.query(migrationDdl)
      await db.query(migrationDdl)

      const thing = (await db.query(`
        SELECT generation, parent_thing_id, family_id, copies_made, open_to_reach, open_to_convert,
          as_kind_id, as_revision, kind_id, birth_revision, current_revision
        FROM things WHERE id = $1
      `, [thingId])).rows[0]
      assert.deepEqual(thing, {
        generation: 0, parent_thing_id: null, family_id: null, copies_made: 0,
        open_to_reach: false, open_to_convert: false, as_kind_id: null, as_revision: null,
        kind_id: kindId, birth_revision: 1, current_revision: 1,
      }, 'an old thing is generation 0, its own family, and closed to harder reach and conversion')
      const place = (await db.query(`
        SELECT growth_cap_per_day, growth_share_per_family, allow_arriving_copies FROM places WHERE id = $1
      `, [roomId])).rows[0]
      assert.deepEqual(place, { growth_cap_per_day: 10, growth_share_per_family: 5, allow_arriving_copies: false })

      // The wider vocabularies accept the new values and still refuse unknown ones.
      await db.query(`
        INSERT INTO chance_rolls (id, day, purpose, outcome, place_id, authority_id, sides, roll)
        VALUES (nextval('chance_rolls_id_seq'), '2026-01-01', 'copy_place', 'member_refused', $1, 2, 2, 1)
      `, [roomId])
      await assert.rejects(db.query(`
        INSERT INTO chance_rolls (id, day, purpose, place_id, authority_id, sides, roll)
        VALUES (nextval('chance_rolls_id_seq'), '2026-01-01', 'copy_place', $1, 2, 2, 3)
      `, [roomId]), /check constraint/, 'a copy place roll stays within its sides')
      await assert.rejects(db.query(`
        INSERT INTO chance_rolls (id, day, purpose, place_id, authority_id, sides)
        VALUES (nextval('chance_rolls_id_seq'), '2026-01-01', 'guess', $1, 2, 2)
      `, [roomId]), /check constraint/)
      await db.query(`
        INSERT INTO thing_state_changes (thing_id, version, op, value, trigger, authority_id)
        VALUES ($1, 1, 'inherit', '{}'::jsonb, 'copy', 2)
      `, [thingId])
      await assert.rejects(db.query(`
        INSERT INTO thing_state_changes (thing_id, version, op, trigger, authority_id)
        VALUES ($1, 2, 'rewrite', 'copy', 2)
      `, [thingId]), /check constraint/)

      // The overlay always names a real revision and never touches the birth columns.
      await assert.rejects(db.query('UPDATE things SET as_kind_id = $2 WHERE id = $1', [thingId, kindId]), /things_as_kind_(?:contract|revision_fkey)/)
      await assert.rejects(db.query('UPDATE things SET as_kind_id = $2, as_revision = 9 WHERE id = $1', [thingId, kindId]), /things_as_kind_revision_fkey/)
      await db.query('UPDATE things SET as_kind_id = $2, as_revision = 1 WHERE id = $1', [thingId, kindId])
      await assert.rejects(db.query('UPDATE things SET kind_id = NULL WHERE id = $1', [thingId]), /birth history is immutable/)
      await assert.rejects(db.query(`
        INSERT INTO thing_conversions (thing_id, from_kind_id, from_revision, from_generation,
          from_wake_enabled, to_kind_id, to_revision, to_generation, authority_id)
        VALUES ($1, $2, 1, 0, FALSE, $2, 1, 1, 2)
      `, [thingId, kindId]), /check constraint/, 'a conversion names the thing or the law that made it')
      await db.query(`
        INSERT INTO thing_conversions (thing_id, from_kind_id, from_revision, from_generation,
          from_wake_enabled, to_kind_id, to_revision, to_generation, by_thing_id, authority_id)
        VALUES ($1, $2, 1, 0, FALSE, $2, 1, 1, $1, 2)
      `, [thingId, kindId])
      await assert.rejects(db.query('DELETE FROM thing_conversions'), /append-only/)
      await db.query(`
        INSERT INTO family_growth_marks (family_id, place_id, source_thing_id, cap, cap_limit, over_by)
        VALUES ($1, $2, $1, 'place_daily', 10, 1)
      `, [thingId, roomId])
      await assert.rejects(db.query(`
        INSERT INTO family_growth_marks (family_id, place_id, source_thing_id, cap, cap_limit, over_by)
        VALUES ($1, $2, $1, 'family_share', 5, 1)
      `, [thingId, roomId]), /family_growth_marks_one_open/, 'one open mark per family in a place')
      await assert.rejects(db.query(`
        INSERT INTO family_growth_marks (family_id, place_id, source_thing_id, cap, cap_limit, over_by)
        VALUES ($1, $2, $1, 'owner_daily_things', 20, 1)
      `, [thingId, worldId]), /check constraint/, "a copy never counts toward its owner's daily things")

      assert.deepEqual(await catalog(), freshCatalog, 'the migrated database matches a fresh db/schema.sql')
      assert.ok(fresh.eastRoomId > 0)
    })

    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('the doors refuse copy, reach, and convert where they may never be', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await standIn(GROWER.id, rooms.eastRoomId)
      await connectedDatabase().query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])

      const tooDeep = await coin(app, GROWER.secret, 'too-deep', { use: [{ effect: 'copy', generations: 9 }] })
      assert.equal(tooDeep.status, 400)
      assert.equal(tooDeep.json.error, "recipe must use only the frozen actions, the wake key, and the effect bricks, each within its stated range; call physics for every brick's fields, defaults, and limits")
      const blockInside = await coin(app, GROWER.secret, 'hold-all', {
        use: [{ effect: 'reach', over: 'residents', then: [{ effect: 'block', target: 'target', action: 'talk', seconds: 60 }] }],
      })
      assert.equal(blockInside.status, 400, 'a reach never holds a block')

      const sprout = await coin(app, GROWER.secret, 'sprout', { use: [{ effect: 'copy' }] })
      assert.equal(sprout.status, 201, JSON.stringify(sprout.json))
      assert.deepEqual((sprout.json.trait as Json).recipe, {
        use: [{ effect: 'copy', generations: 3, copies: 1, to: 'here', inherit: ['body'] }],
      })
      const rain = await coin(app, GROWER.secret, 'rain', {
        wake: { on: ['clock'], then: [{ effect: 'reach', then: [{ effect: 'label', target: 'target', label: 'wet' }] }] },
      })
      assert.equal(rain.status, 201, 'a wake program may name target inside a reach')
      const stray = await coin(app, GROWER.secret, 'stray', {
        wake: { then: [{ effect: 'convert', target: 'target' }] },
      })
      assert.equal(stray.status, 400)
      assert.equal(stray.json.error, 'a wake try has no target, destination, or recipient of its own; use target only inside a reach, and move things only to home')
      assert.equal((await coin(app, GROWER.secret, 'blight', {
        use: [{ effect: 'reach', kind: 'oak', then: [{ effect: 'convert', target: 'target' }] }],
      })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'ash-fall', {
        talk: [{ effect: 'reach', kind: 'oak', then: [{ effect: 'convert', target: 'target', into_kind: 'ash' }] }],
      })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'drizzle', {
        talk: [{ effect: 'reach', over: 'residents', then: [{ effect: 'label', target: 'target', label: 'damp' }] }],
      })).status, 201)

      for (const name of ['sprout', 'blight']) {
        const law = await call(app, GROWER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: [name] })
        assert.equal(law.status, 400, name)
        assert.equal(law.json.error, `trait ${name} carries copy, write, a wake key, or a convert without into_kind, which work only in a kind's traits; put it on a kind, or adopt a law trait without them`)
      }
      const reachLaw = await call(app, GROWER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['drizzle'] })
      assert.equal(reachLaw.status, 200, 'reach works as a law')

      const lawOnly = "trait ash-fall converts into a named kind, which only a law may do; a kind's convert always turns things into that kind itself"
      const invented = await call(app, GROWER.secret, 'POST', '/api/kind', {
        name: 'ash-maker', description: 'would convert into ash', traits: ['ash-fall'],
      })
      assert.equal(invented.status, 400, 'refused before any fee')
      assert.equal(invented.json.error, lawOnly)
      const oak = await seedKind(GROWER.id, 'oak', [await traitId('sprout')])
      const revised = await call(app, GROWER.secret, 'POST', `/api/kind/${oak}/revise`, {
        description: 'oak that burns', traits: ['sprout', 'ash-fall'],
      })
      assert.equal(revised.status, 400, 'refused before any fee')
      assert.equal(revised.json.error, lawOnly)
      const fees = (await connectedDatabase().query('SELECT count(*)::int AS count FROM kind_revisions WHERE kind_id = $1', [oak])).rows[0]!.count
      assert.equal(fees, 1, 'no revision was made')
    })
  } finally {
    await postgres.stop()
  }
})
