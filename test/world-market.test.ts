import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono, type Context } from 'hono'
import {
  mountWorldMarketRoutes,
  publicMarketGet,
  type WorldMarketDependencies,
} from '../src/world-market.ts'
import { mcp } from '../src/mcp.ts'
import { canonicalPaymentRequest, type PaymentAttemptRecord } from '../src/payment-attempts.ts'

const MARKET = 'https://1f3ea.com'
const SELLER_SECRET = 'Bearer seller-secret'
const BUYER_SECRET = 'Bearer buyer-secret'
const OTHER_SECRET = 'Bearer other-secret'
const SELLER_WALLET = '0x1111111111111111111111111111111111111111'
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const OTHER_WALLET = '0x3333333333333333333333333333333333333333'
const TX = '0x' + 'ab'.repeat(32)
const SETTLED_RESPONSE = Buffer.from(JSON.stringify({
  success: true,
  transaction: TX,
  payer: BUYER_WALLET,
})).toString('base64')
const COMPLETED_RESPONSE = Buffer.from(JSON.stringify({
  success: true,
  transaction: TX,
  payer: BUYER_WALLET,
  replay: true,
})).toString('base64')
const ATTEMPT_ID = 'pay_world_offer_1234567890abcdef'
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
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
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
  pending_payment_attempt_id: string | null
  pending_x402_tx_hash: string | null
  pending_x402_payer: string | null
  pending_x402_at: string | null
  x402_evidence_state: 'none' | 'pending' | 'invalid' | 'expired' | 'founder_review'
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
  scenario?: 'target changes after world finality'
  thingOwner: number
  thingWithdrawn: boolean
  thingLocked: boolean
  thingModerated: boolean
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
  paymentAttempt: PaymentAttemptRecord | null
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
    maker_id: 6,
    made_by: 'old-maker',
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
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
    pending_payment_attempt_id: null,
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
  const withBuyer = overrides.market_buyer === undefined && offer.buyer_id != null
    ? { ...offer, market_buyer: 'market-buyer' }
    : offer
  return overrides.pending_payment_attempt_id === undefined && withBuyer.pending_x402_tx_hash != null
    ? { ...withBuyer, pending_payment_attempt_id: ATTEMPT_ID }
    : withBuyer
}

function initialState(patch: Partial<FakeState> = {}): FakeState {
  return {
    thingOwner: 7,
    thingWithdrawn: false,
    thingLocked: false,
    thingModerated: false,
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
    paymentAttempt: null,
    now: NOW.toISOString(),
    queries: [],
    ...patch,
  }
}

