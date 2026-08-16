import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono, type Context } from 'hono'
import { mountWorldMarketRoutes, type WorldMarketDependencies } from '../src/world-market.ts'
import { mcp } from '../src/mcp.ts'

const MARKET = 'https://1f3ea.com'
const SELLER_SECRET = 'Bearer seller-secret'
const BUYER_SECRET = 'Bearer buyer-secret'
const OTHER_SECRET = 'Bearer other-secret'
const SELLER_WALLET = '0x1111111111111111111111111111111111111111'
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const OTHER_WALLET = '0x3333333333333333333333333333333333333333'
const TX = '0x' + 'ab'.repeat(32)
const PAYMENT_ID = 'pay_world_offer_1234567890abcdef'
const X_PAYMENT = Buffer.from(JSON.stringify({
  payload: { authorization: { from: BUYER_WALLET } },
  extensions: {
    'payment-identifier': {
      info: { required: true },
      id: PAYMENT_ID,
    },
  },
})).toString('base64')
const X_PAYMENT_NO_ID = Buffer.from(JSON.stringify({
  payload: { authorization: { from: BUYER_WALLET } },
})).toString('base64')
const NOW = new Date('2026-08-12T12:00:00.000Z')

type OfferStatus = 'open' | 'claimed' | 'canceled'

interface FakeOffer {
  [key: string]: unknown
  id: number
  channel: 'world'
  asset_type: 'thing'
  asset_id: number
  asset_name: string
  seller_id: number
  seller: string
  buyer_id: number | null
  buyer: string | null
  price_usdc: number
  seller_wallet: string
  status: OfferStatus
  reserved_by: number | null
  buyer_wallet: string | null
  reserved_at: string | null
  reserved_until: string | null
  market_origin: string
  market_draft_id: number
  market_listing_id: number | null
  market_checkout_id: number | null
  market_buyer: string | null
  pending_x402_tx_hash: string | null
  pending_x402_payer: string | null
  pending_x402_at: string | null
  x402_evidence_state: 'none' | 'pending' | 'invalid'
  x402_invalid_reason: string | null
  x402_invalid_at: string | null
  created_at: string
  claimed_at: string | null
  canceled_at: string | null
  locked: boolean
  tx_hash: string | null
  verified_via: string | null
  block_time: string | null
  from: string | null
  to: string | null
}

interface FakeState {
  thingOwner: number
  thingWithdrawn: boolean
  thingLocked: boolean
  offer: FakeOffer | null
  draft: Record<string, unknown>
  checkout: Record<string, unknown>
  marketFailure: boolean
  marketInvalid: boolean
  directVerifications: number
  directVerificationAvailable: boolean
  directVerificationInvalid: boolean
  directBlockTime: string
  facilitatorSettlements: number
  paymentAttempts: Map<string, {
    public_id: string
    actor_id: number
    operation: string
    target_key: string | null
    request_hash: string
    method: string | null
    network: string | null
    token: string | null
    payer_wallet: string | null
    payee_wallet: string | null
    amount_units: string | null
    x402_nonce: string | null
    x402_payload_digest: string | null
    status: 'settling' | 'payment_pending' | 'completed' | 'invalid' | 'expired'
    tx_hash: string | null
    result_json: Record<string, unknown> | null
    created_at: string
    updated_at: string
    completed_at: string | null
  }>
  now: string
  queries: Array<{ text: string; params: readonly unknown[] }>
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 71,
    status: 'pending',
    delivery_kind: 'city_ownership',
    world_asset: { type: 'thing', id: 41 },
    title: 'porch lantern',
    description: 'A warm light from Lantern Town.',
    preview: 'warm light',
    price_usdc: 2,
    seller_wallet: SELLER_WALLET,
    listing_id: null,
    listing_state: null,
    expires_at: '2026-08-12T13:00:00.000Z',
    created_at: '2026-08-12T11:00:00.000Z',
    ...overrides,
  }
}

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    id: 81,
    status: 'active',
    listing_id: 91,
    world_offer_id: 101,
    market_draft_id: 71,
    market_buyer: 'market-buyer',
    city_handle: 'neighbor',
    expires_at: '2026-08-12T12:10:00.000Z',
    created_at: '2026-08-12T11:59:00.000Z',
    ...overrides,
  }
}

