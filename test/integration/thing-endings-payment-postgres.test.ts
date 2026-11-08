// Thing endings on claims, reservations and the payment race (T13), against real
// PostgreSQL on the full db/schema.sql, the real direct claim route through src/index.ts
// and the real world routes with injected payment services. A claim records a due end
// first; no new reservation or payment starts on a thing whose end has come or would
// come inside the five-minute window (E8); payment evidence already accepted keeps its
// sale (#32), so a remnant moves whole; payment recovery never records an end (#167);
// and a claim on a due thing runs nothing, its program waiting for the room's next settle.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
import { waitPastDatabaseTime } from '../helpers/database-clock.ts'
import { connectedDatabase, resetCity, standIn, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import type { WorldMarketDependencies } from '../../src/world-market.ts'
import type { PaymentFlowDependencies } from '../../src/payment-flow.ts'

const KEEPER = Object.freeze({ id: 5, handle: 'end-keeper', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const SELLER_WALLET = `0x${'11'.repeat(20)}`
const BUYER_WALLET = `0x${'22'.repeat(20)}`
const TX_HASH = `0x${'33'.repeat(32)}`
const NONCE = `0x${'44'.repeat(32)}`
const MARKET = 'https://1f3ea.com'
const LISTING_ID = 91
const SAME_ID = 9001
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

/** An end set an hour ago: a date at this offset from the database clock, or a label_added end. */
async function setEnd(thingId: number, end: Readonly<{ at?: string; atTime?: Date; label?: string }>): Promise<void> {
  const when = end.atTime !== undefined
    ? end.atTime.toISOString()
    : end.at === undefined ? null : (await one<{ at: string }>(`
      SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    `, [end.at])).at
  const rule = when !== null ? { any: [{ at: when }] } : { any: [{ label_added: end.label }] }
  await connectedDatabase().query(`
    UPDATE things SET ending_rule = $2::jsonb, ending_grant = $3::jsonb, ending_set_by = owner_id,
      ending_set_at = now() - interval '1 hour', ending_deadline = $4::timestamptz, ending_label = $5::text
    WHERE id = $1
  `, [thingId, JSON.stringify(rule), JSON.stringify(KINDLESS_GRANT), when, end.label ?? null])
}

async function thingRow(thingId: number): Promise<Json> {
  return one(`
    SELECT owner_id, active_offer_id, wake_enabled, state, ended_at, ended_owner_id, end_program_state,
      end_program_result, thing_end_due(id, clock_timestamp()) AS due
    FROM things WHERE id = $1
  `, [thingId])
}

const endedEvents = (thingId: number) => connectedDatabase().query(`
  SELECT detail FROM events WHERE kind = 'thing_ended' AND detail->>'thing_id' = $1::text ORDER BY id
`, [thingId]).then(result => result.rows.map(row => row.detail as Json))
async function answer(response: Response): Promise<Readonly<{ status: number; json: Json }>> {
  return { status: response.status, json: await response.json() as Json }
}
const endTries = (thingId: number) => count(`SELECT count(*) AS n FROM wake_tries WHERE thing_id = $1`, [thingId])

function paymentHeader(reservedAt: Date, reservedUntil: Date): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: `0x${'55'.repeat(65)}`,
      authorization: {
        from: BUYER_WALLET,
        to: SELLER_WALLET,
        value: '2000000',
        validAfter: String(Math.floor(reservedAt.getTime() / 1_000) - 60),
        validBefore: String(Math.floor(reservedUntil.getTime() / 1_000) + 60),
        nonce: NONCE,
      },
    },
  }), 'utf8').toString('base64')
}