function fakePaymentAttempt(now: string): PaymentAttemptRecord {
  return {
    publicId: ATTEMPT_ID,
    actorId: 8,
    counterpartyId: 7,
    operation: 'world_sale',
    targetKey: 'world-sale:101',
    offerId: 101,
    assetType: 'thing',
    assetId: 41,
    request: null,
    requestHash: null,
    method: 'x402',
    network: 'base',
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    payerWallet: BUYER_WALLET,
    payeeWallet: SELLER_WALLET,
    amountUnits: 2_000_000n,
    x402Nonce: '0x' + '22'.repeat(32),
    x402PayloadDigest: '33'.repeat(32),
    x402ValidAfter: 1n,
    x402ValidBefore: 4_102_444_800n,
    startBlock: 15n,
    startTime: now,
    endTime: new Date(Date.parse(now) + 300_000).toISOString(),
    status: 'payment_pending',
    leaseOwner: 'world-payment-lease',
    leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    recoveryStartedAt: now,
    recoveryDeadlineAt: new Date(Date.parse(now) + 7_200_000).toISOString(),
    txHash: TX,
    finalizedBlockNumber: null,
    finalizedBlockHash: null,
    finalizedBlockTime: null,
    finalizedAt: null,
    invalidReason: null,
    result: null,
    responseStatus: null,
    response: null,
    responseBody: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
}

function worldRequestForOffer(offer: Pick<
  FakeOffer,
  'id' | 'market_checkout_id' | 'market_listing_id' | 'market_draft_id' | 'market_buyer' | 'buyer_wallet' | 'seller_wallet' | 'price_usdc' | 'asset_id'
>) {
  return {
    offer_id: offer.id,
    market_checkout_id: offer.market_checkout_id,
    market_listing_id: offer.market_listing_id,
    market_draft_id: offer.market_draft_id,
    market_buyer: offer.market_buyer,
    buyer_wallet: offer.buyer_wallet,
    seller_wallet: offer.seller_wallet,
    price_usdc: offer.price_usdc,
    asset_id: offer.asset_id,
  }
}

function worldSaleRequestHash(offer: Parameters<typeof worldRequestForOffer>[0]): string {
  return canonicalPaymentRequest(worldRequestForOffer(offer)).hash
}

function makeHarness(
  patch: Partial<FakeState> = {},
  suppliedMarketGet?: WorldMarketDependencies['marketGet'],
) {
  let state = initialState(patch)
  if (state.offer?.pending_payment_attempt_id && state.paymentAttempt == null) {
    const attempt = fakePaymentAttempt(state.now)
    const request = worldRequestForOffer(state.offer)
    const attemptStatus = state.offer.x402_evidence_state === 'founder_review'
      ? 'founder_review' as const
      : state.offer.x402_evidence_state === 'expired'
        ? 'expired' as const
        : attempt.status
    state = {
      ...state,
      paymentAttempt: {
        ...attempt,
        status: attemptStatus,
        request,
        requestHash: canonicalPaymentRequest(request).hash,
      },
    }
  }

  const query = async (text: string, params: readonly unknown[]) => {
    state = { ...state, queries: [...state.queries, { text, params }] }
    if (text.includes('payment-sale-operations:read-attempt')) {
      const attempt = state.paymentAttempt
      const offer = state.offer
      if (!attempt || !offer || attempt.publicId !== String(params[0])) return []
      const request = {
        offer_id: offer.id,
        market_checkout_id: offer.market_checkout_id,
        market_listing_id: offer.market_listing_id,
        market_draft_id: offer.market_draft_id,
        market_buyer: offer.market_buyer,
        buyer_wallet: offer.buyer_wallet,
        seller_wallet: offer.seller_wallet,
        price_usdc: offer.price_usdc,
        asset_id: offer.asset_id,
      }
      const response = attempt.response
      return [{
        attempt_id: attempt.publicId,
        actor_id: attempt.actorId,
        counterparty_id: attempt.counterpartyId,
        operation: attempt.operation,
        target_key: attempt.targetKey,
        attempt_offer_id: attempt.offerId,
        attempt_asset_type: attempt.assetType,
        attempt_asset_id: attempt.assetId,
        request_hash: attempt.requestHash,
        request_json: attempt.request ?? request,
        method: attempt.method,
        network: attempt.network,
        token: attempt.token,
        payer_wallet: attempt.payerWallet,
        payee_wallet: attempt.payeeWallet,
        amount_units: attempt.amountUnits?.toString(),
        start_time: attempt.startTime,
        end_time: attempt.endTime,
        status: attempt.status,
        lease_owner: attempt.leaseOwner,
        tx_hash: attempt.txHash,
        finalized_block_number: attempt.finalizedBlockNumber?.toString() ?? null,
        finalized_block_hash: attempt.finalizedBlockHash,
        finalized_block_time: attempt.finalizedBlockTime,
        finalized_at: attempt.finalizedAt,
        recovery_started_at: attempt.updatedAt,
        recovery_deadline_at: new Date(Date.parse(attempt.createdAt) + 7_200_000).toISOString(),
        recovery_open: Date.parse(state.now) < Date.parse(attempt.createdAt) + 7_200_000,
        offer_id: offer.id,
        channel: offer.channel,
        asset_type: offer.asset_type,
        asset_id: offer.asset_id,
        asset_name: offer.asset_name,
        maker_id: offer.maker_id,
        made_by: offer.made_by,
        current_owner_id: offer.current_owner_id,
        active_offer_id: state.thingLocked ? offer.id : null,
        withdrawn_at: state.thingWithdrawn ? state.now : null,
        seller_id: offer.seller_id,
        seller: offer.seller,
        buyer_id: offer.buyer_id,
        buyer: offer.buyer,
        price_usdc: offer.price_usdc,
        seller_wallet: offer.seller_wallet,
        buyer_wallet: offer.buyer_wallet,
        offer_status: offer.status,
        reserved_by: offer.reserved_by,
        reserved_at: offer.reserved_at,
        reserved_until: offer.reserved_until,
        market_origin: offer.market_origin,
        market_draft_id: offer.market_draft_id,
        market_listing_id: offer.market_listing_id,
        market_checkout_id: offer.market_checkout_id,
        market_buyer: offer.market_buyer,
        pending_payment_attempt_id: offer.pending_payment_attempt_id,
        pending_x402_tx_hash: offer.pending_x402_tx_hash,
        pending_x402_payer: offer.pending_x402_payer,
        pending_x402_at: offer.pending_x402_at,
        x402_evidence_state: offer.x402_evidence_state,
        response_status: attempt.responseStatus,
        response,
        response_body: attempt.responseBody,
        payment_response_header: attempt.paymentResponseHeader,
      }]
    }
    if (text.includes('payment-attempts:find-replayable-target')) {
      return state.paymentAttempt ? [{
        ...state.paymentAttempt,
        public_id: state.paymentAttempt.publicId,
        actor_id: state.paymentAttempt.actorId,
        counterparty_id: state.paymentAttempt.counterpartyId,
        operation: state.paymentAttempt.operation,
        target_key: state.paymentAttempt.targetKey,
        offer_id: state.paymentAttempt.offerId,
        asset_type: state.paymentAttempt.assetType,
        asset_id: state.paymentAttempt.assetId,
        request_hash: state.paymentAttempt.requestHash,
        request_json: state.paymentAttempt.request,
      }] : []
    }
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
    if (text.includes('world-market:public-moderation')) {
      return state.thingModerated ? [{ action: 'remove' }] : []
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
    if (text.includes('world-market:pending-x402') || text.includes('payment-sale-operations:park-world')) {
      const offer = state.offer
      const attempt = state.paymentAttempt
      if (
        !offer || offer.status !== 'open' || offer.pending_x402_tx_hash != null ||
        !attempt || attempt.publicId !== String(params.at(-1))
      ) return []
      const pending = {
        ...offer,
        pending_payment_attempt_id: attempt.publicId,
        pending_x402_tx_hash: attempt.txHash,
        pending_x402_payer: attempt.payerWallet,
        pending_x402_at: state.now,
        x402_evidence_state: 'pending' as const,
      }
      state = { ...state, offer: pending }
      return [{ id: offer.id, state: 'parked' }]
    }
    if (
      text.includes('world-market:invalidate-x402')
      || text.includes('payment-sale-operations:close-invalid-target')
    ) {
      const offer = state.offer
      if (!offer || offer.x402_evidence_state !== 'pending') return []
      const invalid = {
        ...offer,
        x402_evidence_state: 'invalid' as const,
        x402_invalid_reason: text.includes('close-invalid-target')
          ? 'confirmed_mismatch'
          : String(params[2]),
        x402_invalid_at: state.now,
      }
      state = { ...state, offer: invalid }
      return text.includes('close-invalid-target') && state.paymentAttempt
        ? [{
            state: 'invalid',
            attempt_id: state.paymentAttempt.publicId,
            actor_id: state.paymentAttempt.actorId,
            operation: 'world_sale',
            method: 'x402',
            target_released: false,
            evidence_synchronized: true,
          }]
        : [{ id: offer.id }]
    }
    if (text.includes('payment-sale-operations:close-target')) {
      const attempt = state.paymentAttempt
      const offer = state.offer
      if (!attempt || !offer || attempt.leaseOwner !== String(params[1])) return []
      const terminalState = String(params[2]) as 'expired' | 'founder_review'
      state = {
        ...state,
        paymentAttempt: {
          ...attempt,
          status: terminalState,
          invalidReason: attempt.invalidReason ?? String(params[3]),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        offer: {
          ...offer,
          pending_payment_attempt_id: offer.pending_payment_attempt_id ?? attempt.publicId,
          pending_x402_tx_hash: offer.pending_x402_tx_hash ?? attempt.txHash,
          pending_x402_payer: offer.pending_x402_payer ?? attempt.payerWallet,
          pending_x402_at: offer.pending_x402_at ?? state.now,
          x402_evidence_state: terminalState,
        },
      }
      return [{
        state: terminalState,
        attempt_id: attempt.publicId,
        actor_id: attempt.actorId,
        operation: 'world_sale',
        method: 'x402',
        target_released: false,
      }]
    }
    if (text.includes('world-market:finalize-payment') || text.includes('payment-sale-operations:complete-world')) {
      const offer = state.offer
      const attempt = state.paymentAttempt
      if (
        !offer || !attempt || offer.status !== 'open'
        || offer.buyer_id == null || offer.buyer == null
      ) return []
      const claimed = {
        ...offer,
        status: 'claimed' as const,
        current_owner_id: offer.buyer_id,
        current_owner: offer.buyer,
        claimed_at: state.now,
        locked: false,
        tx_hash: attempt.txHash,
        buyer_wallet: attempt.payerWallet,
        verified_via: 'x402',
        block_time: attempt.finalizedBlockTime,
        from: attempt.payerWallet,
        to: offer.seller_wallet,
      }
      const response = {
        offer: {
          id: claimed.id,
          channel: claimed.channel,
          phase: 'claimed',
          asset_type: claimed.asset_type,
          asset_id: claimed.asset_id,
          asset_name: claimed.asset_name,
          maker_id: claimed.maker_id,
          made_by: claimed.made_by,
          current_owner_id: claimed.current_owner_id,
          current_owner: claimed.current_owner,
          locked: false,
          seller: claimed.seller,
          buyer: claimed.buyer,
          price_usdc: claimed.price_usdc,
          seller_wallet: claimed.seller_wallet,
          market_origin: claimed.market_origin,
          market_draft_id: claimed.market_draft_id,
          market_listing_id: claimed.market_listing_id,
          market_checkout_id: claimed.market_checkout_id,
          market_buyer: claimed.market_buyer,
          pending_x402_tx_hash: claimed.pending_x402_tx_hash,
          pending_x402_at: claimed.pending_x402_at,
          x402_invalid_reason: claimed.x402_invalid_reason,
          x402_invalid_at: claimed.x402_invalid_at,
          reserved_at: claimed.reserved_at,
          reserved_until: claimed.reserved_until,
          created_at: claimed.created_at,
          claimed_at: claimed.claimed_at,
          canceled_at: claimed.canceled_at,
          tx_hash: claimed.tx_hash,
          buyer_wallet: claimed.buyer_wallet,
          verified_via: claimed.verified_via,
          block_time: claimed.block_time,
          from: claimed.from,
          to: claimed.to,
        },
      }
      const responseBody = JSON.stringify(response)
      state = {
        ...state,
        offer: claimed,
        thingOwner: offer.buyer_id,
        thingLocked: false,
        paymentAttempt: state.paymentAttempt
          ? {
            ...state.paymentAttempt,
            status: 'completed',
            result: { kind: 'world_offer', id: offer.id },
            responseStatus: 200,
            response,
            responseBody,
            paymentResponseHeader: state.paymentAttempt.paymentResponseHeader ?? SETTLED_RESPONSE,
            completedAt: state.now,
            updatedAt: state.now,
          }
          : null,
      }
      return [{
        state: 'completed',
        attempt_id: attempt.publicId,
        actor_id: attempt.actorId,
        operation: attempt.operation,
        method: attempt.method,
        response_status: 200,
        response,
        response_body: responseBody,
        payment_response_header: attempt.paymentResponseHeader ?? SETTLED_RESPONSE,
      }]
    }
    if (text.includes('world-market:cancel')) {
      const offer = state.offer
      const active = offer?.reserved_until != null && Date.parse(offer.reserved_until) > Date.parse(state.now)
      const terminalEvidence = offer?.x402_evidence_state === 'expired'
        || offer?.x402_evidence_state === 'founder_review'
      if (
        !offer || offer.status !== 'open'
        || (active && offer.x402_evidence_state !== 'invalid' && !terminalEvidence)
        || (offer.pending_x402_tx_hash != null
          && offer.x402_evidence_state !== 'invalid' && !terminalEvidence) ||
        (state.paymentAttempt != null &&
          ['settling', 'payment_pending', 'needs_review'].includes(state.paymentAttempt.status))
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
    marketGet: suppliedMarketGet ?? (async path => {
      if (state.marketFailure) throw new Error('market offline')
      if (state.marketInvalid) return { nope: true }
      if (path === '/api/world/draft/71') return { draft: state.draft }
      if (path === '/api/world/checkout/81' || path === '/api/world/checkout/82') {
        return { checkout: { ...state.checkout, id: Number(path.split('/').at(-1)) } }
      }
      throw new Error(`unexpected market path: ${path}`)
    }),
    findPayment: async () => state.paymentAttempt,
    runPayment: async () => {
      if (state.paymentAttempt?.status === 'completed' && state.paymentAttempt.response) {
        return {
          state: 'completed',
          status: state.paymentAttempt.responseStatus ?? 200,
          body: state.paymentAttempt.response,
          responseBody: state.paymentAttempt.responseBody ?? null,
          paymentResponseHeader: state.paymentAttempt.paymentResponseHeader ?? COMPLETED_RESPONSE,
        }
      }
      const created = state.paymentAttempt == null
      const attempt = state.paymentAttempt ?? fakePaymentAttempt(state.now)
      const boundAttempt = state.offer
        ? {
          ...attempt,
          request: worldRequestForOffer(state.offer),
          requestHash: worldSaleRequestHash(state.offer),
          paymentResponseHeader: attempt.paymentResponseHeader ?? SETTLED_RESPONSE,
        }
        : attempt
      state = {
        ...state,
        facilitatorSettlements: state.facilitatorSettlements + (created ? 1 : 0),
        directVerifications: state.directVerifications + 1,
        paymentAttempt: boundAttempt,
        queries: created
          ? [...state.queries, { text: '/* payment-attempts:create */ INSERT INTO payment_attempts', params: [] }]
          : state.queries,
      }
      if (state.directVerificationInvalid) {
        state = {
          ...state,
          paymentAttempt: { ...boundAttempt, status: 'invalid', invalidReason: 'confirmed_mismatch' },
        }
        return {
          state: 'rejected',
          status: 400,
          body: { error: 'payment transaction does not match this operation', do_not_pay_again: true },
        }
      }
      if (!state.directVerificationAvailable) {
        return {
          state: 'payment_pending',
          status: 202,
          attemptId: boundAttempt.publicId,
          payerWallet: boundAttempt.payerWallet,
          txHash: boundAttempt.txHash,
          body: { payment: 'pending', payment_attempt_id: boundAttempt.publicId, do_not_pay_again: true },
        }
      }
      const finalizedAt = new Date(Date.parse(state.directBlockTime) + 60_000).toISOString()
      state = {
        ...state,
        ...(state.scenario === 'target changes after world finality' && state.offer
          ? {
              thingOwner: 9,
              offer: {
                ...state.offer,
                current_owner_id: 9,
                current_owner: 'someone-else',
              },
            }
          : {}),
        paymentAttempt: {
          ...boundAttempt,
          leaseOwner: 'world-payment-lease',
          finalizedBlockNumber: 16n,
          finalizedBlockHash: '0x' + '44'.repeat(32),
          finalizedBlockTime: state.directBlockTime,
          finalizedAt,
        },
      }
      return {
        state: 'ready',
        attemptId: boundAttempt.publicId,
        leaseOwner: 'world-payment-lease',
        txHash: TX,
        payerWallet: BUYER_WALLET,
        blockNumber: 16n,
        blockHash: '0x' + '44'.repeat(32),
        blockTime: state.directBlockTime,
        finalizedAt,
        paymentResponseHeader: SETTLED_RESPONSE,
      }
    },
    resumePayment: async ({ attempt }) => {
      if (attempt.status === 'completed' && attempt.response) {
        return {
          state: 'completed',
          status: attempt.responseStatus ?? 200,
          body: attempt.response,
          responseBody: attempt.responseBody ?? null,
          paymentResponseHeader: attempt.paymentResponseHeader ?? COMPLETED_RESPONSE,
        }
      }
      state = { ...state, directVerifications: state.directVerifications + 1 }
      if (state.directVerificationInvalid || attempt.status === 'invalid') {
        state = {
          ...state,
          paymentAttempt: { ...attempt, status: 'invalid', invalidReason: 'confirmed_mismatch' },
        }
        return {
          state: 'rejected',
          status: 400,
          body: { error: 'confirmed_mismatch', do_not_pay_again: true },
        }
      }
      if (!state.directVerificationAvailable) {
        return {
          state: 'payment_pending',
          status: 202,
          attemptId: attempt.publicId,
          payerWallet: attempt.payerWallet,
          txHash: attempt.txHash,
          body: { payment: 'pending', payment_attempt_id: attempt.publicId, do_not_pay_again: true },
        }
      }
      const finalizedAt = new Date(Date.parse(state.directBlockTime) + 60_000).toISOString()
      state = {
        ...state,
        ...(state.scenario === 'target changes after world finality' && state.offer
          ? {
              thingOwner: 9,
              offer: {
                ...state.offer,
                current_owner_id: 9,
                current_owner: 'someone-else',
              },
            }
          : {}),
        paymentAttempt: {
          ...attempt,
          leaseOwner: 'world-payment-lease',
          finalizedBlockNumber: 16n,
          finalizedBlockHash: '0x' + '44'.repeat(32),
          finalizedBlockTime: state.directBlockTime,
          finalizedAt,
        },
      }
      return {
        state: 'ready',
        attemptId: attempt.publicId,
        leaseOwner: 'world-payment-lease',
        txHash: TX,
        payerWallet: BUYER_WALLET,
        blockNumber: 16n,
        blockHash: '0x' + '44'.repeat(32),
        blockTime: state.directBlockTime,
        finalizedAt,
        paymentResponseHeader: SETTLED_RESPONSE,
      }
    },
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

test('listing distinguishes a missing market draft from market failure and invalid records', async () => {
  const cases: ReadonlyArray<{
    name: string
    fetcher: typeof fetch
    status: number
    error: string
  }> = [
    {
      name: 'missing draft',
      fetcher: async () => Response.json({ error: 'no such world draft' }, { status: 404 }),
      status: 404,
      error: 'no such market draft 71',
    },
    {
      name: 'transport failure',
      fetcher: async () => { throw new TypeError('fetch failed') },
      status: 503,
      error: 'the market public record is unavailable; nothing changed',
    },
    {
      name: 'invalid public record',
      fetcher: async () => Response.json({ nope: true }),
      status: 502,
      error: 'the market returned an invalid public draft; retry after 1F3EA returns the current draft',
    },
  ]

  for (const entry of cases) {
    const harness = makeHarness(
      {},
      path => publicMarketGet(MARKET, path, entry.fetcher),
    )
    const response = await harness.app.request('/api/world/listing', {
      method: 'POST',
      headers: jsonHeaders(SELLER_SECRET),
      body: JSON.stringify({ thing_id: 41, market_draft_id: 71 }),
    })

    assert.equal(response.status, entry.status, entry.name)
    assert.deepEqual(await response.json(), { error: entry.error }, entry.name)
    assert.equal(harness.getState().thingLocked, false, entry.name)
  }
})

test('listing and claim refusals name the state change that lets the caller continue', async () => {
  const locked = makeHarness({ offer: openOffer(), thingLocked: true })
  const lockedResponse = await locked.app.request('/api/world/listing', {
    method: 'POST',
    headers: jsonHeaders(SELLER_SECRET),
    body: JSON.stringify({ thing_id: 41, market_draft_id: 71 }),
  })
  assert.equal(lockedResponse.status, 409)
  assert.deepEqual(await lockedResponse.json(), {
    error: 'this thing is already locked by an offer; close its current offer before listing it again',
  })

  const claimed = makeHarness({
    offer: openOffer({
      status: 'claimed',
      buyer_id: 9,
      buyer: 'someone-else',
      claimed_at: NOW.toISOString(),
      locked: false,
    }),
    thingLocked: false,
  })
  const claimedResponse = await claimed.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: '{}',
  })
  assert.equal(claimedResponse.status, 403)
  assert.deepEqual(await claimedResponse.json(), {
    error: 'this world offer was claimed by another resident; choose another active offer because this claim cannot change buyers',
  })

  const pendingOffer = openOffer({
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
  })
  const pending = makeHarness({ offer: pendingOffer, thingLocked: true })
  pending.setState(current => ({ ...current, paymentAttempt: null }))
  const pendingResponse = await pending.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(pendingResponse.status, 503)
  assert.deepEqual(await pendingResponse.json(), {
    error: 'the pending payment custody record is unavailable; retry this same offer later and do not pay again',
  })
})

test('claim and cancel name missing market records without reporting an outage', async () => {
  const missingCheckout = makeHarness(
    { offer: openOffer(), thingLocked: true },
    path => publicMarketGet(MARKET, path, async () =>
      Response.json({ error: 'no such world checkout' }, { status: 404 })),
  )
  const checkoutResponse = await missingCheckout.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(checkoutResponse.status, 404)
  assert.deepEqual(await checkoutResponse.json(), { error: 'no such market checkout 81' })

  const missingListing = makeHarness(
    { offer: openOffer(), thingLocked: true },
    path => publicMarketGet(MARKET, path, async () =>
      path.endsWith('/checkout/81')
        ? Response.json({ checkout: checkout() })
        : Response.json({ error: 'no such world draft' }, { status: 404 })),
  )
  const listingResponse = await missingListing.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(listingResponse.status, 404)
  assert.deepEqual(await listingResponse.json(), { error: 'no such market draft 71' })

  const missingCancellation = makeHarness(
    { offer: openOffer(), thingLocked: true },
    path => publicMarketGet(MARKET, path, async () =>
      Response.json({ error: 'no such world draft' }, { status: 404 })),
  )
  const cancellationResponse = await missingCancellation.app.request('/api/world/offer/101/cancel', {
    method: 'POST',
    headers: jsonHeaders(SELLER_SECRET),
    body: JSON.stringify({}),
  })
  assert.equal(cancellationResponse.status, 404)
  assert.deepEqual(await cancellationResponse.json(), { error: 'no such market draft 71' })
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
  assert.equal(offer.maker_id, 6)
  assert.equal(offer.made_by, 'old-maker')
  assert.equal(offer.current_owner_id, 7)
  assert.equal(offer.current_owner, 'tiny-lantern')
  assert.equal(offer.buyer, null)
  assert.equal(text.includes('secret'), false)

  harness.setState(current => ({ ...current, thingModerated: true }))
  const hidden = await harness.app.request('/api/world/offer/101')
  assert.equal(hidden.status, 200)
  assert.deepEqual(await hidden.json(), {
    offer: { id: 101, status: 'maintainer_hidden' },
  })
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
  assert.equal(payFirst.status, 400)
  assert.equal(harness.getState().facilitatorSettlements, 0)
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
    method: 'POST',
    headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })
  const first = await pay()
  assert.equal(first.status, 200, await first.clone().text())
  const firstText = await first.clone().text()
  const firstPaymentResponse = first.headers.get('X-PAYMENT-RESPONSE')
  const firstBody = await first.json() as { offer: FakeOffer & { phase: string } }
  assert.equal(firstBody.offer.phase, 'claimed')
  assert.equal(firstBody.offer.maker_id, 6)
  assert.equal(firstBody.offer.made_by, 'old-maker')
  assert.equal(firstBody.offer.current_owner_id, 8)
  assert.equal(firstBody.offer.current_owner, 'neighbor')
  assert.equal(firstBody.offer.buyer, 'neighbor')
  assert.equal(firstBody.offer.from, BUYER_WALLET)
  assert.equal(firstBody.offer.to, SELLER_WALLET)
  assert.equal(firstBody.offer.tx_hash, TX)
  assert.equal(harness.getState().thingOwner, 8)
  assert.ok(harness.getState().queries.some(call =>
    call.text.includes('payment-sale-operations:complete-world') && /payment_uses/i.test(call.text) &&
    /sale_payments/i.test(call.text) && /update\s+things/i.test(call.text) && /insert\s+into\s+transfers/i.test(call.text)))
  const guardedClaim = harness.getState().queries.find(call =>
    call.text.includes('payment-sale-operations:complete-world'))
  assert.match(guardedClaim?.text ?? '', /date_trunc\('second', offer\.reserved_at\)/i)
  assert.match(guardedClaim?.text ?? '', /complete_payment_attempt/i)
  assert.match(guardedClaim?.text ?? '', /'maker_id'/i)
  assert.match(guardedClaim?.text ?? '', /'made_by'/i)
  assert.match(guardedClaim?.text ?? '', /'current_owner_id'/i)
  assert.match(guardedClaim?.text ?? '', /'current_owner'/i)
  assert.match(
    guardedClaim?.text ?? '',
    /UPDATE\s+things\s+SET\s+owner_id\s*=\s*offer\.buyer_id\s*,\s*active_offer_id\s*=\s*NULL\s+FROM/i,
  )

  const changedWallet = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ buyer_wallet: OTHER_WALLET }),
  })
  assert.equal(changedWallet.status, 409)
  const changedCheckout = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 82 }),
  })
  assert.equal(changedCheckout.status, 409)

  const retry = await pay()
  assert.equal(retry.status, 200)
  assert.equal(await retry.clone().text(), firstText)
  assert.equal(retry.headers.get('X-PAYMENT-RESPONSE'), firstPaymentResponse)
  assert.deepEqual(await retry.json(), firstBody)
  assert.equal(harness.getState().directVerifications, 1)
})