function openOffer(overrides: Partial<FakeOffer> = {}): FakeOffer {
  const offer: FakeOffer = {
    id: 101,
    channel: 'world',
    asset_type: 'thing',
    asset_id: 41,
    asset_name: 'porch lantern',
    seller_id: 7,
    seller: 'tiny-lantern',
    buyer_id: null,
    buyer: null,
    price_usdc: 2,
    seller_wallet: SELLER_WALLET,
    status: 'open',
    reserved_by: null,
    buyer_wallet: null,
    reserved_at: null,
    reserved_until: null,
    market_origin: MARKET,
    market_draft_id: 71,
    market_listing_id: null,
    market_checkout_id: null,
    market_buyer: null,
    pending_x402_tx_hash: null,
    pending_x402_payer: null,
    pending_x402_at: null,
    x402_evidence_state: 'none',
    x402_invalid_reason: null,
    x402_invalid_at: null,
    created_at: '2026-08-12T11:30:00.000Z',
    claimed_at: null,
    canceled_at: null,
    locked: true,
    tx_hash: null,
    verified_via: null,
    block_time: null,
    from: null,
    to: null,
    ...overrides,
  }
  return overrides.market_buyer === undefined && offer.buyer_id != null
    ? { ...offer, market_buyer: 'market-buyer' }
    : offer
}

function initialState(patch: Partial<FakeState> = {}): FakeState {
  return {
    thingOwner: 7,
    thingWithdrawn: false,
    thingLocked: false,
    offer: null,
    draft: draft(),
    checkout: checkout(),
    marketFailure: false,
    marketInvalid: false,
    directVerifications: 0,
    directVerificationAvailable: true,
    directVerificationInvalid: false,
    directBlockTime: NOW.toISOString(),
    facilitatorSettlements: 0,
    paymentAttempts: new Map(),
    now: NOW.toISOString(),
    queries: [],
    ...patch,
  }
}

