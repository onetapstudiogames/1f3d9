import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mountWorldMarketRoutes, type WorldMarketDependencies } from '../../src/world-market.ts'
import { makeHarness } from '../helpers/world-market-fixtures/harness.ts'
import { BUYER_WALLET, MARKET, NOW, openOffer, type FakeOffer } from '../helpers/world-market-fixtures/offers.ts'

type Statement = Parameters<WorldMarketDependencies['readOnlyTransaction']>[0][number]

const LISTED_BODY = '{"offer":{"id":101,"channel":"world","phase":"listed","asset_type":"thing","asset_id":41,"asset_name":"porch lantern","maker_id":6,"made_by":"old-maker","current_owner_id":7,"current_owner":"tiny-lantern","locked":true,"seller":"tiny-lantern","buyer":null,"price_usdc":2,"seller_wallet":"0x1111111111111111111111111111111111111111","market_origin":"https://1f3ea.com","market_draft_id":71,"market_listing_id":null,"market_checkout_id":null,"market_buyer":null,"pending_x402_tx_hash":null,"pending_x402_at":null,"x402_invalid_reason":null,"x402_invalid_at":null,"reserved_at":null,"reserved_until":null,"created_at":"2026-08-12T11:30:00.000Z","claimed_at":null,"canceled_at":null,"tx_hash":null,"buyer_wallet":null,"verified_via":null,"block_time":null,"from":null,"to":null}}'
const RESERVED_BODY = '{"offer":{"id":101,"channel":"world","phase":"reserved","asset_type":"thing","asset_id":41,"asset_name":"porch lantern","maker_id":6,"made_by":"old-maker","current_owner_id":7,"current_owner":"tiny-lantern","locked":true,"seller":"tiny-lantern","buyer":"neighbor","price_usdc":2,"seller_wallet":"0x1111111111111111111111111111111111111111","market_origin":"https://1f3ea.com","market_draft_id":71,"market_listing_id":91,"market_checkout_id":81,"market_buyer":"market-buyer","pending_x402_tx_hash":null,"pending_x402_at":null,"x402_invalid_reason":null,"x402_invalid_at":null,"reserved_at":"2026-08-12T12:00:00.000Z","reserved_until":"2026-08-12T12:05:00.000Z","created_at":"2026-08-12T11:30:00.000Z","claimed_at":null,"canceled_at":null,"tx_hash":null,"buyer_wallet":"0x2222222222222222222222222222222222222222","verified_via":null,"block_time":null,"from":null,"to":null}}'
const LIMIT_REFUSAL = 'world offer ids were rejected because one read takes at most 50 ids, repeats included; split them into reads of 50 or fewer and retry'

function offerFor(id: number, overrides: Partial<FakeOffer> = {}): FakeOffer {
  return openOffer({ id, asset_id: id + 1_000, market_draft_id: id + 2_000, ...overrides })
}

// Serves both reads from the same rows: the single read through query, the batch
// through readOnlyTransaction, so a batch entry can be compared with the single answer.
function batchApp(offers: readonly FakeOffer[], hiddenThingIds: readonly number[] = []) {
  const hidden = new Set(hiddenThingIds)
  const transactions: Statement[][] = []
  const plainQueries: string[] = []
  let failure: unknown = null
  const dependencies: WorldMarketDependencies = {
    query: async (text, params) => {
      plainQueries.push(text)
      if (text.includes('world-market:read-offer')) {
        return offers.filter(offer => offer.id === Number(params[0])).map(offer => ({ ...offer }))
      }
      if (text.includes('world-market:public-moderation')) {
        return hidden.has(Number(params[0])) ? [{ action: 'remove' }] : []
      }
      throw new Error(`unhandled fake query: ${text}`)
    },
    readOnlyTransaction: async statements => {
      transactions.push([...statements])
      if (failure) throw failure
      const batch = statements.find(statement => statement.text.includes('world-market:offer-batch'))
      if (!batch) throw new Error('the batch read was not sent')
      const ids = new Set((batch.params[0] as readonly number[]).map(Number))
      // Newest first, the opposite of most requests, so the route must restore request order.
      const rows = offers
        .filter(offer => ids.has(offer.id))
        .sort((left, right) => right.id - left.id)
        .map(offer => ({ ...offer, maintainer_hidden: hidden.has(offer.asset_id) }))
      return statements.map(statement => statement === batch ? rows : [])
    },
    authenticate: async () => null,
    now: () => new Date(NOW),
    marketOrigin: MARKET,
    marketGet: async path => { throw new Error(`unexpected market read: ${path}`) },
    findPayment: async () => { throw new Error('unexpected payment read') },
    runPayment: async () => { throw new Error('unexpected payment') },
    resumePayment: async () => { throw new Error('unexpected payment') },
  }
  const app = new Hono()
  mountWorldMarketRoutes(app, dependencies)
  return {
    app,
    transactions: () => transactions,
    plainQueries: () => plainQueries,
    failWith: (error: unknown) => { failure = error },
  }
}

