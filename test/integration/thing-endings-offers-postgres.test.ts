// Thing endings on the city offer reads and cancel_world (T12), against real PostgreSQL
// on the full db/schema.sql, the five-states fixture and the real routes. Every offer read
// shows the thing's end before payment, judged at the database's time and equal to what
// snapshot format 4 exports; a due thing's open offer reads thing_ended after the payment
// phases and before reserved; reads never record an end; and cancel_world records a due
// end first and unlocks a remnant once no payment window is open and the market listing
// reads thing_ended (the M1a listing answer).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { call, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, standIn, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import {
  FIVE_STATES_RESIDENTS,
  FIVE_STATES_WALLET,
  seedFiveStates,
  type FiveStatesFixture,
} from '../helpers/thing-endings-fixtures/five-states.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const MAKER_SECRET = `1f3d9_sk_${'2'.repeat(48)}`
const BUYER_WALLET = `0x${'3c'.repeat(20)}`
const LISTING_ID = 91
const TIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

/** Times as one shape (milliseconds, UTC): v4 writes PostgreSQL's, the read writes toISOString. */
function sameTimes(value: unknown): unknown {
  if (typeof value === 'string' && TIME_TEXT.test(value)) return new Date(value).toISOString()
  if (Array.isArray(value)) return value.map(sameTimes)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sameTimes(item)]))
  }
  return value
}

function withoutCheckedAt(ending: unknown): unknown {
  if (!ending || typeof ending !== 'object') return ending
  const { checked_at: _checkedAt, ...rest } = ending as Json
  return sameTimes(rest)
}