function makeHarness(patch: Partial<FakeState> = {}) {
  let state = initialState(patch)

  const query = async (text: string, params: readonly unknown[]) => {
    state = { ...state, queries: [...state.queries, { text, params }] }
    if (text.includes('world-market:resident')) {
      const handle = String(params[0])
      return ['tiny-lantern', 'neighbor', 'someone-else'].includes(handle) ? [{ handle }] : []
    }
    if (text.includes('world-market:thing')) {
      return [{
        id: 41,
        name: 'porch lantern',
        owner_id: state.thingOwner,
        withdrawn_at: state.thingWithdrawn ? '2026-08-12T10:00:00.000Z' : null,
        active_offer_id: state.thingLocked ? state.offer?.id ?? 999 : null,
      }]
    }
    if (text.includes('world-market:create')) {
      if (state.thingOwner !== Number(params[1]) || state.thingWithdrawn || state.thingLocked) return []
      const offer = openOffer({
        id: 101,
        asset_id: Number(params[0]),
        seller_id: Number(params[1]),
        seller: String(params[2]),
        price_usdc: Number(params[3]),
        seller_wallet: String(params[4]),
        market_origin: String(params[5]),
        market_draft_id: Number(params[6]),
      })
      state = { ...state, offer, thingLocked: true }
      return [offer]
    }
    if (text.includes('world-market:read-offer')) return state.offer ? [{ ...state.offer }] : []
    if (text.includes('payment-attempts:find')) {
      const targetKey = params[0] == null ? null : String(params[0])
      const operation = String(params[1])
      const nonce = params[2] == null ? null : String(params[2]).toLowerCase()
      const network = params[3] == null ? null : String(params[3])
      const token = params[4] == null ? null : String(params[4]).toLowerCase()
      const payerWallet = params[5] == null ? null : String(params[5]).toLowerCase()
      const row = [...state.paymentAttempts.values()].reverse().find(attempt =>
        ['settling', 'payment_pending', 'completed'].includes(attempt.status) && (
          (targetKey != null && attempt.operation === operation && attempt.target_key === targetKey)
          || (
            nonce != null
            && attempt.network === network
            && attempt.token === token
            && attempt.payer_wallet === payerWallet
            && attempt.x402_nonce === nonce
          )
        ))
      return row ? [{ ...row }] : []
    }
    if (text.includes('payment-attempts:create')) {
      const key = String(params[0])
      const next = new Map(state.paymentAttempts)
      const conflict = [...next.values()].some(attempt =>
        ['settling', 'payment_pending', 'completed'].includes(attempt.status) && (
          attempt.public_id === key
          || (
            params[4] != null
            && attempt.operation === String(params[3])
            && attempt.target_key === String(params[4])
          )
          || (
            params[16] != null
            && attempt.network === String(params[11])
            && attempt.token === String(params[12]).toLowerCase()
            && attempt.payer_wallet === String(params[13]).toLowerCase()
            && attempt.x402_nonce === String(params[16]).toLowerCase()
          )
        ))
      if (conflict) return []
      const row = {
        public_id: key,
        actor_id: Number(params[1]),
        operation: String(params[3]),
        target_key: params[4] == null ? null : String(params[4]),
        request_hash: String(params[8]),
        method: params[10] == null ? null : String(params[10]),
        network: params[11] == null ? null : String(params[11]),
        token: params[12] == null ? null : String(params[12]).toLowerCase(),
        payer_wallet: params[13] == null ? null : String(params[13]).toLowerCase(),
        payee_wallet: params[14] == null ? null : String(params[14]).toLowerCase(),
        amount_units: params[15] == null ? null : String(params[15]),
        x402_nonce: params[16] == null ? null : String(params[16]).toLowerCase(),
        x402_payload_digest: params[17] == null ? null : String(params[17]).toLowerCase(),
        status: 'settling' as const,
        tx_hash: null,
        result_json: null,
        created_at: state.now,
        updated_at: state.now,
        completed_at: null,
      }
      next.set(key, row)
      state = { ...state, paymentAttempts: next }
      return [{ ...row }]
    }
    if (text.includes('payment-attempts:legacy-settled')) {
      const key = String(params[0])
      const current = state.paymentAttempts.get(key)
      if (!current) return []
      const next = new Map(state.paymentAttempts)
      next.set(key, {
        ...current,
        status: current.status === 'completed' ? 'completed' : 'payment_pending',
        tx_hash: current.tx_hash ?? String(params[1]).toLowerCase(),
        updated_at: state.now,
      })
      state = { ...state, paymentAttempts: next }
      return [{ ...next.get(key)! }]
    }
    if (text.includes('payment-attempts:legacy-completed')) {
      const key = String(params[0])
      const current = state.paymentAttempts.get(key)
      if (!current) return []
      const next = new Map(state.paymentAttempts)
      next.set(key, {
        ...current,
        status: 'completed',
        tx_hash: current.tx_hash ?? String(params[1]).toLowerCase(),
        result_json: {
          completion_kind: String(params[2]),
          completion_id: Number(params[3]),
          completion_revision: params[4] == null ? null : Number(params[4]),
        },
        completed_at: state.now,
        updated_at: state.now,
      })
      state = { ...state, paymentAttempts: next }
      return [{ ...next.get(key)! }]
    }
    if (text.includes('world-market:reserve')) {
      const offer = state.offer
      if (!offer || offer.status !== 'open') return []
      const active = offer.reserved_until != null && Date.parse(offer.reserved_until) > Date.parse(state.now)
      if (active) return []
      const buyerId = Number(params[1])
      const buyer = String(params[2])
      const reservedAt = state.now
      const reservedUntil = new Date(Date.parse(state.now) + 300_000).toISOString()
      const rebound = {
        ...offer,
        buyer_id: buyerId,
        buyer,
        reserved_by: buyerId,
        buyer_wallet: String(params[3]),
        market_listing_id: Number(params[4]),
        market_checkout_id: Number(params[5]),
        market_buyer: String(params[8]),
        reserved_at: reservedAt,
        reserved_until: reservedUntil,
      }
      state = { ...state, offer: rebound }
      return [{ ...rebound }]
    }
    if (text.includes('world-market:pending-x402')) {
      const offer = state.offer
      if (
        !offer || offer.status !== 'open' || offer.pending_x402_tx_hash != null ||
        offer.buyer_id !== Number(params[1]) || offer.buyer_wallet !== String(params[4]) ||
        Date.parse(offer.reserved_until ?? '') <= Date.parse(state.now)
      ) return []
      const pending = {
        ...offer,
        pending_x402_tx_hash: String(params[3]),
        pending_x402_payer: String(params[4]),
        pending_x402_at: state.now,
        x402_evidence_state: 'pending' as const,
      }
      state = { ...state, offer: pending }
      return [{ id: offer.id }]
    }
    if (text.includes('world-market:invalidate-x402')) {
      const offer = state.offer
      if (!offer || offer.x402_evidence_state !== 'pending') return []
      const invalid = {
        ...offer,
        x402_evidence_state: 'invalid' as const,
        x402_invalid_reason: String(params[2]),
        x402_invalid_at: state.now,
      }
      state = { ...state, offer: invalid }
      return [{ id: offer.id }]
    }
    if (text.includes('world-market:claim') || text.includes('world-market:reconcile-claim')) {
      const offer = state.offer
      if (!offer || offer.status !== 'open' || offer.buyer_id !== Number(params[1])) return []
      const claimed = {
        ...offer,
        status: 'claimed' as const,
        claimed_at: state.now,
        locked: false,
        tx_hash: String(params[3]),
        buyer_wallet: String(params[4]),
        verified_via: String(params[5]),
        block_time: params[6] == null ? null : String(params[6]),
        from: String(params[4]),
        to: offer.seller_wallet,
      }
      state = { ...state, offer: claimed, thingOwner: Number(params[1]), thingLocked: false }
      return [{ id: offer.id }]
    }
    if (text.includes('world-market:cancel')) {
      const offer = state.offer
      const active = offer?.reserved_until != null && Date.parse(offer.reserved_until) > Date.parse(state.now)
      if (
        !offer || offer.status !== 'open' || (active && offer.x402_evidence_state !== 'invalid') ||
        (offer.pending_x402_tx_hash != null && offer.x402_evidence_state !== 'invalid')
      ) return []
      state = {
        ...state,
        thingLocked: false,
        offer: { ...offer, status: 'canceled', canceled_at: state.now, locked: false },
      }
      return [{ id: offer.id }]
    }
    throw new Error(`unhandled fake query: ${text}`)
  }

  const authenticate = async (c: Context) => {
    const header = c.req.header('authorization')
    if (header === SELLER_SECRET) return { id: 7, handle: 'tiny-lantern' }
    if (header === BUYER_SECRET) return { id: 8, handle: 'neighbor' }
    if (header === OTHER_SECRET) return { id: 9, handle: 'someone-else' }
    return null
  }

  const dependencies: WorldMarketDependencies = {
    query,
    authenticate,
    now: () => new Date(state.now),
    marketOrigin: MARKET,
    marketGet: async path => {
      if (state.marketFailure) throw new Error('market offline')
      if (state.marketInvalid) return { nope: true }
      if (path === '/api/world/draft/71') return { draft: state.draft }
      if (path === '/api/world/checkout/81' || path === '/api/world/checkout/82') {
        return { checkout: { ...state.checkout, id: Number(path.split('/').at(-1)) } }
      }
      throw new Error(`unexpected market path: ${path}`)
    },
    verifyDirectPayment: async (_hash, _to, _amount, _notBefore, _notAfter) => {
      state = { ...state, directVerifications: state.directVerifications + 1 }
      if (state.directVerificationInvalid) return { state: 'invalid_final', reason: 'confirmed_mismatch' }
      return state.directVerificationAvailable
        ? { state: 'matched', from: BUYER_WALLET, amount: '2.000000', blockTime: new Date(state.directBlockTime) }
        : { state: 'pending' }
    },
    settleX402: async () => {
      state = { ...state, facilitatorSettlements: state.facilitatorSettlements + 1 }
      return {
        transaction: TX,
        payer: BUYER_WALLET,
        raw: { success: true, transaction: TX, payer: BUYER_WALLET },
      }
    },
    paymentResponseHeader: () => 'settled-response',
  }

  const app = new Hono()
  mountWorldMarketRoutes(app, dependencies)
  app.post('/mcp', c => mcp(c, app))
  return {
    app,
    getState: () => state,
    setState: (patcher: (current: FakeState) => FakeState) => { state = patcher(state) },
  }
}

