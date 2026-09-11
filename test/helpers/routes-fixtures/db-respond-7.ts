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

export function respondToDatabaseStage7(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {

  // Event reads name things and notes inside their EXISTS place guards, so
  // they must dispatch on their distinctive SELECT list before the generic
  // notes/things branches can swallow them.
  if (q.includes('select id, at, kind, actor, detail') ||
      q.includes('select at, kind, actor, detail') ||
      q.includes('/* public:events */') ||
      q.includes('/* public:window-events */')) {
    const withEventTotals = (
      page: readonly Record<string, unknown>[],
      all: readonly Record<string, unknown>[],
    ): Record<string, unknown>[] => {
      if (!q.includes('/* public:events */')) return [...page]
      const totalTextBytes = all.reduce((total, event) => {
        const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
          ? event.detail as Record<string, unknown>
          : {}
        return total + ['body', 'description', 'reason'].reduce((subtotal, field) => (
          subtotal + Buffer.byteLength(typeof detail[field] === 'string' ? detail[field] as string : '', 'utf8')
        ), 0)
      }, 0)
      const metadata = { total_items: all.length, total_text_bytes: totalTextBytes }
      return page.length > 0
        ? page.map(event => ({ ...event, ...metadata }))
        : [{ id: null, ...metadata }]
    }
    if (fixtureState.current.scenario === 'public pagination') {
      const kind = params[0] == null ? null : String(params[0])
      const actor = params[1] == null ? null : String(params[1])
      const placeId = params[2] == null ? null : Number(params[2])
      const matching = paginationEvents().filter(event => {
        const detail = event.detail as Record<string, unknown>
        return (kind == null || event.kind === kind) &&
          (actor == null || event.actor === actor) &&
          (placeId == null ||
            Number(detail.place_id) === placeId ||
            Number(detail.from_place_id) === placeId ||
            Number(detail.to_place_id) === placeId)
      })
      return withEventTotals(descendingPage(matching, params[3], params[4]), matching)
    }
    if (fixtureState.current.scenario === 'event pagination') {
      const beforeId = params[3] == null ? null : Number(params[3])
      const limit = q.includes('limit $5') ? Number(params[4]) : 200
      const all = [205, 204, 203, 202, 201].map(id => ({
          id,
          at: new Date(Date.UTC(2026, 7, 11, 0, 0, id - 200)).toISOString(),
          kind: 'note',
          actor: 'tiny-lantern',
          detail: { note_id: id, place_id: 2 },
        }))
      const page = all
        .filter(event => beforeId == null || event.id < beforeId)
        .slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 200)
      return withEventTotals(page, all)
    }
    if (fixtureState.current.scenario === 'activity surfaces') {
      const all = [
      {
        id: 70, at: '2026-08-11T00:00:00.000Z', kind: 'place_created',
        actor: 'tiny-lantern', detail: { place_id: 2 },
      },
      {
        id: 71, at: '2026-08-11T00:01:00.000Z', kind: 'sale',
        actor: 'neighbor', detail: { transfer_id: 5 },
      },
      {
        id: 72, at: '2026-08-11T00:02:00.000Z', kind: 'transfer_cancel',
        actor: 'tiny-lantern', detail: { offer_id: 90 },
      },
      {
        id: 73, at: '2026-08-11T00:03:00.000Z', kind: 'world_sale',
        actor: 'neighbor', detail: { transfer_id: 6, offer_id: 91, thing_id: 9 },
      },
      ]
      return withEventTotals(all, all)
    }
    if (fixtureState.current.scenario === 'nested moderation events') {
      const all = [
      {
        id: 80, at: '2026-08-11T00:06:00.000Z', kind: 'laws_changed',
        actor: 'tiny-lantern', detail: { place_id: 2, traits: ['quiet-hours', 'safe-trait'] },
      },
      {
        id: 83, at: '2026-08-11T00:09:00.000Z', kind: 'place_renamed',
        actor: 'tiny-lantern', detail: {
          place_id: 2, name: 'new unsafe name', former_name: 'old unsafe name',
        },
      },
      {
        id: 81, at: '2026-08-11T00:07:00.000Z', kind: 'kind_invented',
        actor: 'tiny-lantern', detail: {
          kind_id: 3,
          name: 'lantern',
          traits: ['glowing', 'safe-trait'],
          recipe: [{ kind: 'banned-material', quantity: 1 }, { kind: 'safe-material', quantity: 2 }],
        },
      },
      {
        id: 82, at: '2026-08-11T00:08:00.000Z', kind: 'kind_revised',
        actor: 'neighbor', detail: {
          kind_id: 9,
          name: 'safe-tool',
          traits: ['glowing', 'safe-trait'],
          recipe: [{ kind: 'banned-material', quantity: 1 }, { kind: 'safe-material', quantity: 2 }],
        },
      },
      ]
      return withEventTotals(all, all)
    }
    const all = [{
      id: 70,
      at: '2026-08-11T00:00:00.000Z',
      kind: 'register',
      actor: 'tiny-lantern',
      detail: { resident_id: 7 },
    }]
    return withEventTotals(all, all)
  }
  if (q.includes('from notes')) {
    if (fixtureState.current.scenario === 'busy place') {
      const beforeId = params[1] == null ? null : Number(params[1])
      const descending = q.includes('order by n.id desc')
      const limit = q.includes('limit $') ? Number(params.at(-1)) : 200
      const rows = Array.from({ length: 205 }, (_, index) => ({
        id: index + 1,
        place_id: 2,
        author: 'tiny-lantern',
        body: `note ${index + 1}`,
        created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index + 1)).toISOString(),
        pinned: false,
      })).filter(note => beforeId == null || note.id < beforeId)
      if (descending) rows.reverse()
      return rows.slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 200)
    }
    return [{
      id: 51,
      place_id: 2,
      author: 'tiny-lantern',
      body: fixtureState.current.noteBody,
      created_at: '2026-08-11T00:00:00.000Z',
      pinned: fixtureState.current.notePinned,
    }]
  }

  if (q.includes('insert into agreement_accession_openings')) return []
  if (q.includes('insert into agreements')) return [{
    id: 61, body: 'we keep the square open', created_by: fixtureState.current.actorHandle, status: 'open',
  }]
  if (q.includes('insert into agreement_parties')) return []
  if (q.includes('insert into agreement_signatures')) return [{
    agreement_id: 61, handle: fixtureState.current.actorHandle, signed_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('as created_by_me') && q.includes('from agreements')) return [{
    id: 61,
    body: 'we keep the square open',
    created_by_me: true,
    acceded: false,
    accession_open: fixtureState.current.agreementAccessionOpen,
    signed: false,
    created_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('/* public:agreements */')) {
    const row = {
      id: 61,
      body: 'we keep the square open',
      created_by: fixtureState.current.actorHandle,
      parties: fixtureState.current.agreementParties,
      acceded: fixtureState.current.agreementAcceded,
      signatures: ['tiny-lantern'],
      accession_open: fixtureState.current.agreementAccessionOpen,
      open: true,
      created_at: '2026-08-11T00:00:00.000Z',
    }
    return fixtureState.current.agreementExists
      ? [{
          ...row,
          total_items: 1,
          total_text_bytes: Buffer.byteLength(row.body, 'utf8'),
        }]
      : [{ id: null, total_items: 0, total_text_bytes: 0 }]
  }
  if (q.includes('from agreements')) return fixtureState.current.agreementExists ? [{
    id: 61,
    created_by_id: fixtureState.current.agreementCreatorId,
    body: 'we keep the square open',
    parties: fixtureState.current.agreementParties,
    acceded: fixtureState.current.agreementAcceded,
    signatures: ['tiny-lantern'],
    accession_open: fixtureState.current.agreementAccessionOpen,
    opened_at: fixtureState.current.agreementAccessionOpen ? '2026-08-11T00:00:00.000Z' : null,
    already_signed: fixtureState.current.scenario === 'agreement replay',
    signature_acceded: fixtureState.current.agreementAcceded.includes(fixtureState.current.actorHandle),
    signed_at: fixtureState.current.scenario === 'agreement replay' ? '2026-08-10T23:59:00.000Z' : null,
    open: true,
    created_at: '2026-08-11T00:00:00.000Z',
  }] : []
  if (q.includes('from agreement_parties')) return []

  if (q.includes('insert into transfer_offers')) {
    fixtureState.current = { ...fixtureState.current, offer: { ...fixtureState.current.offer, status: 'open' } }
    return [{
      id: fixtureState.current.offer.id,
      type: 'thing',
      asset_id: 41,
      seller: 'tiny-lantern',
      buyer: 'neighbor',
      price_usdc: 2,
      seller_wallet: SELLER_WALLET,
      status: fixtureState.current.offer.status,
      reserved_at: fixtureState.current.offer.reservedAt,
      reserved_until: fixtureState.current.offer.reservedUntil,
      buyer_wallet: fixtureState.current.offer.buyerWallet,
      created_at: '2026-08-11T00:00:00.000Z',
    }]
  }
  if (q.includes('select thing.id, thing.name, thing.owner_id, thing.withdrawn_at') &&
      q.includes('left join transfer_offers')) {
    return [{
      id: 41,
      name: 'paper lantern',
      owner_id: fixtureState.current.thingOwnerId,
      withdrawn_at: fixtureState.current.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null,
      active_offer_id: fixtureState.current.offer.status === 'open' ? fixtureState.current.offer.id : null,
      has_open_offer: fixtureState.current.offer.status === 'open',
    }]
  }
  if (q.includes('select thing.id, thing.owner_id') && q.includes('thing.active_offer_id') &&
      q.includes('left join transfer_offers')) {
    return fixtureState.current.thingWithdrawn ? [] : [{
      ...thingRow(41),
      active_offer_id: fixtureState.current.offer.status === 'open' ? fixtureState.current.offer.id : null,
      has_open_offer: fixtureState.current.offer.status === 'open',
    }]
  }
  if (q.includes('reserved_until') && q.includes('update transfer_offers') && !q.includes("status = 'claimed'")) {
    const reservedAt = new Date(Date.now() - 2_000).toISOString()
    const reservedUntil = new Date(Date.parse(reservedAt) + 5 * 60_000).toISOString()
    const buyerWallet = String(params.find(value =>
      typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && value !== SELLER_WALLET
    ) ?? BUYER_WALLET).toLowerCase()
    fixtureState.current = { ...fixtureState.current, offer: { ...fixtureState.current.offer, reservedAt, reservedUntil, buyerWallet } }
    return [{
      id: fixtureState.current.offer.id,
      reserved_by: fixtureState.current.actorId,
      reserved_at: reservedAt,
      reserved_until: reservedUntil,
      buyer_wallet: buyerWallet,
    }]
  }
  if (q.includes('update transfer_offers') && q.includes('cancel')) {
    const reservationIsActive = fixtureState.current.offer.reservedUntil != null && Date.parse(fixtureState.current.offer.reservedUntil) > Date.now()
    if (reservationIsActive || fixtureState.current.offer.status !== 'open') return []
    fixtureState.current = { ...fixtureState.current, offer: { ...fixtureState.current.offer, status: 'canceled' } }
    return [{ id: fixtureState.current.offer.id, status: 'canceled' }]
  }
  if (q.includes('update transfer_offers') && (q.includes('claim') || q.includes('closed'))) {
    if (fixtureState.current.offer.status !== 'open') return []
    fixtureState.current = { ...fixtureState.current, offer: { ...fixtureState.current.offer, status: 'claimed' } }
    const createdAt = '2026-08-11T00:00:00.000Z'
    const responseBody = JSON.stringify({
      offer: { id: fixtureState.current.offer.id, status: 'claimed' },
      transfer: {
        id: 91,
        type: String(params[3] ?? 'thing'),
        asset_id: Number(params[4] ?? 41),
        from: String(params[10] ?? 'tiny-lantern'),
        to: String(params[9] ?? fixtureState.current.actorHandle),
        price_usdc: Number(params[5] ?? 2),
        tx_hash: String(params[7] ?? TX1).toLowerCase(),
        created_at: createdAt,
      },
    })
    if (q.includes('complete_payment_attempt')) {
      const attemptId = String(params[16])
      const attempt = fixtureState.current.paymentAttempts.get(attemptId)
      if (attempt) {
        const durable = attempt.response_json?.__1f3d9_x402_response_v1
        const header = durable && typeof durable === 'object' && !Array.isArray(durable)
          ? String((durable as Record<string, unknown>).header ?? '')
          : ''
        const completed: FakePaymentAttempt = {
          ...attempt,
          status: 'completed',
          lease_owner: null,
          lease_expires_at: null,
          result_json: { kind: 'transfer_offer', id: fixtureState.current.offer.id },
          response_status: 200,
          response_json: {
            __1f3d9_x402_response_v1: {
              ...(header ? { header } : {}),
              body: JSON.parse(responseBody) as Record<string, unknown>,
            },
          },
          response_body_bytes: Buffer.from(responseBody, 'utf8'),
          updated_at: createdAt,
          completed_at: createdAt,
        }
        fixtureState.current = {
          ...fixtureState.current,
          paymentAttempts: new Map(fixtureState.current.paymentAttempts).set(attemptId, completed),
        }
      }
    }
    return [{
      id: fixtureState.current.offer.id,
      status: 'claimed',
      new_owner: fixtureState.current.actorHandle,
      ...(q.includes('complete_payment_attempt') ? {
        transfer_id: 91,
        created_at: createdAt,
        response_body: responseBody,
      } : {}),
    }]
  }
  return undefined
}
