// Copy, reach, and convert (docs/DECISIONS.md rows 111 to 115) against real PostgreSQL:
// the additive migration, the real routes through src/index.ts, and one interactive
// transaction per engine action, timer resolution, and wake try.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  FOUNDER, GROWER, NEIGHBOUR, addRevision, call, coin, seedKind, seedThing, traitId, use,
  type CityApp, type Json,
} from '../helpers/abilities-fixtures.ts'
import {
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
      // Sold to the neighbour, where it arrives asleep and closed; the neighbour wakes it
      // and opens it to reach again. The maker of the words stays the grower.
      await db.query('UPDATE things SET owner_id = $2 WHERE id = $1', [parentId, NEIGHBOUR.id])
      assert.deepEqual(
        (await db.query('SELECT wake_enabled, open_to_reach FROM things WHERE id = $1', [parentId])).rows[0],
        { wake_enabled: false, open_to_reach: false },
      )
      await db.query('UPDATE things SET wake_enabled = TRUE, open_to_reach = TRUE WHERE id = $1', [parentId])
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
      const actionEvents = (await db.query(`
        SELECT detail FROM events WHERE kind = 'action' AND (detail->>'action_id')::int = $1
      `, [action.id])).rows
      assert.equal(actionEvents.length, 1, "the copy's own event sits beside the action's, never in place of it")
      assert.equal(actionEvents[0]!.detail.effects_applied, 2)

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

    await t.test('a soft reach touches every thing; a harder one only consenting things, and delayed steps re-read consent', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'soak-all', {
        use: [{ effect: 'reach', then: [{ effect: 'label', target: 'target', label: 'wet' }] }],
      })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'slow-scorch', {
        use: [{ effect: 'reach', then: [{ effect: 'wait', seconds: 1, then: [{ effect: 'label', target: 'target', label: 'scorched' }] }] }],
      })).status, 201)
      const cloud = await seedKind(GROWER.id, 'cloud', [await traitId('soak-all'), await traitId('slow-scorch')])
      const sourceId = await seedThing(GROWER.id, rooms.eastRoomId, cloud, 'a cloud')
      const mineClosed = await seedThing(GROWER.id, rooms.eastRoomId, null, 'my closed crate')
      const theirsClosed = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'their closed crate')
      const theirsOpen = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'their open crate', { openToReach: true })
      const founderOpen = await seedThing(FOUNDER.id, rooms.eastRoomId, null, 'an open crate', { openToReach: true })

      const used = await use(app, GROWER.secret, sourceId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      const wet = (await db.query(`
        SELECT target_id FROM active_labels WHERE label = 'wet' AND target_type = 'thing' ORDER BY target_id
      `)).rows.map(row => row.target_id)
      assert.deepEqual(wet, [mineClosed, theirsClosed, theirsOpen, founderOpen], 'soft steps reach every thing but the source')
      const pending = (await db.query(`
        SELECT target_id, payload->'reach_member' AS member FROM pending_effects ORDER BY target_id
      `)).rows
      assert.deepEqual(pending.map(row => row.target_id), [mineClosed, theirsOpen, founderOpen],
        "a harder step reaches open things and, in the owner's own program, the owner's things")
      assert.deepEqual(pending.map(row => row.member.admitted_by), ['own', 'open', 'open'])
      assert.equal(action.effects_applied, 7, 'each member application counts; the reach itself counts none')
      assert.deepEqual(action.reaches, [
        { source_trait: 'soak-all', source_trait_id: await traitId('soak-all'), over: 'things', reached: 4, more: 0, stopped: null },
        { source_trait: 'slow-scorch', source_trait_id: await traitId('slow-scorch'), over: 'things', reached: 3, more: 0, stopped: null },
      ])

      // Consent is read again when the delayed step fires.
      await db.query('UPDATE things SET open_to_reach = FALSE WHERE id = $1', [theirsOpen])
      await db.query('UPDATE things SET owner_id = $2 WHERE id = $1', [mineClosed, FOUNDER.id])
      await delay(1_200)
      assert.equal((await call(app, GROWER.secret, 'GET', '/api/me')).status, 200)
      const scorched = (await db.query(`
        SELECT target_id FROM active_labels WHERE label = 'scorched' ORDER BY target_id
      `)).rows.map(row => row.target_id)
      assert.deepEqual(scorched, [founderOpen], 'closing open_to_reach, or giving the thing away, stops the delayed step')
      const resolutions = (await db.query(`
        SELECT pending.target_id, resolution.status, resolution.detail FROM effect_resolutions resolution
        JOIN pending_effects pending ON pending.id = resolution.pending_effect_id ORDER BY pending.target_id
      `)).rows
      assert.deepEqual(resolutions.map(row => [row.target_id, row.status]), [
        [mineClosed, 'skipped'], [theirsOpen, 'skipped'], [founderOpen, 'applied'],
      ])
      assert.equal(resolutions[0]!.detail.skipped_effects[0].reason, 'this reach member refused the step')
      assert.equal(resolutions[0]!.detail.skipped_effects[0].member_id, mineClosed)
    })

    await t.test("a law's and a shared use's harder reach never touch the answerer's own closed things", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, FOUNDER.secret, 'wildfire', {
        talk: [{ effect: 'reach', then: [{ effect: 'destroy', target: 'target' }] }],
      })).status, 201)
      assert.equal((await call(app, FOUNDER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['wildfire'] })).status, 200)
      const mineClosed = await seedThing(GROWER.id, rooms.eastRoomId, null, 'my closed crate')
      const mineOpen = await seedThing(GROWER.id, rooms.eastRoomId, null, 'my open crate', { openToReach: true })
      const theirsOpen = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'their open crate', { openToReach: true })
      const theirsClosed = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'their closed crate')

      const spoke = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'strike a match' })
      assert.equal(spoke.status, 201, JSON.stringify(spoke.json))
      const standing = (await db.query(`
        SELECT id FROM things WHERE withdrawn_at IS NULL AND place_id = $1 ORDER BY id
      `, [rooms.eastRoomId])).rows.map(row => row.id)
      assert.deepEqual(standing, [mineClosed, theirsClosed], "a law's fire reaches only open things, the speaker's own included")
      assert.ok(mineOpen && theirsOpen)

      // A shared use runs another's program, so the visitor's own things need open_to_reach too.
      assert.equal((await coin(app, NEIGHBOUR.secret, 'slow-scorch', {
        use: [{ effect: 'reach', then: [{ effect: 'wait', seconds: 30, then: [{ effect: 'label', target: 'target', label: 'scorched' }] }] }],
      })).status, 201)
      const torch = await seedKind(NEIGHBOUR.id, 'torch', [await traitId('slow-scorch')])
      const torchId = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, torch, 'a torch', { openToUse: true })
      const reopened = await seedThing(GROWER.id, rooms.eastRoomId, null, 'my new open crate', { openToReach: true })
      const used = await use(app, GROWER.secret, torchId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const targets = (await db.query('SELECT target_id FROM pending_effects ORDER BY target_id')).rows.map(row => row.target_id)
      assert.deepEqual(targets, [reopened], 'neither the visitor nor the owner is exempt in a shared use')
    })

    await t.test('a reach over residents stickers each resident for a day', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await standIn(FOUNDER.id, rooms.westRoomId)
      assert.equal((await coin(app, GROWER.secret, 'drizzle', {
        use: [{ effect: 'reach', over: 'residents', then: [
          { effect: 'label', target: 'target', label: 'damp' },
          { effect: 'write', key: 'counted', op: 'add' },
        ] }],
      })).status, 201)
      const cloud = await seedKind(GROWER.id, 'drizzle-cloud', [await traitId('drizzle')])
      const cloudId = await seedThing(GROWER.id, rooms.eastRoomId, cloud, 'a small cloud')
      const used = await use(app, GROWER.secret, cloudId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const labels = (await db.query(`
        SELECT target_id, extract(epoch FROM expires_at - created_at)::int AS seconds
        FROM active_labels WHERE label = 'damp' ORDER BY target_id
      `)).rows
      assert.deepEqual(labels, [
        { target_id: GROWER.id, seconds: 86_400 },
        { target_id: NEIGHBOUR.id, seconds: 86_400 },
      ], 'only residents standing here, and each sticker lasts a day')
      assert.deepEqual(((await db.query('SELECT state FROM things WHERE id = $1', [cloudId])).rows[0]!.state), { counted: 2 },
        'write inside a reach still writes its own thing')
    })

    await t.test('a member that refuses a step is skipped and named, keeps its roll public, and the rest apply', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'burn-it', {
        use: [{ effect: 'reach', then: [{
          effect: 'chance', percent: 50,
          then: [{ effect: 'destroy', target: 'target' }],
          else: [{ effect: 'destroy', target: 'target' }],
        }] }],
      })).status, 201)
      const flame = await seedKind(GROWER.id, 'flame', [await traitId('burn-it')])
      const flameId = await seedThing(GROWER.id, rooms.eastRoomId, flame, 'a flame')
      const mine = await seedThing(GROWER.id, rooms.eastRoomId, null, 'my kindling')
      const theirs = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'their open kindling', { openToReach: true })

      const used = await use(app, GROWER.secret, flameId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.equal(action.status, 'applied')
      const [skip] = action.skipped_effects as [Json]
      assert.equal(skip.reason, 'this reach member refused the step')
      assert.equal(skip.member_id, theirs)
      assert.equal(skip.error, 'damage to another resident property requires an effective local law')
      const active = (await db.query('SELECT id FROM things WHERE withdrawn_at IS NULL ORDER BY id')).rows.map(row => row.id)
      assert.deepEqual(active, [flameId, theirs], 'the owner\'s own kindling burned; the neighbour\'s did not')
      const rolls = action.rolls as Json[]
      assert.deepEqual(rolls.map(roll => roll.outcome), ['counted', 'member_refused'])
      const stored = (await db.query('SELECT id::int AS id, outcome FROM chance_rolls ORDER BY id')).rows
      assert.deepEqual(stored.map(row => row.outcome), ['counted', 'member_refused'], 'the refused member\'s roll is still public')
    })

    await t.test('all reaches in one action stop at 512 applications and say so', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const eight = Array.from({ length: 8 }, (_, index) => ({ effect: 'label', target: 'target', label: `mark-${index}` }))
      for (const name of ['wave-one', 'wave-two']) {
        assert.equal((await coin(app, GROWER.secret, name, { use: [{ effect: 'reach', max: 64, then: eight }] })).status, 201)
      }
      const sea = await seedKind(GROWER.id, 'sea', [await traitId('wave-one'), await traitId('wave-two')])
      const seaId = await seedThing(GROWER.id, rooms.eastRoomId, sea, 'the sea')
      await db.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        SELECT $1, 'pebble ' || n, '', $2, $2 FROM generate_series(1, 70) AS n
      `, [rooms.eastRoomId, GROWER.id])
      const used = await use(app, GROWER.secret, seaId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.equal(action.effects_applied, 512)
      assert.deepEqual((action.reaches as Json[]).map(reach => [reach.reached, reach.more, reach.stopped]), [
        [64, 6, null],
        [0, 70, 'action_reach_limit'],
      ])
    })

    await t.test("a waking thing's reach stickers the room for a day and reaches its owner's own things harder", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.westRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'wet-welcome', {
        wake: {
          on: ['arrive'],
          then: [
            { effect: 'reach', over: 'residents', then: [{ effect: 'label', target: 'target', label: 'splashed' }] },
            { effect: 'reach', then: [{ effect: 'wait', seconds: 30, then: [{ effect: 'label', target: 'target', label: 'soaked' }] }] },
          ],
        },
      })).status, 201)
      const fountain = await seedKind(GROWER.id, 'fountain', [await traitId('wet-welcome')])
      const fountainId = await seedThing(GROWER.id, rooms.eastRoomId, fountain, 'a fountain')
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [fountainId])
      const growersCrate = await seedThing(GROWER.id, rooms.eastRoomId, null, "the grower's crate")
      const neighboursCrate = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, "the neighbour's crate")

      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      const entered = await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(entered.status, 200, JSON.stringify(entered.json))
      assert.equal(((entered.json.action as Json).settle as Json).woke, 1)
      const stickers = (await db.query(`
        SELECT target_id, extract(epoch FROM expires_at - created_at)::int AS seconds, actor_id
        FROM active_labels WHERE label = 'splashed' ORDER BY target_id
      `)).rows
      assert.deepEqual(stickers, [
        { target_id: GROWER.id, seconds: 86_400, actor_id: GROWER.id },
        { target_id: NEIGHBOUR.id, seconds: 86_400, actor_id: GROWER.id },
      ], 'everyone standing in the room, each sticker for a day, answering to the thing owner')
      const scheduled = (await db.query(`
        SELECT target_id, payload->'reach_member'->>'admitted_by' AS admitted_by, payload->>'own_program' AS own
        FROM pending_effects ORDER BY target_id
      `)).rows
      assert.deepEqual(scheduled, [{ target_id: growersCrate, admitted_by: 'own', own: 'true' }],
        "a wake try is its owner's own program: the owner's closed crate is reached, the neighbour's is not")
      assert.ok(neighboursCrate > growersCrate)
    })

    await t.test("convert needs the target's consent, keeps birth history, remembers, and the thing then acts as its new kind", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'ash-touch', { use: [{ effect: 'convert', target: 'target' }] })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'ash-glow', {
        wake: { on: ['arrive'], then: [{ effect: 'label', target: 'source', label: 'glowing' }] },
      })).status, 201)
      const ash = await seedKind(GROWER.id, 'ash', [await traitId('ash-touch'), await traitId('ash-glow')])
      const oak = await seedKind(NEIGHBOUR.id, 'oak', [])
      const ember = await seedThing(GROWER.id, rooms.eastRoomId, ash, 'an ember')
      const closedOak = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'a closed oak')
      const openOak = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'an open oak', { openToConvert: true })
      const ownOak = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, "the neighbour's own oak")
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [openOak])

      const refused = await use(app, GROWER.secret, ember, { target_type: 'thing', target_id: closedOak })
      assert.equal(refused.status, 403)
      assert.equal(refused.json.error, `thing ${closedOak} has not agreed to be converted; its owner can set open_to_convert with thing_edit`)

      const converted = await use(app, GROWER.secret, ember, { target_type: 'thing', target_id: openOak })
      assert.equal(converted.status, 200, JSON.stringify(converted.json))
      assert.deepEqual((converted.json.action as Json).converted_thing_ids, [openOak])
      const row = (await db.query(`
        SELECT kind_id, birth_revision, current_revision, as_kind_id, as_revision, wake_enabled,
          generation, family_id, owner_id, maker_id, name
        FROM things WHERE id = $1
      `, [openOak])).rows[0]
      assert.deepEqual(row, {
        kind_id: oak, birth_revision: 1, current_revision: 1, as_kind_id: ash, as_revision: 1,
        wake_enabled: false, generation: 1, family_id: ember, owner_id: NEIGHBOUR.id,
        maker_id: NEIGHBOUR.id, name: 'an open oak',
      }, 'birth history stays, the overlay names the new kind, and the thing sleeps')
      const memory = (await db.query(`
        SELECT from_kind_id, from_revision, from_generation, from_wake_enabled, to_kind_id, to_revision,
          to_generation, by_thing_id, by_law_trait_id, authority_id, resident_id
        FROM thing_conversions WHERE thing_id = $1
      `, [openOak])).rows
      assert.deepEqual(memory, [{
        from_kind_id: oak, from_revision: 1, from_generation: 0, from_wake_enabled: true,
        to_kind_id: ash, to_revision: 1, to_generation: 1, by_thing_id: ember, by_law_trait_id: null,
        authority_id: GROWER.id, resident_id: GROWER.id,
      }])
      const edited = (await db.query(`
        SELECT detail FROM events WHERE kind = 'thing_edited' AND detail->>'mode' = 'converted'
      `)).rows
      assert.deepEqual(edited.map(event => [event.detail.thing_id, event.detail.source_thing_id, event.detail.kind_id]), [
        [openOak, ember, ash],
      ])
      const convertAction = (await db.query(`
        SELECT detail FROM events WHERE kind = 'action' AND (detail->>'action_id')::int = $1
      `, [(converted.json.action as Json).id])).rows
      assert.equal(convertAction.length, 1, "a conversion's event sits beside the action's")

      const read = (await call(app, null, 'GET', `/api/thing/${openOak}`)).json.thing as Json
      assert.equal(read.kind, 'ash', 'every read shows the kind it is now')
      assert.equal(read.kind_id, ash)
      assert.equal(read.current_revision, 1)
      assert.deepEqual(read.born_as, { kind: 'oak', kind_id: oak, revision: 1 }, 'and the kind it was born as')
      assert.equal(read.was_total, 1)
      const [was] = read.was as [Json]
      assert.deepEqual({ ...was, at: undefined }, {
        kind: 'oak', kind_id: oak, revision: 1, changed_by_thing_id: ember, changed_by_law: null,
        changed_by: GROWER.handle, at: undefined,
      })
      assert.equal(read.wake_enabled, false)

      // Its owner's next use runs the new kind's traits, and in the owner's own program
      // the owner's own things need no open_to_convert.
      const again = await use(app, NEIGHBOUR.secret, openOak, { target_type: 'thing', target_id: ownOak })
      assert.equal(again.status, 200, JSON.stringify(again.json))
      assert.deepEqual((await db.query('SELECT as_kind_id, generation FROM things WHERE id = $1', [ownOak])).rows[0], {
        as_kind_id: ash, generation: 2,
      }, 'a converted thing sits one generation below its converter')

      // Asleep until its owner wakes it; then it wakes as its new kind.
      await standIn(GROWER.id, rooms.westRoomId)
      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      await db.query('UPDATE places SET wake_visitors = TRUE WHERE id = $1', [rooms.eastRoomId])
      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(Number((await db.query('SELECT count(*)::int AS count FROM wake_tries WHERE thing_id = $1', [openOak])).rows[0]!.count), 0)
      const woken = await call(app, NEIGHBOUR.secret, 'PATCH', `/api/thing/${openOak}`, { wake_enabled: true })
      assert.equal(woken.status, 200, JSON.stringify(woken.json))
      await db.query('ALTER TABLE wake_settles DISABLE TRIGGER wake_settles_append_only')
      await db.query(`UPDATE wake_settles SET created_at = created_at - interval '1 hour'`)
      await db.query('ALTER TABLE wake_settles ENABLE TRIGGER wake_settles_append_only')
      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      await call(app, GROWER.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      const glow = (await db.query(`
        SELECT target_id FROM active_labels WHERE label = 'glowing' ORDER BY target_id
      `)).rows.map(label => label.target_id)
      assert.ok(glow.includes(openOak), `the converted thing wakes with its new kind's wake key: ${JSON.stringify(glow)}`)
    })

    await t.test('convert refuses residents, places, itself, things with no kind, and the ninth generation', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'rot-touch', { use: [{ effect: 'convert', target: 'target' }] })).status, 201)
      const rot = await seedKind(GROWER.id, 'rot', [await traitId('rot-touch')])
      const spore = await seedThing(GROWER.id, rooms.eastRoomId, rot, 'a spore')
      const drawn = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'a drawn note', { openToConvert: true })

      const resident = await use(app, GROWER.secret, spore, { target_type: 'resident', target_id: NEIGHBOUR.id })
      assert.equal(resident.status, 403)
      assert.equal(resident.json.error, 'convert changes only things; residents and places are never converted')
      const place = await use(app, GROWER.secret, spore, { target_type: 'place', target_id: rooms.eastRoomId })
      assert.equal(place.status, 403)
      // A refusal repeated word for word carries a short note after its first line.
      assert.equal(String(place.json.error).split('\n')[0], 'convert changes only things; residents and places are never converted')
      const itself = await use(app, GROWER.secret, spore, { target_type: 'thing', target_id: spore })
      assert.equal(itself.status, 400)
      assert.equal(itself.json.error, 'convert cannot change the thing running it; choose another target thing')
      const kindless = await use(app, GROWER.secret, spore, { target_type: 'thing', target_id: drawn })
      assert.equal(kindless.status, 409)
      assert.equal(kindless.json.error, `convert changes only things made from a kind; thing ${drawn} has no kind, so it stays as its owner made it`)

      const oak = await seedKind(NEIGHBOUR.id, 'deep-oak', [])
      const deepOak = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'a deep oak', { openToConvert: true })
      await db.query('UPDATE things SET generation = 8 WHERE id = $1', [spore])
      const tooDeep = await use(app, GROWER.secret, spore, { target_type: 'thing', target_id: deepOak })
      assert.equal(tooDeep.status, 409)
      assert.equal(tooDeep.json.error, `convert would take thing ${deepOak} past generation 8; this family cannot spread further`)
      assert.equal((await db.query('SELECT as_kind_id FROM things WHERE id = $1', [deepOak])).rows[0]!.as_kind_id, null)
    })

    await t.test("a law converts only into its place owner's kind, and only things that agreed", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const oak = await seedKind(NEIGHBOUR.id, 'oak', [])
      await seedKind(NEIGHBOUR.id, 'ash', [])
      assert.equal((await coin(app, GROWER.secret, 'ash-fall', {
        talk: [{ effect: 'reach', kind: 'oak', then: [{ effect: 'convert', target: 'target', into_kind: 'ash' }] }],
      })).status, 201)
      const notMine = await call(app, GROWER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['ash-fall'] })
      assert.equal(notMine.status, 409)
      assert.equal(notMine.json.error, 'a law may convert only into a kind its place owner owns; kind ash is missing or belongs to someone else')

      const cinder = await seedKind(GROWER.id, 'cinder', [])
      await addRevision(cinder, 2, [])
      assert.equal((await coin(app, GROWER.secret, 'cinder-fall', {
        talk: [{ effect: 'reach', kind: 'oak', then: [{ effect: 'convert', target: 'target', into_kind: 'cinder' }] }],
      })).status, 201)
      assert.equal((await call(app, GROWER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['cinder-fall'] })).status, 200)
      const agreed = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'an agreeing oak', { openToReach: true, openToConvert: true })
      const ownReachOnly = await seedThing(GROWER.id, rooms.eastRoomId, oak, "the owner's oak", { openToReach: true })
      const closed = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'a closed oak')

      const spoke = await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'let it fall' })
      assert.equal(spoke.status, 201, JSON.stringify(spoke.json))
      const kinds = (await db.query(`
        SELECT id, as_kind_id, as_revision, generation FROM things WHERE id = ANY($1::int[]) ORDER BY id
      `, [[agreed, ownReachOnly, closed]])).rows
      assert.deepEqual(kinds, [
        { id: agreed, as_kind_id: cinder, as_revision: 2, generation: 1 },
        { id: ownReachOnly, as_kind_id: null, as_revision: null, generation: 0 },
        { id: closed, as_kind_id: null, as_revision: null, generation: 0 },
      ], "a law needs open_to_convert even on its own place owner's things, and converts at the kind's current revision")
      const lawMemory = (await db.query(`
        SELECT by_thing_id, by_law_trait_id, by_place_id FROM thing_conversions WHERE thing_id = $1
      `, [agreed])).rows
      assert.deepEqual(lawMemory, [{ by_thing_id: null, by_law_trait_id: await traitId('cinder-fall'), by_place_id: rooms.eastRoomId }])
      const skipped = (await db.query(`
        SELECT detail->'skipped_effects' AS skipped FROM action_resolutions ORDER BY id DESC LIMIT 1
      `)).rows[0]!.skipped as Json[]
      assert.deepEqual(skipped.map(skip => [skip.member_id, skip.error]), [
        [ownReachOnly, `thing ${ownReachOnly} has not agreed to be converted; its owner can set open_to_convert with thing_edit`],
      ])
      const lawRead = (await call(app, null, 'GET', `/api/thing/${agreed}`)).json.thing as Json
      assert.equal((lawRead.was as Json[])[0]!.changed_by_law, 'cinder-fall')

      // Ownership read again when the law runs: a kind given away stops the law.
      await db.query('UPDATE kinds SET owner_id = $1 WHERE id = $2', [NEIGHBOUR.id, cinder])
      const second = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'a second oak', { openToReach: true, openToConvert: true })
      assert.equal((await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'again' })).status, 201)
      assert.equal((await db.query('SELECT as_kind_id FROM things WHERE id = $1', [second])).rows[0]!.as_kind_id, null)
      const after = (await db.query(`
        SELECT detail->'skipped_effects' AS skipped FROM action_resolutions ORDER BY id DESC LIMIT 1
      `)).rows[0]!.skipped as Json[]
      assert.ok(after.some(skip => skip.error === 'a law may convert only into a kind its place owner owns; kind cinder is missing or belongs to someone else'))
    })

    await t.test('upgrading a converted thing moves its overlay revision and refuses a drawing variant', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'moss-touch', { use: [{ effect: 'convert', target: 'target' }] })).status, 201)
      const moss = await seedKind(GROWER.id, 'moss', [await traitId('moss-touch')])
      const stone = await seedKind(GROWER.id, 'stone', [])
      const mossId = await seedThing(GROWER.id, rooms.eastRoomId, moss, 'moss')
      const stoneId = await seedThing(GROWER.id, rooms.eastRoomId, stone, 'a stone')
      const converted = await use(app, GROWER.secret, mossId, { target_type: 'thing', target_id: stoneId })
      assert.equal(converted.status, 200, JSON.stringify(converted.json))

      await addRevision(moss, 2, [await traitId('moss-touch')])
      const variant = await call(app, GROWER.secret, 'POST', `/api/thing/${stoneId}/upgrade`, { drawing_variant_name: 'green' })
      assert.equal(variant.status, 409)
      assert.equal(variant.json.error, `thing ${stoneId} was converted, so it shows its new kind's base drawing; send no drawing_variant_name`)
      const edit = await call(app, GROWER.secret, 'PATCH', `/api/thing/${stoneId}`, { drawing_variant_name: 'green' })
      assert.equal(edit.status, 409)
      assert.equal(edit.json.error, `thing ${stoneId} was converted, so it shows its new kind's base drawing; send no drawing_variant_name`)

      const upgraded = await call(app, GROWER.secret, 'POST', `/api/thing/${stoneId}/upgrade`, {})
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json))
      const thing = upgraded.json.thing as Json
      assert.equal(thing.kind, 'moss')
      assert.equal(thing.current_revision, 2)
      assert.deepEqual(thing.born_as, { kind: 'stone', kind_id: stone, revision: 1 })
      assert.deepEqual((await db.query('SELECT kind_id, current_revision, as_revision FROM things WHERE id = $1', [stoneId])).rows[0], {
        kind_id: stone, current_revision: 1, as_revision: 2,
      }, 'the birth revision stays; only the overlay moves')
    })

    await t.test('make and thing_edit set open_to_reach and open_to_convert, closed unless told', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const make = (body: Json) => call(app, GROWER.secret, 'POST', '/api/thing', { place_id: rooms.eastRoomId, name: 'a crate', body: '', ...body })

      const badReach = await make({ open_to_reach: 'yes' })
      assert.equal(badReach.status, 400)
      assert.equal(badReach.json.error, 'open_to_reach must be boolean when present')
      const badConvert = await make({ open_to_convert: 1 })
      assert.equal(badConvert.status, 400)
      assert.equal(badConvert.json.error, 'open_to_convert must be boolean when present')
      const unknown = await make({ open_to_all: true })
      assert.equal(unknown.status, 400)
      assert.match(String(unknown.json.error), /send only place_id, name, body, optional open_to_use, optional shared_use_may_destroy, optional open_to_reach, optional open_to_convert, optional wake_enabled, optional kind_id, and ingredient_ids/)

      const closed = await make({})
      assert.equal(closed.status, 201, JSON.stringify(closed.json))
      const closedId = Number((closed.json.thing as Json).id)
      const closedRead = (await call(app, null, 'GET', `/api/thing/${closedId}`)).json.thing as Json
      assert.deepEqual([closedRead.open_to_reach, closedRead.open_to_convert], [false, false])
      const open = await make({ open_to_reach: true, open_to_convert: true })
      const openRead = (await call(app, null, 'GET', `/api/thing/${Number((open.json.thing as Json).id)}`)).json.thing as Json
      assert.deepEqual([openRead.open_to_reach, openRead.open_to_convert], [true, true])

      const crate = await seedKind(GROWER.id, 'crate', [])
      const crafted = await make({ kind_id: crate, ingredient_ids: [], open_to_convert: true })
      assert.equal(crafted.status, 201, JSON.stringify(crafted.json))
      assert.deepEqual(
        (await db.query('SELECT open_to_reach, open_to_convert FROM things WHERE id = $1', [Number((crafted.json.thing as Json).id)])).rows[0],
        { open_to_reach: false, open_to_convert: true },
        'a crafted thing takes the same switches',
      )

      const edited = await call(app, GROWER.secret, 'PATCH', `/api/thing/${closedId}`, { open_to_reach: true, open_to_convert: true })
      assert.equal(edited.status, 200, JSON.stringify(edited.json))
      assert.deepEqual((await db.query('SELECT open_to_reach, open_to_convert FROM things WHERE id = $1', [closedId])).rows[0], {
        open_to_reach: true, open_to_convert: true,
      })
      const badEdit = await call(app, GROWER.secret, 'PATCH', `/api/thing/${closedId}`, { open_to_convert: 'no' })
      assert.equal(badEdit.status, 400)
      assert.equal(badEdit.json.error, 'open_to_convert must be boolean when present')
      const unknownEdit = await call(app, GROWER.secret, 'PATCH', `/api/thing/${closedId}`, { open_to_everyone: true })
      assert.equal(unknownEdit.status, 400)
      assert.equal(unknownEdit.json.error, 'only name, body, drawing, drawing_variant_name, open_to_use, shared_use_may_destroy, open_to_reach, open_to_convert, wake_enabled, and state_clear are editable; birth_revision is permanent')
    })

    await t.test('place_edit sets the growth dials, the place read shows them, and a changed dial clears the marks', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const edit = (body: Json) => call(app, GROWER.secret, 'PATCH', `/api/place/${rooms.eastRoomId}`, body)
      for (const [body, error] of [
        [{ growth_cap_per_day: 101 }, 'growth_cap_per_day must be a whole number from 0 to 100'],
        [{ growth_cap_per_day: -1 }, 'growth_cap_per_day must be a whole number from 0 to 100'],
        [{ growth_cap_per_day: 2.5 }, 'growth_cap_per_day must be a whole number from 0 to 100'],
        [{ growth_share_per_family: 0 }, 'growth_share_per_family must be a whole number from 1 to 100'],
        [{ allow_arriving_copies: 'yes' }, 'allow_arriving_copies, wake_visitors, and rough_room must be boolean when present'],
      ] as const) {
        const refused = await edit(body)
        assert.equal(refused.status, 400, JSON.stringify(body))
        assert.equal(String(refused.json.error).split('\n')[0], error)
      }

      const outlineBefore = (await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).json.place as Json
      assert.deepEqual(
        [outlineBefore.growth_cap_per_day, outlineBefore.growth_share_per_family, outlineBefore.allow_arriving_copies, outlineBefore.copies_today, outlineBefore.growth_marks],
        [10, 5, false, 0, []],
        'every place starts small and takes no arriving copies',
      )
      const set = await edit({ growth_cap_per_day: 1, growth_share_per_family: 1, allow_arriving_copies: true })
      assert.equal(set.status, 200, JSON.stringify(set.json))
      const written = set.json.place as Json
      assert.deepEqual([written.growth_cap_per_day, written.growth_share_per_family, written.allow_arriving_copies], [1, 1, true])

      assert.equal((await coin(app, GROWER.secret, 'bud', { use: [{ effect: 'copy', copies: 'unlimited' }] })).status, 201)
      const bud = await seedKind(GROWER.id, 'bud', [await traitId('bud')])
      const budId = await seedThing(GROWER.id, rooms.eastRoomId, bud, 'a bud')
      await use(app, GROWER.secret, budId)
      await use(app, GROWER.secret, budId)
      const full = (await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}?view=full`)).json.place as Json
      assert.equal(full.copies_today, 1)
      const [mark] = full.growth_marks as [Json]
      assert.deepEqual([mark.family_id, mark.source_thing_id, mark.cap, mark.limit, mark.over_by], [budId, budId, 'place_daily', 1, 1])

      assert.equal((await edit({ growth_cap_per_day: 1 })).status, 200, 'an unchanged dial changes nothing')
      assert.equal(((await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).json.place as Json).growth_marks instanceof Array, true)
      assert.equal(Number((await db.query(`SELECT count(*)::int AS count FROM family_growth_marks WHERE cleared_at IS NULL`)).rows[0]!.count), 1)
      assert.equal((await edit({ growth_cap_per_day: 5 })).status, 200)
      const cleared = (await db.query('SELECT cleared_reason FROM family_growth_marks')).rows.map(row => row.cleared_reason)
      assert.deepEqual(cleared, ['place_dials_changed'])
      assert.deepEqual(((await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).json.place as Json).growth_marks, [])
    })
  } finally {
    await postgres.stop()
  }
})