const jsonHeaders = (authorization?: string) => ({
  'content-type': 'application/json',
  ...(authorization ? { authorization } : {}),
})

test('seller locks an owned active thing from a valid pending market draft', async () => {
  const harness = makeHarness()
  const response = await harness.app.request('/api/world/listing', {
    method: 'POST',
    headers: jsonHeaders(SELLER_SECRET),
    body: JSON.stringify({ thing_id: 41, market_draft_id: 71 }),
  })

  assert.equal(response.status, 201, await response.clone().text())
  const payload = await response.json() as { offer: FakeOffer & { phase: string } }
  assert.equal(payload.offer.channel, 'world')
  assert.equal(payload.offer.phase, 'listed')
  assert.equal(payload.offer.locked, true)
  assert.equal(payload.offer.market_origin, MARKET)
  assert.equal(harness.getState().thingLocked, true)
  assert.ok(harness.getState().queries.some(call =>
    call.text.includes('world-market:create') && /update\s+things/i.test(call.text) && /insert\s+into\s+transfer_offers/i.test(call.text)))
})

test('listing rejects nonowners, mismatched drafts, unknown fields, and unavailable records', async () => {
  for (const [patch, body, expected] of [
    [{ thingOwner: 9 }, { thing_id: 41, market_draft_id: 71 }, 403],
    [{ draft: draft({ world_asset: { type: 'thing', id: 42 } }) }, { thing_id: 41, market_draft_id: 71 }, 409],
    [{}, { thing_id: 41, market_draft_id: 71, market_origin: 'https://evil.example' }, 400],
    [{ marketFailure: true }, { thing_id: 41, market_draft_id: 71 }, 503],
    [{ marketInvalid: true }, { thing_id: 41, market_draft_id: 71 }, 502],
  ] as const) {
    const harness = makeHarness(patch)
    const response = await harness.app.request('/api/world/listing', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: JSON.stringify(body),
    })
    assert.equal(response.status, expected, await response.clone().text())
    assert.equal(harness.getState().thingLocked, false)
  }
})

