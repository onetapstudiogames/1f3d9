// Copy, reach, and convert (docs/DECISIONS.md rows 111 to 115) against real PostgreSQL:
// the additive migration, the real routes through src/index.ts, and one interactive
// transaction per engine action, timer resolution, and wake try.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'
// Loaded only after the fixture points src/db.ts at the test container.
const { rollValue } = await import('../../src/engine-chance.ts')

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

/**
 * Add one more revision of a kind listing the given traits, and make it current.
 * A later revision carries a refused drawing, so an upgrade to it is a real
 * drawing change (drawing_revisions refuses a revision that changes nothing).
 */
async function addRevision(kindId: number, revision: number, traitIds: readonly number[]): Promise<void> {
  const db = connectedDatabase()
  const names = (await db.query<{ name: string }>(
    'SELECT name FROM traits WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)', [traitIds],
  )).rows.map(row => row.name)
  await db.query(`
    INSERT INTO kind_revisions (kind_id, revision, traits, drawing_state, drawing_description)
    VALUES ($1, $2, $3::text[], coalesce($4::text, 'undrawn'), $5)
  `, [kindId, revision, names, revision > 1 ? 'refused' : null, revision > 1 ? 'a picture is on its way' : null])
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

    await t.test('a copy is born one generation down, at the parent revision, owned and made by its owner', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'fern-sprout', {
        use: [
          { effect: 'write', key: 'rings', op: 'add' },
          { effect: 'copy', copies: 2, inherit: ['body', 'state'] },
        ],
      })).status, 201)
      const fern = await seedKind(GROWER.id, 'fern', [await traitId('fern-sprout')])
      const parentId = await seedThing(GROWER.id, rooms.eastRoomId, fern, 'a fern', {
        openToUse: true, openToReach: true,
      })
      await db.query(`UPDATE things SET body = 'green words' WHERE id = $1`, [parentId])
      // The kind moves on to revision 2; the parent stays at 1, and so will its copy.
      await addRevision(fern, 2, [await traitId('fern-sprout')])
      // Sold to the neighbour, who wakes it again; the maker of the words stays the grower.
      await db.query('UPDATE things SET owner_id = $2 WHERE id = $1', [parentId, NEIGHBOUR.id])
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [parentId])
      const thingsToday = Number((await db.query('SELECT things_today FROM residents WHERE id = $1', [NEIGHBOUR.id])).rows[0]!.things_today)

      const used = await use(app, NEIGHBOUR.secret, parentId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.equal(action.effects_applied, 2)
      const copied = action.copied_thing_ids as number[]
      assert.equal(copied.length, 1)
      const [copyId] = copied as [number]

      const row = (await db.query(`
        SELECT owner_id, maker_id, kind_id, birth_revision, current_revision, generation,
          parent_thing_id, family_id, copies_made, open_to_use, shared_use_may_destroy,
          open_to_reach, open_to_convert, wake_enabled, body, name, place_id, state, state_version
        FROM things WHERE id = $1
      `, [copyId])).rows[0]
      assert.deepEqual(row, {
        owner_id: NEIGHBOUR.id, maker_id: NEIGHBOUR.id, kind_id: fern, birth_revision: 1,
        current_revision: 1, generation: 1, parent_thing_id: parentId, family_id: parentId,
        copies_made: 0, open_to_use: true, shared_use_may_destroy: false, open_to_reach: true,
        open_to_convert: false, wake_enabled: true, body: 'green words', name: 'a fern',
        place_id: rooms.eastRoomId, state: { rings: 1 }, state_version: 1,
      })
      assert.equal(Number((await db.query('SELECT copies_made FROM things WHERE id = $1', [parentId])).rows[0]!.copies_made), 1)
      assert.equal(
        Number((await db.query('SELECT things_today FROM residents WHERE id = $1', [NEIGHBOUR.id])).rows[0]!.things_today),
        thingsToday,
        "a copy never counts toward its owner's things for the day",
      )
      const created = (await db.query(`
        SELECT actor, detail FROM events WHERE kind = 'thing_created' AND (detail->>'thing_id')::int = $1
      `, [copyId])).rows
      assert.equal(created.length, 1)
      assert.equal(created[0]!.actor, NEIGHBOUR.handle)
      assert.equal(created[0]!.detail.mode, 'copy')
      assert.equal(created[0]!.detail.source_thing_id, parentId)

      const read = await call(app, null, 'GET', `/api/thing/${copyId}`)
      assert.equal(read.status, 200)
      const thing = read.json.thing as Json
      assert.equal(thing.made_by, NEIGHBOUR.handle, 'the copy was made by its owner, whose thing made it')
      assert.equal(thing.current_owner, NEIGHBOUR.handle)
      assert.equal(thing.family_maker, GROWER.handle, 'the maker of the family stays one read away')
      assert.equal(thing.generation, 1)
      assert.equal(thing.parent_thing_id, parentId)
      assert.equal(thing.family_id, parentId)
      assert.equal(thing.growth_mark, null)
      const state = thing.state as Json
      assert.deepEqual(state.values, { rings: 1 })
      assert.equal((state.last_write as Json).op, 'inherit')
      assert.equal((state.last_write as Json).trigger, 'copy')
      const parentRead = (await call(app, null, 'GET', `/api/thing/${parentId}`)).json.thing as Json
      assert.equal(parentRead.generation, 0)
      assert.equal(parentRead.family_id, parentId, "a first thing's family is its own id")
      assert.equal(parentRead.parent_thing_id, null)
      assert.equal(parentRead.copies_made, 1)
    })

    await t.test('a copy at the generation or copy limit is skipped and marks the family', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'once', { use: [{ effect: 'copy', generations: 1 }] })).status, 201)
      const moss = await seedKind(GROWER.id, 'moss', [await traitId('once')])
      const parentId = await seedThing(GROWER.id, rooms.eastRoomId, moss, 'moss')

      const first = await use(app, GROWER.secret, parentId)
      assert.equal(first.status, 200, JSON.stringify(first.json))
      const [copyId] = (first.json.action as Json).copied_thing_ids as [number]

      const second = await use(app, GROWER.secret, parentId)
      assert.equal(second.status, 200, 'a skipped copy never fails the action')
      const secondAction = second.json.action as Json
      assert.equal(secondAction.effects_applied, 0)
      assert.equal(secondAction.copied_thing_ids, undefined)
      assert.deepEqual(secondAction.skipped_effects, [{
        effect: 'copy', target: 'source', source_trait: 'once', source_trait_id: await traitId('once'),
        source_place_id: null, reason: 'the family reached its generation or copy limit',
        cap: 'copies', limit: 1, over_by: 1,
      }])

      const deeper = await use(app, GROWER.secret, copyId)
      assert.equal(deeper.status, 200)
      assert.deepEqual(((deeper.json.action as Json).skipped_effects as Json[]).map(skip => [skip.cap, skip.limit, skip.over_by]), [
        ['generations', 1, 1],
      ])
      const mark = ((await call(app, null, 'GET', `/api/thing/${parentId}`)).json.thing as Json).growth_mark as Json
      assert.equal(mark.family_id, parentId)
      assert.equal(mark.place_id, rooms.eastRoomId)
      assert.equal(mark.source_thing_id, copyId, 'the newest cap that bit in this place, on the one open mark')
      assert.equal(mark.cap, 'generations')
      assert.equal(Number((await db.query(
        'SELECT count(*)::int AS count FROM family_growth_marks WHERE family_id = $1', [parentId],
      )).rows[0]!.count), 1, 'a repeated skip updates the open mark instead of adding one')
    })

    await t.test('growth caps skip extra copies, record the cap and how far over, and clear when things change', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query(
        'UPDATE places SET owner_id = $1, growth_cap_per_day = 2, growth_share_per_family = 5 WHERE id = $2',
        [GROWER.id, rooms.eastRoomId],
      )
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'weed', { use: [{ effect: 'copy', copies: 'unlimited', generations: 8 }] })).status, 201)
      const weed = await seedKind(GROWER.id, 'weed', [await traitId('weed')])
      const parentId = await seedThing(GROWER.id, rooms.eastRoomId, weed, 'weed')
      for (let count = 0; count < 2; count += 1) {
        const made = await use(app, GROWER.secret, parentId)
        assert.equal(((made.json.action as Json).copied_thing_ids as number[]).length, 1)
      }
      const capped = await use(app, GROWER.secret, parentId)
      const [skip] = (capped.json.action as Json).skipped_effects as [Json]
      assert.deepEqual([skip.reason, skip.cap, skip.limit, skip.over_by], ['a growth cap refused the copy', 'place_daily', 2, 1])

      // The family share bites before the place cap once the owner narrows it.
      await db.query('UPDATE places SET growth_cap_per_day = 10, growth_share_per_family = 2 WHERE id = $1', [rooms.eastRoomId])
      const shared = await use(app, GROWER.secret, parentId)
      const [shareSkip] = (shared.json.action as Json).skipped_effects as [Json]
      assert.deepEqual([shareSkip.cap, shareSkip.limit, shareSkip.over_by], ['family_share', 2, 1])
      const counted = (await db.query(`
        SELECT copies FROM place_copy_counts WHERE place_id = $1 AND family_id = $2
      `, [rooms.eastRoomId, parentId])).rows
      assert.deepEqual(counted, [{ copies: 2 }])

      // A later copy of the family here clears the open mark.
      await db.query('UPDATE places SET growth_share_per_family = 3 WHERE id = $1', [rooms.eastRoomId])
      const again = await use(app, GROWER.secret, parentId)
      assert.equal(((again.json.action as Json).copied_thing_ids as number[]).length, 1)
      const cleared = (await db.query(`
        SELECT cleared_reason FROM family_growth_marks WHERE family_id = $1 ORDER BY id
      `, [parentId])).rows.map(row => row.cleared_reason)
      assert.deepEqual(cleared, ['copy_succeeded'])

      // Upgrading a thing to a new kind revision clears its family's open marks.
      await use(app, GROWER.secret, parentId)
      assert.equal(((await call(app, null, 'GET', `/api/thing/${parentId}`)).json.thing as Json).growth_mark !== null, true)
      await addRevision(weed, 2, [await traitId('weed')])
      const upgraded = await call(app, GROWER.secret, 'POST', `/api/thing/${parentId}/upgrade`, {})
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json))
      const reasons = (await db.query(`
        SELECT cleared_reason FROM family_growth_marks WHERE family_id = $1 ORDER BY id
      `, [parentId])).rows.map(row => row.cleared_reason)
      assert.deepEqual(reasons, ['copy_succeeded', 'kind_revision_changed'])
      assert.equal(((await call(app, null, 'GET', `/api/thing/${parentId}`)).json.thing as Json).growth_mark, null)
    })

    await t.test('adjacent copies land only where arriving copies are allowed, and a public roll picks among several', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const gardens: number[] = []
      for (const name of ['Garden A', 'Garden B']) {
        gardens.push(Number((await db.query(`
          INSERT INTO places (parent_id, place_kind, name, description, owner_id)
          VALUES ($1, 'place', $2, 'a garden', 1) RETURNING id
        `, [rooms.eastRoomId, name])).rows[0]!.id))
      }
      assert.equal((await coin(app, GROWER.secret, 'spore', { use: [{ effect: 'copy', to: 'adjacent', copies: 'unlimited' }] })).status, 201)
      const spore = await seedKind(GROWER.id, 'spore', [await traitId('spore')])
      const parentId = await seedThing(GROWER.id, rooms.eastRoomId, spore, 'a spore')

      const closed = await use(app, GROWER.secret, parentId)
      const [skip] = (closed.json.action as Json).skipped_effects as [Json]
      assert.deepEqual([skip.reason, skip.cap, skip.limit, skip.over_by], ['a growth cap refused the copy', 'no_arrivals', 0, 1])
      assert.equal((closed.json.action as Json).rolls, undefined, 'no roll when nothing qualifies')

      await db.query('UPDATE places SET allow_arriving_copies = TRUE WHERE id = $1', [gardens[0]])
      const one = await use(app, GROWER.secret, parentId)
      const [landed] = (one.json.action as Json).copied_thing_ids as [number]
      assert.equal(Number((await db.query('SELECT place_id FROM things WHERE id = $1', [landed])).rows[0]!.place_id), gardens[0])
      assert.equal((one.json.action as Json).rolls, undefined, 'one qualifying place needs no roll')

      await db.query('UPDATE places SET allow_arriving_copies = TRUE WHERE id = $1', [gardens[1]])
      const two = await use(app, GROWER.secret, parentId)
      const twoAction = two.json.action as Json
      const [picked] = twoAction.copied_thing_ids as [number]
      const [roll] = twoAction.rolls as [Json]
      assert.equal(roll.purpose, 'copy_place')
      const stored = (await db.query(`
        SELECT roll.sides, roll.roll, roll.authority_id, roll.place_id, encode(day.secret, 'hex') AS secret
        FROM chance_rolls roll JOIN chance_days day ON day.day = roll.day WHERE roll.id = $1
      `, [roll.roll_id])).rows[0]!
      assert.equal(stored.sides, 2)
      assert.equal(stored.authority_id, GROWER.id, "the copy's owner answers for the roll")
      assert.equal(rollValue(String(stored.secret), {
        rollId: Number(roll.roll_id), purpose: 'copy_place', placeId: rooms.eastRoomId,
        sourceThingId: parentId, sourceTraitId: await traitId('spore'), sides: 2,
      }), stored.roll, 'the place roll follows the published formula')
      assert.equal(
        Number((await db.query('SELECT place_id FROM things WHERE id = $1', [picked])).rows[0]!.place_id),
        gardens[Number(stored.roll) - 1],
        'places are counted in id order',
      )
    })

    await t.test("two copies at once never pass a place's daily cap", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query(
        'UPDATE places SET open_to_things = TRUE, growth_cap_per_day = 1 WHERE id = $1', [rooms.eastRoomId],
      )
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'rush', { use: [{ effect: 'copy', copies: 'unlimited' }] })).status, 201)
      const rush = await seedKind(GROWER.id, 'rush', [await traitId('rush')])
      for (let round = 0; round < 3; round += 1) {
        await db.query('DELETE FROM place_copy_counts')
        const mine = await seedThing(GROWER.id, rooms.eastRoomId, rush, `rush ${round} a`)
        const theirs = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, rush, `rush ${round} b`)
        const answers = await Promise.all([
          use(app, GROWER.secret, mine),
          use(app, NEIGHBOUR.secret, theirs),
        ])
        const made = answers.flatMap(answer => ((answer.json.action as Json).copied_thing_ids as number[] | undefined) ?? [])
        const skipped = answers.flatMap(answer => ((answer.json.action as Json).skipped_effects as Json[] | undefined) ?? [])
        assert.equal(made.length, 1, `round ${round}: exactly one copy under a cap of one`)
        assert.deepEqual(skipped.map(skip => skip.cap), ['place_daily'])
        const total = Number((await db.query(`
          SELECT coalesce(sum(copies), 0)::int AS total FROM place_copy_counts WHERE place_id = $1
        `, [rooms.eastRoomId])).rows[0]!.total)
        assert.equal(total, 1)
      }
    })

    await t.test('copies made or skipped by a wake try and a timer are recorded with them', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query(
        'UPDATE places SET owner_id = $1, growth_cap_per_day = 1 WHERE id = $2', [GROWER.id, rooms.eastRoomId],
      )
      await standIn(GROWER.id, rooms.westRoomId)
      assert.equal((await coin(app, GROWER.secret, 'greets-and-grows', {
        wake: { on: ['arrive'], then: [{ effect: 'copy', copies: 'unlimited' }] },
      })).status, 201)
      const bloom = await seedKind(GROWER.id, 'bloom', [await traitId('greets-and-grows')])
      const bloomId = await seedThing(GROWER.id, rooms.eastRoomId, bloom, 'a bloom')
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [bloomId])

      const arrived = await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      const entered = await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(entered.status, 200, JSON.stringify(entered.json))
      const tries = (await db.query(`
        SELECT status, effects_applied, skipped_effects FROM wake_tries WHERE thing_id = $1 ORDER BY id
      `, [bloomId])).rows
      assert.deepEqual(tries.map(row => [row.status, row.effects_applied]), [['woke', 1]])
      const copies = (await db.query('SELECT id, owner_id, wake_enabled FROM things WHERE parent_thing_id = $1', [bloomId])).rows
      assert.equal(copies.length, 1)
      assert.equal(copies[0]!.wake_enabled, true, 'a copy keeps its parent switches, wake_enabled included')

      // The next arrival meets the place cap; the try records the skip, not a failure.
      await db.query(`
        UPDATE thing_wake_state SET last_try_at = last_try_at - interval '1 hour'
      `)
      await db.query('ALTER TABLE wake_settles DISABLE TRIGGER wake_settles_append_only')
      await db.query(`UPDATE wake_settles SET created_at = created_at - interval '1 hour'`)
      await db.query('ALTER TABLE wake_settles ENABLE TRIGGER wake_settles_append_only')
      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      const later = (await db.query(`
        SELECT status, skipped_effects FROM wake_tries WHERE thing_id = $1 ORDER BY id
      `, [bloomId])).rows
      const skippedTry = later.find(row => Array.isArray(row.skipped_effects) && row.skipped_effects.length > 0)
      assert.ok(skippedTry, JSON.stringify(later))
      assert.equal(skippedTry.status, 'quiet')
      assert.equal(skippedTry.skipped_effects[0].cap, 'place_daily')

      // A timer's copy that a cap stops is kept in the effect resolution.
      assert.equal((await coin(app, GROWER.secret, 'slow-seed', {
        use: [{ effect: 'wait', seconds: 1, then: [{ effect: 'copy', copies: 'unlimited' }] }],
      })).status, 201)
      const seed = await seedKind(GROWER.id, 'slow-seed', [await traitId('slow-seed')])
      const seedId = await seedThing(GROWER.id, rooms.eastRoomId, seed, 'a slow seed')
      const planted = await use(app, GROWER.secret, seedId)
      assert.equal(planted.status, 200, JSON.stringify(planted.json))
      await delay(1_200)
      await call(app, GROWER.secret, 'GET', '/api/me')
      const resolution = (await db.query(`
        SELECT resolution.status, resolution.detail FROM effect_resolutions resolution
        JOIN pending_effects pending ON pending.id = resolution.pending_effect_id
        WHERE pending.source_thing_id = $1
      `, [seedId])).rows
      assert.equal(resolution.length, 1)
      assert.equal(resolution[0]!.status, 'applied')
      assert.equal(resolution[0]!.detail.skipped_effects[0].cap, 'place_daily')
    })
  } finally {
    await postgres.stop()
  }
})