test('a completed payment replay preserves its x402 response header', async () => {
  const now = NOW.toISOString()
  const settledOffer = openOffer({
    buyer_id: 8,
    buyer: 'neighbor',
    reserved_by: 8,
    buyer_wallet: BUYER_WALLET,
    market_listing_id: 91,
    market_checkout_id: 81,
    reserved_at: now,
    reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
  })
  const paymentAttempt = {
    ...fakePaymentAttempt(now),
    status: 'completed' as const,
    requestHash: worldSaleRequestHash(settledOffer),
    responseStatus: 200,
    response: { offer: { id: 101, phase: 'claimed' } },
    completedAt: now,
  }
  const harness = makeHarness({
    offer: settledOffer,
    thingLocked: true,
    paymentAttempt,
  })

  const response = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
    body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
  })

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('X-PAYMENT-RESPONSE'), COMPLETED_RESPONSE)
  assert.equal(harness.getState().facilitatorSettlements, 0)
})

test('a claimed world replay rejects a different checkout binding', async () => {
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
  const first = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
    body: '{}',
  })
  assert.equal(first.status, 200, await first.clone().text())
  const verificationsBeforeReplay = harness.getState().directVerifications

  const replay = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: JSON.stringify({ market_checkout_id: 82 }),
  })
  assert.equal(replay.status, 409, await replay.clone().text())
  assert.match(await replay.text(), /market_checkout_id does not match the settled payment/i)
  assert.equal(harness.getState().directVerifications, verificationsBeforeReplay)

  const exactRetry = await harness.app.request('/api/world/offer/101/claim', {
    method: 'POST',
    headers: jsonHeaders(BUYER_SECRET),
    body: '{}',
  })
  assert.equal(exactRetry.status, 200, await exactRetry.clone().text())
  assert.equal(harness.getState().directVerifications, verificationsBeforeReplay)
})