test('thing endings on claims, reservations and the payment race, against PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-payment')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd, recordDueEndQuietly } = await import('../../src/thing-ending-record.ts')
    const { mountWorldMarketRoutes } = await import('../../src/world-market.ts')
    const { ENDING_PURCHASE_REFUSAL, END_TRY_SKIP_REASONS } = await import('../../src/thing-ending-refusals.ts')
    const { findPaymentAttempt, getPaymentAttemptRecord } = await import('../../src/payment-attempts.ts')
    const { resumeDurableX402, runDurableX402 } = await import('../../src/payment-flow.ts')
    const { parseX402Payment } = await import('../../src/pay.ts')
    const { createPaymentRecoveryRuntime } = await import('../../src/payment-recovery-runtime.ts')
    const db = connectedDatabase()
    const query: WorldMarketDependencies['query'] = async (text, params) => (await db.query(text, [...params])).rows

    let home = 0
    let shed = 0
    let continent = 0
    let market: (path: string) => unknown = path => { throw new Error(`unexpected market read: ${path}`) }
    const marketReads: string[] = []
    let settlements = 0
    let classify: PaymentFlowDependencies['classify'] = async () => ({ state: 'pending' })
    let blockTime = new Date()
    const payment: Partial<PaymentFlowDependencies> = {
      custodyReady: async () => true,
      currentBlock: async () => 22_000_000n,
      verify: async (header, accepted) => {
        const parsed = parseX402Payment(header, accepted)
        assert.ok(!('error' in parsed))
        return { ...parsed, state: 'verified', verificationPayer: BUYER_WALLET }
      },
      settle: async () => {
        settlements += 1
        return {
          state: 'settled',
          transaction: TX_HASH,
          payer: BUYER_WALLET,
          response: { success: true, transaction: TX_HASH, payer: BUYER_WALLET, network: 'base' },
        }
      },
      classify: (...args) => classify(...args),
    }
    const matched = (finalizedAt: Date): PaymentFlowDependencies['classify'] => async () => ({
      state: 'matched',
      from: BUYER_WALLET,
      to: SELLER_WALLET,
      amount: 2_000_000n,
      blockTime,
      blockNumber: 22_000_001n,
      blockHash: `0x${'66'.repeat(32)}`,
      finalizedAt,
    })
    const routes = new Hono()
    routes.onError(error => { throw error })
    mountWorldMarketRoutes(routes, {
      query,
      readOnlyTransaction: async () => { throw new Error('unused: this suite reads no offer batch') },
      authenticate: async c => {
        const header = c.req.header('authorization')
        if (header === `Bearer ${KEEPER.secret}`) return { id: KEEPER.id, handle: KEEPER.handle }
        if (header === `Bearer ${NEIGHBOUR.secret}`) return { id: NEIGHBOUR.id, handle: NEIGHBOUR.handle }
        return null
      },
      now: () => new Date(),
      marketOrigin: MARKET,
      marketGet: async path => {
        marketReads.push(path)
        return market(path)
      },
      findPayment: findPaymentAttempt,
      runPayment: input => runDurableX402(input, payment),
      resumePayment: input => resumeDurableX402(input, payment),
      recordEnds: thingIds => recordDueEndQuietly(thingIds),
    })
    const recovery = () => createPaymentRecoveryRuntime({ query }, {
      resumeX402: (input, overrides) => resumeDurableX402(input, { ...payment, ...overrides }),
    })

    const reset = async () => {
      const rooms = await resetCity([FOUNDER, NEIGHBOUR, KEEPER])
      continent = rooms.continentId
      home = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
        VALUES ($1, 'place', 'Keeper Yard', 'the keeper''s own yard', $2, TRUE) RETURNING id
      `, [rooms.continentId, KEEPER.id])).id)
      shed = Number((await one<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
        VALUES ($1, 'place', 'Keeper Shed', 'a shed in the yard', $2, TRUE) RETURNING id
      `, [home, KEEPER.id])).id)
      await standIn(KEEPER.id, shed)
      await standIn(NEIGHBOUR.id, shed)
      market = path => { throw new Error(`unexpected market read: ${path}`) }
      marketReads.length = 0
      settlements = 0
      classify = async () => ({ state: 'pending' })
    }
    /** A thing of a kind whose one trait has end steps, with waking on, in the keeper's yard. */
    const endingLantern = async (name: string) => {
      const coined = await coin(app, KEEPER.secret, 'last-light', { end: { then: [{ effect: 'write', key: 'ended', op: 'add' }] } })
      assert.ok(coined.status === 201 || coined.status === 409, JSON.stringify(coined.json))
      const kind = await seedKind(KEEPER.id, `lanterns-${name.replaceAll(' ', '-')}`, [await traitId('last-light')])
      const id = await seedThing(KEEPER.id, home, kind, name)
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [id])
      return id
    }
    const directOffer = async (type: 'thing' | 'place' | 'kind', assetId: number) => {
      const id = Number((await one<{ id: number }>(`
        INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
        VALUES ('direct', $1, $2, $3, $4, 2.000000, $5) RETURNING id
      `, [type, assetId, KEEPER.id, NEIGHBOUR.id, SELLER_WALLET])).id)
      const table = type === 'thing' ? 'things' : type === 'place' ? 'places' : 'kinds'
      await db.query(`UPDATE ${table} SET active_offer_id = $1 WHERE id = $2`, [id, assetId])
      return id
    }
    /** A world offer, optionally with a window opened `opened` ago (5 minutes wide). */
    const worldOffer = async (thingId: number, draftId: number, opened?: string) => {
      const row = await one<{ id: number; reserved_at: Date | null; reserved_until: Date | null }>(`
        WITH reservation AS MATERIALIZED (
          SELECT CASE WHEN $3::interval IS NULL THEN NULL
            ELSE date_trunc('second', clock_timestamp()) - $3::interval END AS reserved_at
        )
        INSERT INTO transfer_offers (
          channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet, buyer_wallet,
          market_origin, market_draft_id, market_listing_id, market_checkout_id, market_buyer,
          status, reserved_by, reserved_at, reserved_until
        )
        SELECT 'world', 'thing', $1, $4, CASE WHEN reserved_at IS NULL THEN NULL ELSE $5::integer END,
          2.000000, $6, CASE WHEN reserved_at IS NULL THEN NULL ELSE $7 END,
          $8, $2, CASE WHEN reserved_at IS NULL THEN NULL ELSE $9::integer END,
          CASE WHEN reserved_at IS NULL THEN NULL ELSE 80 + $2 END,
          CASE WHEN reserved_at IS NULL THEN NULL ELSE 'market-buyer' END,
          'open', CASE WHEN reserved_at IS NULL THEN NULL ELSE $5::integer END,
          reserved_at, reserved_at + interval '5 minutes'
        FROM reservation
        RETURNING id, reserved_at, reserved_until
      `, [thingId, draftId, opened ?? null, KEEPER.id, NEIGHBOUR.id, SELLER_WALLET, BUYER_WALLET, MARKET, LISTING_ID])
      await db.query('UPDATE things SET active_offer_id = $1 WHERE id = $2', [row.id, thingId])
      return row
    }
    const directClaim = (offerId: number, payment?: string, body: Json = { buyer_wallet: BUYER_WALLET }) =>
      Promise.resolve(app.request(`http://city.test/api/transfer/${offerId}/claim`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${NEIGHBOUR.secret}`,
          'content-type': 'application/json',
          ...(payment ? { 'x-payment': payment } : {}),
        },
        body: JSON.stringify(body),
      })).then(answer)
    const worldClaim = (offerId: number, body: Json, payment?: string) => Promise.resolve(routes.request(`/api/world/offer/${offerId}/claim`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${NEIGHBOUR.secret}`,
        'content-type': 'application/json',
        ...(payment ? { 'x-payment': payment } : {}),
      },
      body: JSON.stringify(body),
    })).then(answer)
    const worldCancel = (offerId: number) => Promise.resolve(routes.request(`/api/world/offer/${offerId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEEPER.secret}`, 'content-type': 'application/json' },
      body: '{}',
    })).then(answer)
    // The market's own listing answer for an ended thing, copied from 1F3EA PR #71 (M1a) at
    // d6d5ca5, as T12's tests use it; its ids are set to the offer's.
    const m1a = JSON.parse(await readFile(new URL('../fixtures/m1a-world-thing-ended-listing.json', import.meta.url), 'utf8')) as {
      listing: Json
      draft: Json
    }
    // The listing answer when the offer names its listing; the draft answer otherwise, with
    // the M1a draft's status and listing_state and the fields the city's draft read needs.
    const endedMarket = (offerId: number, thingId: number, draftId: number) => (path: string): Json => {
      if (path === `/api/listing/${LISTING_ID}`) {
        return { listing: { ...m1a.listing, id: LISTING_ID, world_offer_id: offerId, world_asset_id: thingId, world_draft_id: draftId } }
      }
      assert.equal(path, `/api/world/draft/${draftId}`)
      const now = Date.now()
      return { draft: {
        id: draftId, status: m1a.draft.status, delivery_kind: 'city_ownership', world_asset: { type: 'thing', id: thingId },
        title: 'an ending lantern', description: 'a lantern with an end', preview: 'a lantern',
        price_usdc: 2, seller_wallet: SELLER_WALLET, listing_id: LISTING_ID, listing_state: m1a.draft.listing_state,
        expires_at: new Date(now + 3_600_000).toISOString(), created_at: new Date(now - 60_000).toISOString(),
      } }
    }
    const reservedBy = async (offerId: number) => (await one<{ reserved_by: number | null }>(
      'SELECT reserved_by FROM transfer_offers WHERE id = $1', [offerId],
    )).reserved_by

    await t.test('a direct claim refuses E8 on a due, an ended and a soon-ending thing; places and kinds with its id still reserve', async () => {
      await reset()
      const far = await seedThing(KEEPER.id, home, null, 'a far lamp')
      const soon = await seedThing(KEEPER.id, home, null, 'a soon lamp')
      const ended = await seedThing(KEEPER.id, home, null, 'an ended lamp')
      await db.query(`
        INSERT INTO things (id, place_id, name, body, owner_id, maker_id) VALUES ($1, $2, 'a due lamp', '', $3, $3)
      `, [SAME_ID, home, KEEPER.id])
      await db.query(`
        INSERT INTO places (id, parent_id, place_kind, name, description, owner_id)
        VALUES ($1, $2, 'place', 'Same Number Plot', 'a plot sharing a number', $3)
      `, [SAME_ID, continent, KEEPER.id])
      await db.query(`INSERT INTO kinds (id, name, owner_id) VALUES ($1, 'same-number-kind', $2)`, [SAME_ID, KEEPER.id])
      await db.query('INSERT INTO kind_revisions (kind_id, revision) VALUES ($1, 1)', [SAME_ID])

      const offers = {
        far: await directOffer('thing', far),
        soon: await directOffer('thing', soon),
        ended: await directOffer('thing', ended),
        due: await directOffer('thing', SAME_ID),
        place: await directOffer('place', SAME_ID),
        kind: await directOffer('kind', SAME_ID),
      }
      await setEnd(far, { at: '1 hour' })
      await setEnd(soon, { at: '2 minutes' })
      await setEnd(ended, { at: '-2 minutes' })
      await setEnd(SAME_ID, { at: '-1 minute' })
      assert.deepEqual([...await recordDueEnd([ended])], [ended])

      for (const [name, offerId] of [['soon', offers.soon], ['ended', offers.ended], ['due', offers.due]] as const) {
        const claim = await directClaim(offerId)
        assert.equal(claim.status, 409, `${name}: ${JSON.stringify(claim.json)}`)
        assert.equal(claim.json.error, ENDING_PURCHASE_REFUSAL, name)
        assert.equal(await reservedBy(offerId), null, `${name}: no reservation`)
      }
      const due = await thingRow(SAME_ID)
      assert.notEqual(due.ended_at, null, 'the claim records the due end first')
      assert.equal(due.ended_owner_id, KEEPER.id)
      assert.equal((await endedEvents(SAME_ID)).length, 1)
      assert.equal((await endedEvents(ended)).length, 1, 'an end already recorded is not recorded again')
      assert.equal(await endTries(SAME_ID), 0, 'a claim runs nothing')

      for (const [name, offerId] of [['far', offers.far], ['place', offers.place], ['kind', offers.kind]] as const) {
        const claim = await directClaim(offerId)
        assert.equal(claim.status, 402, `${name}: ${JSON.stringify(claim.json)}`)
        assert.equal(await reservedBy(offerId), NEIGHBOUR.id, `${name}: reserved`)
      }
    })

    await t.test('a direct claim whose end comes inside the open window refuses E8 and its payment never settles', async () => {
      await reset()
      const lamp = await seedThing(KEEPER.id, home, null, 'a lamp ended by a label')
      const offerId = await directOffer('thing', lamp)
      await setEnd(lamp, { label: 'spent' })
      const opened = await directClaim(offerId)
      assert.equal(opened.status, 402, JSON.stringify(opened.json))
      // The route judges a window begun by this process's clock; move it ten seconds back so a
      // container clock a little ahead of the host cannot make it look not yet begun.
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(`
          UPDATE transfer_offers SET reserved_at = reserved_at - interval '10 seconds',
            reserved_until = reserved_until - interval '10 seconds' WHERE id = $1
        `, [offerId])
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const reservation = await one<{ reserved_at: Date; reserved_until: Date }>(
        'SELECT reserved_at, reserved_until FROM transfer_offers WHERE id = $1', [offerId],
      )
      // A real path: a label put on now makes the label_added end due at once.
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'spent', $2)
      `, [lamp, KEEPER.id])
      assert.equal((await thingRow(lamp)).due, true)

      const realFetch = globalThis.fetch
      let fetched = 0
      globalThis.fetch = (async () => {
        fetched += 1
        throw new Error('no network: a refused claim must never reach the facilitator')
      }) as typeof fetch
      try {
        const instructions = await directClaim(offerId, undefined, {})
        assert.equal(instructions.status, 409, JSON.stringify(instructions.json))
        assert.equal(instructions.json.error, ENDING_PURCHASE_REFUSAL, 'no payment instructions once the end came')
        const paid = await directClaim(offerId, paymentHeader(reservation.reserved_at, reservation.reserved_until), {})
        assert.equal(paid.status, 409, JSON.stringify(paid.json))
        assert.equal(paid.json.error, ENDING_PURCHASE_REFUSAL)
      } finally {
        globalThis.fetch = realFetch
      }
      assert.equal(fetched, 0, 'the payment is never verified or settled')
      assert.equal(await count('SELECT count(*) AS n FROM payment_attempts'), 0)
      const offer = await one<Json>('SELECT status, reserved_by FROM transfer_offers WHERE id = $1', [offerId])
      assert.deepEqual(offer, { status: 'open', reserved_by: NEIGHBOUR.id }, 'the offer and its window stay as they were')
      assert.equal((await thingRow(lamp)).owner_id, KEEPER.id)
    })

    await t.test('a world claim refuses E8 on a due, an ended and a soon-ending thing before any market read', async () => {
      await reset()
      const far = await seedThing(KEEPER.id, home, null, 'a far lamp')
      const soon = await seedThing(KEEPER.id, home, null, 'a soon lamp')
      const ended = await seedThing(KEEPER.id, home, null, 'an ended lamp')
      const due = await seedThing(KEEPER.id, home, null, 'a due lamp')
      const offers = {
        far: (await worldOffer(far, 71)).id,
        soon: (await worldOffer(soon, 72)).id,
        ended: (await worldOffer(ended, 73)).id,
        due: (await worldOffer(due, 74)).id,
      }
      await setEnd(far, { at: '1 hour' })
      await setEnd(soon, { at: '2 minutes' })
      await setEnd(ended, { at: '-2 minutes' })
      await setEnd(due, { at: '-1 minute' })
      assert.deepEqual([...await recordDueEnd([ended])], [ended])

      for (const [name, offerId] of [['soon', offers.soon], ['ended', offers.ended], ['due', offers.due]] as const) {
        const claim = await worldClaim(offerId, { market_checkout_id: 81, buyer_wallet: BUYER_WALLET })
        assert.equal(claim.status, 409, `${name}: ${JSON.stringify(claim.json)}`)
        assert.equal(claim.json.error, ENDING_PURCHASE_REFUSAL, name)
        assert.equal(await reservedBy(offerId), null)
      }
      assert.deepEqual(marketReads, [], 'a thing whose end has come or is near costs no market call')
      assert.notEqual((await thingRow(due)).ended_at, null, 'claim_world records the due end first')
      assert.equal((await endedEvents(due)).length, 1)

      const now = Date.now()
      market = path => {
        if (path === '/api/world/checkout/81') {
          return { checkout: {
            id: 81, status: 'active', listing_id: LISTING_ID, world_offer_id: offers.far, market_draft_id: 71,
            market_buyer: 'market-buyer', city_handle: NEIGHBOUR.handle,
            expires_at: new Date(now + 600_000).toISOString(), created_at: new Date(now - 30_000).toISOString(),
          } }
        }
        if (path === '/api/world/draft/71') {
          return { draft: {
            id: 71, status: 'active', delivery_kind: 'city_ownership', world_asset: { type: 'thing', id: far },
            title: 'a far lamp', description: 'a lamp with an end an hour off', preview: 'a lamp',
            price_usdc: 2, seller_wallet: SELLER_WALLET, listing_id: LISTING_ID, listing_state: 'active',
            expires_at: new Date(now + 3_600_000).toISOString(), created_at: new Date(now - 60_000).toISOString(),
          } }
        }
        throw new Error(`unexpected market read: ${path}`)
      }
      const reserved = await worldClaim(offers.far, { market_checkout_id: 81, buyer_wallet: BUYER_WALLET })
      assert.notEqual(reserved.json.error, ENDING_PURCHASE_REFUSAL, JSON.stringify(reserved.json))
      assert.equal(await reservedBy(offers.far), NEIGHBOUR.id, 'an end an hour off still reserves through the end clause')
      assert.deepEqual(marketReads, ['/api/world/checkout/81', '/api/world/draft/71'])
    })

    await t.test('a world claim whose end comes inside the open window refuses E8 and writes no payment attempt', async () => {
      await reset()
      const lamp = await seedThing(KEEPER.id, home, null, 'a world lamp ended by a label')
      // The window was opened ten seconds ago on the database clock, as the direct case moves
      // its window back, so a container clock a little ahead of the host cannot hide it.
      const offer = await worldOffer(lamp, 77, '10 seconds')
      assert.equal(await reservedBy(offer.id), NEIGHBOUR.id)
      await setEnd(lamp, { label: 'spent' })
      // A real path: a label put on now makes the label_added end due at once.
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'spent', $2)
      `, [lamp, KEEPER.id])
      assert.equal((await thingRow(lamp)).due, true)

      const realFetch = globalThis.fetch
      let fetched = 0
      globalThis.fetch = (async () => {
        fetched += 1
        throw new Error('no network: a refused claim must never reach the facilitator')
      }) as typeof fetch
      try {
        const instructions = await worldClaim(offer.id, {})
        assert.equal(instructions.status, 409, JSON.stringify(instructions.json))
        assert.equal(instructions.json.error, ENDING_PURCHASE_REFUSAL, 'no payment instructions once the end came')
        const paid = await worldClaim(offer.id, {}, paymentHeader(offer.reserved_at!, offer.reserved_until!))
        assert.equal(paid.status, 409, JSON.stringify(paid.json))
        assert.equal(paid.json.error, ENDING_PURCHASE_REFUSAL)
      } finally {
        globalThis.fetch = realFetch
      }
      assert.equal(fetched, 0, 'the payment is never verified or settled')
      assert.equal(settlements, 0)
      assert.deepEqual(marketReads, [], 'a refused claim costs no market call')
      assert.equal(await count('SELECT count(*) AS n FROM payment_attempts'), 0, 'no payment attempt is written')
      const after = await thingRow(lamp)
      assert.notEqual(after.ended_at, null, 'the claim records the due end first')
      assert.equal(after.owner_id, KEEPER.id)
      const kept = await one<Json>('SELECT status, reserved_by FROM transfer_offers WHERE id = $1', [offer.id])
      assert.deepEqual(kept, { status: 'open', reserved_by: NEIGHBOUR.id }, 'the offer and its window stay as they were')
    })

    await t.test('claim_world on a due thing records and runs nothing; cancelled first, its program runs at the next settle', async () => {
      await reset()
      const lantern = await endingLantern('a sold lantern')
      const offer = await worldOffer(lantern, 75)
      await setEnd(lantern, { at: '-1 minute' })
      const claim = await worldClaim(offer.id, { market_checkout_id: 81, buyer_wallet: BUYER_WALLET })
      assert.equal(claim.status, 409, JSON.stringify(claim.json))
      assert.equal(claim.json.error, ENDING_PURCHASE_REFUSAL)
      const recorded = await thingRow(lantern)
      assert.notEqual(recorded.ended_at, null)
      assert.equal(recorded.end_program_state, 'pending')
      assert.deepEqual(recorded.state, {}, 'and runs nothing')
      assert.equal(await endTries(lantern), 0)

      market = endedMarket(offer.id, lantern, 75)
      const cancel = await worldCancel(offer.id)
      assert.equal(cancel.status, 200, JSON.stringify(cancel.json))
      assert.equal((await thingRow(lantern)).active_offer_id, null)

      await standIn(KEEPER.id, home)
      const arrived = await call(app, KEEPER.secret, 'GET', '/api/me')
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      const after = await thingRow(lantern)
      assert.equal(after.end_program_state, 'ran')
      assert.deepEqual(after.state, { ended: 1 })
      assert.equal(await endTries(lantern), 1, 'the program ran once')
    })

    await t.test('claim_world on a due thing, then a settle while the sale is open: its end steps are skipped for good', async () => {
      await reset()
      const lantern = await endingLantern('a lantern still for sale')
      const offer = await worldOffer(lantern, 76)
      await setEnd(lantern, { at: '-1 minute' })
      const claim = await worldClaim(offer.id, { market_checkout_id: 81, buyer_wallet: BUYER_WALLET })
      assert.equal(claim.json.error, ENDING_PURCHASE_REFUSAL)

      await standIn(KEEPER.id, home)
      assert.equal((await call(app, KEEPER.secret, 'GET', '/api/me')).status, 200)
      const skipped = await thingRow(lantern)
      assert.equal(skipped.end_program_state, 'skipped')
      assert.ok(JSON.stringify(skipped.end_program_result).includes(END_TRY_SKIP_REASONS.in_sale), JSON.stringify(skipped.end_program_result))
      assert.deepEqual(skipped.state, {})

      market = endedMarket(offer.id, lantern, 76)
      assert.equal((await worldCancel(offer.id)).status, 200)
      await db.query('ALTER TABLE wake_settles DISABLE TRIGGER wake_settles_append_only')
      try {
        await db.query(`UPDATE wake_settles SET created_at = created_at - interval '30 seconds' WHERE place_id = $1`, [home])
      } finally {
        await db.query('ALTER TABLE wake_settles ENABLE TRIGGER wake_settles_append_only')
      }
      assert.equal((await call(app, KEEPER.secret, 'GET', '/api/me')).status, 200)
      const later = await thingRow(lantern)
      assert.equal(later.end_program_state, 'skipped', 'never tried again')
      assert.deepEqual(later.state, {})
    })

    await t.test('the end passes while payment is pending: recovery moves the remnant whole, records nothing, and the next write records the seller', async () => {
      await reset()
      const lantern = await endingLantern('a lantern sold in a race')
      // A window opened 4 minutes 58 seconds ago, and an end a second after it closes.
      const offer = await worldOffer(lantern, 77, '4 minutes 58 seconds')
      const reservedAt = offer.reserved_at!
      const reservedUntil = offer.reserved_until!
      const endsAt = new Date(reservedUntil.getTime() + 1_000)
      await setEnd(lantern, { atTime: endsAt })
      blockTime = new Date(Math.ceil(reservedAt.getTime() / 1_000) * 1_000)

      const paid = await worldClaim(offer.id, {}, paymentHeader(reservedAt, reservedUntil))
      assert.equal(paid.status, 202, JSON.stringify(paid.json))
      assert.equal(settlements, 1)
      const attempt = await one<{ public_id: string; end_time: Date }>(`
        SELECT public_id, end_time FROM payment_attempts WHERE operation = 'world_sale' AND offer_id = $1
      `, [offer.id])

      const finalizedAt = await waitPastDatabaseTime(db, endsAt)
      assert.ok(finalizedAt > attempt.end_time, 'finality comes after the reservation window')
      assert.equal((await thingRow(lantern)).due, true, 'the end came while payment was pending')

      // The buyer's explicit recheck while the chain is not yet final, then the scheduled run.
      const runtime = recovery()
      const record = await getPaymentAttemptRecord({ query }, { publicId: attempt.public_id, actorId: NEIGHBOUR.id })
      assert.ok(record)
      await runtime.recheck(record)
      assert.equal((await thingRow(lantern)).ended_at, null, 'an explicit recheck records no end')
      classify = matched(finalizedAt)
      const batch = await runtime.runBatch(10)
      assert.equal(batch.completed, 1, JSON.stringify(batch))

      const sold = await thingRow(lantern)
      assert.equal(sold.owner_id, NEIGHBOUR.id, 'accepted evidence keeps its sale and the remnant moves whole')
      assert.equal(sold.active_offer_id, null)
      assert.equal(sold.wake_enabled, false, 'an owner change turns waking off')
      assert.equal(sold.ended_at, null, 'payment recovery never records an end (#167)')
      assert.equal((await endedEvents(lantern)).length, 0)
      assert.equal(await endTries(lantern), 0)
      assert.equal(settlements, 1, 'no second payment')
      assert.equal(await count('SELECT count(*) AS n FROM payment_attempts'), 1)
      assert.equal((await one<Json>('SELECT status FROM transfer_offers WHERE id = $1', [offer.id])).status, 'claimed')

      // The next resident write naming the thing records it; the seller owned it at the end.
      await standIn(NEIGHBOUR.id, home)
      await call(app, NEIGHBOUR.secret, 'POST', '/api/transfer/offer', {
        type: 'thing', id: lantern, to_handle: KEEPER.handle, price_usdc: 2, seller_wallet: BUYER_WALLET,
      })
      const recorded = await thingRow(lantern)
      assert.notEqual(recorded.ended_at, null)
      assert.equal(recorded.ended_owner_id, KEEPER.id, 'the owner at the end is the seller')
      const [event] = await endedEvents(lantern) as [Json]
      assert.equal(event.owner, KEEPER.handle)
      assert.equal(event.program_state, 'pending', 'recorded with its program waiting')

      // Waking went off with the sale, so the program is skipped, never run.
      assert.equal((await call(app, NEIGHBOUR.secret, 'GET', '/api/me')).status, 200)
      const settled = await thingRow(lantern)
      assert.equal(settled.end_program_state, 'skipped')
      assert.ok(JSON.stringify(settled.end_program_result).includes(END_TRY_SKIP_REASONS.wake_off), JSON.stringify(settled.end_program_result))
      assert.deepEqual(settled.state, {})
    })

    await t.test('recovery fails after the end came: the market shows thing_ended, then the seller cancel unlocks the remnant', async () => {
      await reset()
      const lantern = await endingLantern('a lantern whose payment failed')
      const offer = await worldOffer(lantern, 78, '4 minutes 58 seconds')
      const reservedAt = offer.reserved_at!
      const reservedUntil = offer.reserved_until!
      const endsAt = new Date(reservedUntil.getTime() + 1_000)
      await setEnd(lantern, { atTime: endsAt })
      blockTime = new Date(Math.ceil(reservedAt.getTime() / 1_000) * 1_000)
      const paid = await worldClaim(offer.id, {}, paymentHeader(reservedAt, reservedUntil))
      assert.equal(paid.status, 202, JSON.stringify(paid.json))
      await waitPastDatabaseTime(db, endsAt)

      classify = async () => ({ state: 'invalid_final', reason: 'failed_transaction' })
      const batch = await recovery().runBatch(10)
      assert.equal(batch.terminalized, 1, JSON.stringify(batch))
      assert.equal((await thingRow(lantern)).ended_at, null, 'recovery records no end')
      const read = await routes.request(`/api/world/offer/${offer.id}`)
      const shown = (await read.json() as { offer: Json }).offer
      assert.equal(shown.phase, 'payment_invalid')
      assert.equal(shown.asset_state, 'remnant')

      market = endedMarket(offer.id, lantern, 78)
      const cancel = await worldCancel(offer.id)
      assert.equal(cancel.status, 200, JSON.stringify(cancel.json))
      const unlocked = await thingRow(lantern)
      assert.equal(unlocked.active_offer_id, null)
      assert.equal(unlocked.owner_id, KEEPER.id)
      assert.notEqual(unlocked.ended_at, null, 'the cancel recorded the end first')
      assert.equal(unlocked.ended_owner_id, KEEPER.id)
      assert.equal(settlements, 1)
    })
  } finally {
    await postgres.stop()
  }
})
