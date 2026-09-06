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

export function respondToDatabaseStage8(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {

  if (q.includes('from transfer_offers') && !q.includes('from things thing') && !q.includes('update things')) {
    const directOnlyWorld = q.includes("o.channel = 'direct'") && fixtureState.current.offer.channel === 'world'
    const openOnly = q.includes("status = 'open'")
    return !directOnlyWorld && (!openOnly || fixtureState.current.offer.status === 'open') ? [{
    id: fixtureState.current.offer.id,
    type: 'thing',
    asset_id: 41,
    owner_id: 7,
    seller_id: 7,
    seller: 'tiny-lantern',
    buyer_id: 8,
    buyer: 'neighbor',
    price_usdc: 2,
    seller_wallet: SELLER_WALLET,
    status: fixtureState.current.offer.status,
    reserved_by: fixtureState.current.offer.reservedUntil ? 8 : null,
    reserved_at: fixtureState.current.offer.reservedAt,
    reserved_until: fixtureState.current.offer.reservedUntil,
    buyer_wallet: fixtureState.current.offer.buyerWallet,
    created_at: '2026-08-11T00:00:00.000Z',
    }] : []
  }

  if (q.includes('update things set withdrawn_at')) {
    const target = Number(params.find(value => [41, 42].includes(Number(value))) ?? 41)
    if (target === 41 && fixtureState.current.actorId === fixtureState.current.thingOwnerId && !fixtureState.current.thingWithdrawn) {
      fixtureState.current = { ...fixtureState.current, thingWithdrawn: true }
      return [{ id: 41, withdrawn_at: '2026-08-11T00:02:00.000Z' }]
    }
    if (target === 42 && !fixtureState.current.targetThingWithdrawn) {
      fixtureState.current = { ...fixtureState.current, targetThingWithdrawn: true }
      return [{ id: 42 }]
    }
    return []
  }
  if (q.includes('update things set owner_id')) {
    const target = q.includes('from recipient')
      ? Number(params[1] ?? 0)
      : Number(params[1] ?? 0)
    const toOwner = q.includes('from recipient')
      ? Number(params[2] ?? fixtureState.current.actorId)
      : Number(params[0] ?? fixtureState.current.actorId)
    if (target === 42 && !fixtureState.current.targetThingWithdrawn) {
      fixtureState.current = { ...fixtureState.current, targetThingOwnerId: toOwner }
      return [{ id: 42 }]
    }
    if (target === 41 && !fixtureState.current.thingWithdrawn) {
      fixtureState.current = { ...fixtureState.current, thingOwnerId: toOwner }
      return [{ id: 41 }]
    }
    return []
  }
  if (q.includes('insert into things')) return [thingRow()]
  if (q.includes('update things set')) {
    if (q.includes('current_revision')) {
      fixtureState.current = { ...fixtureState.current, thingCurrentRevision: fixtureState.current.kindRevision }
    }
    if (q.includes('open_to_use')) {
      const requested = params.find(value => value === true || value === false || value === 'true' || value === 'false')
      if (requested != null) fixtureState.current = { ...fixtureState.current, thingOpenToUse: String(requested) === 'true' }
    }
    return fixtureState.current.actorId === fixtureState.current.thingOwnerId && !fixtureState.current.thingWithdrawn ? [thingRow()] : []
  }
  if (q.includes('select owner_id from things')) {
    const target = Number(params[0] ?? 41)
    return [{ owner_id: target === 41 ? fixtureState.current.thingOwnerId : fixtureState.current.targetThingOwnerId }]
  }
  if (q.includes('select thing.id, thing.owner_id, thing.place_id')) {
    const target = Number(params[0] ?? 41)
    const targetIsSource = target === 41
    return [{
      id: target,
      owner_id: targetIsSource ? fixtureState.current.thingOwnerId : fixtureState.current.targetThingOwnerId,
      place_id: targetIsSource ? 2 : fixtureState.current.targetThingPlaceId,
      kind_id: targetIsSource ? 3 : fixtureState.current.targetThingKindId,
      withdrawn_at: targetIsSource
        ? (fixtureState.current.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
        : (fixtureState.current.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null),
      active_offer_id: null,
      has_open_offer: false,
      open_to_use: targetIsSource ? fixtureState.current.thingOpenToUse : fixtureState.current.targetThingOpenToUse,
      traits: fixtureState.current.kindTraitNames,
    }]
  }
  if (q.includes('from things') && !q.includes('update places set')) {
    if (q.includes('where thing.id') || q.includes('where id =')) {
      const target = Number(params[0] ?? 41)
      if (target === 41) {
        if (fixtureState.current.thingWithdrawn && q.includes('withdrawn_at is null')) return []
        return [thingRow(41)]
      }
      if (target === 42) {
        if (fixtureState.current.targetThingWithdrawn && q.includes('withdrawn_at is null')) return []
        return [thingRow(42)]
      }
    }
    const rows: Record<string, unknown>[] = []
    if (!fixtureState.current.thingWithdrawn) rows.push(thingRow(41))
    if (!fixtureState.current.targetThingWithdrawn) rows.push(thingRow(42))
    return rows
  }

  if (q.includes('/* public:residents */')) return [residentRow(), {
    ...residentRow(), id: 8, handle: 'neighbor', joined_at: '2026-08-11T00:01:00.000Z',
  }].map(row => ({ ...row, total_items: 2, total_text_bytes: 0 }))
  if (q.includes('from residents')) return [residentRow(), {
    ...residentRow(), id: 8, handle: 'neighbor', joined_at: '2026-08-11T00:01:00.000Z',
  }]
  if (q.includes('from events') && q.includes('count(')) return [{ n: 0 }]
  if (q.includes('/* public:treasury-fees */')) return [{
    id: 1,
    amount_usdc: 1,
    tx_hash: TX1,
    handle: 'tiny-lantern',
    purpose: 'kind',
    created_at: '2026-08-11T00:00:00.000Z',
    collected: 1,
    n: 1,
    total_items: 1,
    total_text_bytes: 4,
  }]
  if (q.includes('sum(') && (q.includes('fees') || q.includes('payment_uses'))) return [{ collected: 1, n: 1 }]
  if (q.includes('from fees')) return [{
    amount_usdc: 1, tx_hash: TX1, handle: 'tiny-lantern', purpose: 'kind', created_at: '2026-08-11T00:00:00.000Z',
  }]

  if (q.includes('insert into events') || q.includes('insert into flags') || q.includes('insert into payment_uses')) return []
  if (q.startsWith('delete from reg_log')) return []
  return undefined
}
