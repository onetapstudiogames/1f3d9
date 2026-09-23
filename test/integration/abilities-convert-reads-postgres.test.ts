// Converted things read true everywhere, reaches keep their 512 limit, and a
// family's copies never deadlock (docs/DECISIONS.md rows 112 to 115), against real
// PostgreSQL through the real routes of src/index.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FOUNDER, GROWER, NEIGHBOUR, call, coin, seedKind, seedThing, traitId, use,
  type CityApp, type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

/** Add a revision of a kind with the given drawing state, and make it current. */
async function kindRevision(
  kindId: number,
  revision: number,
  traitNames: readonly string[],
  drawingState: 'undrawn' | 'refused',
): Promise<void> {
  const db = connectedDatabase()
  await db.query(`
    INSERT INTO kind_revisions (kind_id, revision, traits, drawing_state, drawing_description)
    VALUES ($1, $2, $3::text[], $4, $5)
  `, [kindId, revision, traitNames, drawingState, drawingState === 'refused' ? 'a picture is on its way' : null])
  await db.query('UPDATE kinds SET current_revision = $2 WHERE id = $1', [kindId, revision])
}

function thingRow(list: unknown, id: number): Json {
  const rows = Array.isArray(list) ? list : (list as Json | undefined)?.items
  assert.ok(Array.isArray(rows), `a list of things: ${JSON.stringify(list)}`)
  const found = (rows as Json[]).find(row => row.id === id)
  assert.ok(found, `thing ${id} is in the list: ${JSON.stringify(rows)}`)
  return found
}

/** The presentation facts a drawing read and a history snapshot share. */
function presentation(snapshot: Json): Json {
  return {
    source: snapshot.source,
    state: snapshot.state ?? snapshot.drawing_state,
    kind_id: snapshot.kind_id ?? null,
    revision: snapshot.revision ?? null,
  }
}

