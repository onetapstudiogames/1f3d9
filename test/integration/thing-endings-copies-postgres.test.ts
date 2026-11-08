// Thing endings and copies (T10b, decision #174), against real PostgreSQL on the full
// db/schema.sql and the real routes. A copy is born with its parent's remaining end, fixed
// at copy time: a date stays, uses start at the parent's uses left, an unused-for end
// becomes an absolute deadline that still ends with cause idle_seconds, a label condition
// and the grant carry over. Nothing the parent or its owner does later reaches the copy,
// and the copy's owner may only clear its end. A parent whose end has come is skipped by
// the copy step, except by its own end try, whose copy starts with no end.
import assert from 'node:assert/strict'
import test from 'node:test'
import { waitPastDatabaseTime } from '../helpers/database-clock.ts'
import {
  call,
  coin,
  FOUNDER,
  NEIGHBOUR,
  seedKind,
  seedThing,
  traitId,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const KEEPER = Object.freeze({ id: 5, handle: 'copy-keeper', secret: `1f3d9_sk_${'6'.repeat(48)}` })
const ALL_MODES = Object.freeze(['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'])

async function one<T = Json>(text: string, values: readonly unknown[] = []): Promise<T> {
  return (await connectedDatabase().query(text, [...values])).rows[0] as T
}

/** A time this far from the database clock, in the shape toISOString writes. */
async function dbTime(offset: string): Promise<string> {
  return (await one<{ at: string }>(`
    SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
  `, [offset])).at
}

const END_COLUMNS = `
  ending_rule, ending_grant, ending_set_by, ending_set_at, ending_deadline, ending_idle_seconds,
  ending_idle_anchor, ending_uses_left, ending_uses_spent_at, ending_label, ending_copied_from,
  ending_copied_at, ended_at, ended_cause, parent_thing_id
`

async function endColumns(thingId: number): Promise<Json> {
  return one(`SELECT ${END_COLUMNS} FROM things WHERE id = $1`, [thingId])
}

function iso(value: unknown): string | null {
  return value == null ? null : new Date(value as string).toISOString()
}

test('thing endings and copies, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-copies')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd } = await import('../../src/thing-ending-record.ts')
    const { makeCopy } = await import('../../src/engine-copy.ts')
    const { engineSql, withEngineTransaction } = await import('../../src/engine.ts')
    const { ENDING_COPY_FIXED_REFUSAL, THING_ENDED_SKIP_REASON } = await import('../../src/thing-ending-refusals.ts')
    const db = connectedDatabase()

    let home = 0
    const reset = async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOUR, KEEPER])
      home = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
        VALUES ($1, 'place', 'Keeper Garden', 'the keeper''s own garden', $2, TRUE) RETURNING id
      `, [rooms.continentId, KEEPER.id])).id)
      await db.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id) VALUES ($1, $2, $2)
        ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
      `, [KEEPER.id, home])
    }
    const act = (body: Json) => call(app, KEEPER.secret, 'POST', '/api/action', body)
    const edit = (thingId: number, body: Json) => call(app, KEEPER.secret, 'PATCH', `/api/thing/${thingId}`, body)
    const kindWith = async (kind: string, traits: ReadonlyArray<readonly [string, unknown]>) => {
      const ids: number[] = []
      for (const [name, recipe] of traits) {
        const coined = await coin(app, KEEPER.secret, name, recipe)
        assert.equal(coined.status, 201, JSON.stringify(coined.json))
        ids.push(await traitId(name))
      }
      return seedKind(KEEPER.id, kind, ids)
    }
    const grantFor = (kindId: number) => ({
      kind_id: kindId,
      revision: 1,
      allowed: ALL_MODES,
      limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: ['wilted'] },
      city_limits_version: 1,
    })
    /** The parent's end, written as an owner's setting an hour ago would have left it. */
    const setParentEnd = async (thingId: number, columns: Readonly<{
      rule: unknown; grant: unknown; deadline?: string | null; idleSeconds?: number | null
      idleAnchor?: string | null; usesLeft?: number | null; label?: string | null
    }>) => db.query(`
      UPDATE things SET ending_rule = $2::jsonb, ending_grant = $3::jsonb, ending_set_by = owner_id,
        ending_set_at = now() - interval '1 hour', ending_deadline = $4::timestamptz,
        ending_idle_seconds = $5::integer, ending_idle_anchor = $6::timestamptz,
        ending_uses_left = $7::integer, ending_label = $8::text
      WHERE id = $1
    `, [thingId, JSON.stringify(columns.rule), JSON.stringify(columns.grant), columns.deadline ?? null,
      columns.idleSeconds ?? null, columns.idleAnchor ?? null, columns.usesLeft ?? null, columns.label ?? null])
    const copyByUse = async (thingId: number): Promise<number> => {
      const used = await act({ action: 'use', thing_id: thingId })
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const copied = (used.json.action as Json).copied_thing_ids as number[]
      assert.equal(copied.length, 1, JSON.stringify(used.json))
      return copied[0]!
    }
    const copyChanges = (thingId: number) => db.query(`
      SELECT change, actor_id, rule, "grant", result FROM thing_ending_changes WHERE thing_id = $1 ORDER BY id
    `, [thingId]).then(result => result.rows as Json[])

    await t.test('a copy takes its parent remaining end, fixed at copy time, and the parent later reaches nothing', async () => {
      await reset()
      const ferns = await kindWith('ferns', [['fern-spread', { use: [{ effect: 'copy', copies: 5 }] }]])
      const parent = await seedThing(KEEPER.id, home, ferns, 'a fern')
      const at = await dbTime('2 days')
      const anchor = await dbTime('-30 minutes')
      const grant = grantFor(ferns)
      await setParentEnd(parent, {
        rule: { any: [{ at }, { uses: 5 }, { idle_seconds: 7200 }, { label_added: 'wilted' }] },
        grant, deadline: at, idleSeconds: 7200, idleAnchor: anchor, usesLeft: 3, label: 'wilted',
      })

      const copy = await copyByUse(parent)
      const row = await endColumns(copy)
      const until = new Date(new Date(anchor).getTime() + 7_200_000).toISOString()
      assert.deepEqual(row.ending_rule, {
        any: [{ at }, { uses: 3 }, { idle_seconds: 7200, until }, { label_added: 'wilted' }],
      }, 'a date stays, uses start at the parent uses left, the unused-for end becomes an until')
      assert.deepEqual(row.ending_grant, grant, 'the copy keeps its parent grant')
      assert.equal(row.ending_set_by, KEEPER.id)
      assert.equal(iso(row.ending_deadline), until, 'the soonest absolute end')
      assert.equal(row.ending_idle_seconds, null)
      assert.equal(row.ending_idle_anchor, null)
      assert.equal(row.ending_uses_left, 3)
      assert.equal(row.ending_uses_spent_at, null)
      assert.equal(row.ending_label, 'wilted')
      assert.equal(row.ending_copied_from, parent)
      assert.equal(row.parent_thing_id, parent)
      assert.equal(iso(row.ending_set_at), iso(row.ending_copied_at), 'set at the copy time')
      const cut = await one<Json>(`
        SELECT ending_set_at = date_trunc('milliseconds', ending_set_at) AS millis,
          abs(extract(epoch FROM ending_set_at - now())) < 60 AS recent
        FROM things WHERE id = $1
      `, [copy])
      assert.deepEqual(cut, { millis: true, recent: true }, 'the copy time is the transaction time cut to milliseconds')
      assert.equal(row.ended_at, null)

      const changes = await copyChanges(copy)
      assert.equal(changes.length, 1)
      assert.equal(changes[0]!.change, 'copy')
      assert.equal(changes[0]!.actor_id, KEEPER.id)
      assert.deepEqual(changes[0]!.rule, row.ending_rule)
      assert.deepEqual(changes[0]!.grant, grant)
      assert.deepEqual(changes[0]!.result, { source_thing_id: parent, copied_at: (changes[0]!.result as Json).copied_at })
      assert.equal(iso((changes[0]!.result as Json).copied_at), iso(row.ending_copied_at))

      // The use counted on the parent after its programs ran; the copy is untouched by it.
      const after = await endColumns(parent)
      assert.equal(after.ending_uses_left, 2)

      // The parent's owner shortens, then clears the parent's end; the copy keeps its own.
      await db.query(`UPDATE things SET ending_deadline = now() + interval '1 hour' WHERE id = $1`, [parent])
      const cleared = await edit(parent, { ending: null })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      assert.deepEqual(await endColumns(copy), row, 'nothing done to the parent reaches the copy')

      // The copy's owner may not move it earlier or lower its uses, only clear it.
      const earlier = await edit(copy, { ending: { any: [{ at: await dbTime('1 day') }] } })
      assert.equal(earlier.status, 409, JSON.stringify(earlier.json))
      assert.equal(earlier.json.error, ENDING_COPY_FIXED_REFUSAL)
      const fewer = await edit(copy, { ending: { any: [{ uses: 1 }] } })
      assert.equal(fewer.status, 409, JSON.stringify(fewer.json))
      assert.ok(String(fewer.json.error).startsWith(ENDING_COPY_FIXED_REFUSAL))
      assert.deepEqual(await endColumns(copy), row)
      const clearCopy = await edit(copy, { ending: null })
      assert.equal(clearCopy.status, 200, JSON.stringify(clearCopy.json))
      const clearedRow = await endColumns(copy)
      assert.equal(clearedRow.ending_rule, null)
      assert.equal(clearedRow.ending_copied_from, parent, 'the copy origin stays after a clear')
      assert.equal(iso(clearedRow.ending_copied_at), iso(row.ending_copied_at))
    })

    await t.test('a copied unused-for end is an absolute deadline that ends the copy with cause idle_seconds', async () => {
      await reset()
      const moss = await kindWith('mosses', [['moss-spread', { use: [{ effect: 'copy', copies: 5 }] }]])
      const parent = await seedThing(KEEPER.id, home, moss, 'a moss')
      const at = await dbTime('1 day')
      // The parent's unused clock runs out about ten seconds from now; the use resets it.
      const anchor = await dbTime('-50 seconds')
      await setParentEnd(parent, {
        rule: { any: [{ at }, { idle_seconds: 60 }] }, grant: grantFor(moss),
        deadline: at, idleSeconds: 60, idleAnchor: anchor,
      })
      const copy = await copyByUse(parent)
      const until = new Date(new Date(anchor).getTime() + 60_000).toISOString()
      const row = await endColumns(copy)
      assert.deepEqual(row.ending_rule, { any: [{ at }, { idle_seconds: 60, until }] })
      assert.equal(iso(row.ending_deadline), until)

      await waitPastDatabaseTime(connectedDatabase(), new Date(until))
      assert.deepEqual(await recordDueEnd([copy, parent]), [copy], 'only the copy fell due; the use moved the parent clock')
      const ended = await endColumns(copy)
      assert.equal(ended.ended_cause, 'idle_seconds', 'the copy rule keeps the mode')
      assert.equal(iso(ended.ended_at), until)
      assert.equal((await endColumns(parent)).ended_at, null)
    })

    await t.test('a copy of a thing with no end has none and can never gain one', async () => {
      await reset()
      const reeds = await kindWith('reeds', [['reed-spread', { use: [{ effect: 'copy', copies: 5 }] }]])
      const parent = await seedThing(KEEPER.id, home, reeds, 'a reed')
      const copy = await copyByUse(parent)
      const row = await endColumns(copy)
      assert.equal(row.ending_rule, null)
      assert.equal(row.ending_grant, null)
      assert.equal(row.ending_copied_from, null)
      assert.equal(row.ending_copied_at, null)
      assert.equal(row.parent_thing_id, parent)
      assert.deepEqual(await copyChanges(copy), [])
      const gain = await edit(copy, { ending: { any: [{ uses: 2 }] } })
      assert.equal(gain.status, 409, JSON.stringify(gain.json))
      assert.equal(gain.json.error, ENDING_COPY_FIXED_REFUSAL)
    })

    await t.test('the copy step skips a parent whose end has come; only its own end try copies it, with no end', async () => {
      await reset()
      const lilies = await kindWith('lilies', [
        ['lily-spread', { use: [{ effect: 'copy', copies: 5 }] }],
        ['lily-last', { end: { then: [{ effect: 'copy' }] } }],
      ])
      const spreadId = await traitId('lily-spread')
      const parent = await seedThing(KEEPER.id, home, lilies, 'a lily')
      const other = await seedThing(KEEPER.id, home, lilies, 'another lily')
      await setParentEnd(parent, {
        rule: { any: [{ at: await dbTime('-1 minute') }] }, grant: grantFor(lilies),
        deadline: await dbTime('-1 minute'),
      })
      const effect = Object.freeze({
        effect: 'copy' as const, generations: 8, copies: 'unlimited' as const, to: 'here' as const, inherit: [],
      })
      const context = {
        actionId: null, actorId: KEEPER.id, actorHandle: KEEPER.handle, placeId: home,
        sourceThingId: parent, sharedSourceThingId: null, target: null, destinationPlaceId: null,
        recipientId: null, sourceTraitId: spreadId, sourceTraitName: 'lily-spread', lawAuthority: null,
        originThingId: parent, originPlaceId: home, parentEffectId: null, generation: 0,
        logicalAt: new Date(), trigger: 'use' as const, ownProgram: true,
      }
      const copyUnder = (writer: string | null) => withEngineTransaction(engineSql, async transaction => {
        if (writer !== null) await transaction`SELECT set_config('city.ending_writer', ${writer}, true)`
        return makeCopy(effect, context as never, transaction)
      })
      const children = async () => Number((await one<{ n: unknown }>(
        'SELECT count(*) AS n FROM things WHERE parent_thing_id = $1', [parent],
      )).n)
      const copiesMade = async () => Number((await one<{ n: unknown }>(
        'SELECT copies_made AS n FROM things WHERE id = $1', [parent],
      )).n)

      const due = await copyUnder(null)
      assert.ok('skipped' in due, JSON.stringify(due))
      assert.equal(due.skipped.effect, 'copy')
      assert.equal(due.skipped.target, 'source')
      assert.equal(due.skipped.reason, THING_ENDED_SKIP_REASON)
      assert.equal(await children(), 0)
      assert.equal((await endColumns(parent)).ended_at, null, 'the copy step records nothing')

      assert.deepEqual(await recordDueEnd([parent]), [parent])
      assert.equal((await one<Json>('SELECT end_program_state FROM things WHERE id = $1', [parent])).end_program_state, 'pending')
      for (const writer of [null, `end_try:${other}`, `record:${parent}`]) {
        const skipped = await copyUnder(writer)
        assert.ok('skipped' in skipped, `${writer}: ${JSON.stringify(skipped)}`)
        assert.equal(skipped.skipped.reason, THING_ENDED_SKIP_REASON)
      }
      assert.equal(await children(), 0)
      assert.equal(await copiesMade(), 0)

      const made = await copyUnder(`end_try:${parent}`)
      assert.ok('copiedThingId' in made, JSON.stringify(made))
      const row = await endColumns(made.copiedThingId)
      assert.equal(row.parent_thing_id, parent)
      assert.equal(row.ending_rule, null, 'a copy made by its parent own end try starts with no end')
      assert.equal(row.ending_grant, null)
      assert.equal(row.ending_copied_from, null)
      assert.deepEqual(await copyChanges(made.copiedThingId), [])
      assert.equal(await copiesMade(), 1)
    })
  } finally {
    await postgres.stop()
  }
})
