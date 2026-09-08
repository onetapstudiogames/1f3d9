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

export function respondToDatabaseStage1(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {


  if (q.includes('insert into resident_refusal_state')) {
    const residentId = Number(params[0])
    const httpStatus = Number(params[1])
    const causeHash = String(params[2])
    const previous = fixtureState.current.residentRefusalStates.get(residentId)
    const repetitionCount = previous?.httpStatus === httpStatus
      && previous.causeHash === causeHash
      ? Math.min(previous.repetitionCount + 1, 10)
      : 1
    const residentRefusalStates = new Map(fixtureState.current.residentRefusalStates)
    residentRefusalStates.set(residentId, { httpStatus, causeHash, repetitionCount })
    fixtureState.current = { ...fixtureState.current, residentRefusalStates }
    return [{ repetition_count: repetitionCount }]
  }

  if (q.includes('front_matter_thing_ids') && q.includes('select')
      && /\b(?:from|join)\s+things\b/iu.test(q)
      && !/\b(?:insert|update|delete)\b/iu.test(q)) {
    return fixtureState.current.scenario === 'room orientation'
      ? visibleRoomFrontMatter().map((heading, position) => ({ ...heading, place_id: 2, position }))
      : []
  }

  if (fixtureState.current.scenario === 'room orientation') {
    const writesFrontMatter = q.includes('front_matter_thing_ids')
      && /\b(?:insert|update|delete)\b/iu.test(q)
    const updatesOrientation = q.includes('update places')
      && (q.includes('purpose') || q.includes('front_matter_thing_ids'))
    if (writesFrontMatter || updatesOrientation) {
      if (fixtureState.current.frontMatterRaceLost) return []
      const parsedIds = frontMatterIdsIn(params)
      const ids = parsedIds
      if (ids && ids.some(id => {
        const row = roomOrientationThingRow(id)
        return row.place_id !== 2 || row.withdrawn_at !== null
          || fixtureState.current.frontMatterHiddenThingIds.includes(id)
      })) {
        throw Object.assign(
          new Error('front matter must use active public things in the same place'),
          { code: '23514' },
        )
      }
      const purpose = roomPurposeIn(params)
      fixtureState.current = {
        ...fixtureState.current,
        ...(ids === null ? {} : { frontMatterThingIds: [...ids] }),
        ...(purpose === null ? {} : { roomPurpose: purpose }),
      }
      return [{
        ...placeRow(2, 1),
        purpose: fixtureState.current.roomPurpose,
        front_matter_thing_ids: [...fixtureState.current.frontMatterThingIds],
        active_offer_id: null,
        has_open_offer: false,
      }]
    }
    if (q.includes('from things') && !q.includes('/* public:place-collections')) {
      const requested = frontMatterIdsIn(params) ?? []
      return requested.map(roomOrientationThingRow)
        .filter(row => row.place_id === 2 && row.withdrawn_at === null)
        .filter(row => !fixtureState.current.frontMatterHiddenThingIds.includes(row.id))
    }
    if (q.includes('from places') && q.includes('purpose') && !q.includes('/* public:')) {
      return [{
        ...placeRow(2, 1),
        purpose: fixtureState.current.roomPurpose,
        front_matter_thing_ids: [...fixtureState.current.frontMatterThingIds],
        active_offer_id: null,
        has_open_offer: false,
      }]
    }
  }

  if (q.includes('select id from residents where handle')) {
    const handle = String(params[0])
    const residentId = handle === 'founder' ? 1 : handle === 'tiny-lantern' ? 7 : handle === 'neighbor' ? 8 : null
    return residentId === null ? [] : [{ id: residentId }]
  }
  if (q.includes('/* community-tools:waiting-count */')) {
    return [{
      count: fixtureState.current.communityToolSubmissions.filter(submission => submission.reviewed_at === null).length,
    }]
  }
  if (q.includes('/* community-tools:operator-queue */')) {
    return fixtureState.current.communityToolSubmissions
      .filter(submission => submission.reviewed_at === null)
      .sort((left, right) => right.id - left.id)
      .map(submission => ({
        id: submission.id,
        title: submission.title,
        url: submission.url,
        operator_name: submission.operator_name,
        description: submission.description,
        resident_id: submission.resident_id,
        resident_handle: submission.resident_handle,
        category: submission.category,
        tags: [...submission.tags],
        created_at: submission.created_at,
      }))
  }
  if (q.includes('/* community-tools:review */')) {
    const id = Number(params[0])
    const reviewer = Number(params[1])
    const requestedOutcome = params[2]
    const existing = fixtureState.current.communityToolSubmissions.find(submission => submission.id === id)
    if (!existing) return []
    if (existing.reviewed_at !== null) {
      return [{ outcome: 'already_reviewed', review_outcome: existing.review_outcome }]
    }
    if (requestedOutcome !== 'listed' && requestedOutcome !== 'declined') {
      throw new Error('community tool review fake received an invalid outcome')
    }
    const reviewed: FakeCommunityToolSubmission = {
      ...existing,
      submitter_ip_hash: null,
      reviewed_at: '2026-09-01T20:05:00.000Z',
      reviewed_by: reviewer,
      review_outcome: requestedOutcome,
    }
    fixtureState.current = {
      ...fixtureState.current,
      communityToolSubmissions: fixtureState.current.communityToolSubmissions.map(submission =>
        submission.id === id ? reviewed : submission),
    }
    return [{ outcome: 'reviewed', review_outcome: requestedOutcome }]
  }
  if (q.includes('/* city-credit:issue */')) {
    const founderId = Number(params[0])
    const residentId = Number(params[1])
    const sourceKey = String(params[2])
    const reason = String(params[3])
    const amountUnits = String(params[4])
    const existing = fixtureState.current.cityCreditEntries.find(entry => entry.source_key === sourceKey)
    if (existing) {
      return [{
        ...existing,
        entry_id: existing.id,
        created: false,
        balance_units: String(fixtureState.current.cityCreditBalances.get(existing.resident_id) ?? 0n),
      }]
    }
    if (![1, 7, 8].includes(residentId)) return []
    const entry: FakeCityCreditEntry = {
      id: String(fixtureState.current.nextCityCreditEntryId),
      resident_id: residentId,
      entry_kind: 'founder_issue',
      amount_units: amountUnits,
      founder_id: founderId,
      source_key: sourceKey,
      request_id: null,
      payment_attempt_id: null,
      related_spend_id: null,
      reason,
      created_at: '2026-08-11T00:00:00.000Z',
    }
    const balance = (fixtureState.current.cityCreditBalances.get(residentId) ?? 0n) + BigInt(amountUnits)
    fixtureState.current = {
      ...fixtureState.current,
      cityCreditBalances: new Map(fixtureState.current.cityCreditBalances).set(residentId, balance),
      cityCreditEntries: [...fixtureState.current.cityCreditEntries, entry],
      nextCityCreditEntryId: fixtureState.current.nextCityCreditEntryId + 1,
    }
    return [{ ...entry, entry_id: entry.id, created: true, balance_units: String(balance) }]
  }
  if (q.includes('/* city-credit:read-account */')) {
    const residentId = Number(params[0])
    const beforeId = params[1] == null ? null : BigInt(String(params[1]))
    const limit = params[2] == null ? 20 : Number(params[2])
    const matching = fixtureState.current.cityCreditEntries
      .filter(entry => entry.resident_id === residentId && (beforeId === null || BigInt(entry.id) < beforeId))
      .sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)))
    const history = matching.slice(0, limit).map(entry => {
      const attempt = entry.payment_attempt_id == null
        ? null
        : fixtureState.current.paymentAttempts.get(entry.payment_attempt_id) ?? null
      return {
        ...entry,
        operation: attempt?.operation ?? null,
        target_key: attempt?.target_key ?? null,
      }
    })
    return [{
      resident_id: residentId,
      balance_units: String(fixtureState.current.cityCreditBalances.get(residentId) ?? 0n),
      history,
      has_more: matching.length > limit,
    }]
  }
  if (q.includes('/* city-credit:lock-me-read */')) return [{ id: fixtureState.current.actorId }]
  if (q.includes('/* city-credit:me-summary-window */')) return [{ after_change_id: null, through_change_id: '0' }]
  if (q.includes('/* city-credit:admit-me-summary */')) return [{ slot: 0 }]
  if (/\/\* city-credit:(?:save-me-summary|me-summary-timeout|me-summary-parallel|release-me-summary|rollback-me-summary) \*\//u.test(q)) return []
  if (q.includes('/* city-credit:read-attention */')) {
    const pendingGifts = Array.from(
      { length: Math.min(fixtureState.current.attentionPendingGiftsCount, 10) },
      (_, index) => ({
        row_id: String(100 - index),
        gift_id: `city_gift_${String(index + 1).padStart(32, '0')}`,
        amount_units: '1000000',
      }),
    )
    return [{
      had_previous_read: false,
      change_units: null,
      changed_at: null,
      last_visit_at: null,
      accepted_gift_units: '0',
      settled_purchase_units: '0',
      founder_issue_units: '0',
      founder_issue_count: 0,
      founder_issues: [],
      founder_issues_have_more: false,
      pending_gifts: pendingGifts,
      pending_gifts_have_more: fixtureState.current.attentionPendingGiftsCount > 10,
      pending_count: fixtureState.current.attentionPendingGiftsCount,
      frozen_count: 0,
      around_you: {
        after_change_id: null,
        through_change_id: '0',
        notes_in_owned_places: { count: 0, records: [] },
        new_things_in_owned_places: { count: 0, records: [] },
        new_agreement_signers: { count: 0, records: [] },
        mentions: { count: 0, records: [] },
      },
    }]
  }
  if (q.includes('/* paypal-credit:founder-dispute-inspection */')) return []
  if (q.includes('/* paypal-credit:rate-limit */')) {
    const maximum = Number(params[1])
    if (fixtureState.current.paypalCreditRateSlotsUsed >= maximum) return []
    const used = fixtureState.current.paypalCreditRateSlotsUsed + 1
    fixtureState.current = { ...fixtureState.current, paypalCreditRateSlotsUsed: used }
    return [{ used }]
  }
  if (q.includes('/* paypal-credit:founder-dispute-resolution */')) {
    const disputeId = String(params.find(value => /^PP-D-[A-Za-z0-9-]+$/u.test(String(value))) ?? '')
    const requestedDecision = params.find(value =>
      value === 'seller_favour' || value === 'buyer_favour') as
        | 'seller_favour'
        | 'buyer_favour'
        | undefined
    const stored = fixtureState.current.founderPayPalDisputes.get(disputeId)
    if (!stored) {
      return [{
        status: 'not_found', application_outcome: 'dispute_not_found',
        dispute_id: disputeId, state: null, decision: null, created: false,
      }]
    }
    if (stored.decision !== null) {
      const existing = stored.decision === requestedDecision
      const applicationOutcome = stored.decision === 'seller_favour'
        ? 'founder_review_seller_favour_applied'
        : 'founder_review_buyer_favour_applied'
      return [{
        status: existing ? 'resolved' : 'decision_conflict',
        application_outcome: existing
          ? applicationOutcome
          : 'founder_dispute_resolution_conflict',
        dispute_id: disputeId,
        state: stored.state,
        decision: stored.decision,
        created: false,
        disposition: existing ? 'existing' : 'conflict',
        founder_event_id: 'founder-review-1',
        public_event_id: 1,
        local_purchase_count: 1,
        receipts_created: existing ? 0 : 1,
      }]
    }
    if (stored.state !== 'resolution_review') {
      return [{
        status: 'not_reviewable', application_outcome: 'dispute_not_in_resolution_review',
        dispute_id: disputeId, state: stored.state, decision: null, created: false,
      }]
    }
    if (!requestedDecision) throw new Error('founder dispute fake received no decision')
    const resolvedState = requestedDecision === 'seller_favour'
      ? 'resolved_seller' as const
      : 'resolved_against_seller' as const
    const eventId = fixtureState.current.nextFounderPayPalDisputeEventId
    const resolved: FakeFounderPayPalDispute = {
      ...stored,
      state: resolvedState,
      decision: requestedDecision,
    }
    fixtureState.current = {
      ...fixtureState.current,
      founderPayPalDisputes: new Map(fixtureState.current.founderPayPalDisputes).set(disputeId, resolved),
      founderPayPalDisputeEvents: [...fixtureState.current.founderPayPalDisputeEvents, {
        kind: 'payment_repair',
        actor: fixtureState.current.actorHandle,
        detail: {
          action: requestedDecision === 'seller_favour'
            ? 'credit_dispute_seller_favour'
            : 'credit_dispute_buyer_favour',
        },
      }],
      nextFounderPayPalDisputeEventId: eventId + 1,
    }
    return [{
      status: 'resolved',
      application_outcome: requestedDecision === 'seller_favour'
        ? 'founder_review_seller_favour_applied'
        : 'founder_review_buyer_favour_applied',
      dispute_id: disputeId,
      state: resolvedState,
      decision: requestedDecision,
      created: true,
      disposition: 'created',
      founder_event_id: `founder-review-${eventId}`,
      public_event_id: eventId,
      local_purchase_count: 1,
      receipts_created: 1,
    }]
  }
  if (q.includes('/* city-credit:preflight */')) {
    const residentId = Number(params[0])
    if (![1, 7, 8].includes(residentId)) return []
    return [{
      balance_units: String(fixtureState.current.cityCreditBalances.get(residentId) ?? 0n),
      pending_gifts_count: '0',
      observed_at: '2026-08-26T23:30:00.000Z',
    }]
  }
  if (q.includes('/* prepaid-credit:read-pending-gifts */')) return []
  if (q.includes('/* city-credit:issue-balance */')) {
    const residentId = Number(params[0])
    const balance = fixtureState.current.cityCreditBalances.get(residentId)
    return balance == null ? [] : [{ balance_units: String(balance) }]
  }
  if (q.includes('/* city-credit:begin-spend */')) {
    const actorId = Number(params[0])
    const operation = String(params[1])
    const targetKey = String(params[2])
    const requestId = String(params[3])
    const requestHash = String(params[4])
    const requestJson = JSON.parse(String(params[5])) as Record<string, unknown>
    const amountUnits = String(params[6])
    const newAttemptId = String(params[7])
    const newLeaseOwner = String(params[8])
    const assetType = params[10] == null ? null : String(params[10])
    const assetId = params[11] == null ? null : Number(params[11])
    let spend = fixtureState.current.cityCreditEntries.find(entry =>
      entry.entry_kind === 'spend'
      && entry.resident_id === actorId
      && entry.request_id === requestId)
    if (!spend) {
      spend = fixtureState.current.cityCreditEntries.find(entry => {
        if (entry.entry_kind !== 'spend' || entry.payment_attempt_id == null) return false
        const attempt = fixtureState.current.paymentAttempts.get(entry.payment_attempt_id)
        return attempt?.operation === operation
          && attempt.target_key === targetKey
          && ['settling', 'payment_pending', 'needs_review', 'completed'].includes(attempt.status)
      })
    }
    if (!spend) {
      const balance = fixtureState.current.cityCreditBalances.get(actorId) ?? 0n
      if (balance < BigInt(amountUnits)) {
        throw Object.assign(new Error('insufficient city fee credit'), { code: '23514' })
      }
      const now = '2026-08-11T00:00:00.000Z'
      const recoveryStartAt = Date.now()
      const attempt: FakePaymentAttempt = {
        public_id: newAttemptId,
        actor_id: actorId,
        counterparty_id: null,
        operation,
        target_key: targetKey,
        offer_id: null,
        asset_type: assetType,
        asset_id: assetId,
        request_hash: requestHash,
        request_json: requestJson,
        method: 'credit',
        network: null,
        token: null,
        payer_wallet: null,
        payee_wallet: null,
        amount_units: amountUnits,
        x402_nonce: null,
        x402_payload_digest: null,
        x402_valid_after: null,
        x402_valid_before: null,
        start_block: null,
        start_time: null,
        end_time: null,
        status: 'payment_pending',
        lease_owner: newLeaseOwner,
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
        recovery_started_at: new Date(recoveryStartAt).toISOString(),
        recovery_deadline_at: new Date(
          recoveryStartAt + 2 * 60 * 60 * 1000,
        ).toISOString(),
        tx_hash: null,
        finalized_block_number: null,
        finalized_block_hash: null,
        finalized_block_time: null,
        finalized_at: null,
        invalid_reason: null,
        result_json: null,
        response_status: null,
        response_json: null,
        response_body_bytes: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      }
      spend = {
        id: String(fixtureState.current.nextCityCreditEntryId),
        resident_id: actorId,
        entry_kind: 'spend',
        amount_units: amountUnits,
        founder_id: null,
        source_key: null,
        request_id: requestId,
        payment_attempt_id: newAttemptId,
        related_spend_id: null,
        reason: null,
        created_at: now,
      }
      fixtureState.current = {
        ...fixtureState.current,
        cityCreditBalances: new Map(fixtureState.current.cityCreditBalances).set(actorId, balance - BigInt(amountUnits)),
        cityCreditEntries: [...fixtureState.current.cityCreditEntries, spend],
        nextCityCreditEntryId: fixtureState.current.nextCityCreditEntryId + 1,
        paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(newAttemptId, attempt),
      }
    }
    let attempt = fixtureState.current.paymentAttempts.get(spend.payment_attempt_id!)!
    let leaseAcquired = attempt.lease_owner === newLeaseOwner
    if (attempt.status === 'payment_pending' && attempt.lease_owner == null) {
      attempt = {
        ...attempt,
        lease_owner: newLeaseOwner,
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      }
      fixtureState.current = {
        ...fixtureState.current,
        paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attempt.public_id, attempt),
      }
      leaseAcquired = true
    }
    const returned = fixtureState.current.cityCreditEntries.find(entry =>
      entry.entry_kind === 'return' && entry.related_spend_id === spend!.id)
    const responseBody = attempt.response_body_bytes?.toString('utf8') ?? null
    return [{
      state: attempt.status === 'completed'
        ? 'completed'
        : attempt.status === 'credit_returned'
          ? 'returned'
          : leaseAcquired ? 'ready' : 'busy',
      attempt_id: attempt.public_id,
      actor_id: attempt.actor_id,
      operation: attempt.operation,
      target_key: attempt.target_key,
      method: attempt.method,
      asset_type: attempt.asset_type,
      asset_id: attempt.asset_id,
      request_id: spend.request_id,
      request_hash: attempt.request_hash,
      request_json: attempt.request_json,
      amount_units: attempt.amount_units,
      spend_entry_id: spend.id,
      return_entry_id: returned?.id ?? null,
      response_status: attempt.response_status,
      response_json: attempt.response_json,
      response_body: responseBody,
      lease_acquired: leaseAcquired,
      lease_owner: leaseAcquired ? attempt.lease_owner : null,
    }]
  }
  return undefined
}
