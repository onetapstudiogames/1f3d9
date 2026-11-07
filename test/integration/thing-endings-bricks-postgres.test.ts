// Thing endings inside programs (T10a), against real PostgreSQL on the full db/schema.sql
// and the real routes. No step inside any program touches a thing whose end has come:
// reach and convert leave it out, destroy, move, label and transfer skip it with their
// reason, check_label reads it as unlabelled, a waiting step aimed at it is skipped, a
// waking thing whose end came does not wake, and crafting refuses it as an ingredient.
// Each step reads due from the database, so a thing a label made due earlier in the same
// run is skipped by the next step, and the run finishes.
import assert from 'node:assert/strict'
import test from 'node:test'
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
import { waitPastPendingEffects } from '../helpers/database-clock.ts'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const KEEPER = Object.freeze({ id: 5, handle: 'end-keeper', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const KINDLESS_GRANT = Object.freeze({
  kindless: true,
  allowed: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'],
  limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: null },
  city_limits_version: 1,
})

async function one<T = Json>(text: string, values: readonly unknown[] = []): Promise<T> {
  return (await connectedDatabase().query(text, [...values])).rows[0] as T
}

async function count(text: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await one<{ n: unknown }>(text, values)).n)
}

/**
 * An end set an hour ago: a date this far from the database clock (negative is past), or
 * a label_added end on the named label, which only a label put on later can bring.
 */
async function setEnd(thingId: number, end: Readonly<{ at?: string; label?: string }>): Promise<void> {
  const when = end.at === undefined ? null : (await one<{ at: string }>(`
    SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
  `, [end.at])).at
  const rule = when !== null ? { any: [{ at: when }] } : { any: [{ label_added: end.label }] }
  await connectedDatabase().query(`
    UPDATE things SET ending_rule = $2::jsonb, ending_grant = $3::jsonb, ending_set_by = owner_id,
      ending_set_at = now() - interval '1 hour', ending_deadline = $4::timestamptz, ending_label = $5::text
    WHERE id = $1
  `, [thingId, JSON.stringify(rule), JSON.stringify(KINDLESS_GRANT), when, end.label ?? null])
}

async function row(thingId: number): Promise<Json> {
  return one(`
    SELECT owner_id, place_id, withdrawn_at, state, ended_at, as_kind_id,
      thing_end_due(id, now()) AS due
    FROM things WHERE id = $1
  `, [thingId])
}

async function labelsOn(thingId: number, label: string): Promise<number> {
  return count(`
    SELECT count(*) AS n FROM active_labels WHERE target_type = 'thing' AND target_id = $1 AND label = $2
  `, [thingId, label])
}

function skips(json: Json): Array<[unknown, unknown, unknown]> {
  const action = json.action as Json
  return ((action.skipped_effects ?? []) as Json[]).map(skip => [skip.effect, skip.reason, skip.member_id])
}

