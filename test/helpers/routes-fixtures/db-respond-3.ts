import { canonicalPaymentRequest } from './source-imports.ts'
import {
  AUTHORIZATION_NOW,
  BUYER_WALLET,
  CONTRACT_DRAWING,
  CONTRACT_DRAWING_DESCRIPTION,
  OTHER_SECRET,
  SALE_X_PAYMENT,
  SECRET,
  SELLER_WALLET,
  STRANGER_WALLET,
  TREASURY,
  TX1,
  TX2,
  TX_CASE_UPPER,
  X_PAYMENT,
  X_PAYMENT_NO_ID,
} from './environment.ts'
import {
  fixtureState,
  paidCompletionError,
} from './state.ts'
import type {
  FakeCityCreditEntry,
  FakeCommunityToolSubmission,
  FakeFounderPayPalDispute,
  FakeLaterHolderItem,
  FakePaymentAttempt,
} from './state.ts'
import {
  descendingPage,
  kindRow,
  mapOutlineParent,
  mapOutlineRows,
  paginationEvents,
  paginationNotes,
  paginationSubplaces,
  paginationThings,
  placeRow,
  recentIds,
  remainingPaginationRows,
  residentArrivalPage,
  residentArrivalRows,
  residentHandleForFakeId,
  residentRow,
  roomOrientationThingRow,
  selectedPlacePermission,
  thingRow,
  visibleRoomFrontMatter,
} from './rows.ts'
import {
  frontMatterIdsIn,
  recordPayment,
  roomPurposeIn,
} from './state-tools.ts'

