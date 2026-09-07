import { canonicalPaymentRequest, type PaymentAttemptRecord } from '../../../src/payment-attempts.ts'

export const MARKET = 'https://1f3ea.com'
export const SELLER_SECRET = 'Bearer seller-secret'
export const BUYER_SECRET = 'Bearer buyer-secret'
export const OTHER_SECRET = 'Bearer other-secret'
export const SELLER_WALLET = '0x1111111111111111111111111111111111111111'
export const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
export const OTHER_WALLET = '0x3333333333333333333333333333333333333333'
export const TX = '0x' + 'ab'.repeat(32)
export const SETTLED_RESPONSE = Buffer.from(JSON.stringify({
  success: true,
  transaction: TX,
  payer: BUYER_WALLET,
})).toString('base64')
export const COMPLETED_RESPONSE = Buffer.from(JSON.stringify({
  success: true,
  transaction: TX,
  payer: BUYER_WALLET,
  replay: true,
})).toString('base64')
const ATTEMPT_ID = 'pay_world_offer_1234567890abcdef'
const PAYMENT_ID = 'pay_world_offer_1234567890abcdef'
export const X_PAYMENT = Buffer.from(JSON.stringify({
  payload: { authorization: { from: BUYER_WALLET } },
  extensions: {
    'payment-identifier': {
      info: { required: true },
      id: PAYMENT_ID,
    },
  },
})).toString('base64')
export const X_PAYMENT_NO_ID = Buffer.from(JSON.stringify({
  payload: { authorization: { from: BUYER_WALLET } },
})).toString('base64')
export const NOW = new Date('2026-08-12T12:00:00.000Z')

type OfferStatus = 'open' | 'claimed' | 'canceled'

export interface FakeOffer {
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

export interface FakeState {
  scenario?: 'target changes after world finality'
  thingOwner: number
  thingWithdrawn: boolean
  thingLocked: boolean
  thingModerated: boolean
  offer: FakeOffer | null
  draft: Record<string, unknown>
  listing: Record<string, unknown>
  checkout: Record<string, unknown>
  marketFailure: boolean
  marketInvalid: boolean
  directVerifications: number
  directVerificationAvailable: boolean
  directVerificationInvalid: boolean
  directBlockTime: string
  facilitatorSettlements: number
  paymentAttempt: PaymentAttemptRecord | null
  databaseReturnsTimestampDates: boolean
  now: string
  queries: Array<{ text: string; params: readonly unknown[] }>
}

export function draft(overrides: Record<string, unknown> = {}) {
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

export function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: 91,
    state: 'active',
    world_state: 'active',
    world_offer_id: 101,
    world_draft_id: 71,
    ...overrides,
  }
}

export function checkout(overrides: Record<string, unknown> = {}) {
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

export function openOffer(overrides: Partial<FakeOffer> = {}): FakeOffer {
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

export function initialState(patch: Partial<FakeState> = {}): FakeState {
  return {
    thingOwner: 7,
    thingWithdrawn: false,
    thingLocked: false,
    thingModerated: false,
    offer: null,
    draft: draft(),
    listing: listing(),
    checkout: checkout(),
    marketFailure: false,
    marketInvalid: false,
    directVerifications: 0,
    directVerificationAvailable: true,
    directVerificationInvalid: false,
    directBlockTime: NOW.toISOString(),
    facilitatorSettlements: 0,
    paymentAttempt: null,
    databaseReturnsTimestampDates: false,
    now: NOW.toISOString(),
    queries: [],
    ...patch,
  }
}

export function fakePaymentAttempt(now: string): PaymentAttemptRecord {
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

export function worldRequestForOffer(offer: Pick<
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

export function worldSaleRequestHash(offer: Parameters<typeof worldRequestForOffer>[0]): string {
  return canonicalPaymentRequest(worldRequestForOffer(offer)).hash
}
