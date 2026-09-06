import { Hono, type Context } from 'hono'
import { mountWorldMarketRoutes, type WorldMarketDependencies } from '../../../src/world-market.ts'
import { mcp } from '../../../src/mcp.ts'
import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import {
  BUYER_SECRET,
  BUYER_WALLET,
  COMPLETED_RESPONSE,
  type FakeState,
  MARKET,
  OTHER_SECRET,
  SELLER_SECRET,
  SELLER_WALLET,
  SETTLED_RESPONSE,
  TX,
  fakePaymentAttempt,
  initialState,
  openOffer,
  worldRequestForOffer,
  worldSaleRequestHash,
} from './offers.ts'

export function makeHarness(
  patch: Partial<FakeState> = {},
  suppliedMarketGet?: WorldMarketDependencies['marketGet'],
) {
  let state = initialState(patch)
  const runPaymentInputs: Parameters<WorldMarketDependencies['runPayment']>[0][] = []
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
    if (text.includes('world-market:read-offer')) {
      if (!state.offer) return []
      return [{
        ...state.offer,
        ...(state.databaseReturnsTimestampDates
          ? {
              reserved_at: state.offer.reserved_at == null
                ? null
                : new Date(state.offer.reserved_at),
              reserved_until: state.offer.reserved_until == null
                ? null
                : new Date(state.offer.reserved_until),
            }
          : {}),
      }]
    }
    if (text.includes('world-market:public-moderation')) {
      return state.thingModerated ? [{ action: 'remove' }] : []
    }
    if (text.includes('world-market:reserve')) {
      const offer = state.offer
      if (!offer || offer.status !== 'open') return []
      const active = offer.reserved_until != null && Date.parse(offer.reserved_until) > Date.parse(state.now)
      if (active) return []
      const buyerId = Number(params[1])
      // The real statement stores buyer_id only; the public read joins the
      // handle from residents, the way this fake's authenticate() knows them.
      const handles: Record<number, string> = { 7: 'tiny-lantern', 8: 'neighbor', 9: 'someone-else' }
      const buyer = handles[buyerId] ?? String(buyerId)
      const reservedAt = state.now
      const reservedUntil = new Date(Date.parse(state.now) + 300_000).toISOString()
      const rebound = {
        ...offer,
        buyer_id: buyerId,
        buyer,
        reserved_by: buyerId,
        buyer_wallet: String(params[2]),
        market_listing_id: Number(params[3]),
        market_checkout_id: Number(params[4]),
        market_buyer: String(params[7]),
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
      if (path === '/api/listing/91') return { listing: state.listing }
      if (path === '/api/world/checkout/81' || path === '/api/world/checkout/82') {
        return { checkout: { ...state.checkout, id: Number(path.split('/').at(-1)) } }
      }
      throw new Error(`unexpected market path: ${path}`)
    }),
    findPayment: async () => state.paymentAttempt,
    runPayment: async input => {
      runPaymentInputs.push(input)
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
    getRunPaymentInputs: () => [...runPaymentInputs],
    setState: (patcher: (current: FakeState) => FakeState) => { state = patcher(state) },
  }
}

export const jsonHeaders = (authorization?: string) => ({
  'content-type': 'application/json',
  ...(authorization ? { authorization } : {}),
})