export function respondToDatabaseStage3(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {


  if (q.includes('/* payment-sale-operations:read-attempt */')) {
    const attempt = fixtureState.current.paymentAttempts.get(String(params[0]))
    if (!attempt || attempt.offer_id !== fixtureState.current.offer.id) return []
    const request = attempt.request_json ?? null
    const wrapped = attempt.response_json?.__1f3d9_x402_response_v1
    const wrapper = wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
      ? wrapped as Record<string, unknown>
      : null
    const response = wrapper?.body && typeof wrapper.body === 'object' && !Array.isArray(wrapper.body)
      ? wrapper.body as Record<string, unknown>
      : attempt.response_json
    const assetId = Number(request?.asset_id ?? attempt.asset_id ?? 41)
    const price = Number(request?.price_usdc ?? 2)
    const buyerWallet = String(request?.buyer_wallet ?? attempt.payer_wallet ?? BUYER_WALLET).toLowerCase()
    const sellerWallet = String(request?.seller_wallet ?? attempt.payee_wallet ?? SELLER_WALLET).toLowerCase()
    return [{
      attempt_id: attempt.public_id,
      actor_id: attempt.actor_id,
      counterparty_id: attempt.counterparty_id,
      operation: attempt.operation,
      target_key: attempt.target_key,
      attempt_offer_id: attempt.offer_id,
      attempt_asset_type: attempt.asset_type,
      attempt_asset_id: attempt.asset_id,
      request_hash: attempt.request_hash,
      request_json: request,
      method: attempt.method,
      network: attempt.network,
      token: attempt.token,
      payer_wallet: attempt.payer_wallet,
      payee_wallet: attempt.payee_wallet,
      amount_units: attempt.amount_units,
      start_time: attempt.start_time,
      end_time: attempt.end_time,
      status: attempt.status,
      lease_owner: attempt.lease_owner,
      tx_hash: attempt.tx_hash,
      finalized_block_number: attempt.finalized_block_number,
      finalized_block_hash: attempt.finalized_block_hash,
      finalized_block_time: attempt.finalized_block_time,
      finalized_at: attempt.finalized_at,
      recovery_started_at: attempt.recovery_started_at,
      recovery_deadline_at: attempt.recovery_deadline_at,
      recovery_open: attempt.recovery_deadline_at != null
        && Date.parse(attempt.recovery_deadline_at) > Date.now(),
      offer_id: fixtureState.current.offer.id,
      channel: fixtureState.current.offer.channel ?? 'direct',
      asset_type: attempt.asset_type,
      asset_id: assetId,
      seller_id: 7,
      seller: 'tiny-lantern',
      buyer_id: 8,
      buyer: 'neighbor',
      price_usdc: price,
      seller_wallet: sellerWallet,
      buyer_wallet: fixtureState.current.offer.buyerWallet ?? buyerWallet,
      offer_status: fixtureState.current.offer.status,
      reserved_by: fixtureState.current.offer.reservedUntil == null ? null : 8,
      reserved_at: fixtureState.current.offer.reservedAt,
      reserved_until: fixtureState.current.offer.reservedUntil,
      market_origin: 'https://1f3ea.com',
      market_draft_id: null,
      market_listing_id: null,
      market_checkout_id: null,
      market_buyer: null,
      pending_payment_attempt_id: null,
      pending_x402_tx_hash: null,
      pending_x402_payer: null,
      pending_x402_at: null,
      x402_evidence_state: 'none',
      current_owner_id: fixtureState.current.thingOwnerId,
      active_offer_id: fixtureState.current.offer.status === 'open' ? fixtureState.current.offer.id : null,
      withdrawn_at: fixtureState.current.thingWithdrawn ? new Date().toISOString() : null,
      asset_name: 'porch lantern',
      maker_id: 7,
      made_by: 'tiny-lantern',
      response_status: attempt.response_status,
      response,
      response_body: attempt.response_body_bytes == null
        ? null
        : Buffer.from(attempt.response_body_bytes).toString('utf8'),
      payment_response_header: wrapper?.header == null ? null : String(wrapper.header),
    }]
  }
  if (q.includes('/* payment-sale-operations:complete-direct */')) {
    const attemptId = String(params[0])
    const leaseOwner = String(params[1])
    const attempt = fixtureState.current.paymentAttempts.get(attemptId)
    if (
      !attempt || attempt.lease_owner !== leaseOwner || attempt.status !== 'payment_pending'
      || attempt.offer_id !== fixtureState.current.offer.id || fixtureState.current.offer.status !== 'open'
    ) return []
    const createdAt = '2026-08-11T00:00:00.000Z'
    const response = {
      offer: { id: fixtureState.current.offer.id, status: 'claimed' },
      transfer: {
        id: 91,
        type: attempt.asset_type,
        asset_id: attempt.asset_id,
        from: 'tiny-lantern',
        to: 'neighbor',
        price_usdc: Number(attempt.amount_units ?? 0) / 1_000_000,
        tx_hash: attempt.tx_hash,
        created_at: createdAt,
      },
    }
    const responseBody = JSON.stringify(response)
    const wrapped = attempt.response_json?.__1f3d9_x402_response_v1
    const wrapper = wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
      ? wrapped as Record<string, unknown>
      : null
    const completed: FakePaymentAttempt = {
      ...attempt,
      status: 'completed',
      lease_owner: null,
      lease_expires_at: null,
      result_json: { kind: 'transfer_offer', id: fixtureState.current.offer.id },
      response_status: 200,
      response_json: wrapper?.header == null
        ? response
        : { __1f3d9_x402_response_v1: { header: wrapper.header, body: response } },
      response_body_bytes: Buffer.from(responseBody, 'utf8'),
      updated_at: createdAt,
      completed_at: createdAt,
    }
    fixtureState.current = {
      ...fixtureState.current,
      offer: { ...fixtureState.current.offer, status: 'claimed' },
      thingOwnerId: attempt.actor_id,
      paymentHashes: new Set(fixtureState.current.paymentHashes).add(String(attempt.tx_hash)),
      paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, completed),
    }
    return [{
      state: 'completed',
      attempt_id: attemptId,
      actor_id: attempt.actor_id,
      operation: attempt.operation,
      method: attempt.method,
      response_status: 200,
      response,
      response_body: responseBody,
      payment_response_header: wrapper?.header == null ? null : String(wrapper.header),
    }]
  }
  if (q.includes('/* payment-sale-operations:close-target */')) {
    const attemptId = String(params[0])
    const leaseOwner = String(params[1])
    const terminalState = String(params[2]) as 'expired' | 'founder_review'
    const attempt = fixtureState.current.paymentAttempts.get(attemptId)
    if (!attempt || attempt.lease_owner !== leaseOwner) return []
    const closed: FakePaymentAttempt = {
      ...attempt,
      status: terminalState,
      invalid_reason: attempt.invalid_reason ?? String(params[3]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    fixtureState.current = {
      ...fixtureState.current,
      offer: attempt.operation === 'direct_sale'
        ? { ...fixtureState.current.offer, status: 'canceled' }
        : fixtureState.current.offer,
      paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, closed),
    }
    return [{
      state: terminalState,
      attempt_id: attemptId,
      actor_id: attempt.actor_id,
      operation: attempt.operation,
      method: attempt.method,
      target_released: attempt.operation === 'direct_sale',
    }]
  }

  if (q.includes('/* payment-treasury-operations:complete */')) {
    const attemptId = String(params[0])
    const leaseOwner = String(params[1])
    const attempt = fixtureState.current.paymentAttempts.get(attemptId)
    if (
      !attempt
      || attempt.lease_owner !== leaseOwner
      || attempt.status !== 'payment_pending'
    ) return []
    if (fixtureState.current.interruptTreasuryCompletionOnce) {
      fixtureState.current = {
        ...fixtureState.current,
        interruptTreasuryCompletionOnce: false,
        paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, {
          ...attempt,
          lease_expires_at: new Date(Date.now() - 1).toISOString(),
        }),
      }
      throw Object.assign(new Error('connection interrupted before treasury completion'), { code: '57P01' })
    }
    const deadline = attempt.recovery_deadline_at == null
      ? null
      : new Date(attempt.recovery_deadline_at).getTime()
    if (deadline != null && deadline <= Date.now()) {
      return [{ state: 'deadline_passed', attempt_id: attemptId }]
    }
    if (deadline == null || fixtureState.current.failPaidWriteOnce || !attempt.request_json) {
      if (fixtureState.current.failPaidWriteOnce) fixtureState.current = { ...fixtureState.current, failPaidWriteOnce: false }
      return [{
        state: 'target_changed',
        attempt_id: attemptId,
        reason: 'stored treasury request is invalid or its target changed',
      }]
    }
    if (fixtureState.current.paidCompletionFailure) {
      const failure = fixtureState.current.paidCompletionFailure
      fixtureState.current = { ...fixtureState.current, paidCompletionFailure: null }
      throw paidCompletionError(failure)
    }

    let responseStatus: 200 | 201
    let response: Record<string, unknown>
    let result: Record<string, unknown>
    if (attempt.operation === 'frontier') {
      const request = attempt.request_json
      const place = {
        ...placeRow(3, 1),
        name: String(request.name),
        description: String(request.description),
        open_to_building: Boolean(request.open_to_building),
        open_to_things: Boolean(request.open_to_things),
        open_to_notes: Boolean(request.open_to_notes),
      }
      responseStatus = 201
      result = { kind: 'place', id: place.id }
      response = { place }
    } else if (attempt.operation === 'kind_invention') {
      const request = attempt.request_json
      const kind = {
        id: 3,
        name: String(request.name),
        owner_id: attempt.actor_id,
        owner: residentHandleForFakeId(attempt.actor_id),
        revision: 1,
        description: String(request.description),
        traits: request.traits,
        recipe: request.recipe,
        created_at: '2026-08-11T00:00:00.000Z',
      }
      responseStatus = 201
      result = { kind: 'kind_revision', id: kind.id, revision: kind.revision }
      response = { kind }
    } else if (attempt.operation === 'kind_revision') {
      const request = attempt.request_json
      const kind = {
        ...kindRow(),
        revision: fixtureState.current.kindRevision + 1,
        description: String(request.description),
        traits: request.traits,
        recipe: request.recipe,
      }
      responseStatus = 200
      result = { kind: 'kind_revision', id: kind.id, revision: kind.revision }
      response = { kind }
    } else {
      return [{
        state: 'target_changed',
        attempt_id: attemptId,
        reason: 'stored treasury request is invalid or its target changed',
      }]
    }

    if (attempt.method === 'x402') {
      if (!attempt.tx_hash || fixtureState.current.paymentHashes.has(attempt.tx_hash)) {
        return [{
          state: 'target_changed',
          attempt_id: attemptId,
          reason: 'stored treasury request is invalid or its target changed',
        }]
      }
      response = { ...response, fee_tx: attempt.tx_hash }
      fixtureState.current = {
        ...fixtureState.current,
        paymentHashes: new Set([...fixtureState.current.paymentHashes, attempt.tx_hash]),
      }
    } else {
      const balance = fixtureState.current.cityCreditBalances.get(attempt.actor_id) ?? 0n
      response = {
        ...response,
        city_fee_credit: {
          spent_usdc: '1.000000',
          balance_usdc: `${balance / 1_000_000n}.${String(balance % 1_000_000n).padStart(6, '0')}`,
        },
      }
    }

    const responseBody = JSON.stringify(response)
    const durable = attempt.response_json?.__1f3d9_x402_response_v1
    const paymentResponseHeader = fixtureState.current.treasuryCompletionHeader ?? (
      durable && typeof durable === 'object' && !Array.isArray(durable)
        ? String((durable as Record<string, unknown>).header ?? '')
        : null
    )
    const completed: FakePaymentAttempt = {
      ...attempt,
      status: 'completed',
      lease_owner: null,
      lease_expires_at: null,
      result_json: result,
      response_status: responseStatus,
      response_json: attempt.method === 'x402'
        ? { __1f3d9_x402_response_v1: { header: paymentResponseHeader, body: response } }
        : response,
      response_body_bytes: Buffer.from(responseBody, 'utf8'),
      updated_at: '2026-08-11T00:00:01.000Z',
      completed_at: '2026-08-11T00:00:01.000Z',
    }
    fixtureState.current = {
      ...fixtureState.current,
      paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, completed),
    }
    return [{
      state: 'completed',
      attempt_id: attemptId,
      actor_id: attempt.actor_id,
      operation: attempt.operation,
      method: attempt.method,
      response_status: responseStatus,
      response_json: response,
      response_body: responseBody,
      payment_response_header: attempt.method === 'x402' ? paymentResponseHeader : null,
      reason: null,
    }]
  }
  return undefined
}