test('converted things read true, reaches stay within 512, and families copy without deadlock', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('abilities-convert-reads')
  try {
    await resetCity([FOUNDER, GROWER, NEIGHBOUR])
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    /** An open oak of NEIGHBOUR's born at oak revision 2, converted by GROWER's ember into ash revision 1. */
    async function convertedOak(rooms: Readonly<{ eastRoomId: number }>, prefix: string) {
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, `${prefix}-touch`, { use: [{ effect: 'convert', target: 'target' }] })).status, 201)
      const ash = Number((await db.query(
        `INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id`, [`${prefix}-ash`, GROWER.id],
      )).rows[0]!.id)
      await kindRevision(ash, 1, [`${prefix}-touch`], 'refused')
      const oak = Number((await db.query(
        `INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id`, [`${prefix}-oak`, NEIGHBOUR.id],
      )).rows[0]!.id)
      await kindRevision(oak, 1, [], 'undrawn')
      await kindRevision(oak, 2, [], 'undrawn')
      const ember = await seedThing(GROWER.id, rooms.eastRoomId, ash, `${prefix} ember`)
      const oakId = Number((await db.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, open_to_convert)
        VALUES ($1, $2, '', $3, $3, $4, 2, 2, TRUE) RETURNING id
      `, [rooms.eastRoomId, `${prefix} oak`, NEIGHBOUR.id, oak])).rows[0]!.id)
      const converted = await use(app, GROWER.secret, ember, { target_type: 'thing', target_id: oakId })
      assert.equal(converted.status, 200, JSON.stringify(converted.json))
      assert.deepEqual((converted.json.action as Json).converted_thing_ids, [oakId])
      return { ash, oak, ember, oakId }
    }

    await t.test('every read of a converted thing shows the kind it is now, born_as, and generation', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const { ash, oak, oakId } = await convertedOak(rooms, 'b1')
      const bornAs = { kind: 'b1-oak', kind_id: oak, revision: 2 }
      const expectNow = (row: Json, where: string) => {
        assert.equal(row.kind_id, ash, `${where}: kind_id is the kind it is now`)
        assert.equal(row.current_revision, 1, `${where}: current_revision is its new kind's revision`)
        assert.deepEqual(row.born_as, bornAs, `${where}: born_as names the birth kind and revision`)
        assert.equal(row.generation, 1, `${where}: generation`)
        if (Object.hasOwn(row, 'kind')) assert.equal(row.kind, 'b1-ash', `${where}: kind`)
      }

      expectNow((await call(app, null, 'GET', `/api/thing/${oakId}`)).json.thing as Json, 'thing read')
      const me = await call(app, NEIGHBOUR.secret, 'GET', '/api/me')
      assert.equal(me.status, 200)
      expectNow(thingRow(me.json.things, oakId), 'me')
      const full = (await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}?view=full`)).json
      expectNow(thingRow(full.things, oakId), 'place full')
      const outline = (await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).json
      const outlined = thingRow(outline.things, oakId)
      if (Object.hasOwn(outlined, 'kind_id')) expectNow(outlined, 'place outline')
      const windowRows = (await call(app, null, 'GET', `/api/window?collection=things&place_id=${rooms.eastRoomId}`)).json
      // The window's full rows name the kind by name only, as before; they add born_as and generation.
      const windowThing = thingRow(windowRows.things ?? windowRows.items, oakId)
      assert.equal(windowThing.kind, 'b1-ash', 'window things: kind')
      assert.deepEqual(windowThing.born_as, bornAs, 'window things: born_as')
      assert.equal(windowThing.generation, 1, 'window things: generation')
      const headings = (await call(app, null, 'GET', `/api/window?collection=things&place_id=${rooms.eastRoomId}&presentation=headings`)).json
      const heading = thingRow(headings.things ?? headings.items, oakId)
      assert.equal(heading.kind_id, ash, 'window headings: kind_id is the kind it is now')
      assert.deepEqual(heading.born_as, bornAs, 'window headings: born_as')
      assert.equal(heading.generation, 1, 'window headings: generation')

      const edited = await call(app, NEIGHBOUR.secret, 'PATCH', `/api/thing/${oakId}`, { name: 'b1 oak renamed' })
      assert.equal(edited.status, 200, JSON.stringify(edited.json))
      expectNow(edited.json.thing as Json, 'thing_edit answer')
      assert.equal(Object.hasOwn(edited.json.thing as Json, 'as_kind_id'), false, 'the answer names one kind, not the overlay columns')

      // A hidden birth kind's name stays hidden wherever born_as or was names it.
      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('kind', $1, 'remove', 1, 'suite: hide the birth kind')
      `, [oak])
      const hidden = { kind: '[removed by maintainer]', kind_id: oak, revision: 2 }
      const hiddenRead = (await call(app, null, 'GET', `/api/thing/${oakId}`)).json.thing as Json
      assert.deepEqual(hiddenRead.born_as, hidden, 'thing read: born_as')
      assert.equal(((hiddenRead.was as Json[])[0] as Json).kind, '[removed by maintainer]', 'thing read: was')
      const hiddenFull = (await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}?view=full`)).json
      assert.deepEqual(thingRow(hiddenFull.things, oakId).born_as, hidden, 'place full: born_as')
      const hiddenMe = await call(app, NEIGHBOUR.secret, 'GET', '/api/me')
      assert.deepEqual(thingRow(hiddenMe.json.things, oakId).born_as, hidden, 'me: born_as')
    })

    await t.test('all reaches in one action never pass 512 applications, whatever their step counts', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      const labels = (count: number) => Array.from({ length: count }, (_, index) => ({ effect: 'label', target: 'target', label: `mark-${index}` }))
      assert.equal((await coin(app, GROWER.secret, 'seven', { use: [{ effect: 'reach', max: 64, then: labels(7) }] })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'three', { use: [{ effect: 'reach', max: 64, then: labels(3) }] })).status, 201)
      const tide = await seedKind(GROWER.id, 'tide', [await traitId('seven'), await traitId('three')])
      const tideId = await seedThing(GROWER.id, rooms.eastRoomId, tide, 'the tide')
      await db.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        SELECT $1, 'pebble ' || n, '', $2, $2 FROM generate_series(1, 70) AS n
      `, [rooms.eastRoomId, GROWER.id])
      const used = await use(app, GROWER.secret, tideId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.ok(Number(action.effects_applied) <= 512, `at most 512 applications, got ${action.effects_applied}`)
      assert.equal(action.effects_applied, 7 * 64 + 3 * 21)
      assert.deepEqual((action.reaches as Json[]).map(reach => [reach.reached, reach.more, reach.stopped]), [
        [64, 6, null],
        [21, 49, 'action_reach_limit'],
      ], 'the second reach stops before a member whose steps would pass the limit')
      const stickers = Number((await db.query(`SELECT count(*)::int AS count FROM active_labels WHERE label LIKE 'mark-%'`)).rows[0]!.count)
      assert.equal(stickers, 7 * 64 + 3 * 21)
    })

    await t.test("a converted thing's drawing history always ends at what the thing shows", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const { ash, oakId } = await convertedOak(rooms, 'b3')
      const matchesRead = async (step: string) => {
        const read = (await call(app, null, 'GET', `/api/drawing/thing/${oakId}`)).json
        const history = (await call(app, null, 'GET', `/api/drawing/thing/${oakId}/history`)).json
        const [latest] = history.revisions as [Json]
        assert.ok(latest, `${step}: the history has a revision`)
        assert.deepEqual(presentation(latest.current as Json), presentation(read), `${step}: the newest history snapshot is what the thing shows`)
        return history.revisions as Json[]
      }

      const afterConversion = await matchesRead('conversion')
      assert.equal(afterConversion.length, 1, 'the conversion appends one drawing revision')
      assert.deepEqual(presentation(afterConversion[0]!.previous as Json), { source: 'none', state: 'undrawn', kind_id: null, revision: null })
      assert.deepEqual(presentation(afterConversion[0]!.current as Json), { source: 'kind_base', state: 'refused', kind_id: ash, revision: 1 })
      assert.deepEqual((afterConversion[0]!.author as Json).relation, 'kind_owner')
      assert.deepEqual((afterConversion[0]!.author as Json).id, GROWER.id)

      const refused = await call(app, NEIGHBOUR.secret, 'PATCH', `/api/thing/${oakId}`, {
        drawing: 'REFUSE', drawing_description: 'not this picture',
      })
      assert.equal(refused.status, 200, JSON.stringify(refused.json))
      await matchesRead('owner refused')
      const cleared = await call(app, NEIGHBOUR.secret, 'PATCH', `/api/thing/${oakId}`, { drawing: null })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      const afterClear = await matchesRead('owner cleared')
      assert.equal(afterClear.length, 3)

      await kindRevision(ash, 2, ['b3-touch'], 'undrawn')
      const upgraded = await call(app, NEIGHBOUR.secret, 'POST', `/api/thing/${oakId}/upgrade`, {})
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json))
      const afterUpgrade = await matchesRead('converted upgrade')
      assert.equal(afterUpgrade.length, 4, "a converted thing's upgrade appends a drawing revision")
      assert.deepEqual((afterUpgrade[0]!.author as Json).relation, 'owner')
      const event = (await connectedDatabase().query(`
        SELECT detail FROM events WHERE kind = 'thing_upgraded' ORDER BY id DESC LIMIT 1
      `)).rows[0]!.detail as Json
      assert.deepEqual(event, { thing_id: oakId, kind_id: ash, current_revision: 2 }, 'the upgrade event describes one kind')
    })

    await t.test("a conversion clears the old family's open growth marks", async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'l3-touch', { use: [{ effect: 'convert', target: 'target' }] })).status, 201)
      const ash = await seedKind(GROWER.id, 'l3-ash', [await traitId('l3-touch')])
      const oak = await seedKind(NEIGHBOUR.id, 'l3-oak', [])
      const ember = await seedThing(GROWER.id, rooms.eastRoomId, ash, 'l3 ember')
      const oakId = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'l3 oak', { openToConvert: true })
      await db.query(`
        INSERT INTO family_growth_marks (family_id, place_id, source_thing_id, cap, cap_limit, over_by)
        VALUES ($1, $2, $1, 'family_share', 5, 1)
      `, [oakId, rooms.eastRoomId])
      const converted = await use(app, GROWER.secret, ember, { target_type: 'thing', target_id: oakId })
      assert.equal(converted.status, 200, JSON.stringify(converted.json))
      assert.deepEqual((await db.query('SELECT cleared_reason FROM family_growth_marks')).rows, [
        { cleared_reason: 'kind_revision_changed' },
      ], "the thing's kind revision changed, so its family's mark clears")
    })

    await t.test('a use whose only effect is a skipped copy says so', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = TRUE, growth_cap_per_day = 0 WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'l2-sprout', { use: [{ effect: 'copy' }] })).status, 201)
      const fern = await seedKind(GROWER.id, 'l2-fern', [await traitId('l2-sprout')])
      const fernId = await seedThing(GROWER.id, rooms.eastRoomId, fern, 'l2 fern')
      const used = await use(app, GROWER.secret, fernId)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.equal(action.status, 'noop')
      assert.deepEqual((action.skipped_effects as Json[]).map(skip => skip.cap), ['place_daily'])
      assert.equal(action.reason, 'no use effect applied: every effect that would have run was skipped, and skipped_effects says why')
    })

    await t.test('a parent and its copy used at the same moment never deadlock', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = TRUE, growth_share_per_family = 1 WHERE id = $1', [rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'l1-sprout', {
        use: [{ effect: 'copy', copies: 'unlimited', generations: 8 }],
      })).status, 201)
      const fern = await seedKind(GROWER.id, 'l1-fern', [await traitId('l1-sprout')])
      for (let round = 0; round < 30; round += 1) {
        await db.query('DELETE FROM place_copy_counts')
        const parent = await seedThing(GROWER.id, rooms.eastRoomId, fern, `l1 parent ${round}`)
        const child = await seedThing(GROWER.id, rooms.eastRoomId, fern, `l1 child ${round}`, { openToUse: true })
        await db.query('UPDATE things SET parent_thing_id = $1, family_id = $1, generation = 1 WHERE id = $2', [parent, child])
        const answers = await Promise.all([
          use(app, GROWER.secret, parent),
          use(app, NEIGHBOUR.secret, child),
        ])
        for (const answer of answers) {
          assert.equal(answer.status, 200, `round ${round}: ${JSON.stringify(answer.json)}`)
        }
        const made = answers.flatMap(answer => ((answer.json.action as Json).copied_thing_ids as number[] | undefined) ?? [])
        assert.equal(made.length, 1, `round ${round}: the family's share of one holds`)
      }
    })
  } finally {
    await postgres.stop()
  }
})
