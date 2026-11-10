// The settle step and end tries (things ending, T11), against real PostgreSQL on the full
// db/schema.sql and the real routes. A room settle records up to 64 ends that came there,
// then runs each recorded thing's end program at most once, inside the settle's budget,
// and only when a resident is in the room. A write from elsewhere only records the end.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
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
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const KEEPER = Object.freeze({ id: 5, handle: 'end-keeper', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const WALLET = `0x${'a'.repeat(40)}`
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
async function setEnd(thingIds: number | readonly number[], end: Readonly<{ at?: string; label?: string }>): Promise<void> {
  const when = end.at === undefined ? null : (await one<{ at: string }>(`
    SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
  `, [end.at])).at
  const rule = when !== null ? { any: [{ at: when }] } : { any: [{ label_added: end.label }] }
  await connectedDatabase().query(`
    UPDATE things SET ending_rule = $2::jsonb, ending_grant = $3::jsonb, ending_set_by = owner_id,
      ending_set_at = now() - interval '1 hour', ending_deadline = $4::timestamptz, ending_label = $5::text
    WHERE id = ANY($1::int[])
  `, [typeof thingIds === 'number' ? [thingIds] : thingIds, JSON.stringify(rule), JSON.stringify(KINDLESS_GRANT),
    when, end.label ?? null])
}

async function row(thingId: number): Promise<Json> {
  return one(`
    SELECT owner_id, place_id, withdrawn_at, state, ended_at, end_program_state, end_program_result,
      thing_end_due(id, now()) AS due
    FROM things WHERE id = $1
  `, [thingId])
}

async function endTries(thingId: number): Promise<Json[]> {
  return (await connectedDatabase().query(`
    SELECT id, settle_id, status, effects_applied, error FROM wake_tries
    WHERE thing_id = $1 AND reason = 'end' ORDER BY id
  `, [thingId])).rows as Json[]
}

/** Let the room's 10-second quiet pass, as if its last settle were this much older. */
async function ageRoom(placeId: number, seconds: number): Promise<void> {
  const db = connectedDatabase()
  await db.query('ALTER TABLE wake_settles DISABLE TRIGGER wake_settles_append_only')
  try {
    await db.query(
      'UPDATE wake_settles SET created_at = created_at - make_interval(secs => $2) WHERE place_id = $1',
      [placeId, seconds],
    )
  } finally {
    await db.query('ALTER TABLE wake_settles ENABLE TRIGGER wake_settles_append_only')
  }
}

async function changeMarker(app: CityApp): Promise<string> {
  const read = await call(app, null, 'GET', '/api/changes')
  assert.equal(read.status, 200, JSON.stringify(read.json))
  return String(read.json.change_marker)
}

/** Wait until the database shows what a concurrent settle has reached. */
async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await delay(25)
  }
  assert.fail(`the concurrent settle did not reach: ${what}`)
}