test('thing endings inside programs, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-bricks')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd } = await import('../../src/thing-ending-record.ts')
    const { resolveDueEffects } = await import('../../src/engine-effects.ts')
    const { settleRoom } = await import('../../src/engine-settle.ts')
    const { THING_ENDED_SKIP_REASON, THING_REMNANT_REFUSAL } = await import('../../src/thing-ending-refusals.ts')
    const db = connectedDatabase()

    let home = 0
    let shed = 0
    const reset = async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOUR, KEEPER])
      home = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
        VALUES ($1, 'place', 'Keeper Yard', 'the keeper''s own yard', $2, TRUE) RETURNING id
      `, [rooms.continentId, KEEPER.id])).id)
      shed = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
        VALUES ($1, 'place', 'Keeper Shed', 'a shed in the yard', $2, TRUE) RETURNING id
      `, [home, KEEPER.id])).id)
      await db.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id) VALUES ($1, $2, $2)
        ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
      `, [KEEPER.id, home])
    }
    const standAt = (placeId: number) => db.query(
      'UPDATE resident_presence SET current_place_id = $2 WHERE resident_id = $1', [KEEPER.id, placeId],
    )
    const act = (body: Json) => call(app, KEEPER.secret, 'POST', '/api/action', body)
    const kindWith = async (kind: string, trait: string, recipe: unknown) => {
      const coined = await coin(app, KEEPER.secret, trait, recipe)
      assert.equal(coined.status, 201, JSON.stringify(coined.json))
      return seedKind(KEEPER.id, kind, [await traitId(trait)])
    }
    const wakeOn = (thingId: number) => db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [thingId])

    await t.test('a reach leaves out things whose end came, and skips a member a label made due a step earlier', async () => {
      await reset()
      await standAt(shed)
      const taggers = await kindWith('taggers', 'tag-all', {
        use: [{ effect: 'reach', max: 16, then: [{ effect: 'label', target: 'target', label: 'tagged', permanent: true }] }],
      })
      const burners = await kindWith('burners', 'mark-and-burn', {
        use: [{ effect: 'reach', max: 16, then: [
          { effect: 'label', target: 'target', label: 'spent', permanent: true },
          { effect: 'destroy', target: 'target' },
        ] }],
      })
      const senders = await kindWith('senders', 'mark-and-send', {
        use: [{ effect: 'reach', max: 16, then: [
          { effect: 'label', target: 'target', label: 'spent', permanent: true },
          { effect: 'move', target: 'target', to: 'home' },
        ] }],
      })
      const givers = await kindWith('givers', 'mark-and-give', {
        use: [{ effect: 'reach', max: 16, then: [
          { effect: 'label', target: 'target', label: 'spent', permanent: true },
          { effect: 'transfer', target: 'target', to: 'recipient' },
        ] }],
      })
      const plain = await seedThing(KEEPER.id, shed, null, 'a plain pot')
      const due = await seedThing(KEEPER.id, shed, null, 'a due pot')
      const remnant = await seedThing(KEEPER.id, shed, null, 'a spent pot')
      await setEnd(due, { at: '-1 minute' })
      await setEnd(remnant, { at: '-2 minutes' })
      assert.deepEqual(await recordDueEnd([remnant]), [remnant])

      const tagger = await seedThing(KEEPER.id, shed, taggers, 'a tagger')
      const tagged = await act({ action: 'use', thing_id: tagger })
      assert.equal(tagged.status, 200, JSON.stringify(tagged.json))
      assert.deepEqual([await labelsOn(plain, 'tagged'), await labelsOn(due, 'tagged'), await labelsOn(remnant, 'tagged')], [1, 0, 0])
      const reached = await one<Json>(`SELECT detail FROM events WHERE kind = 'room_reached' ORDER BY id DESC LIMIT 1`)
      assert.equal((reached.detail as Json).reached, 1, 'a member whose end came is not a member')
      // The use's own room settle recorded it first (T11); the reach then left the remnant out.
      assert.notEqual((await row(due)).ended_at, null, 'the room settle records it, never the step')

      // Fresh members with a label end: the label step makes each one due, so the next step skips it.
      for (const [kind, name, effect] of [
        [burners, 'a burner', 'destroy'], [senders, 'a sender', 'move'], [givers, 'a giver', 'transfer'],
      ] as const) {
        await db.query(`UPDATE things SET withdrawn_at = now() WHERE place_id = $1 AND withdrawn_at IS NULL AND ended_at IS NULL AND ending_rule IS NULL`, [shed])
        const member = await seedThing(KEEPER.id, shed, null, `a pot for the ${effect}`)
        await setEnd(member, { label: 'spent' })
        const runner = await seedThing(KEEPER.id, shed, kind, name)
        const used = await act({
          action: 'use', thing_id: runner, ...(effect === 'transfer' ? { to_handle: NEIGHBOUR.handle } : {}),
        })
        assert.equal(used.status, 200, JSON.stringify(used.json))
        assert.deepEqual(skips(used.json), [[effect, THING_ENDED_SKIP_REASON, member]], `the ${effect} step skips the member`)
        assert.equal((used.json.action as Json).effects_applied, 1, 'the label landed and the run finished')
        const after = await row(member)
        assert.deepEqual([after.withdrawn_at, after.place_id, after.owner_id, after.due, after.ended_at],
          [null, shed, KEEPER.id, true, null], `${effect}: the member stays with its owner, due and unrecorded`)
      }
    })

    await t.test('destroy, move, label, convert and transfer skip a remnant target, check_label reads it unlabelled, and the rest runs', async () => {
      await reset()
      const steps = {
        destroy: { effect: 'destroy', target: 'target' },
        move: { effect: 'move', target: 'target', to: 'home' },
        label: { effect: 'label', target: 'target', label: 'tagged', permanent: true },
        convert: { effect: 'convert', target: 'target' },
        transfer: { effect: 'transfer', target: 'target', to: 'recipient' },
      } as const
      await standAt(shed)
      const potKind = await seedKind(KEEPER.id, 'pots', [])
      for (const [effect, step] of Object.entries(steps)) {
        const kind = await kindWith(`${effect}-tools`, `${effect}-then-count`, {
          use: [step, { effect: 'write', key: 'count', op: 'add' }],
        })
        const tool = await seedThing(KEEPER.id, shed, kind, `a ${effect} tool`)
        const remnant = await seedThing(KEEPER.id, shed, potKind, `a spent pot for ${effect}`, { openToConvert: true })
        await setEnd(remnant, { at: '-1 minute' })
        assert.deepEqual(await recordDueEnd([remnant]), [remnant])
        const used = await act({
          action: 'use', thing_id: tool, target_type: 'thing', target_id: remnant,
          ...(effect === 'transfer' ? { to_handle: NEIGHBOUR.handle } : {}),
        })
        assert.equal(used.status, 200, `${effect}: ${JSON.stringify(used.json)}`)
        assert.deepEqual(skips(used.json), [[effect, THING_ENDED_SKIP_REASON, undefined]], effect)
        assert.deepEqual((await row(tool)).state, { count: 1 }, `${effect}: the rest of the program runs`)
        const after = await row(remnant)
        assert.deepEqual([after.withdrawn_at, after.place_id, after.owner_id, after.as_kind_id], [null, shed, KEEPER.id, null], effect)
        assert.equal(await labelsOn(remnant, 'tagged'), 0, effect)
      }

      // A label it wore before its end no longer counts for check_label.
      const checkers = await kindWith('checkers', 'check-then-count', {
        use: [{ effect: 'check_label', target: 'target', label: 'worn', then: [{ effect: 'write', key: 'yes', op: 'add' }],
          else: [{ effect: 'write', key: 'no', op: 'add' }] }],
      })
      const checker = await seedThing(KEEPER.id, shed, checkers, 'a checker')
      const worn = await seedThing(KEEPER.id, shed, null, 'a worn pot')
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'worn', $2)
      `, [worn, KEEPER.id])
      assert.equal((await act({ action: 'use', thing_id: checker, target_type: 'thing', target_id: worn })).status, 200)
      await setEnd(worn, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([worn]), [worn])
      assert.equal((await act({ action: 'use', thing_id: checker, target_type: 'thing', target_id: worn })).status, 200)
      assert.deepEqual((await row(checker)).state, { yes: 1, no: 1 })

      // The guard refuses a label written past the engine.
      await assert.rejects(db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'tagged', $2)
      `, [worn, KEEPER.id]), (error: Error & { code?: string; constraint?: string }) => (
        error.code === '23514' && error.constraint === 'thing_ending_guard'
      ))
    })

    await t.test('a waiting step whose source or target ended meanwhile is skipped, and the room\'s other due steps run', async () => {
      await reset()
      const laterTaggers = await kindWith('later-taggers', 'later-tag', {
        use: [{ effect: 'wait', seconds: 3, then: [{ effect: 'label', target: 'target', label: 'tagged', permanent: true }] }],
      })
      const laterCounters = await kindWith('later-counters', 'later-count', {
        use: [{ effect: 'wait', seconds: 3, then: [{ effect: 'write', key: 'ticks', op: 'add' }] }],
      })
      const laterSelves = await kindWith('later-selves', 'later-self', {
        use: [{ effect: 'wait', seconds: 3, then: [
          { effect: 'label', target: 'source', label: 'spent' },
          { effect: 'write', key: 'after', op: 'add' },
        ] }],
      })
      const tagger = await seedThing(KEEPER.id, home, laterTaggers, 'a slow tagger')
      const target = await seedThing(KEEPER.id, home, null, 'a pot that ends meanwhile')
      const counter = await seedThing(KEEPER.id, home, laterCounters, 'a slow counter')
      const fading = await seedThing(KEEPER.id, home, laterCounters, 'a slow counter that ends meanwhile')
      const self = await seedThing(KEEPER.id, home, laterSelves, 'a slow self-labeller')
      await setEnd(self, { label: 'spent' })
      for (const body of [
        { action: 'use', thing_id: tagger, target_type: 'thing', target_id: target },
        { action: 'use', thing_id: counter },
        { action: 'use', thing_id: fading },
        { action: 'use', thing_id: self },
      ]) {
        const used = await act(body)
        assert.equal(used.status, 200, JSON.stringify(used.json))
      }
      await setEnd(target, { at: '-1 second' })
      await setEnd(fading, { at: '-1 second' })
      await waitPastPendingEffects(db)
      assert.deepEqual(await resolveDueEffects(home), { resolved: 4, failed: 0, capped: false })
      const resolutions = (await db.query<{ source_thing_id: number; status: string; detail: Json }>(`
        SELECT pending.source_thing_id, resolution.status, resolution.detail
        FROM effect_resolutions resolution JOIN pending_effects pending ON pending.id = resolution.pending_effect_id
        ORDER BY pending.id
      `)).rows
      const bySource = new Map(resolutions.map(resolution => [resolution.source_thing_id, resolution]))
      const reasons = (id: number) => ((bySource.get(id)?.detail.skipped_effects ?? []) as Json[]).map(skip => [skip.effect, skip.target, skip.reason])
      assert.equal(bySource.get(tagger)?.status, 'skipped')
      assert.deepEqual(reasons(tagger), [['wait', 'target', THING_ENDED_SKIP_REASON]])
      assert.equal(await labelsOn(target, 'tagged'), 0)
      assert.equal(bySource.get(fading)?.status, 'skipped')
      assert.deepEqual(reasons(fading), [['wait', 'source', THING_ENDED_SKIP_REASON]])
      assert.deepEqual((await row(fading)).state, {})
      assert.equal(bySource.get(counter)?.status, 'applied', 'the other due steps run')
      assert.deepEqual((await row(counter)).state, { ticks: 1 })
      // The timer labels its own thing with its end label; its next step, a write, is skipped.
      assert.equal(bySource.get(self)?.status, 'applied')
      assert.deepEqual(reasons(self), [['write', 'source', THING_ENDED_SKIP_REASON]])
      const selfAfter = await row(self)
      assert.deepEqual([selfAfter.state, selfAfter.due, selfAfter.ended_at], [{}, true, null])
      assert.equal((await row(target)).ended_at, null, 'a step records nothing')
    })

    await t.test('a thing whose end came does not wake, and a waking thing that labels itself due skips its write', async () => {
      await reset()
      const glows = await kindWith('glows', 'glow', { wake: { then: [{ effect: 'write', key: 'woke', op: 'add' }] } })
      const spenders = await kindWith('spenders', 'self-spend', {
        wake: { then: [
          { effect: 'label', target: 'source', label: 'spent' },
          { effect: 'write', key: 'woke', op: 'add' },
        ] },
      })
      const awake = await seedThing(KEEPER.id, home, glows, 'a glowing lamp')
      const due = await seedThing(KEEPER.id, home, glows, 'a lamp whose end came')
      const remnant = await seedThing(KEEPER.id, home, glows, 'a spent lamp')
      const spender = await seedThing(KEEPER.id, home, spenders, 'a lamp that spends itself')
      for (const id of [awake, due, remnant, spender]) await wakeOn(id)
      await setEnd(due, { at: '-1 minute' })
      await setEnd(remnant, { at: '-2 minutes' })
      assert.deepEqual(await recordDueEnd([remnant]), [remnant])
      await setEnd(spender, { label: 'spent' })
      const summary = await settleRoom(home, 'arrive', KEEPER.id)
      assert.notEqual(summary, null)
      const tries = (await db.query<{ thing_id: number; status: string; skipped_effects: Json[] }>(
        'SELECT thing_id, status, skipped_effects FROM wake_tries ORDER BY thing_id',
      )).rows
      assert.deepEqual(tries.map(attempt => attempt.thing_id), [awake, spender], 'only things whose end has not come wake')
      assert.deepEqual((await row(awake)).state, { woke: 1 })
      const spent = tries.find(attempt => attempt.thing_id === spender)!
      assert.equal(spent.status, 'woke', 'its label landed')
      assert.deepEqual(spent.skipped_effects.map(skip => [skip.effect, skip.reason]), [['write', THING_ENDED_SKIP_REASON]])
      const after = await row(spender)
      assert.deepEqual([after.state, after.due, after.ended_at], [{}, true, null])
      assert.notEqual((await row(due)).ended_at, null, 'the settle records the end that came in its room (T11)')
    })

    await t.test('crafting records a due ingredient and refuses E7, and refuses an older remnant', async () => {
      await reset()
      const reeds = await seedKind(KEEPER.id, 'reeds', [])
      const baskets = Number((await one<{ id: number }>(
        'INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', ['baskets', KEEPER.id],
      )).id)
      await db.query(`
        INSERT INTO kind_revisions (kind_id, revision, traits, recipe) VALUES ($1, 1, '{}'::text[], $2::jsonb)
      `, [baskets, JSON.stringify([{ kind: 'reeds', quantity: 1 }])])
      const make = (ingredient: number) => call(app, KEEPER.secret, 'POST', '/api/thing', {
        place_id: home, name: 'a basket', body: '', kind_id: baskets, ingredient_ids: [ingredient],
      })
      const due = await seedThing(KEEPER.id, home, reeds, 'a due reed')
      await setEnd(due, { at: '-1 minute' })
      const first = await make(due)
      assert.equal(first.status, 409, JSON.stringify(first.json))
      assert.equal(first.json.error, THING_REMNANT_REFUSAL)
      let after = await row(due)
      assert.notEqual(after.ended_at, null, 'crafting records first')
      assert.equal(after.withdrawn_at, null, 'the ingredient is not used')
      const again = await make(due)
      assert.equal(again.status, 409, JSON.stringify(again.json))
      assert.ok(String(again.json.error).startsWith(THING_REMNANT_REFUSAL), 'an older remnant is refused too')
      after = await row(due)
      assert.equal(after.withdrawn_at, null)
      assert.equal(await count(`SELECT count(*) AS n FROM things WHERE kind_id = $1`, [baskets]), 0)
      const fresh = await seedThing(KEEPER.id, home, reeds, 'a fresh reed')
      const made = await make(fresh)
      assert.equal(made.status, 201, JSON.stringify(made.json))
    })
  } finally {
    await postgres.stop()
  }
})