async function singleOffer(app: Hono, id: number): Promise<unknown> {
  const response = await app.request(`/api/world/offer/${id}`)
  assert.equal(response.status, 200)
  return (await response.json() as { offer: unknown }).offer
}

function assertOneBoundedRead(transactions: readonly Statement[][], ids: readonly number[]): void {
  assert.equal(transactions.length, 1, 'the batch is one read-only transaction')
  const [timeout, read] = transactions[0]!
  assert.equal(transactions[0]!.length, 2, 'the timeout and one query')
  assert.equal(timeout!.text, "SET LOCAL statement_timeout = '1500ms'")
  assert.deepEqual(timeout!.params, [])
  assert.match(read!.text, /world-market:offer-batch/u)
  assert.deepEqual(read!.params, [ids])
}

export function registerOfferBatchTests(): void {
  test('one world offer id answers in the single offer shape with no-store', async () => {
    const city = batchApp([offerFor(101)])
    const response = await city.app.request('/api/world/offers?ids=101')
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json() as { offers: unknown[] }
    assert.deepEqual(payload, { offers: [await singleOffer(city.app, 101)] })
    assertOneBoundedRead(city.transactions(), [101])
  })

  test('fifty world offer ids answer in request order from one query', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => 201 + ((index * 7) % 50))
    assert.equal(new Set(ids).size, 50)
    const city = batchApp(ids.map(id => offerFor(id, id % 2 === 0
      ? {}
      : {
          buyer_id: 8,
          buyer: 'neighbor',
          reserved_by: 8,
          buyer_wallet: BUYER_WALLET,
          market_listing_id: 91,
          market_checkout_id: 81,
          reserved_at: NOW.toISOString(),
          reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
        })))
    const response = await city.app.request(`/api/world/offers?ids=${ids.join(',')}`)
    assert.equal(response.status, 200, await response.clone().text())
    const payload = await response.json() as { offers: Array<{ id: number; phase: string }> }
    assert.deepEqual(payload.offers.map(offer => offer.id), ids)
    assert.deepEqual(new Set(payload.offers.map(offer => offer.phase)), new Set(['listed', 'reserved']))
    assertOneBoundedRead(city.transactions(), ids)
    assert.deepEqual(city.plainQueries(), [], 'the batch never reads outside its bounded query')
    for (const [index, id] of ids.entries()) {
      assert.deepEqual(payload.offers[index], await singleOffer(city.app, id), `offer ${id}`)
    }
  })

  test('fifty-one world offer ids are refused before any read', async () => {
    const city = batchApp([offerFor(101)])
    const ids = Array.from({ length: 51 }, (_, index) => 101 + index)
    const response = await city.app.request(`/api/world/offers?ids=${ids.join(',')}`)
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      error: 'world offer ids were rejected because one read takes at most 50 ids, repeats included; split them into reads of 50 or fewer and retry',
    })
    const repeated = await city.app.request(`/api/world/offers?ids=${Array(51).fill(101).join(',')}`)
    assert.equal(repeated.status, 400)
    assert.deepEqual(await repeated.json(), { error: LIMIT_REFUSAL })
    assert.deepEqual(city.transactions(), [])
    assert.deepEqual(city.plainQueries(), [])
  })

  test('a repeated world offer id is read and answered once, where it first appears', async () => {
    const city = batchApp([offerFor(101), offerFor(102)])
    const response = await city.app.request('/api/world/offers?ids=102,101,102,101')
    assert.equal(response.status, 200)
    const payload = await response.json() as { offers: Array<{ id: number }> }
    assert.deepEqual(payload.offers.map(offer => offer.id), [102, 101])
    assertOneBoundedRead(city.transactions(), [102, 101])
  })

  test('a bad world offer id or option is refused before any read', async () => {
    const city = batchApp([offerFor(101)])
    for (const query of [
      '',
      '?ids=',
      '?ids=101,',
      '?ids=,101',
      '?ids=101,,102',
      '?ids=0',
      '?ids=-1',
      '?ids=1.5',
      '?ids=1e2',
      '?ids=0101',
      '?ids=%2B101',
      '?ids=101,%20102',
      '?ids=abc',
      '?ids=2147483648',
      '?ids=101&ids=102',
    ]) {
      const response = await city.app.request(`/api/world/offers${query}`)
      assert.equal(response.status, 400, query)
      assert.equal(response.headers.get('cache-control'), 'no-store', query)
      assert.deepEqual(await response.json(), {
        error: 'world offer ids were rejected because ids must appear once and list positive whole numbers separated by commas with no spaces; retry with ids such as ids=101,102',
      }, query)
    }
    const option = await city.app.request('/api/world/offers?ids=101&limit=5')
    assert.equal(option.status, 400)
    assert.deepEqual(await option.json(), { error: 'unsupported query option: limit; remove the shown option and retry' })
    assert.deepEqual(city.transactions(), [])
    assert.deepEqual(city.plainQueries(), [])
  })

  test('a missing world offer id is marked not_found in its place', async () => {
    const city = batchApp([offerFor(101), offerFor(103)])
    const response = await city.app.request('/api/world/offers?ids=103,102,101')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      offers: [
        await singleOffer(city.app, 103),
        { id: 102, status: 'not_found' },
        await singleOffer(city.app, 101),
      ],
    })
    assert.equal((await city.app.request('/api/world/offer/102')).status, 404)
  })

  test('a maintainer-hidden world offer is marked as the single read marks it', async () => {
    const hiddenOffer = offerFor(102)
    const city = batchApp([offerFor(101), hiddenOffer], [hiddenOffer.asset_id])
    const response = await city.app.request('/api/world/offers?ids=101,102')
    assert.equal(response.status, 200)
    const payload = await response.json() as { offers: unknown[] }
    assert.deepEqual(payload.offers, [
      await singleOffer(city.app, 101),
      { id: 102, status: 'maintainer_hidden' },
    ])
    assert.deepEqual(payload.offers[1], await singleOffer(city.app, 102))
    assert.equal(JSON.stringify(payload.offers[1]).includes(hiddenOffer.asset_name), false)
  })

  test('a world offer batch past its 1,500 ms timeout answers busy with no-store', async () => {
    const city = batchApp([offerFor(101)])
    city.failWith(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
    const response = await city.app.request('/api/world/offers?ids=101')
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('retry-after'), '1')
    assert.deepEqual(await response.json(), { error: 'world offers are temporarily busy; retry the same read' })
    assertOneBoundedRead(city.transactions(), [101])
  })

  test('the single world offer read answers byte for byte as before', async () => {
    const reservedOffer = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const cases = [
      { patch: { offer: openOffer(), thingLocked: true }, path: '/api/world/offer/101', status: 200, body: LISTED_BODY },
      { patch: { offer: reservedOffer, thingLocked: true }, path: '/api/world/offer/101', status: 200, body: RESERVED_BODY },
      {
        patch: { offer: openOffer(), thingLocked: true, thingModerated: true },
        path: '/api/world/offer/101',
        status: 200,
        body: '{"offer":{"id":101,"status":"maintainer_hidden"}}',
      },
      {
        patch: { offer: null },
        path: '/api/world/offer/101',
        status: 404,
        body: '{"error":"world offer_id 101 was not found; re-read the 1F3EA listing and send its current city offer_id"}',
      },
      {
        patch: { offer: openOffer() },
        path: '/api/world/offer/abc',
        status: 400,
        body: '{"error":"world offer id was rejected because it must be a positive whole number; use GET /api/world-market if your client can open URLs, and retry with a current offer_id"}',
      },
      {
        patch: { offer: openOffer() },
        path: '/api/world/offer/101?q=1',
        status: 400,
        body: '{"error":"unsupported query option: q; remove the shown option and retry"}',
      },
    ] as const
    for (const entry of cases) {
      const harness = makeHarness(entry.patch)
      const response = await harness.app.request(entry.path)
      assert.equal(response.status, entry.status, entry.path)
      assert.deepEqual([...response.headers.entries()], [['content-type', 'application/json']], entry.path)
      assert.equal(await response.text(), entry.body, entry.path)
    }
  })
}