test('public resident and offer records expose no bearer material', async () => {
  const harness = makeHarness({ offer: openOffer(), thingLocked: true })
  const resident = await harness.app.request('/api/world/resident/neighbor')
  assert.equal(resident.status, 200)
  assert.deepEqual(await resident.json(), { resident: { handle: 'neighbor' } })
  assert.equal((await harness.app.request('/api/world/resident/not-here')).status, 404)

  const response = await harness.app.request('/api/world/offer/101')
  assert.equal(response.status, 200)
  const text = await response.text()
  const offer = (JSON.parse(text) as { offer: Record<string, unknown> }).offer
  assert.equal(offer.phase, 'listed')
  assert.equal(offer.asset_name, 'porch lantern')
  assert.equal(offer.buyer, null)
  assert.equal(text.includes('secret'), false)
})

test('a buyer must already be a resident and cannot pay before reserving', async () => {
  const harness = makeHarness({ offer: openOffer(), thingLocked: true })
  const anonymous = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(anonymous.status, 401)

  const payFirst = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET, tx_hash: TX }),
  })
  assert.equal(payFirst.status, 409)
  assert.equal(harness.getState().directVerifications, 0)
})

test('checkout city handle is bound to the authenticated resident', async () => {
  const harness = makeHarness({
    offer: openOffer(),
    thingLocked: true,
    checkout: checkout({ city_handle: 'someone-else' }),
    draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
  })
  const response = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(response.status, 403)
  assert.equal(harness.getState().offer?.buyer_id, null)
})

test('a valid checkout opens exactly five minutes and retries idempotently', async () => {
  const harness = makeHarness({
    offer: openOffer(),
    thingLocked: true,
    draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
  })
  const reserve = () => harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  const first = await reserve()
  assert.equal(first.status, 402, await first.clone().text())
  assert.equal(
    Date.parse(harness.getState().offer!.reserved_until!) - Date.parse(harness.getState().offer!.reserved_at!),
    300_000,
  )
  const second = await reserve()
  assert.equal(second.status, 402)
  assert.equal(harness.getState().queries.filter(call => call.text.includes('world-market:reserve')).length, 1)

  const race = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(OTHER_SECRET),
    body: JSON.stringify({ market_checkout_id: 82, buyer_wallet: OTHER_WALLET }),
  })
  assert.equal(race.status, 409)
})

