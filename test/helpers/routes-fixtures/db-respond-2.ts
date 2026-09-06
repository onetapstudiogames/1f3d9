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

export function respondToDatabaseStage2(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {

  if (q.includes('/* city-credit:return-spend */')) {
    if (fixtureState.current.failCreditReturnOnce) {
      fixtureState.current = { ...fixtureState.current, failCreditReturnOnce: false }
      throw new Error('connection interrupted while returning city fee credit')
    }
    const actorId = Number(params[0])
    const attemptId = String(params[1])
    const leaseOwner = String(params[2])
    const reason = String(params[3])
    const responseStatus = Number(params[4])
    const response = JSON.parse(String(params[5])) as Record<string, unknown>
    const amountUnits = String(params[7])
    const attempt = fixtureState.current.paymentAttempts.get(attemptId)
    const spend = fixtureState.current.cityCreditEntries.find(entry =>
      entry.entry_kind === 'spend' && entry.payment_attempt_id === attemptId)
    if (!attempt || !spend || attempt.actor_id !== actorId) return []
    let returned = fixtureState.current.cityCreditEntries.find(entry =>
      entry.entry_kind === 'return' && entry.related_spend_id === spend.id)
    const returnCreated = returned == null
    if (!returned) {
      if (attempt.lease_owner !== leaseOwner || attempt.status !== 'payment_pending') return []
      returned = {
        id: String(fixtureState.current.nextCityCreditEntryId),
        resident_id: actorId,
        entry_kind: 'return',
        amount_units: amountUnits,
        founder_id: null,
        source_key: null,
        request_id: null,
        payment_attempt_id: attemptId,
        related_spend_id: spend.id,
        reason,
        created_at: '2026-08-11T00:00:01.000Z',
      }
      const completed: FakePaymentAttempt = {
        ...attempt,
        status: 'credit_returned',
        lease_owner: null,
        lease_expires_at: null,
        response_status: responseStatus,
        response_json: response,
        response_body_bytes: Buffer.from(JSON.stringify(response), 'utf8'),
        updated_at: '2026-08-11T00:00:01.000Z',
      }
      fixtureState.current = {
        ...fixtureState.current,
        cityCreditBalances: new Map(fixtureState.current.cityCreditBalances).set(
          actorId,
          (fixtureState.current.cityCreditBalances.get(actorId) ?? 0n) + BigInt(amountUnits),
        ),
        cityCreditEntries: [...fixtureState.current.cityCreditEntries, returned],
        nextCityCreditEntryId: fixtureState.current.nextCityCreditEntryId + 1,
        paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, completed),
      }
    }
    const completed = fixtureState.current.paymentAttempts.get(attemptId)!
    return [{
      ...completed,
      prior_return_id: returnCreated ? null : returned.id,
    }]
  }
  if (q.includes('/* city-credit:return-result */')) {
    const actorId = Number(params[0])
    const attemptId = String(params[1])
    const attempt = fixtureState.current.paymentAttempts.get(attemptId)
    const spend = fixtureState.current.cityCreditEntries.find(entry =>
      entry.entry_kind === 'spend' && entry.payment_attempt_id === attemptId)
    const returned = spend == null ? null : fixtureState.current.cityCreditEntries.find(entry =>
      entry.entry_kind === 'return' && entry.related_spend_id === spend.id)
    if (!attempt || !spend || !returned || attempt.actor_id !== actorId) return []
    return [{
      state: 'returned',
      attempt_id: attemptId,
      actor_id: actorId,
      operation: attempt.operation,
      target_key: attempt.target_key,
      request_id: spend.request_id,
      request_hash: attempt.request_hash,
      request_json: attempt.request_json,
      amount_units: attempt.amount_units,
      spend_entry_id: spend.id,
      return_entry_id: returned.id,
      response_status: attempt.response_status,
      response_json: attempt.response_json,
    }]
  }
  if (q.includes('/* private:later-holder-notice */')) {
    return [{ count: fixtureState.current.laterHolderItems.length }]
  }
  if (q.includes('/* private:later-holder-index */')) {
    const beforeMarkId = params[1] == null ? null : BigInt(String(params[1]))
    const limit = Number(params[2])
    const page = fixtureState.current.laterHolderItems
      .filter(item => beforeMarkId === null || BigInt(item.mark_id) < beforeMarkId)
      .sort((left, right) => Number(BigInt(right.mark_id) - BigInt(left.mark_id)))
      .slice(0, limit)
      .map(item => ({
        ...item, total_count: fixtureState.current.laterHolderItems.length,
      }))
    return page.length > 0
      ? page
      : [{ total_count: fixtureState.current.laterHolderItems.length }]
  }
  if (q.includes('/* private:later-holder-mark */')) {
    const thingId = Number(params[1])
    const existing = fixtureState.current.laterHolderItems.find(item => item.id === thingId)
    if (existing) return [{ thing_id: thingId, changed: false }]
    if (thingId !== 41 || fixtureState.current.thingOwnerId !== fixtureState.current.actorId || fixtureState.current.thingWithdrawn) return []
    const next: FakeLaterHolderItem = {
      mark_id: String(1 + Math.max(0, ...fixtureState.current.laterHolderItems.map(item => Number(item.mark_id)))),
      id: 41, title: 'porch lantern', place_id: 2, place_title: 'Lantern Town',
      date: '2026-08-11T00:00:00.000000Z', body_text_bytes: Buffer.byteLength('warm light'),
    }
    fixtureState.current = { ...fixtureState.current, laterHolderItems: [next, ...fixtureState.current.laterHolderItems] }
    return [{ thing_id: thingId, changed: true }]
  }
  if (q.includes('/* private:later-holder-unmark */')) {
    const thingId = Number(params[1])
    const changed = fixtureState.current.laterHolderItems.some(item => item.id === thingId)
    fixtureState.current = {
      ...fixtureState.current,
      laterHolderItems: fixtureState.current.laterHolderItems.filter(item => item.id !== thingId),
    }
    return changed ? [{ thing_id: thingId }] : []
  }

  if (q.includes('/* public:search */')) {
    return [{
      result_type: 'thing', id: 41, place_id: 2, name: 'archive_lantern',
      maker_id: 5, made_by: 'archive-smith',
      current_owner_id: 7, current_owner: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern', open_to_use: true,
      author_id: null, author: null, body_text_bytes: 19,
      created_at: '2026-08-11T00:00:00.000000Z',
      total_items: 1, total_body_bytes: '19', change_marker: fixtureState.current.publicChangeMarker,
    }]
  }
  if (q.includes('/* public:changes-checkpoint */')) {
    return [{ checkpoint: fixtureState.current.publicChangeMarker }]
  }
  const publicReadMarkerRaceNeedle = fixtureState.current.publicReadMarkerRaceNeedle
  if (fixtureState.current.publicReadMarkerRaces > 0 && (publicReadMarkerRaceNeedle
    ? q.includes(publicReadMarkerRaceNeedle)
    : [
        '/* public:map-outline */',
        '/* public:residents */',
        '/* public:resident-presence */',
        '/* public:events */',
        'from notes note',
        'from things thing',
        'from agreements agreement',
        '/* public:window-outline-totals */',
        '/* public:window-live-survey */',
      ].some(marker => q.includes(marker)))) {
    fixtureState.current = {
      ...fixtureState.current,
      publicChangeMarker: (BigInt(fixtureState.current.publicChangeMarker) + 1n).toString(),
      publicReadMarkerRaces: fixtureState.current.publicReadMarkerRaces - 1,
    }
  }
  if (q.includes('/* public:changes */')) {
    return [{
      checkpoint: fixtureState.current.publicChangeMarker, change_id: fixtureState.current.publicChangeMarker,
      kind: 'action', actor: 'tiny-lantern',
      detail: { channel: 'public' }, created_at: '2026-08-11T00:00:09.000Z',
    }]
  }
  if (q.includes('/* public:window-live-survey */')) {
    const places = fixtureState.current.scenario === 'window outline'
      ? [mapOutlineParent(1), ...mapOutlineRows().sort((left, right) => left.id - right.id)]
      : [placeRow(1, null), placeRow(2, 1), placeRow(3, 1)]
    return places.map(place => ({
      id: place.id,
      parent_id: place.parent_id,
      things: place.things,
      notes: place.notes,
    }))
  }

  // Once the action resolution committed, every later presence read breaks.
  if (fixtureState.current.scenario === 'post-action observation failure'
    && fixtureState.current.actionResolved && q.includes('resident_presence')) {
    throw Object.assign(
      new Error('connection reset while re-reading presence'),
      { code: '57P01' },
    )
  }

  if (q.includes('/* payment-attempts:find-operation */')) {
    const row = [...fixtureState.current.paymentAttempts.values()].reverse().find(attempt =>
      attempt.actor_id === Number(params[0])
      && attempt.operation === String(params[1])
      && attempt.offer_id === Number(params[2]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:response-replay-ready */')) {
    return [{ ready: fixtureState.current.paymentReplaySchemaReady }]
  }
  if (q.includes('/* payment-attempts:find-replayable-target */')) {
    const row = [...fixtureState.current.paymentAttempts.values()].reverse().find(attempt =>
      attempt.actor_id === Number(params[0])
      && attempt.operation === String(params[1])
      && attempt.target_key === String(params[2])
      && ['settling', 'payment_pending', 'needs_review', 'completed'].includes(attempt.status))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:find */')) {
    const targetKey = params[0] == null ? null : String(params[0])
    const operation = String(params[1])
    const nonce = params[2] == null ? null : String(params[2]).toLowerCase()
    const network = params[3] == null ? null : String(params[3])
    const token = params[4] == null ? null : String(params[4]).toLowerCase()
    const payerWallet = params[5] == null ? null : String(params[5]).toLowerCase()
    const row = [...fixtureState.current.paymentAttempts.values()].reverse().find(attempt =>
      ['settling', 'payment_pending', 'needs_review', 'completed'].includes(attempt.status) && (
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
  if (q.includes('/* payment-attempts:create */')) {
    const key = String(params[0])
    const next = new Map(fixtureState.current.paymentAttempts)
    const conflict = [...next.values()].some(attempt =>
      ['settling', 'payment_pending', 'needs_review', 'completed'].includes(attempt.status) && (
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
      counterparty_id: params[2] == null ? null : Number(params[2]),
      operation: String(params[3]),
      target_key: params[4] == null ? null : String(params[4]),
      offer_id: params[5] == null ? null : Number(params[5]),
      asset_type: params[6] == null ? null : String(params[6]),
      asset_id: params[7] == null ? null : Number(params[7]),
      request_hash: String(params[8]),
      request_json: JSON.parse(String(params[9])) as Record<string, unknown>,
      method: params[10] == null ? null : String(params[10]),
      network: params[11] == null ? null : String(params[11]),
      token: params[12] == null ? null : String(params[12]).toLowerCase(),
      payer_wallet: params[13] == null ? null : String(params[13]).toLowerCase(),
      payee_wallet: params[14] == null ? null : String(params[14]).toLowerCase(),
      amount_units: params[15] == null ? null : String(params[15]),
      x402_nonce: params[16] == null ? null : String(params[16]).toLowerCase(),
      x402_payload_digest: params[17] == null ? null : String(params[17]).toLowerCase(),
      x402_valid_after: params[18] == null ? null : String(params[18]),
      x402_valid_before: params[19] == null ? null : String(params[19]),
      start_block: params[20] == null ? null : String(params[20]),
      start_time: params[21] == null ? null : String(params[21]),
      end_time: params[22] == null ? null : String(params[22]),
      status: 'settling' as const,
      lease_owner: null,
      lease_expires_at: null,
      recovery_started_at: null,
      recovery_deadline_at: null,
      tx_hash: null,
      finalized_block_number: null,
      finalized_block_hash: null,
      finalized_block_time: null,
      finalized_at: null,
      invalid_reason: null,
      result_json: null,
      response_status: null,
      response_json: null,
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-11T00:00:00.000Z',
      completed_at: null,
    }
    next.set(key, row)
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...row }]
  }
  if (q.includes('/* payment-attempts:lease */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (
      !current || current.actor_id !== Number(params[1])
      || !['settling', 'payment_pending', 'needs_review'].includes(current.status)
      || (
        current.lease_owner != null
        && current.lease_expires_at != null
        && new Date(current.lease_expires_at).getTime() > Date.now()
      )
    ) return []
    const updated: FakePaymentAttempt = {
      ...current,
      lease_owner: String(params[2]),
      lease_expires_at: new Date(Date.now() + Number(params[3])).toISOString(),
      updated_at: new Date().toISOString(),
    }
    const next = new Map(fixtureState.current.paymentAttempts).set(key, updated)
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:lease-read */')) {
    const row = fixtureState.current.paymentAttempts.get(String(params[0]))
    return row?.actor_id === Number(params[1]) ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:bind-evidence */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const recoveryStartAt = fixtureState.current.scenario === 'treasury deadline passed'
      ? Date.now() - 2 * 60 * 60 * 1000
      : Date.now()
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'payment_pending',
      tx_hash: current.tx_hash ?? String(params[2]).toLowerCase(),
      finalized_block_number: current.finalized_block_number ?? (params[3] == null ? null : String(params[3])),
      finalized_block_hash: current.finalized_block_hash ?? (params[4] == null ? null : String(params[4]).toLowerCase()),
      finalized_block_time: current.finalized_block_time ?? (params[5] == null ? null : String(params[5])),
      finalized_at: current.finalized_at ?? (params[6] == null ? null : String(params[6])),
      recovery_started_at: current.recovery_started_at ?? new Date(recoveryStartAt).toISOString(),
      recovery_deadline_at: current.recovery_deadline_at ?? new Date(
        recoveryStartAt + 2 * 60 * 60 * 1000,
      ).toISOString(),
      response_json: current.response_json ?? (params[7] == null ? null : {
        __1f3d9_x402_response_v1: { header: String(params[7]) },
      }),
      updated_at: new Date().toISOString(),
    }
    const next = new Map(fixtureState.current.paymentAttempts).set(key, updated)
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:evidence-read */')) {
    const row = fixtureState.current.paymentAttempts.get(String(params[0]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:release-lease */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    const next = new Map(fixtureState.current.paymentAttempts).set(key, updated)
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:release-lease-read */')) {
    const row = fixtureState.current.paymentAttempts.get(String(params[0]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:invalidate */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'invalid',
      invalid_reason: String(params[2]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    const next = new Map(fixtureState.current.paymentAttempts).set(key, updated)
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:needs-review */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'needs_review',
      invalid_reason: String(params[2]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    const next = new Map(fixtureState.current.paymentAttempts).set(key, updated)
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:founder-review */')) {
    if (fixtureState.current.failFounderReviewOnce) {
      fixtureState.current = { ...fixtureState.current, failFounderReviewOnce: false }
      throw paidCompletionError({
        code: '57P01',
        message: 'connection interrupted while recording founder review',
      })
    }
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (
      !current
      || current.lease_owner !== String(params[1])
      || !['settling', 'payment_pending', 'needs_review'].includes(current.status)
    ) return []
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'founder_review',
      invalid_reason: current.invalid_reason ?? String(params[2]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    fixtureState.current = {
      ...fixtureState.current,
      paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(key, updated),
    }
    return [{ ...updated }]
  }
  if (
    q.includes('/* payment-attempts:invalidate-read */')
    || q.includes('/* payment-attempts:needs-review-read */')
    || q.includes('/* payment-attempts:founder-review-read */')
  ) {
    const row = fixtureState.current.paymentAttempts.get(String(params[0]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:legacy-settled */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (!current) return []
    const next = new Map(fixtureState.current.paymentAttempts)
    next.set(key, {
      ...current,
      status: current.status === 'completed' ? 'completed' : 'payment_pending',
      tx_hash: current.tx_hash ?? String(params[1]).toLowerCase(),
      updated_at: '2026-08-11T00:00:01.000Z',
    })
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...next.get(key)! }]
  }
  if (q.includes('/* payment-attempts:legacy-completed */')) {
    const key = String(params[0])
    const current = fixtureState.current.paymentAttempts.get(key)
    if (!current) return []
    const next = new Map(fixtureState.current.paymentAttempts)
    next.set(key, {
      ...current,
      status: 'completed',
      tx_hash: current.tx_hash ?? String(params[1]).toLowerCase(),
      result_json: {
        completion_kind: String(params[2]),
        completion_id: Number(params[3]),
        completion_revision: params[4] == null ? null : Number(params[4]),
      },
      completed_at: '2026-08-11T00:00:02.000Z',
      updated_at: '2026-08-11T00:00:02.000Z',
    })
    fixtureState.current = { ...fixtureState.current, paymentAttempts: next }
    return [{ ...next.get(key)! }]
  }
  return undefined
}