test('thing endings in the room settle, against PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-settle')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd, recordDueEndQuietly } = await import('../../src/thing-ending-record.ts')
    const { settleRoom, settleRoomAndRecord } = await import('../../src/engine-settle.ts')
    const { mountWorldMarketRoutes } = await import('../../src/world-market.ts')
    const { END_TRY_SKIP_REASONS } = await import('../../src/thing-ending-refusals.ts')
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
    /** A kind whose one trait carries an end key with these steps. */
    const endKind = async (kind: string, trait: string, then: unknown[]) => {
      const coined = await coin(app, KEEPER.secret, trait, { end: { then } })
      assert.equal(coined.status, 201, JSON.stringify(coined.json))
      return seedKind(KEEPER.id, kind, [await traitId(trait)])
    }
    /** A thing of the kind with waking on, owned by `ownerId`, standing in `placeId`. */
    const waking = async (ownerId: number, placeId: number, kindId: number | null, name: string) => {
      const id = await seedThing(ownerId, placeId, kindId, name)
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [id])
      return id
    }
    const roomSettled = async (): Promise<Json[]> => (await db.query(`
      SELECT actor, detail FROM events WHERE kind = 'room_settled' ORDER BY id
    `)).rows as Json[]

    await t.test('seventy things due at the same moment record 64, then 6, and say more_due', async () => {
      await reset()
      const marker = await changeMarker(app)
      const ids: number[] = []
      for (let index = 0; index < 70; index += 1) ids.push(await seedThing(KEEPER.id, home, null, `pebble ${index}`))
      await setEnd(ids, { at: '-1 minute' })

      const first = await settleRoomAndRecord(home, 'arrive', KEEPER.id)
      assert.deepEqual(first.settle, {
        settle_id: null, tried: 0, woke: 0, forfeited: 0, ended: 64, end_tries: 0, more_due: true,
      }, 'a settle that only recorded answers with no settle_id')
      assert.deepEqual([...first.recordedThingIds], ids.slice(0, 64), 'the first 64 by id')
      assert.equal(await count(`SELECT count(*) AS n FROM things WHERE ended_at IS NOT NULL`), 64)
      assert.equal(await count(`SELECT count(*) AS n FROM wake_settles`), 0, 'recording alone claims nothing')
      const [settled] = await roomSettled() as [Json]
      assert.equal(settled.actor, KEEPER.handle)
      assert.deepEqual(settled.detail, {
        settle_id: null, place_id: home, mode: 'arrive', status: 'quiet',
        tried: 0, woke: 0, forfeited: 0, budget: 8, ended: 64, end_tries: 0, more_due: true,
      })

      // Inside the 10-second quiet: recording is not limited by it.
      const second = await settleRoom(home, 'me', KEEPER.id)
      assert.deepEqual(second, {
        settle_id: null, tried: 0, woke: 0, forfeited: 0, ended: 6, end_tries: 0, more_due: false,
      })
      assert.equal(await count(`SELECT count(*) AS n FROM things WHERE ended_at IS NOT NULL`), 70)
      assert.equal(await count(`SELECT count(*) AS n FROM events WHERE kind = 'thing_ended'`), 70)

      const third = await settleRoomAndRecord(home, 'me', KEEPER.id)
      assert.deepEqual(third, { settle: null, recordedThingIds: [] }, 'nothing recorded and nothing claimed writes nothing')
      assert.equal((await roomSettled()).length, 2)

      const changes = await call(app, null, 'GET', `/api/changes?since=${marker}&limit=200`)
      assert.equal(changes.status, 200, JSON.stringify(changes.json))
      const feed = (changes.json.changes as Json[]).filter(change => change.kind === 'room_settled')
      assert.deepEqual(feed.map(change => {
        const detail = change.detail as Json
        return [detail.settle_id, detail.ended, detail.end_tries, detail.more_due]
      }), [[null, 64, 0, true], [null, 6, 0, false]], "room_settled's new fields reach /api/changes")
    })

    await t.test('a remote touch only records the end; the next settle in its room runs the program once', async () => {
      await reset()
      await standAt(shed)
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const marked = await waking(KEEPER.id, home, lanterns, 'a marked lantern')
      const listed = await waking(KEEPER.id, home, lanterns, 'a listed lantern')
      await setEnd([marked, listed], { at: '-1 minute' })

      // mark_for_later from a neighbour, far away.
      const mark = await call(app, NEIGHBOUR.secret, 'POST', `/api/thing/${marked}/mark`, { action: 'mark' })
      assert.notEqual(mark.status, 200, JSON.stringify(mark.json))
      // list_world by the owner, who stands in the shed.
      const listing = new Hono()
      listing.onError(error => { throw error })
      const now = new Date()
      mountWorldMarketRoutes(listing, {
        query: async (text, params) => (await db.query(text, [...params])).rows,
        readOnlyTransaction: async () => { throw new Error('unused: this suite reads no offer batch') },
        authenticate: async () => ({ id: KEEPER.id, handle: KEEPER.handle }),
        now: () => new Date(),
        marketOrigin: 'https://1f3ea.com',
        marketGet: async () => ({ draft: {
          id: 71, status: 'pending', delivery_kind: 'city_ownership', world_asset: { type: 'thing', id: listed },
          title: 'an ending lantern', description: 'a lantern with an end', preview: 'a lantern',
          price_usdc: 2, seller_wallet: WALLET, listing_id: null, listing_state: null,
          expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
          created_at: new Date(now.getTime() - 60_000).toISOString(),
        } }),
        findPayment: async () => { throw new Error('no payment in this suite') },
        runPayment: async () => { throw new Error('no payment in this suite') },
        resumePayment: async () => { throw new Error('no payment in this suite') },
        recordEnds: thingIds => recordDueEndQuietly(thingIds),
      })
      const list = await listing.request('/api/world/listing', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thing_id: listed, market_draft_id: 71 }),
      })
      assert.equal(list.status, 409)

      for (const id of [marked, listed]) {
        const after = await row(id)
        assert.notEqual(after.ended_at, null, 'a remote touch records the end')
        assert.equal(after.end_program_state, 'pending')
        assert.deepEqual(after.state, {}, 'and runs nothing')
      }
      assert.equal(await count(`SELECT count(*) AS n FROM wake_tries`), 0)

      await standAt(home)
      const arrived = await call(app, KEEPER.secret, 'GET', '/api/me')
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      const settle = arrived.json.settle as Json
      assert.deepEqual({ ...settle, settle_id: undefined }, {
        settle_id: undefined, tried: 2, woke: 2, forfeited: 0, ended: 0, end_tries: 2, more_due: false,
      })
      for (const id of [marked, listed]) {
        const after = await row(id)
        assert.deepEqual(after.state, { ended: 1 }, 'its own state write passes the guard under its end try')
        assert.equal(after.end_program_state, 'ran')
        const [attempt] = await endTries(id) as [Json]
        assert.deepEqual([attempt.status, attempt.effects_applied, Number(attempt.settle_id)], ['woke', 1, settle.settle_id])
        assert.deepEqual(after.end_program_result, { ran: true, wake_try_id: Number(attempt.id), effects_applied: 1 })
        assert.deepEqual((await db.query(`
          SELECT actor_id, settle_id, result FROM thing_ending_changes WHERE thing_id = $1 AND change = 'program'
        `, [id])).rows, [{ actor_id: KEEPER.id, settle_id: String(settle.settle_id), result: after.end_program_result }])
        assert.equal(await count(`
          SELECT count(*) AS n FROM thing_state_changes WHERE thing_id = $1 AND trigger = 'wake_end'
        `, [id]), 1)
      }
      const applied = (await db.query(`
        SELECT actor, detail FROM events WHERE kind = 'wake_try_applied' ORDER BY id
      `)).rows as Json[]
      assert.deepEqual(applied.map(event => [event.actor, (event.detail as Json).reason]), [
        [KEEPER.handle, 'end'], [KEEPER.handle, 'end'],
      ], 'a changed end try writes wake_try_applied and stamps its owner')
      assert.ok((await one<Json>('SELECT last_public_action_at FROM residents WHERE id = $1', [KEEPER.id])).last_public_action_at)
      const units = (await one<{ units: Json[] }>('SELECT units FROM wake_settles WHERE id = $1', [settle.settle_id])).units
      assert.deepEqual(units.map(unit => [unit.thing_id, unit.reason, unit.pinned]), [
        [marked, 'end', false], [listed, 'end', false],
      ])

      await ageRoom(home, 30)
      await settleRoom(home, 'arrive', KEEPER.id)
      for (const id of [marked, listed]) assert.equal((await endTries(id)).length, 1, 'one try ever')
    })

    await t.test('two settles at the same moment plus a direct write give one try', async () => {
      await reset()
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const lantern = await waking(KEEPER.id, home, lanterns, 'a lantern')
      await setEnd(lantern, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([lantern]), [lantern])
      // A direct write without the end try's writer may never move the program, whichever
      // of the three reaches the thing first.
      const [left, right, direct] = await Promise.allSettled([
        settleRoom(home, 'arrive', KEEPER.id),
        settleRoom(home, 'arrive', KEEPER.id),
        db.query(`UPDATE things SET end_program_state = 'skipped' WHERE id = $1`, [lantern]),
      ])
      assert.equal(direct.status, 'rejected')
      const refusal = (direct as PromiseRejectedResult).reason as { code?: string; constraint?: string }
      assert.deepEqual([refusal.code, refusal.constraint], ['23514', 'thing_ending_guard'])
      const summaries = [left, right].map(result => (result.status === 'fulfilled' ? result.value : null))
      assert.equal(summaries.filter(summary => summary?.end_tries === 1).length, 1)
      assert.equal((await endTries(lantern)).length, 1)
      assert.deepEqual((await row(lantern)).state, { ended: 1 })
    })

    await t.test('a settle 11 seconds later, while the first try is held asleep, claims nothing', async () => {
      await reset()
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const lantern = await waking(KEEPER.id, home, lanterns, 'a lantern')
      await setEnd(lantern, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([lantern]), [lantern])
      const holder = await db.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM things WHERE id = $1 FOR UPDATE', [lantern])
        const first = settleRoom(home, 'arrive', KEEPER.id)
        await until('the first claim', async () => await count('SELECT count(*) AS n FROM wake_settles') === 1)
        await ageRoom(home, 11)
        const second = await settleRoomAndRecord(home, 'arrive', KEEPER.id)
        assert.deepEqual(second, { settle: null, recordedThingIds: [] }, 'the unit still running is not claimed again')
        assert.equal(await count('SELECT count(*) AS n FROM wake_settles'), 1)
        await holder.query('ROLLBACK')
        const done = await first
        assert.equal(done?.end_tries, 1)
      } finally {
        holder.release()
      }
      assert.equal((await endTries(lantern)).length, 1)
      assert.equal((await row(lantern)).end_program_state, 'ran')
    })

    await t.test('a claim older than ten minutes with no outcome is claimed again; a newer one is not', async () => {
      await reset()
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const stale = await waking(KEEPER.id, home, lanterns, 'a lantern whose claim died')
      const fresh = await waking(KEEPER.id, home, lanterns, 'a lantern whose claim still runs')
      await setEnd([stale, fresh], { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([stale, fresh]), [stale, fresh])
      const claimed = (thingId: number, age: string) => db.query(`
        INSERT INTO wake_settles (place_id, trigger, resident_id, budget, units, picked, created_at)
        VALUES ($1, 'arrive', $2, 8, $3::jsonb, $3::jsonb, now() - $4::interval)
      `, [home, KEEPER.id, JSON.stringify([{ thing_id: thingId, unit_index: 0, reason: 'end', pinned: false }]), age])
      await claimed(stale, '11 minutes')
      await claimed(fresh, '1 minute')
      const settle = await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal(settle?.end_tries, 1)
      assert.equal((await endTries(stale)).length, 1)
      assert.equal((await row(stale)).end_program_state, 'ran')
      assert.equal((await endTries(fresh)).length, 0)
      assert.equal((await row(fresh)).end_program_state, 'pending')
    })

    await t.test('a remnant withdrawn while its claimed try waits records quiet, and the next unit still runs', async () => {
      await reset()
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const withdrawn = await waking(KEEPER.id, home, lanterns, 'a lantern taken away')
      const kept = await waking(KEEPER.id, home, lanterns, 'a lantern kept')
      await setEnd(withdrawn, { at: '-2 minutes' })
      await setEnd(kept, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([withdrawn, kept]), [withdrawn, kept])
      const holder = await db.connect()
      let running: Promise<unknown>
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM things WHERE id = $1 FOR UPDATE', [withdrawn])
        running = settleRoom(home, 'arrive', KEEPER.id)
        await until('the claim', async () => await count('SELECT count(*) AS n FROM wake_settles') === 1)
        await holder.query(`SELECT set_config('city.ending_writer', 'withdraw:' || $1::text, true)`, [withdrawn])
        await holder.query(`
          UPDATE things SET withdrawn_at = clock_timestamp(), end_program_state = 'skipped',
            end_program_result = '{"skipped": "withdrawn"}'::jsonb
          WHERE id = $1
        `, [withdrawn])
        await holder.query('COMMIT')
      } finally {
        holder.release()
      }
      const settle = await running! as Json
      assert.equal(settle.end_tries, 2)
      const [quiet] = await endTries(withdrawn) as [Json]
      assert.deepEqual([quiet.status, quiet.error], ['quiet', 'no longer eligible'])
      const gone = await row(withdrawn)
      assert.deepEqual([gone.end_program_state, gone.end_program_result], ['skipped', { skipped: 'withdrawn' }])
      assert.equal((await row(kept)).end_program_state, 'ran')
    })

    await t.test('a try that throws is recorded failed, reads skipped with the failure, and is never claimed again', async () => {
      await reset()
      const failing = await endKind('failing', 'roll-less', [{ effect: 'write', key: 'roll', op: 'set', value: { from: 'roll' } }])
      const lamp = await waking(KEEPER.id, home, failing, 'a lamp that fails')
      await setEnd(lamp, { at: '-1 minute' })
      const settle = await settleRoom(home, 'arrive', KEEPER.id)
      assert.deepEqual({ ...settle, settle_id: undefined }, {
        settle_id: undefined, tried: 1, woke: 0, forfeited: 0, ended: 1, end_tries: 1, more_due: false,
      })
      const [failed] = await endTries(lamp) as [Json]
      const reason = 'write from roll needs a chance roll earlier in this same run; put the write after or inside a chance'
      assert.deepEqual([failed.status, failed.error], ['failed', reason])
      const after = await row(lamp)
      assert.equal(after.end_program_state, 'skipped')
      assert.deepEqual(after.end_program_result, { skipped: 'failed', reason, wake_try_id: Number(failed.id) })
      assert.deepEqual(after.state, {})
      assert.equal(await count(`SELECT count(*) AS n FROM thing_ending_changes WHERE thing_id = $1 AND change = 'program'`, [lamp]), 1)
      await ageRoom(home, 30)
      await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal((await endTries(lamp)).length, 1, 'a failed try is never tried again')
    })

    await t.test('each closed gate is recorded as skipped with its reason, writes no state, and is never retried', async () => {
      await reset()
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const asleep = await seedThing(KEEPER.id, home, lanterns, 'a lantern that does not wake')
      const visitor = await waking(NEIGHBOUR.id, home, lanterns, "a visitor's lantern")
      const carried = await waking(KEEPER.id, home, lanterns, 'a carried lantern')
      const sold = await waking(KEEPER.id, home, lanterns, 'a lantern in a sale')
      await db.query('UPDATE things SET held_by = $2 WHERE id = $1', [carried, KEEPER.id])
      await db.query(`
        INSERT INTO transfer_offers (asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
        VALUES ('thing', $1, $2, $3, 1, $4)
      `, [sold, KEEPER.id, NEIGHBOUR.id, WALLET])
      const gated = [[asleep, 'wake_off'], [visitor, 'visitors_not_waking'], [carried, 'carried'], [sold, 'in_sale']] as const
      await setEnd(gated.map(([id]) => id), { at: '-1 minute' })
      const settle = await settleRoom(home, 'arrive', KEEPER.id)
      assert.deepEqual({ ...settle, settle_id: undefined }, {
        settle_id: undefined, tried: 4, woke: 0, forfeited: 0, ended: 4, end_tries: 4, more_due: false,
      })
      for (const [id, gate] of gated) {
        const reason = END_TRY_SKIP_REASONS[gate]
        const [skip] = await endTries(id) as [Json]
        assert.deepEqual([skip.status, skip.error], ['quiet', reason], gate)
        const after = await row(id)
        assert.equal(after.end_program_state, 'skipped', gate)
        assert.deepEqual(after.end_program_result, {
          skipped: gate, blocked_by: [gate], reason, wake_try_id: Number(skip.id),
        }, gate)
        assert.deepEqual(after.state, {}, `${gate}: no state write`)
      }
      await ageRoom(home, 30)
      await settleRoom(home, 'arrive', KEEPER.id)
      for (const [id, gate] of gated) assert.equal((await endTries(id)).length, 1, `${gate}: never retried`)
    })

    await t.test('a full budget defers an end try to the room\'s next settle', async () => {
      await reset()
      const heavy = Array.from({ length: 128 }, () => ({ effect: 'write', key: 'n', op: 'add' }))
      const heavies = await endKind('heavies', 'heavy-end', heavy)
      const ids = [
        await waking(KEEPER.id, home, heavies, 'a heavy lantern one'),
        await waking(KEEPER.id, home, heavies, 'a heavy lantern two'),
        await waking(KEEPER.id, home, heavies, 'a heavy lantern three'),
      ]
      await setEnd(ids, { at: '-1 minute' })
      const first = await settleRoom(home, 'arrive', KEEPER.id)
      assert.deepEqual({ ...first, settle_id: undefined }, {
        settle_id: undefined, tried: 2, woke: 2, forfeited: 0, ended: 3, end_tries: 2, more_due: false,
      })
      const [stopped] = await endTries(ids[2]!) as [Json]
      assert.equal(stopped.status, 'stopped')
      assert.equal((await row(ids[2]!)).end_program_state, 'pending', 'a try the budget never started waits')
      await ageRoom(home, 30)
      const second = await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal(second?.end_tries, 1)
      assert.equal((await row(ids[2]!)).end_program_state, 'ran')
      assert.deepEqual((await row(ids[2]!)).state, { n: 128 })
      for (const id of ids.slice(0, 2)) assert.equal((await endTries(id)).length, 1)
    })

    await t.test('two things that end each other by label end at different settles, and neither runs twice', async () => {
      await reset()
      const sparks = await endKind('sparks', 'spark-end', [
        { effect: 'reach', max: 16, then: [{ effect: 'label', target: 'target', label: 'ember', permanent: true }] },
      ])
      const embers = await endKind('embers', 'ember-end', [
        { effect: 'reach', max: 16, then: [{ effect: 'label', target: 'target', label: 'spark', permanent: true }] },
      ])
      const spark = await waking(KEEPER.id, home, sparks, 'a spark')
      const ember = await waking(KEEPER.id, home, embers, 'an ember')
      await db.query('UPDATE things SET open_to_reach = TRUE WHERE id = ANY($1::int[])', [[spark, ember]])
      await setEnd(spark, { at: '-1 minute' })
      await setEnd(ember, { label: 'ember' })
      const first = await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal(first?.ended, 1)
      assert.equal(first?.end_tries, 1)
      const afterFirst = await row(ember)
      assert.deepEqual([afterFirst.due, afterFirst.ended_at], [true, null], 'the label made it due; the next settle records it')
      await ageRoom(home, 30)
      const second = await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal(second?.ended, 1)
      assert.equal(second?.end_tries, 1)
      assert.equal(await count(`
        SELECT count(*) AS n FROM active_labels WHERE target_type = 'thing' AND target_id = $1 AND label = 'spark'
      `, [spark]), 0, 'a remnant takes no label')
      await ageRoom(home, 30)
      await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal((await endTries(spark)).length, 1)
      assert.equal((await endTries(ember)).length, 1)
    })

    await t.test('a program copy of its own remnant passes the guard and starts with no end', async () => {
      await reset()
      const seeds = await endKind('seeds', 'last-seed', [
        { effect: 'write', key: 'ended', op: 'add' },
        { effect: 'copy' },
      ])
      await db.query('UPDATE places SET allow_arriving_copies = TRUE WHERE id = $1', [home])
      const seed = await waking(KEEPER.id, home, seeds, 'a seed')
      await setEnd(seed, { at: '-1 minute' })
      const settle = await settleRoom(home, 'arrive', KEEPER.id)
      assert.equal(settle?.end_tries, 1)
      const [attempt] = await endTries(seed) as [Json]
      assert.deepEqual([attempt.status, attempt.effects_applied, attempt.error], ['woke', 2, null])
      const child = await one<Json>(`
        SELECT id, ending_rule, ended_at, end_program_state FROM things WHERE parent_thing_id = $1
      `, [seed])
      assert.deepEqual([child.ending_rule, child.ended_at, child.end_program_state], [null, null, 'none'])
      assert.equal((await one<Json>('SELECT copies_made FROM things WHERE id = $1', [seed])).copies_made, 1)
    })

    await t.test('end tries run outside the random cap and before pinned wake tries', async () => {
      await reset()
      const lanterns = await endKind('lanterns', 'last-light', [{ effect: 'write', key: 'ended', op: 'add' }])
      const glows = await coin(app, KEEPER.secret, 'glow', { wake: { then: [{ effect: 'write', key: 'woke', op: 'add' }] } })
      assert.equal(glows.status, 201, JSON.stringify(glows.json))
      const glowKind = await seedKind(KEEPER.id, 'glows', [await traitId('glow')])
      const cap = 2
      const ending = [] as number[]
      for (let index = 0; index < cap + 2; index += 1) ending.push(await waking(KEEPER.id, home, lanterns, `an ending lantern ${index}`))
      await setEnd(ending, { at: '-1 minute' })
      const pinnedLamp = await waking(KEEPER.id, home, glowKind, 'a pinned lamp')
      const lamps = [] as number[]
      for (let index = 0; index < cap + 1; index += 1) lamps.push(await waking(KEEPER.id, home, glowKind, `a lamp ${index}`))
      await db.query('UPDATE places SET wake_random_cap = $2, wake_pins = $3::int[] WHERE id = $1', [home, cap, [pinnedLamp]])

      const settle = await settleRoom(home, 'arrive', KEEPER.id)
      assert.deepEqual({ ...settle, settle_id: undefined }, {
        settle_id: undefined, tried: ending.length + 1 + cap, woke: ending.length + 1 + cap, forfeited: 0,
        ended: ending.length, end_tries: ending.length, more_due: false,
      }, 'every end try runs, beside the pinned try and the capped pick')
      for (const id of ending) assert.equal((await row(id)).end_program_state, 'ran')
      const picked = (await one<{ picked: Json[] }>('SELECT picked FROM wake_settles WHERE id = $1', [settle!.settle_id])).picked
      assert.deepEqual(picked.slice(0, ending.length + 1).map(unit => [unit.thing_id, unit.reason, unit.pinned]), [
        ...ending.map(id => [id, 'end', false]), [pinnedLamp, 'arrive', true],
      ], 'end units come first, then the pinned wake unit')
      assert.equal(picked.length, ending.length + 1 + cap)
      const tries = (await db.query<{ thing_id: number; reason: string }>(`
        SELECT thing_id, reason FROM wake_tries WHERE settle_id = $1 ORDER BY id
      `, [settle!.settle_id])).rows
      assert.deepEqual(tries.slice(0, ending.length + 1).map(attempt => [attempt.thing_id, attempt.reason]), [
        ...ending.map(id => [id, 'end']), [pinnedLamp, 'arrive'],
      ], 'the end tries ran before the pinned wake try')
      const roll = await one<{ sides: number }>(`
        SELECT sides FROM chance_rolls WHERE purpose = 'wake_pick' AND settle_id = $1
      `, [settle!.settle_id])
      assert.equal(roll.sides, lamps.length, 'the random pick counts the unpinned wake units only')
    })

    await t.test('a recorder failure inside the settle fails nothing, and the wake part still runs', async () => {
      await reset()
      const glows = await coin(app, KEEPER.secret, 'glow', { wake: { then: [{ effect: 'write', key: 'woke', op: 'add' }] } })
      assert.equal(glows.status, 201, JSON.stringify(glows.json))
      const lamp = await waking(KEEPER.id, home, await seedKind(KEEPER.id, 'glows', [await traitId('glow')]), 'a lamp')
      const logged = mock.method(console, 'error', () => {})
      const broken = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.reduce((text, part, index) =>
          text + part + (index < values.length ? `$${index + 1}` : ''), '')
        if (statement.includes('/* thing-endings:room-due */')) throw new Error('test interruption in the recorder')
        return (await db.query(statement, values)).rows
      }, { query: async (statement: string, values: readonly unknown[] = []) =>
        (await db.query(statement, [...values])).rows })
      try {
        const settle = await settleRoom(home, 'arrive', KEEPER.id, broken)
        assert.equal(settle?.woke, 1, 'a wake try owed in the same room still ran')
      } finally {
        logged.mock.restore()
      }
      assert.ok(logged.mock.calls.length > 0, 'the recorder failure is logged')
      assert.deepEqual((await row(lamp)).state, { woke: 1 })
    })

    await t.test('claims leave transferred clocks and anchors untouched', async t => {
      const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
      const scenarios = [false, true].flatMap(anchor => ['active', 'retiring', 'retired']
        .map(retirementState => ({ anchor, retirementState, phase: 'after candidates' })))
      for (const { anchor, retirementState, phase } of scenarios) {
        await t.test(`${anchor ? 'anchor' : 'owed clock'} with ${retirementState} new owner ${phase}`, async () => {
          await reset()
          await db.query('UPDATE places SET wake_visitors = true WHERE id = $1', [home])
          const coined = await coin(app, KEEPER.secret, 'clock', { wake: {
            on: ['clock'], every_seconds: 10, then: [{ effect: 'write', key: 'ticks', op: 'add' }],
          } })
          assert.equal(coined.status, 201, JSON.stringify(coined.json))
          const lamp = await waking(KEEPER.id, home,
            await seedKind(KEEPER.id, 'clocks', [await traitId('clock')]), 'a clock')
          if (!anchor) await db.query(`
            INSERT INTO thing_wake_state (thing_id, clock_at) VALUES ($1, now() - interval '60 seconds')
          `, [lamp])
          const before = (await db.query('SELECT * FROM thing_wake_state WHERE thing_id = $1', [lamp])).rows
          let transferred = false
          setEngineTransactionRunnerForTests(async (_db, work) => {
            const client = await db.connect()
            const query = async (text: string, values: readonly unknown[] = []) => {
              const result = await client.query(text, [...values])
              const pauseHere = text.includes('state.last_try_at, state.clock_at')
              if (!transferred && pauseHere) {
                transferred = true
                assert.equal(result.rows.length, 1, 'pause after reading the old owner candidate')
                const transfer = await db.connect()
                try {
                  await transfer.query('BEGIN')
                  await transfer.query("SET LOCAL lock_timeout = '500ms'")
                  // The give path locks its actor, room, and thing in this order.
                  await transfer.query('SELECT id FROM residents WHERE id = $1 FOR NO KEY UPDATE', [KEEPER.id])
                  await transfer.query('SELECT id FROM places WHERE id = $1 FOR NO KEY UPDATE', [home])
                  await transfer.query('SELECT id FROM things WHERE id = $1 FOR UPDATE', [lamp])
                  await transfer.query('UPDATE things SET owner_id = $2 WHERE id = $1', [lamp, NEIGHBOUR.id])
                  await transfer.query('COMMIT')
                  if (retirementState !== 'active') await transfer.query(`
                    UPDATE residents SET retirement_state = 'retiring',
                      retirement_requested_at = clock_timestamp() - interval '31 days' WHERE id = $1
                  `, [NEIGHBOUR.id])
                  if (retirementState === 'retired') await transfer.query(`
                    UPDATE residents SET retirement_state = 'retired', retired_at = clock_timestamp() WHERE id = $1
                  `, [NEIGHBOUR.id])
                } finally {
                  await transfer.query('ROLLBACK')
                  transfer.release()
                }
              }
              return result.rows
            }
            const transaction = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) =>
              query(strings.reduce((text, part, index) =>
                text + part + (index < values.length ? `$${index + 1}` : ''), ''), values), { query })
            try {
              await client.query('BEGIN')
              const result = await work(transaction, true)
              await client.query('COMMIT')
              return result
            } catch (error) {
              await client.query('ROLLBACK')
              throw error
            } finally {
              client.release()
            }
          })
          const errors = mock.method(console, 'error')
          const settled = await settleRoom(home, 'me', FOUNDER.id).finally(() => errors.mock.restore())
          assert.equal(errors.mock.calls.length, 0, 'a swallowed settlement error must not look like a skipped claim')
          assert.ok(transferred, 'the claim reached the chosen transfer interleaving')
          assert.deepEqual(await one(`
            SELECT thing.owner_id, owner.retirement_state FROM things thing
            JOIN residents owner ON owner.id = thing.owner_id WHERE thing.id = $1
          `, [lamp]), { owner_id: NEIGHBOUR.id, retirement_state: retirementState })
          assert.deepEqual((await db.query('SELECT * FROM thing_wake_state WHERE thing_id = $1', [lamp])).rows,
            before, 'neither a new anchor nor an owed clock changes after ownership moves')
          assert.equal(settled, null, 'no stale-owner tries are consumed or forfeited')
          assert.equal(await count('SELECT count(*) AS n FROM wake_settles'), 0)
          assert.equal(await count('SELECT count(*) AS n FROM wake_tries'), 0)
          assert.deepEqual((await row(lamp)).state, {})
          if (retirementState === 'active') {
            await db.query('UPDATE things SET wake_enabled = true WHERE id = $1', [lamp])
            const next = await settleRoom(home, 'me', FOUNDER.id)
            if (anchor) {
              assert.equal(next, null)
              assert.equal(await count('SELECT count(*) AS n FROM thing_wake_state WHERE thing_id = $1', [lamp]), 1)
            } else {
              assert.equal(next?.tried, 6, 'the next claim keeps all owed tries for the active new owner')
              assert.equal(next?.woke, 6)
              assert.deepEqual((await row(lamp)).state, { ticks: 6 })
            }
          }
        })
      }
    })

    await t.test('retirement and wake-state writes wait for each other', async t => {
      const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
      for (const anchor of [false, true]) for (const retirementFirst of [false, true]) {
        await t.test(`${anchor ? 'anchor' : 'owed clock'}, ${retirementFirst ? 'retirement' : 'claim'} first`, async () => {
          await reset()
          assert.equal((await coin(app, KEEPER.secret, 'clock', { wake: {
            on: ['clock'], every_seconds: 10, then: [{ effect: 'write', key: 'ticks', op: 'add' }],
          } })).status, 201)
          const lamp = await waking(KEEPER.id, home,
            await seedKind(KEEPER.id, 'clocks', [await traitId('clock')]), 'a clock')
          if (!anchor) await db.query(`
            INSERT INTO thing_wake_state (thing_id, clock_at) VALUES ($1, now() - interval '60 seconds')
          `, [lamp])
          const before = (await db.query('SELECT * FROM thing_wake_state WHERE thing_id = $1', [lamp])).rows
          const retirement = await db.connect()
          const retirementPid = Number((await retirement.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          let raced = false
          let pendingRetirement: Promise<unknown> | undefined
          setEngineTransactionRunnerForTests(async (_db, work) => {
            const client = await db.connect()
            const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const query = async (text: string, values: readonly unknown[] = []) => {
              const raceHere = !raced && text.includes('/* wake:current-owner */')
              if (raceHere) {
                raced = true
                await retirement.query('BEGIN')
                if (retirementFirst) await retirement.query(`
                  UPDATE residents SET retirement_state = 'retiring', retirement_requested_at = now() WHERE id = $1
                `, [KEEPER.id])
              }
              const pending = client.query(text, [...values])
              if (raceHere && retirementFirst) {
                try {
                  await until('claim waits for retirement', async () =>
                    (await one<{ blocked: boolean }>('SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked', [retirementPid, pid])).blocked)
                } finally {
                  await retirement.query('COMMIT')
                }
              }
              const result = await pending
              if (raceHere && !retirementFirst) {
                pendingRetirement = retirement.query(`
                  UPDATE residents SET retirement_state = 'retiring', retirement_requested_at = now() WHERE id = $1
                `, [KEEPER.id])
                await until('retirement waits for claim', async () =>
                  (await one<{ blocked: boolean }>('SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked', [pid, retirementPid])).blocked)
              }
              if (text.includes('INSERT INTO thing_wake_state')) {
                assert.equal((await client.query('SELECT retirement_state FROM residents WHERE id = $1',
                  [KEEPER.id])).rows[0].retirement_state, 'active', 'every wake-state write happens before retirement')
              }
              return result.rows
            }
            const transaction = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) =>
              query(strings.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), ''), values), { query })
            try {
              await client.query('BEGIN')
              const result = await work(transaction, true)
              await client.query('COMMIT')
              if (pendingRetirement) {
                await pendingRetirement
                await retirement.query('COMMIT')
                pendingRetirement = undefined
              }
              return result
            } finally {
              await client.query('ROLLBACK')
              client.release()
            }
          })
          const errors = mock.method(console, 'error')
          try {
            const settled = await settleRoom(home, 'me', FOUNDER.id)
            assert.equal(errors.mock.calls.length, 0, 'settlement must not swallow a lock error')
            assert.ok(raced, 'the concurrent retirement reached the owner check')
            const after = (await db.query('SELECT * FROM thing_wake_state WHERE thing_id = $1', [lamp])).rows
            if (retirementFirst) {
              assert.deepEqual(after, before, 'a retiring owner gets no anchor or clock update')
              assert.equal(settled, null)
              assert.equal(await count('SELECT count(*) AS n FROM wake_settles'), 0)
            } else {
              assert.equal(after.length, 1)
              assert.ok(anchor || after[0].clock_at > before[0].clock_at, 'the active owner claim committed')
              assert.equal(settled?.tried ?? 0, anchor ? 0 : 6)
              assert.equal(settled?.woke ?? 0, 0, 'retirement after the claim prevents later effects')
            }
            assert.equal((await one('SELECT retirement_state FROM residents WHERE id = $1', [KEEPER.id])).retirement_state, 'retiring')
            assert.deepEqual((await row(lamp)).state, {})
          } finally {
            errors.mock.restore()
            await pendingRetirement
            await retirement.query('ROLLBACK')
            retirement.release()
          }
        })
      }
    })
  } finally {
    await postgres.stop()
  }
})