test('an expired world reservation can bind a different resident with a fresh checkout', async () => {
  const harness = makeHarness({
    offer: openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 80,
      reserved_at: '2026-08-12T11:40:00.000Z',
      reserved_until: '2026-08-12T11:45:00.000Z',
    }),
    thingLocked: true,
    checkout: checkout({ id: 82, city_handle: 'someone-else' }),
    draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
  })
  const response = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(OTHER_SECRET),
    body: JSON.stringify({ market_checkout_id: 82, buyer_wallet: OTHER_WALLET }),
  })
  assert.equal(response.status, 402, await response.clone().text())
  assert.equal(harness.getState().offer?.buyer, 'someone-else')
  assert.equal(harness.getState().offer?.market_checkout_id, 82)
  assert.equal(harness.getState().offer?.market_buyer, 'market-buyer')
})

test('market buyer identity is retained as an immutable public checkout binding', async () => {
  const harness = makeHarness({
    offer: openOffer(),
    thingLocked: true,
    draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
  })
  const response = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(response.status, 402, await response.clone().text())
  assert.equal(harness.getState().offer?.market_buyer, 'market-buyer')
  const publicRecord = await harness.app.request('/api/world/offer/101')
  assert.equal((await publicRecord.json() as { offer: FakeOffer }).offer.market_buyer, 'market-buyer')
  const reserveSql = harness.getState().queries.find(call => call.text.includes('world-market:reserve'))?.text ?? ''
  assert.match(reserveSql, /market_buyer\s*=\s*\$9/i)
})

test('payment closes ownership atomically and a retry returns the same public receipt', async () => {
  const reserved = openOffer({
    buyer_id: 8,
    buyer: 'neighbor',
    reserved_by: 8,
    buyer_wallet: BUYER_WALLET,
    market_listing_id: 91,
    market_checkout_id: 81,
    reserved_at: NOW.toISOString(),
    reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
  })
  const harness = makeHarness({
    offer: reserved,
    thingLocked: true,
    marketFailure: true,
    draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
  })
  const pay = () => harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: JSON.stringify({ tx_hash: TX }),
  })
  const first = await pay()
  assert.equal(first.status, 200, await first.clone().text())
  const firstBody = await first.json() as { offer: FakeOffer & { phase: string } }
  assert.equal(firstBody.offer.phase, 'claimed')
  assert.equal(firstBody.offer.buyer, 'neighbor')
  assert.equal(firstBody.offer.from, BUYER_WALLET)
  assert.equal(firstBody.offer.to, SELLER_WALLET)
  assert.equal(firstBody.offer.tx_hash, TX)
  assert.equal(harness.getState().thingOwner, 8)
  assert.ok(harness.getState().queries.some(call =>
    call.text.includes('world-market:claim') && /payment_uses/i.test(call.text) &&
    /sale_payments/i.test(call.text) && /update\s+things/i.test(call.text) && /insert\s+into\s+transfers/i.test(call.text)))
  const guardedClaim = harness.getState().queries.find(call => call.text.includes('world-market:claim'))
  assert.match(guardedClaim?.text ?? '', /reserved_until\s*>\s*clock_timestamp\(\)/i)
  assert.match(guardedClaim?.text ?? '', /\$7::timestamptz\s*>=\s*reserved_at/i)

  const retry = await pay()
  assert.equal(retry.status, 200)
  assert.deepEqual(await retry.json(), firstBody)
  assert.equal(harness.getState().directVerifications, 1)
})

test('world x402 claim requires a payment-identifier for safe retries', async () => {
  const reserved = openOffer({
    buyer_id: 8,
    buyer: 'neighbor',
    reserved_by: 8,
    buyer_wallet: BUYER_WALLET,
    market_listing_id: 91,
    market_checkout_id: 81,
    reserved_at: NOW.toISOString(),
    reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
  })
  const harness = makeHarness({ offer: reserved, thingLocked: true, marketFailure: true })
  const response = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT_NO_ID },
    body: '{}',
  })

  assert.equal(response.status, 402)
  assert.match(await response.text(), /payment-identifier/i)
  assert.equal(harness.getState().facilitatorSettlements, 0)
})

test('hosted world claims fail closed before custody schema readiness', async () => {
  const previousVercel = process.env.VERCEL
  const previousVercelEnv = process.env.VERCEL_ENV
  const previousReady = process.env.PAYMENT_CUSTODY_READY
  process.env.VERCEL = '1'
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  try {
    const harness = makeHarness({
      thingLocked: true,
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        reserved_at: NOW.toISOString(),
        reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
      }),
    })
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })

    assert.equal(response.status, 503, await response.clone().text())
    assert.match(await response.text(), /payments are temporarily unavailable/i)
    assert.equal(harness.getState().facilitatorSettlements, 0)
    assert.equal(harness.getState().queries.length, 0)
  } finally {
    if (previousVercel == null) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
    if (previousVercelEnv == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousVercelEnv
    if (previousReady == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousReady
  }
})