test('thing endings on the city offer reads and cancel_world, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-offers')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEndQuietly } = await import('../../src/thing-ending-record.ts')
    const { mountWorldMarketRoutes } = await import('../../src/world-market.ts')
    const { MODERATED_TEXT } = await import('../../src/moderation.ts')
    const db = connectedDatabase()

    let fixture: FiveStatesFixture
    let market: (path: string) => unknown = path => { throw new Error(`unexpected market read: ${path}`) }
    const recordCalls: number[][] = []
    const routes = new Hono()
    routes.onError(error => { throw error })
    mountWorldMarketRoutes(routes, {
      query: async (text, params) => (await db.query(text, [...params])).rows,
      readOnlyTransaction: async statements => {
        const client = await db.connect()
        try {
          await client.query('BEGIN READ ONLY')
          const results: Record<string, unknown>[][] = []
          for (const statement of statements) results.push((await client.query(statement.text, [...statement.params])).rows)
          await client.query('COMMIT')
          return results
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      },
      authenticate: async c => c.req.header('authorization') === `Bearer ${MAKER_SECRET}`
        ? { ...FIVE_STATES_RESIDENTS.maker }
        : null,
      now: () => new Date(),
      marketOrigin: 'https://1f3ea.com',
      marketGet: async path => market(path),
      findPayment: async () => { throw new Error('no payment in this suite') },
      runPayment: async () => { throw new Error('no payment in this suite') },
      resumePayment: async () => { throw new Error('no payment in this suite') },
      recordEnds: async ids => {
        recordCalls.push([...ids])
        return recordDueEndQuietly(ids)
      },
    })

    const reset = async () => {
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schemaDdl)
      fixture = await seedFiveStates(db)
      await db.query('UPDATE residents SET secret_hash = $2 WHERE id = $1', [
        FIVE_STATES_RESIDENTS.maker.id, createHash('sha256').update(MAKER_SECRET, 'utf8').digest('hex'),
      ])
      recordCalls.length = 0
      market = path => { throw new Error(`unexpected market read: ${path}`) }
    }
    const read = async (offerId: number): Promise<Readonly<{ status: number; headers: Headers; offer: Json }>> => {
      const response = await routes.request(`/api/world/offer/${offerId}`)
      return { status: response.status, headers: response.headers, offer: (await response.json() as { offer: Json }).offer }
    }
    const cancel = async (offerId: number) => {
      const response = await routes.request(`/api/world/offer/${offerId}/cancel`, {
        method: 'POST', headers: { authorization: `Bearer ${MAKER_SECRET}`, 'content-type': 'application/json' }, body: '{}',
      })
      return { status: response.status, json: await response.json() as Json }
    }
    const one = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows[0] as Json
    const endedEvents = async (thingId: number) => Number((await one(
      `SELECT count(*) AS n FROM events WHERE kind = 'thing_ended' AND detail->>'thing_id' = $1::text`, [thingId],
    )).n)
    const v4Offers = async (): Promise<Map<number, Json>> => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        await db.query('SET LOCAL ROLE city_snapshot_export')
        const rows = (await db.query<{ record_id: string; payload: Json }>(`
          SELECT record_id, payload FROM city_snapshot.public_records_v4 WHERE class_name = 'world_market_offers'
        `)).rows
        return new Map(rows.map(row => [Number(row.record_id), row.payload]))
      } finally {
        await db.query('ROLLBACK')
      }
    }
    // A fixture write to an offer's reservation or status, with the offer triggers off for
    // this one transaction: they stamp a reservation with the clock and keep an open one
    // immutable, so a test could not otherwise place a window a minute ago or end it early.
    const offerFixture = async (text: string, values: unknown[]) => {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(text, values)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    const reserve = (offerId: number, at: string) => offerFixture(`
      UPDATE transfer_offers SET buyer_id = $2, reserved_by = $2, buyer_wallet = $3,
        market_listing_id = $4, market_checkout_id = 80 + $1, market_buyer = 'market-buyer',
        reserved_at = now() + $5::interval, reserved_until = now() + $5::interval + interval '5 minutes'
      WHERE id = $1
    `, [offerId, FIVE_STATES_RESIDENTS.buyer.id, BUYER_WALLET, LISTING_ID, at])
    // The market's own listing answer for an ended thing, copied from 1F3EA PR #71 (M1a) at
    // d6d5ca5; its ids are set to the offer's, its states are used as they are.
    const m1a = JSON.parse(await readFile(new URL('../fixtures/m1a-world-thing-ended-listing.json', import.meta.url), 'utf8')) as {
      listing: Json
    }
    const endedListing = (offerId: number): Json => ({
      listing: { ...m1a.listing, id: LISTING_ID, world_offer_id: offerId, world_draft_id: 9102 },
    })

    await t.test('offer reads carry the end as snapshot v4 exports it, and record nothing', async () => {
      await reset()
      const { offers, things } = fixture
      const active = await read(offers.active)
      assert.equal(active.status, 200)
      assert.equal(active.headers.get('cache-control'), 'no-store')
      assert.equal(active.offer.phase, 'listed')
      assert.equal(active.offer.asset_state, 'active')
      const activeEnding = active.offer.ending as Json
      assert.equal(activeEnding.status, 'active')
      assert.equal(activeEnding.uses_left, 3)
      assert.equal(activeEnding.label, 'spent')
      assert.match(String(active.offer.end_program_summary), /end-glow's end steps once\.$/u)
      assert.equal(activeEnding.checked_at, active.offer.ending_checked_at)

      const due = await read(offers.due)
      assert.equal(due.offer.phase, 'thing_ended')
      assert.equal(due.offer.asset_state, 'remnant')
      const dueEnding = due.offer.ending as Json
      assert.equal(dueEnding.status, 'due_waiting_settle')
      assert.deepEqual(dueEnding.program, {
        state: 'none', result: null, has_end_trait: true, would_run: false, blocked_by: ['in_sale'],
      })

      // The same answer as the export, field for field, apart from when it was checked.
      const v4 = await v4Offers()
      for (const [offerId, live] of [[offers.active, active.offer], [offers.due, due.offer]] as const) {
        const exported = v4.get(offerId)!
        assert.equal(live.phase, exported.phase, `offer ${offerId} phase`)
        assert.equal(live.asset_state, exported.asset_state, `offer ${offerId} asset_state`)
        assert.deepEqual(withoutCheckedAt(live.ending), withoutCheckedAt(exported.ending), `offer ${offerId} ending`)
      }

      // The batch route answers each offer as the single read does.
      const batch = await routes.request(`/api/world/offers?ids=${offers.active},${offers.due}`)
      assert.equal(batch.status, 200)
      const listed = (await batch.json() as { offers: Json[] }).offers
      for (const [index, single] of [active.offer, due.offer].entries()) {
        const entry = listed[index]!
        assert.equal(entry.asset_state, single.asset_state)
        assert.equal(entry.phase, single.phase)
        assert.deepEqual(withoutCheckedAt(entry.ending), withoutCheckedAt(single.ending))
        assert.equal(entry.end_program_summary, single.end_program_summary)
        assert.equal(typeof entry.ending_checked_at, 'string')
      }

      assert.deepEqual(recordCalls, [], 'a read never records (#37)')
      assert.equal((await one('SELECT ended_at FROM things WHERE id = $1', [things.due])).ended_at, null)
      assert.equal(await endedEvents(things.due), 0)
    })

    await t.test('a due thing reads thing_ended over an open window, and keeps claimed, canceled and withdrawn', async () => {
      await reset()
      const { offers, things } = fixture
      await reserve(offers.due, '-1 minute')
      assert.equal((await read(offers.due)).offer.phase, 'thing_ended', 'the end wins over a payment window')
      await reserve(offers.active, '-1 minute')
      assert.equal((await read(offers.active)).offer.phase, 'reserved', 'a thing whose end is still to come stays reserved')

      // Recorded: still thing_ended, now ended.
      assert.deepEqual([...await recordDueEndQuietly([things.due])], [things.due])
      const recorded = await read(offers.due)
      assert.equal(recorded.offer.phase, 'thing_ended')
      assert.equal(recorded.offer.asset_state, 'remnant')
      assert.equal((recorded.offer.ending as Json).status, 'ended')
      assert.equal((recorded.offer.ending as Json).ended_cause, 'at')

      await offerFixture(`UPDATE transfer_offers SET status = 'claimed', claimed_at = now() WHERE id = $1`, [offers.due])
      assert.equal((await read(offers.due)).offer.phase, 'claimed')
      await offerFixture(`UPDATE transfer_offers SET status = 'canceled', claimed_at = NULL, canceled_at = now() WHERE id = $1`, [offers.due])
      const canceled = await read(offers.due)
      assert.equal(canceled.offer.phase, 'canceled')
      assert.equal(canceled.offer.asset_state, 'remnant')

      await db.query('UPDATE things SET active_offer_id = NULL WHERE id = $1', [things.due])
      await db.query(`
        UPDATE things SET withdrawn_at = now(), held_by = NULL WHERE id = $1
          AND (SELECT set_config('city.ending_writer', 'withdraw:' || $1::text, true)) IS NOT NULL
      `, [things.due])
      const withdrawn = await read(offers.due)
      assert.equal(withdrawn.offer.asset_state, 'withdrawn')
      assert.equal(withdrawn.offer.ending, null)
      assert.equal(withdrawn.offer.end_program_summary, null)

      await db.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'offer read test')
      `, [things.active])
      assert.deepEqual((await read(offers.active)).offer, { id: offers.active, status: 'maintainer_hidden' })
    })

    await t.test('a hidden end trait is named as removed in the summary', async () => {
      await reset()
      assert.match(String((await read(fixture.offers.active)).offer.end_program_summary), /end-glow/u)
      await db.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('trait', $1, 'remove', 1, 'offer read test')
      `, [fixture.endTraitId])
      const summary = String((await read(fixture.offers.active)).offer.end_program_summary)
      assert.doesNotMatch(summary, /end-glow/u)
      assert.ok(summary.includes(`${MODERATED_TEXT}'s end steps`), summary)
    })

    await t.test('cancel_world records a due end first, waits out a payment window, then unlocks on thing_ended', async () => {
      await reset()
      const { offers, things } = fixture
      market = path => {
        assert.equal(path, `/api/listing/${LISTING_ID}`)
        return endedListing(offers.due)
      }
      await reserve(offers.due, '-1 minute')
      const windowOpen = await cancel(offers.due)
      assert.equal(windowOpen.status, 409, JSON.stringify(windowOpen.json))
      assert.match(String(windowOpen.json.error), /five-minute payment window/u)
      assert.deepEqual(recordCalls, [[things.due]])
      assert.notEqual((await one('SELECT ended_at FROM things WHERE id = $1', [things.due])).ended_at, null)
      assert.equal(await endedEvents(things.due), 1)

      // The window ends (its width kept): the cancel unlocks the remnant.
      await offerFixture(`
        UPDATE transfer_offers SET reserved_at = now() - interval '10 minutes', reserved_until = now() - interval '5 minutes'
        WHERE id = $1
      `, [offers.due])
      const unlocked = await cancel(offers.due)
      assert.equal(unlocked.status, 200, JSON.stringify(unlocked.json))
      const offer = unlocked.json.offer as Json
      assert.equal(offer.phase, 'canceled')
      assert.equal(offer.asset_state, 'remnant')
      assert.equal((offer.ending as Json).status, 'ended')
      const thing = await one('SELECT active_offer_id, end_program_state FROM things WHERE id = $1', [things.due])
      assert.equal(thing.active_offer_id, null)
      assert.equal(thing.end_program_state, 'pending', 'its end try waits; the open sale closes its gate (in_sale)')
      assert.equal(await endedEvents(things.due), 1, 'one thing_ended event')
      assert.equal(Number((await one(`SELECT count(*) AS n FROM events WHERE kind = 'world_cancel'`)).n), 1)
    })

    await t.test('a thing offered directly shows its end in the offer answer; a kind offer does not', async () => {
      await reset()
      await standIn(FIVE_STATES_RESIDENTS.maker.id, fixture.rooms.home)
      const offered = await call(app, MAKER_SECRET, 'POST', '/api/transfer/offer', {
        type: 'thing', id: fixture.things.unset, to_handle: FIVE_STATES_RESIDENTS.buyer.handle,
        price_usdc: 2, seller_wallet: FIVE_STATES_WALLET,
      })
      assert.equal(offered.status, 201, JSON.stringify(offered.json))
      const offer = offered.json.offer as Json
      assert.equal(offer.asset_state, 'active')
      assert.equal((offer.ending as Json).status, 'permitted_but_unset')
      assert.match(String(offer.end_program_summary), /end-glow's end steps once\.$/u)
      assert.equal(typeof offer.ending_checked_at, 'string')

      const kind = await call(app, MAKER_SECRET, 'POST', '/api/transfer/offer', {
        type: 'kind', id: fixture.kinds.stone, to_handle: FIVE_STATES_RESIDENTS.buyer.handle,
        price_usdc: 2, seller_wallet: FIVE_STATES_WALLET,
      })
      assert.equal(kind.status, 201, JSON.stringify(kind.json))
      assert.equal(Object.hasOwn(kind.json.offer as Json, 'asset_state'), false)
      assert.equal(Object.hasOwn(kind.json.offer as Json, 'ending'), false)
    })
  } finally {
    await postgres.stop()
  }
})
