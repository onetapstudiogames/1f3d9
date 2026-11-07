// Thing endings at the doors that change hands, withdraw, mark and offer (T9), against real
// PostgreSQL on the full db/schema.sql and the real routes. A thing with an end set never
// changes owner except by a sale already open: every give refuses E9 before anything is
// held, and an accepted held gift refuses E9b. Each door records a due end first, then
// refuses E7 for a thing that has just become a remnant; an older remnant may still be
// given, carried, set down or withdrawn. Withdrawing a remnant skips its waiting end try.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Hono } from 'hono'
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
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

// The keeper owns and makes every thing here. It is not a founder, so a mute holds its gifts.
const KEEPER = Object.freeze({ id: 5, handle: 'end-keeper', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const WALLET = `0x${'ab'.repeat(20)}`
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

/** An end at a date this far from the database clock (negative is past), set an hour ago. */
async function setEnd(thingId: number, at: string): Promise<void> {
  const when = (await one<{ at: string }>(`
    SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
  `, [at])).at
  await connectedDatabase().query(`
    UPDATE things SET ending_rule = $2::jsonb, ending_grant = $3::jsonb, ending_set_by = owner_id,
      ending_set_at = now() - interval '1 hour', ending_deadline = $4::timestamptz
    WHERE id = $1
  `, [thingId, JSON.stringify({ any: [{ at: when }] }), JSON.stringify(KINDLESS_GRANT), when])
}

async function row(thingId: number): Promise<Json> {
  return one(`
    SELECT owner_id, place_id, held_by, withdrawn_at, active_offer_id, wake_enabled, state,
      ended_at, end_program_state, end_program_result
    FROM things WHERE id = $1
  `, [thingId])
}

async function endedEvents(thingId: number): Promise<number> {
  return count(`SELECT count(*) AS n FROM events WHERE kind = 'thing_ended' AND detail->>'thing_id' = $1::text`, [thingId])
}

async function waitingId(thingId: number): Promise<number> {
  return Number((await one<{ id: number }>(
    'SELECT id FROM waiting_transfers WHERE asset_type = $1 AND asset_id = $2 AND answer IS NULL', ['thing', thingId],
  )).id)
}

test('thing endings at the gift, withdraw, mark and offer doors, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-doors')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd, recordDueEndQuietly } = await import('../../src/thing-ending-record.ts')
    const { mountWorldMarketRoutes } = await import('../../src/world-market.ts')
    const { waitingAcceptFailed } = await import('../../src/waiting-transfers.ts')
    const {
      ENDING_GIFT_ACCEPT_REFUSAL,
      ENDING_GIVE_REFUSAL,
      ENDING_MARKED_REFUSAL,
      THING_ENDED_SKIP_REASON,
      THING_REMNANT_REFUSAL,
    } = await import('../../src/thing-ending-refusals.ts')
    const db = connectedDatabase()

    let home = 0
    let closed = 0
    let inner = 0
    const reset = async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOUR, KEEPER])
      home = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
        VALUES ($1, 'place', 'Keeper Yard', 'the keeper''s own yard', $2, TRUE) RETURNING id
      `, [rooms.continentId, KEEPER.id])).id)
      // Two rooms the keeper does not own and that do not take things: a carried thing stays held.
      closed = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'place', 'Closed Porch', 'no things stay here', $2) RETURNING id
      `, [home, FOUNDER.id])).id)
      inner = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'place', 'Closed Hall', 'no things stay here either', $2) RETURNING id
      `, [closed, FOUNDER.id])).id)
      await db.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id) VALUES ($1, $2, $2)
        ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
      `, [KEEPER.id, home])
      await standIn(NEIGHBOUR.id, home)
    }
    const thing = (name = 'an ending lantern') => seedThing(KEEPER.id, home, null, name)
    const act = (body: Json) => call(app, KEEPER.secret, 'POST', '/api/action', body)
    const transfer = (id: number) => call(app, KEEPER.secret, 'POST', '/api/transfer', { type: 'thing', id, to_handle: NEIGHBOUR.handle })
    const mute = () => db.query(
      `INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES ($1, 'resident', $2, 'mute')`,
      [NEIGHBOUR.id, KEEPER.id],
    )
    const transfers = (id: number) => count(`SELECT count(*) AS n FROM transfers WHERE asset_type = 'thing' AND asset_id = $1`, [id])
    const waitingRows = (id: number) => count(`SELECT count(*) AS n FROM waiting_transfers WHERE asset_id = $1`, [id])

    await t.test('a thing with a running clock is refused E9 on every give, and a muted recipient never holds it', async () => {
      await reset()
      const lantern = await thing()
      await setEnd(lantern, '5 days')
      const refusals = [
        await act({ action: 'give', thing_id: lantern, to_handle: NEIGHBOUR.handle }),
        await act({ action: 'give', target_type: 'thing', target_id: lantern, to_handle: NEIGHBOUR.handle }),
        await transfer(lantern),
      ]
      for (const refused of refusals) {
        assert.equal(refused.status, 409, JSON.stringify(refused.json))
        assert.ok(String(refused.json.error).startsWith(ENDING_GIVE_REFUSAL), JSON.stringify(refused.json))
      }
      await mute()
      for (const refused of [await transfer(lantern), await act({ action: 'give', thing_id: lantern, to_handle: NEIGHBOUR.handle })]) {
        assert.equal(refused.status, 409, JSON.stringify(refused.json))
        assert.ok(String(refused.json.error).startsWith(ENDING_GIVE_REFUSAL))
      }
      assert.equal((await row(lantern)).owner_id, KEEPER.id)
      assert.equal(await transfers(lantern), 0)
      assert.equal(await waitingRows(lantern), 0, 'refused at once, never held')
      // A sale offer of a thing whose end is still to come may open.
      const offer = await call(app, KEEPER.secret, 'POST', '/api/transfer/offer', {
        type: 'thing', id: lantern, to_handle: NEIGHBOUR.handle, price_usdc: 1, seller_wallet: WALLET,
      })
      assert.equal(offer.status, 201, JSON.stringify(offer.json))
    })

    await t.test('a transfer step refuses E9 on a thing with a running clock and skips a remnant', async () => {
      await reset()
      await coin(app, KEEPER.secret, 'hand-over', { use: [{ effect: 'transfer', target: 'source', to: 'recipient' }] })
      await coin(app, KEEPER.secret, 'pass-along', {
        use: [{ effect: 'transfer', target: 'target', to: 'recipient' }, { effect: 'write', key: 'passed', op: 'add' }],
      })
      const parcel = await seedThing(KEEPER.id, home, await seedKind(KEEPER.id, 'parcels', [await traitId('hand-over')]), 'a parcel')
      await setEnd(parcel, '5 days')
      const used = await act({ action: 'use', thing_id: parcel, to_handle: NEIGHBOUR.handle })
      assert.equal(used.status, 409, JSON.stringify(used.json))
      assert.equal(used.json.error, ENDING_GIVE_REFUSAL)
      assert.equal((await row(parcel)).owner_id, KEEPER.id)
      assert.equal(await transfers(parcel), 0)

      const passer = await seedThing(KEEPER.id, home, await seedKind(KEEPER.id, 'passers', [await traitId('pass-along')]), 'a passer')
      const remnant = await thing('a spent lantern')
      await setEnd(remnant, '-1 minute')
      assert.deepEqual(await recordDueEnd([remnant]), [remnant])
      const passed = await act({ action: 'use', thing_id: passer, target_type: 'thing', target_id: remnant, to_handle: NEIGHBOUR.handle })
      assert.equal(passed.status, 200, JSON.stringify(passed.json))
      const action = passed.json.action as Json
      assert.deepEqual((action.skipped_effects as Json[]).map(skip => [skip.effect, skip.reason]), [['transfer', THING_ENDED_SKIP_REASON]])
      assert.equal(action.effects_applied, 1, 'the rest of the program runs')
      assert.deepEqual((await row(passer)).state, { passed: 1 })
      assert.equal((await row(remnant)).owner_id, KEEPER.id)
    })

    await t.test('accepting a held gift after its giver set an end refuses E9b; the gift ends and stays with the giver', async () => {
      await reset()
      await mute()
      const lantern = await thing()
      const held = await transfer(lantern)
      assert.equal(held.status, 200, JSON.stringify(held.json))
      const waiting = await waitingId(lantern)
      await setEnd(lantern, '5 days')
      const accepted = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${waiting}/accept`)
      assert.equal(accepted.status, 409, JSON.stringify(accepted.json))
      assert.equal(accepted.json.error, waitingAcceptFailed(waiting, ENDING_GIFT_ACCEPT_REFUSAL))
      assert.deepEqual(await one('SELECT answer, answer_detail FROM waiting_transfers WHERE id = $1', [waiting]), {
        answer: 'failed', answer_detail: ENDING_GIFT_ACCEPT_REFUSAL,
      })
      assert.equal((await row(lantern)).owner_id, KEEPER.id)
      assert.equal(await transfers(lantern), 0)
    })

    await t.test('a held gift whose end came records first: accept refuses E7, decline proceeds; an older remnant is accepted', async () => {
      await reset()
      await mute()
      const dueAccept = await thing('a lantern accepted too late')
      const dueDecline = await thing('a lantern declined')
      for (const id of [dueAccept, dueDecline]) assert.equal((await transfer(id)).status, 200)
      const acceptId = await waitingId(dueAccept)
      const declineId = await waitingId(dueDecline)
      await setEnd(dueAccept, '-1 minute')
      await setEnd(dueDecline, '-1 minute')
      const accepted = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${acceptId}/accept`)
      assert.equal(accepted.status, 409, JSON.stringify(accepted.json))
      assert.equal(accepted.json.error, waitingAcceptFailed(acceptId, THING_REMNANT_REFUSAL))
      assert.deepEqual(await one('SELECT answer, answer_detail FROM waiting_transfers WHERE id = $1', [acceptId]), {
        answer: 'failed', answer_detail: THING_REMNANT_REFUSAL,
      })
      assert.equal((await row(dueAccept)).owner_id, KEEPER.id)
      assert.notEqual((await row(dueAccept)).ended_at, null, 'recorded first')
      const declined = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${declineId}/decline`)
      assert.equal(declined.status, 200, JSON.stringify(declined.json))
      assert.notEqual((await row(dueDecline)).ended_at, null, 'decline records and proceeds')
      assert.equal(await endedEvents(dueDecline), 1)

      // An older remnant has no clock left: it is held, then accepted, with its switches off.
      const remnant = await thing('an older remnant')
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [remnant])
      await setEnd(remnant, '-1 minute')
      assert.deepEqual(await recordDueEnd([remnant]), [remnant])
      assert.equal((await transfer(remnant)).status, 200)
      const remnantWaiting = await waitingId(remnant)
      const moved = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${remnantWaiting}/accept`)
      assert.equal(moved.status, 200, JSON.stringify(moved.json))
      const after = await row(remnant)
      assert.equal(after.owner_id, NEIGHBOUR.id)
      assert.equal(after.wake_enabled, false)
    })

    await t.test('a give of a due thing records it and refuses E7; an older remnant gives by transfer and by act', async () => {
      await reset()
      const byTarget = await thing('a target lantern')
      await setEnd(byTarget, '-1 minute')
      const refused = await act({ action: 'give', target_type: 'thing', target_id: byTarget, to_handle: NEIGHBOUR.handle })
      assert.equal(refused.status, 409, JSON.stringify(refused.json))
      assert.equal(refused.json.error, THING_REMNANT_REFUSAL)
      assert.equal((await row(byTarget)).owner_id, KEEPER.id)
      assert.notEqual((await row(byTarget)).ended_at, null)
      const given = await act({ action: 'give', target_type: 'thing', target_id: byTarget, to_handle: NEIGHBOUR.handle })
      assert.equal(given.status, 200, JSON.stringify(given.json))
      assert.equal((await row(byTarget)).owner_id, NEIGHBOUR.id)
      assert.equal(await endedEvents(byTarget), 1)
    })

    await t.test('withdraw records a due thing and refuses E7, then withdraws a remnant and skips its waiting end try', async () => {
      await reset()
      await coin(app, KEEPER.secret, 'end-glow', { end: { then: [] } })
      const lamps = await seedKind(KEEPER.id, 'glowing-lamps', [await traitId('end-glow')])
      const withdraw = (id: number, name: string) => call(app, KEEPER.secret, 'POST', `/api/thing/${id}/withdraw`, { thing_name: name })

      const due = await thing('a due lantern')
      await setEnd(due, '-1 minute')
      const refused = await withdraw(due, 'a due lantern')
      assert.equal(refused.status, 409, JSON.stringify(refused.json))
      assert.equal(refused.json.error, THING_REMNANT_REFUSAL)
      assert.equal((await row(due)).withdrawn_at, null)
      assert.notEqual((await row(due)).ended_at, null)
      const withdrawn = await withdraw(due, 'a due lantern')
      assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.json))
      const plain = await row(due)
      assert.notEqual(plain.withdrawn_at, null)
      assert.equal(plain.end_program_state, 'none')
      assert.equal(plain.end_program_result, null)

      const pending = await seedThing(KEEPER.id, home, lamps, 'a glowing lamp')
      await setEnd(pending, '-1 minute')
      assert.deepEqual(await recordDueEnd([pending]), [pending])
      assert.equal((await row(pending)).end_program_state, 'pending')
      const skipped = await withdraw(pending, 'a glowing lamp')
      assert.equal(skipped.status, 200, JSON.stringify(skipped.json))
      const after = await row(pending)
      assert.notEqual(after.withdrawn_at, null)
      assert.equal(after.end_program_state, 'skipped')
      assert.deepEqual(after.end_program_result, { skipped: 'withdrawn' })
      assert.deepEqual(await one(`
        SELECT actor_id, result FROM thing_ending_changes WHERE thing_id = $1 AND change = 'program'
      `, [pending]), { actor_id: KEEPER.id, result: { skipped: 'withdrawn' } })

      // A program that already ran keeps its state and result.
      const ran = await seedThing(KEEPER.id, home, lamps, 'a lamp that glowed')
      await setEnd(ran, '-1 minute')
      assert.deepEqual(await recordDueEnd([ran]), [ran])
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('city.ending_writer', $1, true)`, [`end_try:${ran}`])
        await client.query(`UPDATE things SET end_program_state = 'ran', end_program_result = '{"ran": true}' WHERE id = $1`, [ran])
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      assert.equal((await withdraw(ran, 'a lamp that glowed')).status, 200)
      const kept = await row(ran)
      assert.equal(kept.end_program_state, 'ran')
      assert.deepEqual(kept.end_program_result, { ran: true })
      assert.equal(await count(`SELECT count(*) AS n FROM thing_ending_changes WHERE thing_id = $1 AND change = 'program'`, [ran]), 0)
    })

    await t.test('mark_for_later refuses E4 on a running clock and E7 on a remnant, records first, and unmark always works', async () => {
      await reset()
      const mark = (secret: string, id: number, action = 'mark') => call(app, secret, 'POST', `/api/thing/${id}/mark`, { action })
      const active = await thing('a ticking lantern')
      await setEnd(active, '5 days')
      const ticking = await mark(KEEPER.secret, active)
      assert.equal(ticking.status, 409, JSON.stringify(ticking.json))
      assert.equal(ticking.json.error, ENDING_MARKED_REFUSAL)
      const stranger = await mark(NEIGHBOUR.secret, active)
      assert.equal(stranger.status, 403, JSON.stringify(stranger.json))

      const due = await thing('a due lantern')
      await setEnd(due, '-1 minute')
      const recorded = await mark(KEEPER.secret, due)
      assert.equal(recorded.status, 409, JSON.stringify(recorded.json))
      assert.equal(recorded.json.error, THING_REMNANT_REFUSAL)
      assert.notEqual((await row(due)).ended_at, null)
      const again = await mark(KEEPER.secret, due)
      assert.equal(again.status, 409)
      assert.ok(String(again.json.error).startsWith(THING_REMNANT_REFUSAL), 'an older remnant refuses E7 too')
      assert.equal(await count('SELECT count(*) AS n FROM thing_later_holder_marks'), 0)
      const unmarked = await mark(KEEPER.secret, due, 'unmark')
      assert.equal(unmarked.status, 200, JSON.stringify(unmarked.json))
      // A thing with no end still marks.
      assert.equal((await mark(KEEPER.secret, await thing('a plain lantern'))).status, 200)
    })

    await t.test('list_world records a due thing and refuses E7; a thing with a running clock lists', async () => {
      await reset()
      const listing = new Hono()
      listing.onError(error => { throw error })
      let draftThing = 0
      const now = new Date()
      mountWorldMarketRoutes(listing, {
        query: async (text, params) => (await db.query(text, [...params])).rows,
        authenticate: async () => ({ id: KEEPER.id, handle: KEEPER.handle }),
        now: () => new Date(),
        marketOrigin: 'https://1f3ea.com',
        marketGet: async () => ({ draft: {
          id: 71, status: 'pending', delivery_kind: 'city_ownership', world_asset: { type: 'thing', id: draftThing },
          title: 'an ending lantern', description: 'a lantern with an end', preview: 'a lantern',
          price_usdc: 2, seller_wallet: WALLET, listing_id: null, listing_state: null,
          expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
          created_at: new Date(now.getTime() - 60_000).toISOString(),
        } }),
        findPayment: async () => { throw new Error('no payment in this suite') },
        runPayment: async () => { throw new Error('no payment in this suite') },
        resumePayment: async () => { throw new Error('no payment in this suite') },
        recordEnds: ids => recordDueEndQuietly(ids),
      })
      const list = async (id: number) => {
        draftThing = id
        const response = await listing.request('/api/world/listing', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ thing_id: id, market_draft_id: 71 }),
        })
        return Object.freeze({ status: response.status, json: await response.json() as Json })
      }
      const due = await thing('a due lantern')
      await setEnd(due, '-1 minute')
      const refused = await list(due)
      assert.equal(refused.status, 409, JSON.stringify(refused.json))
      assert.equal(refused.json.error, THING_REMNANT_REFUSAL)
      assert.notEqual((await row(due)).ended_at, null)
      assert.equal((await row(due)).active_offer_id, null)
      const active = await thing('a ticking lantern')
      await setEnd(active, '5 days')
      const listed = await list(active)
      assert.equal(listed.status, 201, JSON.stringify(listed.json))
      assert.notEqual((await row(active)).active_offer_id, null)
    })

    await t.test('cancelling an offer on a thing whose end came records it and unlocks it', async () => {
      await reset()
      const lantern = await thing()
      await setEnd(lantern, '5 days')
      const offer = await call(app, KEEPER.secret, 'POST', '/api/transfer/offer', {
        type: 'thing', id: lantern, to_handle: NEIGHBOUR.handle, price_usdc: 1, seller_wallet: WALLET,
      })
      assert.equal(offer.status, 201, JSON.stringify(offer.json))
      await setEnd(lantern, '-1 minute')
      const offerId = Number((offer.json.offer as Json).id)
      const canceled = await call(app, KEEPER.secret, 'POST', `/api/transfer/${offerId}/cancel`)
      assert.equal(canceled.status, 200, JSON.stringify(canceled.json))
      const after = await row(lantern)
      assert.equal(after.active_offer_id, null)
      assert.notEqual(after.ended_at, null)
      assert.equal(after.owner_id, KEEPER.id)
    })

    await t.test('a carried thing: carrying a due one records and proceeds, and one that ends while held follows home', async () => {
      await reset()
      const due = await thing('a due lantern')
      await setEnd(due, '-1 minute')
      const carried = await act({ action: 'move', to_place_id: closed, carry_thing_id: due })
      assert.equal(carried.status, 200, JSON.stringify(carried.json))
      let after = await row(due)
      assert.notEqual(after.ended_at, null, 'carry records first')
      assert.equal(after.place_id, closed)
      assert.equal(after.held_by, KEEPER.id, 'a closed room does not take it')
      const wentHome = await act({ action: 'go_home' })
      assert.equal(wentHome.status, 200, JSON.stringify(wentHome.json))
      after = await row(due)
      assert.equal(after.place_id, home)
      assert.equal(after.held_by, null, 'set down at home, where things may stay')

      const ticking = await thing('a ticking lantern')
      await setEnd(ticking, '10 seconds')
      assert.equal((await act({ action: 'move', to_place_id: closed, carry_thing_id: ticking })).status, 200)
      await delay(10_500)
      assert.equal((await one<Json>('SELECT thing_end_due(id, now()) AS due FROM things WHERE id = $1', [ticking])).due, true)
      const onward = await act({ action: 'move', to_place_id: inner })
      assert.equal(onward.status, 200, JSON.stringify(onward.json))
      after = await row(ticking)
      assert.deepEqual([after.place_id, after.held_by], [inner, KEEPER.id], 'it follows, still held')
      assert.notEqual(after.ended_at, null, 'the arrival settle in its new room records it (T11)')
      const back = await act({ action: 'go_home' })
      assert.equal(back.status, 200, JSON.stringify(back.json))
      after = await row(ticking)
      assert.deepEqual([after.place_id, after.held_by], [home, null], 'a remnant is still carried and set down')
      assert.deepEqual(await recordDueEnd([ticking]), [], 'recorded once')
      assert.equal(await endedEvents(ticking), 1)
    })
  } finally {
    await postgres.stop()
  }
})