test('x402 claims re-read the confirmed transfer and publish its in-window block time', async () => {
  const reserved = openOffer({
    buyer_id: 8,
    buyer: 'neighbor',
    reserved_by: 8,
    buyer_wallet: BUYER_WALLET,
    market_listing_id: 91,
    market_checkout_id: 81,
    reserved_at: NOW.toISOString(),
    reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
  })
  const harness = makeHarness({ offer: reserved, thingLocked: true, marketFailure: true })
  const response = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
    body: '{}',
  })

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('x-payment-response'), 'settled-response')
  const offer = (await response.json() as { offer: FakeOffer }).offer
  assert.equal(offer.verified_via, 'x402')
  assert.equal(offer.block_time, NOW.toISOString())
  assert.equal(offer.from, BUYER_WALLET)
  assert.equal(offer.to, SELLER_WALLET)
  assert.equal(harness.getState().directVerifications, 1)
})

test('a settled x402 payment stays locked while Base indexing catches up and finalizes once', async () => {
  const reservedAt = NOW.toISOString()
  const reservedUntil = new Date(NOW.getTime() + 300_000).toISOString()
  const harness = makeHarness({
    offer: openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: reservedAt,
      reserved_until: reservedUntil,
    }),
    thingLocked: true,
    directVerificationAvailable: false,
    directBlockTime: new Date(NOW.getTime() + 60_000).toISOString(),
  })

  const settle = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
    body: '{}',
  })
  assert.equal(settle.status, 202, await settle.clone().text())
  const pending = (await settle.json() as { offer: FakeOffer & { phase: string } }).offer
  assert.equal(pending.phase, 'payment_pending')
  assert.equal(pending.pending_x402_tx_hash, TX)
  assert.equal(harness.getState().facilitatorSettlements, 1)
  assert.equal(harness.getState().thingLocked, true)
  const attemptIndex = harness.getState().queries.findIndex(call =>
    /insert\s+into\s+payment_attempts/i.test(call.text))
  const pendingIndex = harness.getState().queries.findIndex(call => call.text.includes('world-market:pending-x402'))
  assert.ok(attemptIndex >= 0 && pendingIndex > attemptIndex)

  harness.setState(current => ({
    ...current,
    now: new Date(NOW.getTime() + 360_000).toISOString(),
    draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
  }))
  const otherBuyer = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(OTHER_SECRET),
    body: JSON.stringify({ market_checkout_id: 82, buyer_wallet: OTHER_WALLET }),
  })
  assert.equal(otherBuyer.status, 409)
  const cancel = await harness.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(cancel.status, 409)
  assert.equal(harness.getState().thingLocked, true)

  harness.setState(current => ({ ...current, directVerificationAvailable: true }))
  const finish = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: '{}',
  })
  assert.equal(finish.status, 200, await finish.clone().text())
  const claimed = (await finish.json() as { offer: FakeOffer & { phase: string } }).offer
  assert.equal(claimed.phase, 'claimed')
  assert.equal(claimed.tx_hash, TX)
  assert.equal(claimed.block_time, new Date(NOW.getTime() + 60_000).toISOString())
  assert.equal(harness.getState().facilitatorSettlements, 1)
  assert.equal(harness.getState().thingOwner, 8)
})