test('world x402 claim uses the signed authorization nonce without a payment-identifier extension', async () => {
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

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(harness.getState().facilitatorSettlements, 1)
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
  assert.equal(response.headers.get('x-payment-response'), SETTLED_RESPONSE)
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
  const pendingIndex = harness.getState().queries.findIndex(call =>
    call.text.includes('payment-sale-operations:park-world'))
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

test('a finalized payment whose world target changed enters founder review with no ownership effect', async () => {
  const harness = makeHarness({
    scenario: 'target changes after world finality',
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
  })

  const response = await harness.app.request('/api/world/offer/101/reconcile', {
    method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: '{}',
  })

  assert.equal(response.status, 409, await response.clone().text())
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.payment, 'founder_review')
  assert.equal(body.do_not_pay_again, true)
  assert.equal('retry' in body, false)
  assert.equal(harness.getState().paymentAttempt?.status, 'founder_review')
  assert.equal(harness.getState().offer?.x402_evidence_state, 'founder_review')
  assert.equal(harness.getState().thingOwner, 9)
  assert.equal(harness.getState().thingLocked, true)
  assert.equal(harness.getState().queries.some(call =>
    call.text.includes('payment-sale-operations:complete-world')), false)
  assert.equal(harness.getState().queries.some(call =>
    call.text.includes('payment-sale-operations:close-target')), true)
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
  const claimedHarness = makeHarness({
    offer: openOffer({ status: 'claimed', claimed_at: NOW.toISOString(), locked: false }),
    thingLocked: false,
  })
  const claimedResponse = await claimedHarness.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(claimedResponse.status, 409)
  assert.deepEqual(await claimedResponse.json(), {
    error: 'claimed world offer cannot be canceled; the completed sale is permanent, so list another owned thing instead',
  })

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

test('founder-review evidence keeps the world thing locked until market-first cancellation', async () => {
  const reviewed = openOffer({
    buyer_id: 8,
    buyer: 'neighbor',
    reserved_by: 8,
    buyer_wallet: BUYER_WALLET,
    market_listing_id: 91,
    market_checkout_id: 81,
    pending_x402_tx_hash: TX,
    pending_x402_payer: BUYER_WALLET,
    pending_x402_at: NOW.toISOString(),
    x402_evidence_state: 'founder_review',
    reserved_at: NOW.toISOString(),
    reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
  })
  const active = makeHarness({
    offer: reviewed,
    thingLocked: true,
    draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
  })
  const blocked = await active.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(blocked.status, 409)
  assert.equal(active.getState().thingLocked, true)

  const ended = makeHarness({
    offer: reviewed,
    thingLocked: true,
    draft: draft({ status: 'canceled', listing_id: 91, listing_state: 'stale' }),
  })
  const canceled = await ended.app.request('/api/world/offer/101/cancel', {
    method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
  })
  assert.equal(canceled.status, 200, await canceled.clone().text())
  assert.equal(ended.getState().thingLocked, false)
})