test('buyer or seller can reconcile pending payment, but ambiguous chain state stays locked', async () => {
  const pending = openOffer({
    buyer_id: 8,
    buyer: 'neighbor',
    reserved_by: 8,
    buyer_wallet: BUYER_WALLET,
    market_buyer: 'market-buyer',
    market_listing_id: 91,
    market_checkout_id: 81,
    pending_x402_tx_hash: TX,
    pending_x402_payer: BUYER_WALLET,
    pending_x402_at: NOW.toISOString(),
    x402_evidence_state: 'pending',
    reserved_at: NOW.toISOString(),
    reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
  })
  for (const authorization of [BUYER_SECRET, SELLER_SECRET]) {
    const harness = makeHarness({
      offer: pending,
      thingLocked: true,
      directVerificationAvailable: false,
    })
    const response = await harness.app.request('/api/world/offer/101/reconcile', {
      method: 'POST', headers: jsonHeaders(authorization), body: '{}',
    })
    assert.equal(response.status, 202, await response.clone().text())
    assert.equal((await response.json() as { offer: { phase: string } }).offer.phase, 'payment_pending')
    assert.equal(harness.getState().thingLocked, true)
  }

  const sellerFinalizes = makeHarness({ offer: pending, thingLocked: true })
  const finalized = await sellerFinalizes.app.request('/api/world/offer/101/reconcile', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(finalized.status, 200, await finalized.clone().text())
  assert.equal((await finalized.json() as { offer: { phase: string } }).offer.phase, 'claimed')
  assert.equal(sellerFinalizes.getState().thingOwner, 8)
})

test('reconcile_world MCP dispatches through HTTP bearer auth without a secret argument', async () => {
  const harness = makeHarness({
    offer: openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      pending_x402_tx_hash: TX,
      pending_x402_payer: BUYER_WALLET,
      pending_x402_at: NOW.toISOString(),
      x402_evidence_state: 'pending',
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    }),
    thingLocked: true,
    directVerificationAvailable: false,
  })
  const response = await harness.app.request('/mcp', {
    method: 'POST',
    headers: jsonHeaders(SELLER_SECRET),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reconcile_world', arguments: { offer_id: 101 } },
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(body.result.isError, false)
  assert.equal((JSON.parse(body.result.content[0]!.text) as { offer: { phase: string } }).offer.phase, 'payment_pending')
})

test('conclusive invalid x402 receipt becomes durable payment_invalid and still needs market-first cancel', async () => {
  const harness = makeHarness({
    offer: openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_buyer: 'market-buyer',
      market_listing_id: 91,
      market_checkout_id: 81,
      pending_x402_tx_hash: TX,
      pending_x402_payer: BUYER_WALLET,
      pending_x402_at: NOW.toISOString(),
      x402_evidence_state: 'pending',
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    }),
    thingLocked: true,
    directVerificationInvalid: true,
    draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
  })
  const reconcile = await harness.app.request('/api/world/offer/101/reconcile', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(reconcile.status, 200, await reconcile.clone().text())
  const invalid = (await reconcile.json() as { offer: FakeOffer & { phase: string } }).offer
  assert.equal(invalid.phase, 'payment_invalid')
  assert.equal(invalid.pending_x402_tx_hash, TX)
  assert.equal(harness.getState().thingLocked, true)

  const tooEarly = await harness.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(tooEarly.status, 409)
  harness.setState(current => ({
    ...current,
    draft: draft({ status: 'canceled', listing_id: 91, listing_state: 'stale' }),
  }))
  const cancel = await harness.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(cancel.status, 200, await cancel.clone().text())
  assert.equal(harness.getState().thingLocked, false)
})

test('cancellation follows the market first, fails closed, and is idempotent', async () => {
  for (const [patch, expected] of [
    [{ draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }) }, 409],
    [{ draft: draft({ status: 'active', listing_id: 91, listing_state: 'withdrawn' }) }, 409],
    [{ draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'active' }) }, 409],
    [{ marketFailure: true }, 503],
  ] as const) {
    const harness = makeHarness({ offer: openOffer({ market_listing_id: 91 }), thingLocked: true, ...patch })
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, expected)
    assert.equal(harness.getState().thingLocked, true)
  }

  const harness = makeHarness({
    offer: openOffer({ market_listing_id: 91 }),
    thingLocked: true,
    draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
  })
  const cancel = () => harness.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  const first = await cancel()
  assert.equal(first.status, 200, await first.clone().text())
  assert.equal((await first.json() as { offer: { phase: string } }).offer.phase, 'canceled')
  assert.equal(harness.getState().thingLocked, false)

  harness.setState(current => ({ ...current, marketFailure: true }))
  const retry = await cancel()
  assert.equal(retry.status, 200)
})

test('an active reservation blocks world cancellation even after market withdrawal', async () => {
  const harness = makeHarness({
    offer: openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    }),
    thingLocked: true,
    draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
  })
  const response = await harness.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(response.status, 409)
  assert.equal(harness.getState().thingLocked, true)
})
