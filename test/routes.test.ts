// One fake isolates Neon, Base JSON-RPC, and the x402 facilitator.
// No live database, wallet, payment, deployment, or network service is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PUBLIC_PAGE_DEFAULT,
  PUBLIC_PAGE_MAX,
  finalizePublicPage,
  parsePublicPage,
} from '../src/public-pagination.ts'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.BASE_RPC_URL = 'https://base-rpc.test'
process.env.FACILITATOR_URL = 'https://facilitator.test'

const TREASURY = process.env.TREASURY_ADDRESS
const SELLER_WALLET = '0x1111111111111111111111111111111111111111'
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const STRANGER_WALLET = '0x3333333333333333333333333333333333333333'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SECRET = '1f3d9_sk_' + 'ab'.repeat(24)
const OTHER_SECRET = '1f3d9_sk_' + 'cd'.repeat(24)
const TX1 = '0x' + '11'.repeat(32)
const TX2 = '0x' + '22'.repeat(32)
const TX_CASE_UPPER = '0x' + 'AB'.repeat(32)
const AUTHORIZATION_NOW = Math.floor(Date.now() / 1000)
function xPayment(
  payer: string,
  payee: string,
  amountUnits: number,
  nonceDigit: string,
): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0x' + 'ef'.repeat(65),
      authorization: {
        from: payer,
        to: payee,
        value: String(amountUnits),
        validAfter: String(AUTHORIZATION_NOW - 120),
        validBefore: String(AUTHORIZATION_NOW + 3600),
        nonce: '0x' + nonceDigit.repeat(32),
      },
    },
  }), 'utf8').toString('base64')
}
const X_PAYMENT = xPayment(SELLER_WALLET, TREASURY, 1_000_000, 'aa')
const X_PAYMENT_NO_ID = xPayment(SELLER_WALLET, TREASURY, 1_000_000, 'bb')
const SALE_X_PAYMENT = xPayment(BUYER_WALLET, SELLER_WALLET, 2_000_000, 'cc')
const STRANGER_SALE_X_PAYMENT = xPayment(STRANGER_WALLET, SELLER_WALLET, 2_000_000, 'dd')

interface DbCall { url: string; query?: string; params?: unknown[] }
interface OfferState {
  id: number
  channel?: 'direct' | 'world'
  status: 'open' | 'canceled' | 'claimed'
  reservedAt?: string | null
  reservedUntil: string | null
  buyerWallet?: string | null
}
interface FakePaymentAttempt {
  public_id: string
  actor_id: number
  counterparty_id: number | null
  operation: string
  target_key: string | null
  offer_id: number | null
  asset_type: string | null
  asset_id: number | null
  request_hash: string
  method: string | null
  network: string | null
  token: string | null
  payer_wallet: string | null
  payee_wallet: string | null
  amount_units: string | null
  x402_nonce: string | null
  x402_payload_digest: string | null
  x402_valid_after: string | null
  x402_valid_before: string | null
  start_block: string | null
  start_time: string | null
  end_time: string | null
  status: 'settling' | 'payment_pending' | 'completed' | 'invalid' | 'expired' | 'needs_review'
  lease_owner: string | null
  lease_expires_at: string | null
  tx_hash: string | null
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  invalid_reason: string | null
  result_json: Record<string, unknown> | null
  response_status: number | null
  response_json: Record<string, unknown> | null
  response_body_bytes?: Buffer | null
  created_at: string
  updated_at: string
  completed_at: string | null
}
type LawRecipe = Record<string, unknown>
interface FakeState {
  scenario: string
  calls: DbCall[]
  authValid: boolean
  actorId: number
  actorHandle: string
  currentPlaceId: number | null
  homePlaceId: number | null
  placeOwnerId: number
  openToBuilding: boolean
  openToThings: boolean
  openToNotes: boolean
  quota: { things: boolean; notes: boolean; agreements: boolean }
  agreementParties: string[]
  agreementAcceded: string[]
  agreementAccessionOpen: boolean
  agreementCreatorId: number
  agreementExists: boolean
  thingOwnerId: number
  thingOpenToUse: boolean
  thingWithdrawn: boolean
  targetThingOwnerId: number
  targetThingWithdrawn: boolean
  kindOwnerId: number
  kindRevision: number
  kindRecipe: unknown
  traitHasRecipe: boolean
  kindTraitNames: string[]
  thingTraitRecipe: unknown
  lawTraitName: string
  lawTraitRecipe: LawRecipe | null
  placeLawNames: string[]
  actorLabels: string[]
  placeLabels: string[]
  actionBlocked: boolean
  damageAllowed: boolean
  scheduledLabelAt: number | null
  pendingResolved: boolean
  noteRemoved: boolean
  notePinned: boolean
  moderatedKindIds: number[]
  moderatedKindNames: string[]
  moderatedTraitIds: number[]
  moderatedTraitNames: string[]
  offer: OfferState
  chainFrom: string
  chainTo: string
  chainAgeSeconds: number
  paymentHashes: Set<string>
  paymentAttempts: Map<string, FakePaymentAttempt>
  facilitatorVerify: boolean
  facilitatorSettle: boolean
  anonymousFlagsUsed: number
  failPaidWriteOnce: boolean
}

const initialState = (): FakeState => ({
  scenario: '',
  calls: [],
  authValid: true,
  actorId: 7,
  actorHandle: 'tiny-lantern',
  currentPlaceId: 2,
  homePlaceId: 3,
  placeOwnerId: 7,
  openToBuilding: false,
  openToThings: false,
  openToNotes: false,
  quota: { things: true, notes: true, agreements: true },
  agreementParties: ['tiny-lantern', 'neighbor'],
  agreementAcceded: [],
  agreementAccessionOpen: false,
  agreementCreatorId: 7,
  agreementExists: true,
  thingOwnerId: 7,
  thingOpenToUse: false,
  thingWithdrawn: false,
  targetThingOwnerId: 8,
  targetThingWithdrawn: false,
  kindOwnerId: 7,
  kindRevision: 1,
  kindRecipe: [],
  traitHasRecipe: false,
  kindTraitNames: ['glowing'],
  thingTraitRecipe: null,
  lawTraitName: 'quiet-hours',
  lawTraitRecipe: null,
  placeLawNames: [],
  actorLabels: [],
  placeLabels: [],
  actionBlocked: false,
  damageAllowed: false,
  scheduledLabelAt: null,
  pendingResolved: false,
  noteRemoved: false,
  notePinned: false,
  moderatedKindIds: [],
  moderatedKindNames: [],
  moderatedTraitIds: [],
  moderatedTraitNames: [],
  offer: { id: 90, status: 'canceled', reservedAt: null, reservedUntil: null, buyerWallet: null },
  chainFrom: SELLER_WALLET,
  chainTo: TREASURY,
  chainAgeSeconds: 60,
  paymentHashes: new Set<string>(),
  paymentAttempts: new Map(),
  facilitatorVerify: false,
  facilitatorSettle: false,
  anonymousFlagsUsed: 0,
  failPaidWriteOnce: false,
})

let state = initialState()

const residentRow = () => ({
  id: state.actorId,
  handle: state.actorHandle,
  model: 'openai-codex',
  joined_at: '2026-08-11T00:00:00.000Z',
  quota_day: '2026-08-11',
  current_place_id: state.currentPlaceId,
  home_place_id: state.homePlaceId,
  things_today: state.quota.things ? 0 : 20,
  notes_today: state.quota.notes ? 0 : 50,
  agreement_actions_today: state.quota.agreements ? 0 : 5,
})

const placeRow = (id = 2, parentId: number | null = 1) => ({
  id,
  parent_id: parentId,
  name: id === 1 ? 'First Continent' : id === 2 ? 'Lantern Town' : 'Small Plot',
  description: 'a place made from words',
  owner_id: id === 3 ? state.actorId : state.placeOwnerId,
  owner: id === 3 ? state.actorHandle : 'founder',
  open_to_building: state.openToBuilding,
  open_to_things: state.openToThings,
  open_to_notes: state.openToNotes,
  places: id === 1 ? 1 : 0,
  things: id === 2 && !state.thingWithdrawn ? (state.targetThingWithdrawn ? 1 : 2) : 0,
  notes: state.noteRemoved ? 0 : 1,
  created_at: '2026-08-11T00:00:00.000Z',
})

const kindRow = () => ({
  id: 3,
  name: 'lantern',
  owner_id: state.kindOwnerId,
  owner: 'tiny-lantern',
  revision: state.kindRevision,
  current_revision: state.kindRevision,
  description: state.kindRevision === 1 ? 'a small light' : 'a small dependable light',
  traits: state.kindTraitNames,
  recipe: state.kindRecipe,
  created_at: '2026-08-11T00:00:00.000Z',
})

const thingRow = (id = 41) => ({
  id,
  place_id: 2,
  name: id === 41 ? 'porch lantern' : 'neighbor chest',
  body: id === 41 ? 'warm light' : 'locked shut',
  owner_id: id === 41 ? state.thingOwnerId : state.targetThingOwnerId,
  owner: id === 41
    ? (state.thingOwnerId === state.actorId ? state.actorHandle : 'founder')
    : (state.targetThingOwnerId === state.actorId ? state.actorHandle : 'neighbor'),
  open_to_use: id === 41 ? state.thingOpenToUse : false,
  kind_id: 3,
  kind: 'lantern',
  birth_revision: 1,
  current_revision: state.kindRevision,
  withdrawn_at: id === 41
    ? (state.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
    : (state.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null),
  created_at: '2026-08-11T00:00:00.000Z',
})

const descendingPage = <T extends { id: number }>(
  rows: readonly T[],
  cursor: unknown,
  fetchLimit: unknown,
) => rows
  .filter(row => cursor == null || row.id < Number(cursor))
  .sort((left, right) => right.id - left.id)
  .slice(0, Number(fetchLimit))

const paginationEvents = () => Array.from({ length: 70 }, (_, index) => {
  const id = 70 - index
  return {
    id,
    at: `2026-08-11T00:${String(id).padStart(2, '0')}:00.000Z`,
    kind: id % 2 === 0 ? 'note_created' : 'thing_created',
    actor: 'tiny-lantern',
    detail: { id },
  }
})

const paginationSubplaces = () => Array.from({ length: 60 }, (_, index) => ({
  ...placeRow(160 - index, 2),
  name: `Subplace ${160 - index}`,
}))

const paginationThings = () => Array.from({ length: 60 }, (_, index) => ({
  ...thingRow(260 - index),
  name: `Thing ${260 - index}`,
}))

const paginationNotes = () => Array.from({ length: 60 }, (_, index) => ({
  id: 360 - index,
  place_id: 2,
  author: 'tiny-lantern',
  body: `Note ${360 - index}`,
  created_at: '2026-08-11T00:00:00.000Z',
}))

const recentIds = (newest: number) => Array.from({ length: 60 }, (_, index) => newest - index)

const remainingPaginationRows = (collection: string) => {
  const newestByCollection: Record<string, number> = {
    residents: 1070,
    kinds: 1170,
    traits: 1270,
    agreements: 1370,
    moderation: 1470,
    me_places: 1570,
    me_things: 1670,
    me_kinds: 1770,
    me_agreements: 1870,
    me_notes: 1970,
    me_offers: 2070,
  }
  const newest = newestByCollection[collection]
  if (!newest) throw new Error(`unknown pagination fixture: ${collection}`)
  return recentIds(newest).map(id => {
    const common = { id, created_at: '2026-08-11T00:00:00.000Z' }
    if (collection === 'residents') return {
      ...common, handle: `resident-${id}`, model: 'test-model', joined_at: common.created_at,
    }
    if (collection === 'kinds') return {
      ...common, name: `kind-${id}`, owner_id: 7, owner: 'tiny-lantern',
      revision: 1, description: '', traits: [], recipe: [],
    }
    if (collection === 'traits') return {
      ...common, name: `trait-${id}`, description: '', recipe: null,
      mechanical: false, coiner: 'tiny-lantern',
    }
    if (collection === 'agreements') return {
      ...common, body: `agreement ${id}`, created_by: 'tiny-lantern',
      parties: ['tiny-lantern'], signatures: id % 2 === 0 ? [] : ['tiny-lantern'],
      open: id % 2 === 0,
    }
    if (collection === 'moderation') return {
      ...common, target_type: 'note', target_id: id, action: 'remove',
      reason: `reason ${id}`, actor: 'founder',
    }
    if (collection === 'me_places') return { ...common, parent_id: 1, name: `place-${id}` }
    if (collection === 'me_things') return {
      ...common, place_id: 2, name: `thing-${id}`, kind_id: null,
      birth_revision: null, current_revision: null, open_to_use: false,
    }
    if (collection === 'me_kinds') return { ...common, name: `kind-${id}`, current_revision: 1 }
    if (collection === 'me_agreements') return { ...common, body: `agreement ${id}`, signed: id % 2 === 0 }
    if (collection === 'me_notes') return { ...common, place_id: 2, body: `note ${id}` }
    return {
      ...common, type: 'thing', asset_id: 41, status: 'open',
      price_usdc: 2, reserved_until: null,
    }
  })
}

const residentArrivalRows = () => [
  { id: 1_000, handle: 'old-high-id', model: 'test-model', joined_at: '2026-08-10T00:00:00.000Z' },
  { id: 100, handle: 'early-tie-low', model: 'test-model', joined_at: '2026-08-11T00:00:00.000Z' },
  { id: 200, handle: 'early-tie-high', model: 'test-model', joined_at: '2026-08-11T00:00:00.000Z' },
  { id: 910, handle: 'middle', model: 'test-model', joined_at: '2026-08-12T00:00:00.000Z' },
  { id: 5, handle: 'recent-tie-low', model: 'test-model', joined_at: '2026-08-13T00:00:00.000Z' },
  { id: 800, handle: 'recent-tie-high', model: 'test-model', joined_at: '2026-08-13T00:00:00.000Z' },
]

function residentArrivalPage(query: string, cursor: unknown, fetchLimit: unknown) {
  const orderedByArrival = /order\s+by\s+resident\.joined_at\s+desc\s*,\s*resident\.id\s+desc/i.test(query)
  const rows = residentArrivalRows().sort((left, right) => orderedByArrival
    ? right.joined_at.localeCompare(left.joined_at) || right.id - left.id
    : right.id - left.id)
  if (cursor == null) return rows.slice(0, Number(fetchLimit))
  const boundary = rows.find(row => row.id === Number(cursor))
  if (!boundary) return []
  return rows.filter(row => orderedByArrival
    ? row.joined_at < boundary.joined_at
      || (row.joined_at === boundary.joined_at && row.id < boundary.id)
    : row.id < boundary.id).slice(0, Number(fetchLimit))
}

function reset(patch: Partial<FakeState> = {}) {
  state = { ...initialState(), ...patch }
}

function setActor(id: number, handle: string) {
  state = { ...state, actorId: id, actorHandle: handle }
}

function recordPayment(query: string, params: unknown[]) {
  if (!/insert\s+into\s+payment_uses/i.test(query)) return
  if (state.failPaidWriteOnce && /insert\s+into\s+places/i.test(query)) return
  const raw = params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))
  if (!raw) return
  const canonical = String(raw).toLowerCase()
  if (state.paymentHashes.has(canonical)) {
    throw Object.assign(new Error('payment proof already used'), { code: '23505' })
  }
  state = { ...state, paymentHashes: new Set([...state.paymentHashes, canonical]) }
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
  recordPayment(query, params)

  if (q.includes('/* payment-attempts:find-operation */')) {
    const row = [...state.paymentAttempts.values()].reverse().find(attempt =>
      attempt.actor_id === Number(params[0])
      && attempt.operation === String(params[1])
      && attempt.offer_id === Number(params[2]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:find */')) {
    const targetKey = params[0] == null ? null : String(params[0])
    const operation = String(params[1])
    const nonce = params[2] == null ? null : String(params[2]).toLowerCase()
    const network = params[3] == null ? null : String(params[3])
    const token = params[4] == null ? null : String(params[4]).toLowerCase()
    const payerWallet = params[5] == null ? null : String(params[5]).toLowerCase()
    const row = [...state.paymentAttempts.values()].reverse().find(attempt =>
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
    const next = new Map(state.paymentAttempts)
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
    state = { ...state, paymentAttempts: next }
    return [{ ...row }]
  }
  if (q.includes('/* payment-attempts:lease */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
    if (
      !current || current.actor_id !== Number(params[1])
      || !['settling', 'payment_pending', 'needs_review'].includes(current.status)
      || current.lease_owner != null
    ) return []
    const updated: FakePaymentAttempt = {
      ...current,
      lease_owner: String(params[2]),
      lease_expires_at: new Date(Date.now() + Number(params[3])).toISOString(),
      updated_at: new Date().toISOString(),
    }
    const next = new Map(state.paymentAttempts).set(key, updated)
    state = { ...state, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:lease-read */')) {
    const row = state.paymentAttempts.get(String(params[0]))
    return row?.actor_id === Number(params[1]) ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:bind-evidence */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'payment_pending',
      tx_hash: current.tx_hash ?? String(params[2]).toLowerCase(),
      finalized_block_number: current.finalized_block_number ?? (params[3] == null ? null : String(params[3])),
      finalized_block_hash: current.finalized_block_hash ?? (params[4] == null ? null : String(params[4]).toLowerCase()),
      finalized_block_time: current.finalized_block_time ?? (params[5] == null ? null : String(params[5])),
      finalized_at: current.finalized_at ?? (params[6] == null ? null : String(params[6])),
      response_json: current.response_json ?? (params[7] == null ? null : {
        __1f3d9_x402_response_v1: { header: String(params[7]) },
      }),
      updated_at: new Date().toISOString(),
    }
    const next = new Map(state.paymentAttempts).set(key, updated)
    state = { ...state, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:evidence-read */')) {
    const row = state.paymentAttempts.get(String(params[0]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:release-lease */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    const next = new Map(state.paymentAttempts).set(key, updated)
    state = { ...state, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:release-lease-read */')) {
    const row = state.paymentAttempts.get(String(params[0]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:invalidate */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'invalid',
      invalid_reason: String(params[2]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    const next = new Map(state.paymentAttempts).set(key, updated)
    state = { ...state, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (q.includes('/* payment-attempts:needs-review */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
    if (!current || current.lease_owner !== String(params[1])) return []
    const updated: FakePaymentAttempt = {
      ...current,
      status: 'needs_review',
      invalid_reason: String(params[2]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    const next = new Map(state.paymentAttempts).set(key, updated)
    state = { ...state, paymentAttempts: next }
    return [{ ...updated }]
  }
  if (
    q.includes('/* payment-attempts:invalidate-read */')
    || q.includes('/* payment-attempts:needs-review-read */')
  ) {
    const row = state.paymentAttempts.get(String(params[0]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:legacy-settled */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
    if (!current) return []
    const next = new Map(state.paymentAttempts)
    next.set(key, {
      ...current,
      status: current.status === 'completed' ? 'completed' : 'payment_pending',
      tx_hash: current.tx_hash ?? String(params[1]).toLowerCase(),
      updated_at: '2026-08-11T00:00:01.000Z',
    })
    state = { ...state, paymentAttempts: next }
    return [{ ...next.get(key)! }]
  }
  if (q.includes('/* payment-attempts:legacy-completed */')) {
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
      completed_at: '2026-08-11T00:00:02.000Z',
      updated_at: '2026-08-11T00:00:02.000Z',
    })
    state = { ...state, paymentAttempts: next }
    return [{ ...next.get(key)! }]
  }

  // link_kind_revision_traits refuses a trait nobody has coined yet.
  if (state.scenario === 'uncoined kind trait' &&
      (/insert into kinds/.test(q) || /insert into kind_revisions/.test(q))) {
    throw Object.assign(
      new Error('kind revision names an unknown or duplicate trait'),
      { code: '23503' },
    )
  }

  if (q.includes('where secret_hash')) return state.authValid ? [residentRow()] : []
  if (q.includes('/* crafting:commit */')) return [thingRow()]
  if (q.includes('insert into resident_presence') && !q.includes('insert into places')) {
    if (q.includes('cross join places place')) {
      const destination = Number(params[1])
      state = { ...state, currentPlaceId: destination }
      return [{ resident_id: state.actorId }]
    }
    const requestedHome = params.find(value => Number(value) === 2 || Number(value) === 3)
    if (q.includes('where owned.id') && requestedHome != null) {
      const home = Number(requestedHome)
      if (home !== 3 && state.placeOwnerId !== state.actorId) return []
      state = { ...state, homePlaceId: home, currentPlaceId: state.currentPlaceId ?? home }
    }
    return [{
      resident_id: state.actorId,
      current_place_id: state.currentPlaceId,
      home_place_id: state.homePlaceId,
      updated_at: '2026-08-11T00:00:00.000Z',
    }]
  }
  if (q.includes('from resident_presence')) return [{
    resident_id: state.actorId,
    current_place_id: state.currentPlaceId,
    home_place_id: state.homePlaceId,
    updated_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('update resident_presence')) {
    const destination = q.includes('home_place_id')
      ? state.homePlaceId
      : Number(params[0] ?? state.currentPlaceId)
    state = { ...state, currentPlaceId: destination }
    return [{
      resident_id: state.actorId,
      current_place_id: state.currentPlaceId,
      home_place_id: state.homePlaceId,
      updated_at: '2026-08-11T00:05:00.000Z',
    }]
  }
  if (q.includes('insert into action_runs')) return [{ id: 101 }]
  if (q.includes('as place_pending')) return [{ place_pending: 0, actor_pending: 0 }]
  if (q.includes('pg_advisory_xact_lock')) return []
  if (q.includes('from active_blocks')) return [{ blocked: state.actionBlocked }]
  if (q.includes('insert into action_resolutions')) return [{ id: 201 }]
  if (q.includes('with recursive ancestry') && q.includes('update things set withdrawn_at')) {
    const target = Number(params.find(value => [41, 42].includes(Number(value))) ?? 41)
    if (target === 42 && !state.targetThingWithdrawn) {
      state = { ...state, targetThingWithdrawn: true }
      return [{ id: 42 }]
    }
    return []
  }
  if (q.includes('with recursive ancestry') && q.includes('ranked_changes')) {
    return state.placeLawNames.map((name, position) => ({
      trait_id: 4 + position,
      name,
      recipe: state.lawTraitRecipe,
      source_place_id: 2,
      position,
    }))
  }
  if (q.includes('from pending_effects pending')) {
    if (state.scheduledLabelAt == null || state.scheduledLabelAt > Date.now() || state.pendingResolved) return []
    return [{
      id: 501,
      action_id: 101,
      parent_effect_id: null,
      place_id: 2,
      actor_id: state.actorId,
      source_trait_id: 4,
      source_thing_id: 41,
      target_type: 'place',
      target_id: 2,
      destination_place_id: null,
      recipient_id: null,
      payload: {
        effects: [{ effect: 'label', target: 'place', label: 'echo' }],
        repeat_remaining: 0,
        repeat_seconds: 60,
        law_authority: null,
      },
      due_at: new Date(state.scheduledLabelAt).toISOString(),
      generation: 0,
    }]
  }
  if (q.includes('insert into pending_effects')) {
    state = { ...state, scheduledLabelAt: Date.now() + 60_000 }
    return [{ id: 301 }]
  }
  if (q.includes('insert into effect_resolutions')) {
    state = { ...state, pendingResolved: true }
    return [{ id: 701 }]
  }
  if (q.includes('select distinct label') && q.includes('from active_labels')) {
    const labels = q.includes("target_type = 'resident'") ? state.actorLabels : state.placeLabels
    return labels.map(label => ({ label }))
  }
  if (q.includes('from active_labels') && q.includes('select exists')) {
    const targetType = String(params[0] ?? '')
    const label = String(params[2] ?? '')
    const labels = targetType === 'resident' ? state.actorLabels : state.placeLabels
    return [{ present: labels.includes(label) }]
  }
  if (q.includes('insert into active_labels')) {
    const targetType = String(params[0] ?? '')
    const label = String(params[2] ?? '')
    if (targetType === 'resident') state = { ...state, actorLabels: [...state.actorLabels, label] }
    if (targetType === 'place') state = { ...state, placeLabels: [...state.placeLabels, label] }
    return [{ id: 301 }]
  }
  if (q.includes('insert into active_blocks')) {
    state = { ...state, actionBlocked: true }
    return [{ id: 302 }]
  }
  if (q.includes('select exists') && (
    q.includes('from residents') || q.includes('from places')
      || q.includes('from kinds') || q.includes('from things')
  )) return [{ exists: true }]
  if (q.includes('select id, parent_id from places') && q.includes('any')) {
    return [placeRow(2, 1), placeRow(3, 2)]
  }
  if (q.includes('from labels')) {
    const targetType = String(params[0] ?? '')
    const names = targetType === 'resident'
      ? state.actorLabels
      : targetType === 'place'
        ? state.placeLabels
        : []
    return names.map(name => ({ name }))
  }
  if (q.includes('insert into labels')) {
    const targetType = String(params[0] ?? '')
    const label = String(params[2] ?? '').toLowerCase()
    if (targetType === 'resident') {
      state = { ...state, actorLabels: [...state.actorLabels, label] }
    } else if (targetType === 'place') {
      state = { ...state, placeLabels: [...state.placeLabels, label] }
    }
    return []
  }
  if (q.includes('from place_laws law') && q.includes('trait.recipe')) {
    return state.placeLawNames.length && state.lawTraitRecipe
      ? [{ recipe: state.lawTraitRecipe }]
      : []
  }
  if (q.includes('from place_laws law') && q.includes('trait.name')) {
    return state.placeLawNames.map(name => ({ name }))
  }
  if (q.includes('select owner_id from places where id =')) return [{ owner_id: state.placeOwnerId }]
  if (q.includes('delete from place_laws')) {
    state = { ...state, placeLawNames: [] }
    return []
  }
  if (q.includes('insert into place_laws')) {
    const traitId = Number(params[1] ?? 0)
    const name = traitId === 4 ? state.lawTraitName : state.lawTraitName
    state = { ...state, placeLawNames: [...state.placeLawNames, name] }
    return []
  }
  if (q.includes('insert into place_law_changes')) {
    const encoded = params.find(value => typeof value === 'string' && value.startsWith('[{'))
    const laws = typeof encoded === 'string'
      ? JSON.parse(encoded) as Array<{ id: number; name: string; position: number }>
      : []
    state = { ...state, placeLawNames: laws.map(law => law.name) }
    return [{ id: 2, laws }]
  }
  if (q.includes('select id, name from traits where name = any')) {
    const raw = params[0]
    let names: string[]
    if (Array.isArray(raw)) {
      names = raw.map(String)
    } else if (typeof raw === 'string' && raw.startsWith('[')) {
      names = (JSON.parse(raw) as unknown[]).map(String)
    } else {
      names = String(raw ?? '').replace(/^\{|\}$/g, '').split(',')
        .map(name => name.replace(/^"|"$/g, ''))
        .filter(Boolean)
    }
    return names.map((name, index) => ({ id: 4 + index, name }))
  }
  if (q.includes('from resident_action_blocks')) {
    return state.actionBlocked ? [{ id: 1 }] : []
  }
  if (q.includes('insert into resident_action_blocks')) {
    state = { ...state, actionBlocked: true }
    return []
  }
  if (q.includes('insert into scheduled_effects')) {
    const seconds = Number(params[6] ?? 0)
    state = { ...state, scheduledLabelAt: Date.now() + seconds * 1000 }
    return []
  }
  if (q.includes('from scheduled_effects')) {
    if (state.scheduledLabelAt == null || state.scheduledLabelAt > Date.now()) return []
    if (!state.placeLabels.includes('echo')) {
      state = { ...state, placeLabels: [...state.placeLabels, 'echo'] }
    }
    return [{
      id: 301,
      actor_id: state.actorId,
      source_thing_id: 41,
      target_type: 'place',
      target_id: 2,
      recipe: [{ effect: 'label', target: 'place', label: 'echo' }],
      repeat_seconds: null,
      generations_left: 1,
    }]
  }
  if (q.includes('delete from scheduled_effects')) {
    state = { ...state, scheduledLabelAt: null, placeLabels: [...state.placeLabels, 'echo'] }
    return []
  }
  if (q.includes('from moderation_states')) return []
  if (q.includes('insert into moderation_states')) {
    if (q.includes('removed_at')) {
      state = { ...state, noteRemoved: !q.includes('set removed_at = null') }
    }
    if (q.includes('pinned_at')) {
      state = { ...state, notePinned: !q.includes('set pinned_at = null') }
    }
    return []
  }
  if (q.includes('insert into moderation_actions')) {
    const targetId = Number(params[0])
    const targetType = String(params[1])
    const action = String(params[2]) as 'remove' | 'restore'
    const reason = String(params[4])
    if (targetType === 'note') {
      state = { ...state, noteRemoved: action === 'remove' }
    }
    return [{
      id: 401,
      target_type: targetType,
      target_id: targetId,
      action,
      actor_id: state.actorId,
      reason,
      created_at: '2026-08-11T00:04:00.000Z',
    }]
  }
  if (state.scenario === 'remaining pagination' && q.includes('/* public:moderation */')) {
    return descendingPage(remainingPaginationRows('moderation'), params[0], params[1])
  }
  if (q.includes('from moderation_actions')) {
    const targetType = String(params.find(value => (
      value === 'place' || value === 'thing' || value === 'kind' || value === 'trait'
        || value === 'note' || value === 'agreement'
    )) ?? '')
    const removedIds = targetType === 'kind'
      ? state.moderatedKindIds
      : targetType === 'trait' ? state.moderatedTraitIds : []
    const removedNames = targetType === 'kind'
      ? state.moderatedKindNames
      : targetType === 'trait' ? state.moderatedTraitNames : []
    if (q.includes('join kinds named') || q.includes('join traits named')) {
      return removedNames.map((name, index) => ({
        name,
        target_id: 100 + index,
        action: 'remove',
        reason: 'illegal nested text',
        created_at: '2026-08-11T00:04:00.000Z',
      }))
    }
    if (removedIds.length > 0) {
      return removedIds.map(target_id => ({
        target_id,
        action: 'remove',
        reason: 'illegal nested text',
        created_at: '2026-08-11T00:04:00.000Z',
      }))
    }
    if (targetType === 'note' && state.noteRemoved) {
      return [{
        target_id: 51,
        action: 'remove',
        reason: 'illegal content',
        created_at: '2026-08-11T00:04:00.000Z',
      }]
    }
    return []
  }
  if (q.includes('insert into anonymous_flag_limits')) {
    if (state.anonymousFlagsUsed >= 5) return []
    const used = state.anonymousFlagsUsed + 1
    state = { ...state, anonymousFlagsUsed: used }
    return [{ used }]
  }
  if (q.includes('from reg_log')) return [{ ip: 0, all: 0 }]
  if (q.includes('insert into residents')) return [{ id: 7, handle: 'tiny-lantern' }]
  if (q.includes("kind = 'rotate'") || q.includes('kind=$') && q.includes('rotate')) return [{ n: 0 }]
  if (q.includes('update residents set secret_hash')) return [{ id: state.actorId }]
  if (q.includes('update residents set current_place_id')) {
    if (q.includes('from destination')) {
      state = { ...state, currentPlaceId: state.homePlaceId }
      return [{ current_place_id: state.currentPlaceId }]
    }
    const placeId = Number(params[0] ?? 0)
    state = { ...state, currentPlaceId: placeId }
    return [{ current_place_id: placeId }]
  }
  if (q.includes('select current_place_id') && q.includes('from residents')) {
    return [{ current_place_id: state.currentPlaceId }]
  }
  if (q.includes('select coalesce(home_place_id')) return [{ current_place_id: state.homePlaceId }]

  if (q.includes('things_today = things_today + 1') && q.includes('insert into things'))
    return state.quota.things ? [thingRow()] : []
  if (q.includes('things_today = things_today + 1')) return state.quota.things ? [{ id: state.actorId }] : []
  if (q.includes('notes_today = notes_today + 1')) return state.quota.notes ? [{ id: state.actorId }] : []
  if (q.includes('agreement_actions_today = agreement_actions_today + 1')) {
    if (!state.quota.agreements) return []
    if (q.includes('insert into agreement_signatures')) {
      const acceded = !state.agreementParties.includes(state.actorHandle)
      state = {
        ...state,
        agreementParties: acceded
          ? [...state.agreementParties, state.actorHandle]
          : state.agreementParties,
        agreementAcceded: acceded
          ? [...state.agreementAcceded, state.actorHandle]
          : state.agreementAcceded,
      }
      return [{
        agreement_id: 61,
        handle: state.actorHandle,
        acceded,
        signed_at: '2026-08-11T00:00:00.000Z',
      }]
    }
    if (q.includes('insert into agreement_accession_openings')) {
      if (q.includes('insert into agreements')) {
        const accessionOpen = params.some(value => value === true || value === 'true' || value === 't')
        state = { ...state, agreementAccessionOpen: accessionOpen }
        return [{
          id: 61,
          body: 'we keep the square open',
          accession_open: accessionOpen,
          created_at: '2026-08-11T00:00:00.000Z',
        }]
      }
      if (state.agreementAccessionOpen) return []
      state = { ...state, agreementAccessionOpen: true }
      return [{ agreement_id: 61, opened_at: '2026-08-11T00:00:00.000Z' }]
    }
    return [{ id: state.actorId }]
  }

  if (state.scenario === 'remaining pagination') {
    if (q.includes('/* public:residents */')) {
      const total = remainingPaginationRows('residents').length
      const page = descendingPage(remainingPaginationRows('residents'), params[0], params[1])
      return page.length > 0 ? page.map(row => ({ ...row, total })) : [{ total }]
    }
    const publicCollection = ['kinds', 'traits', 'moderation']
      .find(collection => q.includes(`/* public:${collection} */`))
    if (publicCollection) {
      return descendingPage(remainingPaginationRows(publicCollection), params[0], params[1])
    }
    if (q.includes('/* public:agreements */')) {
      const party = params[0] == null ? null : String(params[0])
      const open = params[1] == null ? null : String(params[1]) === 'true'
      const agreements = remainingPaginationRows('agreements') as Array<{
        id: number
        parties: string[]
        open: boolean
      }>
      const filtered = agreements.filter(row =>
        (party == null || row.parties.includes(party)) && (open == null || row.open === open))
      return descendingPage(filtered, params[2], params[3])
    }
    const meCollection = [
      'me_places', 'me_things', 'me_kinds', 'me_agreements', 'me_notes', 'me_offers',
    ].find(collection => q.includes(`/* public:${collection} */`))
    if (meCollection) {
      return descendingPage(remainingPaginationRows(meCollection), params[1], params[2])
    }
  }

  if (state.scenario === 'resident arrival pagination' && q.includes('/* public:residents */')) {
    const total = residentArrivalRows().length
    const page = residentArrivalPage(query, params[0], params[1])
    return page.length > 0 ? page.map(row => ({ ...row, total })) : [{ total }]
  }

  if (state.scenario === 'public pagination' && q.includes('from places p') && q.includes('where p.parent_id')) {
    return descendingPage(paginationSubplaces(), params[1], params[2])
  }
  if (state.scenario === 'public pagination' && q.includes('from things t') && q.includes('t.place_id')) {
    return descendingPage(paginationThings(), params[1], params[2])
  }
  if (state.scenario === 'public pagination' && q.includes('from notes n') && q.includes('n.place_id')) {
    return descendingPage(paginationNotes(), params[1], params[2])
  }

  if (q.includes('with recursive place_tree')) return [placeRow(1, null), placeRow(2, 1)]
  if (q.includes('insert into places')) {
    if (state.failPaidWriteOnce) {
      state = { ...state, failPaidWriteOnce: false }
      return []
    }
    const returned = placeRow(3, 2)
    return [{
      ...returned,
      ...(q.includes('complete_payment_attempt') ? {
        response_body: JSON.stringify({ place: returned, fee_tx: TX1.toLowerCase() }),
      } : {}),
    }]
  }
  if (q.includes('from places') && q.includes('parent_id') && !q.includes('update things')) {
    return [placeRow(2, 1)]
  }
  if (q.includes('from places') && (q.includes('where p.id') || q.includes('where id'))) return [placeRow(2, 1)]
  if (q.includes('update places set'))
    return state.actorId === state.placeOwnerId ? [{ ...placeRow(2, 1), description: 'changed by its owner' }] : []

  if (q.includes('insert into kinds') || q.includes('insert into kind_revisions') || q.includes('update kinds')) {
    const returned = { ...kindRow(), revision: state.kindRevision + 1 }
    return [{
      ...returned,
      ...(q.includes('complete_payment_attempt') ? {
        response_body: JSON.stringify({ kind: returned, fee_tx: TX1.toLowerCase() }),
      } : {}),
    }]
  }
  if (q.includes('from kind_revisions') || q.includes('from kinds')) {
    if (q.includes('insert into') || q.includes('update kinds')) return [{ ...kindRow(), revision: state.kindRevision + 1 }]
    return [kindRow()]
  }
  if (q.includes('insert into traits')) return [{
    id: 4,
    name: 'glowing',
    description: 'gives off light',
    recipe: state.traitHasRecipe ? [{ effect: 'label', value: 'lit' }] : null,
    mechanical: state.traitHasRecipe,
    coiner: state.actorHandle,
  }]
  if (q.includes('kind_revision_traits')) {
    return state.thingTraitRecipe ? [{ trait_id: 4, recipe: state.thingTraitRecipe }] : []
  }
  if (q.includes('from traits')) return [{
    id: 4,
    name: state.placeLawNames.length ? state.lawTraitName : 'glowing',
    description: 'gives off light',
    recipe: state.placeLawNames.length ? state.lawTraitRecipe : null,
    mechanical: state.placeLawNames.length ? Boolean(state.lawTraitRecipe) : false,
    coiner: 'founder',
  }]

  if (q.includes('insert into notes')) return [{
    id: 51,
    place_id: Number(params[0] ?? 2),
    author: String(params[4] ?? state.actorHandle),
    body: String(params[3] ?? 'hello from the square'),
    created_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('from notes')) {
    if (state.scenario === 'busy place') {
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
      body: 'hello from the square',
      created_at: '2026-08-11T00:00:00.000Z',
      pinned: state.notePinned,
    }]
  }

  if (q.includes('insert into agreement_accession_openings')) return []
  if (q.includes('insert into agreements')) return [{
    id: 61, body: 'we keep the square open', created_by: state.actorHandle, status: 'open',
  }]
  if (q.includes('insert into agreement_parties')) return []
  if (q.includes('insert into agreement_signatures')) return [{
    agreement_id: 61, handle: state.actorHandle, signed_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('as created_by_me') && q.includes('from agreements')) return [{
    id: 61,
    body: 'we keep the square open',
    created_by_me: true,
    acceded: false,
    accession_open: state.agreementAccessionOpen,
    signed: false,
    created_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('from agreements')) return state.agreementExists ? [{
    id: 61,
    created_by_id: state.agreementCreatorId,
    body: 'we keep the square open',
    parties: state.agreementParties,
    acceded: state.agreementAcceded,
    signatures: ['tiny-lantern'],
    accession_open: state.agreementAccessionOpen,
    opened_at: state.agreementAccessionOpen ? '2026-08-11T00:00:00.000Z' : null,
    already_signed: false,
    open: true,
    created_at: '2026-08-11T00:00:00.000Z',
  }] : []
  if (q.includes('from agreement_parties')) return []

  if (q.includes('insert into transfer_offers')) {
    state = { ...state, offer: { ...state.offer, status: 'open' } }
    return [{
      id: state.offer.id,
      type: 'thing',
      asset_id: 41,
      seller: 'tiny-lantern',
      buyer: 'neighbor',
      price_usdc: 2,
      seller_wallet: SELLER_WALLET,
      status: state.offer.status,
      reserved_at: state.offer.reservedAt,
      reserved_until: state.offer.reservedUntil,
      buyer_wallet: state.offer.buyerWallet,
      created_at: '2026-08-11T00:00:00.000Z',
    }]
  }
  if (q.includes('select thing.id, thing.owner_id, thing.withdrawn_at') &&
      q.includes('left join transfer_offers')) {
    return [{
      id: 41,
      owner_id: state.thingOwnerId,
      withdrawn_at: state.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null,
      active_offer_id: state.offer.status === 'open' ? state.offer.id : null,
      has_open_offer: state.offer.status === 'open',
    }]
  }
  if (q.includes('select thing.id, thing.owner_id, thing.active_offer_id') &&
      q.includes('left join transfer_offers')) {
    return state.thingWithdrawn ? [] : [{
      id: 41,
      owner_id: state.thingOwnerId,
      active_offer_id: state.offer.status === 'open' ? state.offer.id : null,
      has_open_offer: state.offer.status === 'open',
    }]
  }
  if (q.includes('reserved_until') && q.includes('update transfer_offers') && !q.includes("status = 'claimed'")) {
    const reservedAt = new Date(Date.now() - 2_000).toISOString()
    const reservedUntil = new Date(Date.parse(reservedAt) + 5 * 60_000).toISOString()
    const buyerWallet = String(params.find(value =>
      typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && value !== SELLER_WALLET
    ) ?? BUYER_WALLET).toLowerCase()
    state = { ...state, offer: { ...state.offer, reservedAt, reservedUntil, buyerWallet } }
    return [{
      id: state.offer.id,
      reserved_by: state.actorId,
      reserved_at: reservedAt,
      reserved_until: reservedUntil,
      buyer_wallet: buyerWallet,
    }]
  }
  if (q.includes('update transfer_offers') && q.includes('cancel')) {
    const reservationIsActive = state.offer.reservedUntil != null && Date.parse(state.offer.reservedUntil) > Date.now()
    if (reservationIsActive || state.offer.status !== 'open') return []
    state = { ...state, offer: { ...state.offer, status: 'canceled' } }
    return [{ id: state.offer.id, status: 'canceled' }]
  }
  if (q.includes('update transfer_offers') && (q.includes('claim') || q.includes('closed'))) {
    if (state.offer.status !== 'open') return []
    state = { ...state, offer: { ...state.offer, status: 'claimed' } }
    const createdAt = '2026-08-11T00:00:00.000Z'
    const responseBody = JSON.stringify({
      offer: { id: state.offer.id, status: 'claimed' },
      transfer: {
        id: 91,
        type: String(params[3] ?? 'thing'),
        asset_id: Number(params[4] ?? 41),
        from: String(params[10] ?? 'tiny-lantern'),
        to: String(params[9] ?? state.actorHandle),
        price_usdc: Number(params[5] ?? 2),
        tx_hash: String(params[7] ?? TX1).toLowerCase(),
        created_at: createdAt,
      },
    })
    if (q.includes('complete_payment_attempt')) {
      const attemptId = String(params[16])
      const attempt = state.paymentAttempts.get(attemptId)
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
          result_json: { kind: 'transfer_offer', id: state.offer.id },
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
        state = {
          ...state,
          paymentAttempts: new Map(state.paymentAttempts).set(attemptId, completed),
        }
      }
    }
    return [{
      id: state.offer.id,
      status: 'claimed',
      new_owner: state.actorHandle,
      ...(q.includes('complete_payment_attempt') ? {
        transfer_id: 91,
        created_at: createdAt,
        response_body: responseBody,
      } : {}),
    }]
  }
  if (q.includes('from transfer_offers') && !q.includes('from things thing') && !q.includes('update things')) {
    const directOnlyWorld = q.includes("o.channel = 'direct'") && state.offer.channel === 'world'
    const openOnly = q.includes("status = 'open'")
    return !directOnlyWorld && (!openOnly || state.offer.status === 'open') ? [{
    id: state.offer.id,
    type: 'thing',
    asset_id: 41,
    owner_id: 7,
    seller_id: 7,
    seller: 'tiny-lantern',
    buyer_id: 8,
    buyer: 'neighbor',
    price_usdc: 2,
    seller_wallet: SELLER_WALLET,
    status: state.offer.status,
    reserved_by: state.offer.reservedUntil ? 8 : null,
    reserved_at: state.offer.reservedAt,
    reserved_until: state.offer.reservedUntil,
    buyer_wallet: state.offer.buyerWallet,
    created_at: '2026-08-11T00:00:00.000Z',
    }] : []
  }

  if (q.includes('update things set withdrawn_at')) {
    const target = Number(params.find(value => [41, 42].includes(Number(value))) ?? 41)
    if (target === 41 && state.actorId === state.thingOwnerId && !state.thingWithdrawn) {
      state = { ...state, thingWithdrawn: true }
      return [{ id: 41, withdrawn_at: '2026-08-11T00:02:00.000Z' }]
    }
    if (target === 42 && !state.targetThingWithdrawn) {
      state = { ...state, targetThingWithdrawn: true }
      return [{ id: 42 }]
    }
    return []
  }
  if (q.includes('update things set owner_id')) {
    const target = q.includes('from recipient')
      ? Number(params[1] ?? 0)
      : Number(params[1] ?? 0)
    const toOwner = q.includes('from recipient')
      ? Number(params[2] ?? state.actorId)
      : Number(params[0] ?? state.actorId)
    if (target === 42 && !state.targetThingWithdrawn) {
      state = { ...state, targetThingOwnerId: toOwner }
      return [{ id: 42 }]
    }
    if (target === 41 && !state.thingWithdrawn) {
      state = { ...state, thingOwnerId: toOwner }
      return [{ id: 41 }]
    }
    return []
  }
  if (q.includes('insert into things')) return [thingRow()]
  if (q.includes('update things set')) {
    if (q.includes('open_to_use')) {
      const requested = params.find(value => value === true || value === false || value === 'true' || value === 'false')
      if (requested != null) state = { ...state, thingOpenToUse: String(requested) === 'true' }
    }
    return state.actorId === state.thingOwnerId && !state.thingWithdrawn ? [thingRow()] : []
  }
  if (q.includes('select owner_id from things')) {
    const target = Number(params[0] ?? 41)
    return [{ owner_id: target === 41 ? state.thingOwnerId : state.targetThingOwnerId }]
  }
  if (q.includes('select thing.id, thing.owner_id, thing.place_id')) {
    const target = Number(params[0] ?? 41)
    const targetIsSource = target === 41
    return [{
      id: target,
      owner_id: targetIsSource ? state.thingOwnerId : state.targetThingOwnerId,
      place_id: 2,
      kind_id: 3,
      withdrawn_at: targetIsSource
        ? (state.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
        : (state.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null),
      active_offer_id: null,
      has_open_offer: false,
      open_to_use: targetIsSource ? state.thingOpenToUse : false,
      traits: state.kindTraitNames,
    }]
  }
  if (q.includes('from things')) {
    if (q.includes('where thing.id') || q.includes('where id =')) {
      const target = Number(params[0] ?? 41)
      if (target === 41) {
        if (state.thingWithdrawn && q.includes('withdrawn_at is null')) return []
        return [thingRow(41)]
      }
      if (target === 42) {
        if (state.targetThingWithdrawn && q.includes('withdrawn_at is null')) return []
        return [thingRow(42)]
      }
    }
    const rows: Record<string, unknown>[] = []
    if (!state.thingWithdrawn) rows.push(thingRow(41))
    if (!state.targetThingWithdrawn) rows.push(thingRow(42))
    return rows
  }

  if (q.includes('/* public:residents */')) return [residentRow(), {
    ...residentRow(), id: 8, handle: 'neighbor', joined_at: '2026-08-11T00:01:00.000Z',
  }].map(row => ({ ...row, total: 2 }))
  if (q.includes('from residents')) return [residentRow(), {
    ...residentRow(), id: 8, handle: 'neighbor', joined_at: '2026-08-11T00:01:00.000Z',
  }]
  if (q.includes('from events') && state.scenario === 'public pagination') {
    const kind = params[0] == null ? null : String(params[0])
    const matching = paginationEvents().filter(event => kind == null || event.kind === kind)
    return descendingPage(matching, params[1], params[2])
  }
  if (q.includes('from events') && q.includes('count(')) return [{ n: 0 }]
  if (q.includes('from events') && state.scenario === 'event pagination') {
    const beforeId = params[1] == null ? null : Number(params[1])
    const limit = q.includes('limit $3') ? Number(params[2]) : 200
    return [205, 204, 203, 202, 201]
      .filter(id => beforeId == null || id < beforeId)
      .slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 200)
      .map(id => ({
        id,
        at: new Date(Date.UTC(2026, 7, 11, 0, 0, id - 200)).toISOString(),
        kind: 'note',
        actor: 'tiny-lantern',
        detail: { note_id: id, place_id: 2 },
      }))
  }
  if (q.includes('from events') && state.scenario === 'activity surfaces') return [
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
  ]
  if (q.includes('from events') && state.scenario === 'nested moderation events') return [
    {
      id: 80, at: '2026-08-11T00:06:00.000Z', kind: 'laws_changed',
      actor: 'tiny-lantern', detail: { place_id: 2, traits: ['quiet-hours', 'safe-trait'] },
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
  if (q.includes('from events')) return [{
    id: 70,
    at: '2026-08-11T00:00:00.000Z',
    kind: 'register',
    actor: 'tiny-lantern',
    detail: { resident_id: 7 },
  }]
  if (q.includes('sum(') && (q.includes('fees') || q.includes('payment_uses'))) return [{ collected: 1, n: 1 }]
  if (q.includes('from fees')) return [{
    amount_usdc: 1, tx_hash: TX1, handle: 'tiny-lantern', purpose: 'kind', created_at: '2026-08-11T00:00:00.000Z',
  }]

  if (q.includes('insert into events') || q.includes('insert into flags') || q.includes('insert into payment_uses')) return []
  if (q.startsWith('delete from reg_log')) return []
  throw new Error(`unhandled fake SQL (${state.scenario}): ${query}`)
}

const pad32 = (address: string) => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

function pgArray(values: unknown[]) {
  return `{${values.map(value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
}

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (value: unknown) => {
    if (Buffer.isBuffer(value)) return 17
    if (typeof value === 'boolean') return 16
    if (typeof value === 'number') return Number.isInteger(value) ? 23 : 701
    if (Array.isArray(value)) {
      return value.some(item => item != null && typeof item === 'object') ? 3802 : 1009
    }
    if (value != null && typeof value === 'object') return 3802
    return 25
  }
  const encode = (value: unknown) => {
    if (value === null) return null
    if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
    if (typeof value === 'boolean') return value ? 't' : 'f'
    if (Array.isArray(value)) {
      return value.some(item => item != null && typeof item === 'object')
        ? JSON.stringify(value)
        : pgArray(value)
    }
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }
  return {
    command: 'SELECT',
    rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
    rows: rows.map(row => keys.map(key => encode(row[key]))),
  }
}

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(init.body) : null
  state = { ...state, calls: [...state.calls, { url, query: body?.query, params: body?.params }] }
  if (url.includes('/sql')) return jsonResponse(neonEncode(dbRespond(body.query, body.params ?? [])))
  if (url.includes('base-rpc.test')) {
    const result = body.method === 'eth_blockNumber'
      ? '0x100'
      : body.method === 'eth_getTransactionReceipt'
      ? {
        status: '0x1',
        blockHash: '0x' + 'bb'.repeat(32),
        blockNumber: '0x100',
        logs: [{
          address: USDC,
          topics: [TRANSFER_TOPIC, pad32(state.chainFrom), pad32(state.chainTo)],
          data: state.chainTo.toLowerCase() === TREASURY.toLowerCase() ? '0x0f4240' : '0x1e8480',
        }],
      }
      : body.method === 'eth_getBlockByHash'
        ? { timestamp: '0x' + Math.floor((Date.now() - state.chainAgeSeconds * 1000) / 1000).toString(16) }
        : body.method === 'eth_getBlockByNumber'
          ? body.params?.[0] === 'finalized'
            ? { number: '0x100' }
            : { number: '0x100', hash: '0x' + 'bb'.repeat(32) }
        : body.method === 'eth_call'
          ? '0x0f4240'
          : body.method === 'eth_getLogs'
            ? []
            : null
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result })
  }
  if (url.includes('/verify')) return jsonResponse(state.facilitatorVerify
    ? { isValid: true }
    : { isValid: false, invalidReason: 'facilitator says no (test)' })
  if (url.includes('/settle')) return jsonResponse(state.facilitatorSettle
    ? { success: true, transaction: TX_CASE_UPPER, payer: state.chainFrom }
    : { success: false, errorReason: 'settlement failed (test)' })
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const { setEngineTransactionRunnerForTests } = await import('../src/engine.ts')
setEngineTransactionRunnerForTests(async (db, work) => work(db, false))
test.after(() => setEngineTransactionRunnerForTests(null))

const authHeaders = (secret = SECRET) => ({
  Authorization: `Bearer ${secret}`,
  'Content-Type': 'application/json',
})
const sqlCalls = () => state.calls.filter(call => call.query)
const inserted = (table: string) => sqlCalls().filter(call =>
  new RegExp(`insert\\s+into\\s+${table}\\b`, 'i').test(call.query ?? '')).length
const networkCalled = (fragment: string) => state.calls.some(call => call.url.includes(fragment))

test('public pagination applies one bounded default and rejects ambiguous or invalid values', () => {
  assert.equal(PUBLIC_PAGE_DEFAULT, 10)
  assert.equal(PUBLIC_PAGE_MAX, 200)
  assert.deepEqual(parsePublicPage({}, 'before_id', 'limit'), {
    ok: true,
    cursor: null,
    limit: 10,
    fetchLimit: 11,
  })
  assert.deepEqual(parsePublicPage({ before_id: ['41'], limit: ['200'] }, 'before_id', 'limit'), {
    ok: true,
    cursor: 41,
    limit: 200,
    fetchLimit: 201,
  })
  assert.deepEqual(
    parsePublicPage({ limit: ['4'] }, 'before_note_id', 'note_limit', 'limit'),
    { ok: true, cursor: null, limit: 4, fetchLimit: 5 },
  )
  assert.deepEqual(
    parsePublicPage(
      { limit: ['4'], note_limit: ['2'] },
      'before_note_id',
      'note_limit',
      'limit',
    ),
    { ok: true, cursor: null, limit: 2, fetchLimit: 3 },
  )
  assert.equal(
    parsePublicPage(
      { limit: ['wat'], note_limit: ['2'] },
      'before_note_id',
      'note_limit',
      'limit',
    ).ok,
    false,
  )

  for (const query of [
    { before_id: ['0'] },
    { before_id: ['1.5'] },
    { before_id: ['wat'] },
    { before_id: ['2147483648'] },
    { before_id: ['4', '3'] },
    { limit: ['0'] },
    { limit: ['201'] },
    { limit: ['2', '3'] },
  ]) {
    assert.equal(parsePublicPage(query, 'before_id', 'limit').ok, false, JSON.stringify(query))
  }

  const source = Object.freeze([{ id: 3 }, { id: 2 }, { id: 1 }])
  const finalized = finalizePublicPage(source, 2)
  assert.deepEqual(finalized, {
    items: [{ id: 3 }, { id: 2 }],
    hasMore: true,
    nextCursor: 2,
  })
  assert.equal(Object.isFrozen(finalized), true)
  assert.equal(Object.isFrozen(finalized.items), true)
  assert.deepEqual(source.map(row => row.id), [3, 2, 1])
})

test('legacy registration and transcript-visible root-key rotation are retired', async () => {
  reset({ scenario: 'identity' })
  const registered = await app.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: ' Tiny-Lantern ', model: 'openai-codex' }),
  })
  assert.equal(registered.status, 410)
  assert.match((await registered.json() as { error: string }).error, /private browser flow.*\/join/i)
  assert.equal(sqlCalls().length, 0)

  const rotated = await app.request('/api/rotate', { method: 'POST', headers: authHeaders() })
  assert.equal(rotated.status, 410)
  assert.deepEqual(await rotated.json(), {
    error: 'root-key rotation moved to the private browser flow at https://1f3d9.com/rotate',
  })
  assert.equal(sqlCalls().length, 0)
})

test('retired registration never trusts or stores forwarding headers', async () => {
  reset({ scenario: 'trusted registration IP' })
  const register = (handle: string, forwarded: string, vercel?: string) => app.request('/api/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': forwarded,
      ...(vercel ? { 'X-Vercel-Forwarded-For': vercel } : {}),
    },
    body: JSON.stringify({ handle, model: 'test' }),
  })

  assert.equal((await register('edge-one', '198.51.100.1, 203.0.113.9', '192.0.2.7')).status, 410)
  assert.equal((await register('proxy-one', '198.51.100.1, 203.0.113.20')).status, 410)
  assert.equal(sqlCalls().length, 0)
})

test('malformed auth and oversized thing text fail before any world write', async () => {
  reset({ scenario: 'validation' })
  const unauthenticated = await app.request('/api/note', {
    method: 'POST',
    headers: authHeaders('not-a-city-secret'),
    body: JSON.stringify({ place_id: 2, body: 'hello' }),
  })
  assert.equal(unauthenticated.status, 401)
  assert.equal(inserted('notes'), 0)

  const oversized = await app.request('/api/thing', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, name: 'too much', body: 'x'.repeat(64 * 1024 + 1) }),
  })
  assert.equal(oversized.status, 400)
  assert.match(JSON.stringify(await oversized.json()), /64\s*kb|65536/i)
  assert.equal(inserted('things'), 0)
})

test('note validation distinguishes place errors and preserves valid Unicode exactly', async () => {
  reset({ scenario: 'note validation' })
  const invalidPlace = await app.request('/api/note', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ place_id: 0, body: 'valid words' }),
  })
  assert.equal(invalidPlace.status, 400)
  assert.deepEqual(await invalidPlace.json(), { error: 'place_id must be a positive integer' })
  assert.equal(inserted('notes'), 0)

  reset({ scenario: 'note validation' })
  const invalidBody = await app.request('/api/note', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, body: '\u0000' }),
  })
  assert.equal(invalidBody.status, 400)
  assert.deepEqual(await invalidBody.json(), { error: 'body must be 1-4000 safe characters' })
  assert.equal(inserted('notes'), 0)

  reset({ scenario: 'note validation' })
  const body = 'Café — east wing 🗺️'
  const accepted = await app.request('/api/note', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, body }),
  })
  assert.equal(accepted.status, 201)
  const acceptedBody = await accepted.json() as { note: { body: string } }
  assert.equal(acceptedBody.note.body, body)
})

test('the public map is a recursive owner-attributed tree', async () => {
  reset({ scenario: 'map' })
  const response = await app.request('/api/map')
  assert.equal(response.status, 200)
  const body = await response.json() as { places: { id: number; owner: string; children: { id: number }[] }[] }
  assert.equal(body.places[0]?.id, 1)
  assert.equal(body.places[0]?.owner, 'founder')
  assert.equal(body.places[0]?.children[0]?.id, 2)
  assert.ok(sqlCalls().some(call => /with\s+recursive/i.test(call.query ?? '')))
})

test('busy places serve the newest notes and expose an older-note cursor', async () => {
  reset({ scenario: 'busy place' })
  const first = await app.request('/api/place/2?note_limit=200')
  assert.equal(first.status, 200)
  const firstBody = await first.json() as {
    notes: Array<{ id: number }>
    notes_page: { has_more: boolean; next_before_note_id: number | null }
  }
  assert.equal(firstBody.notes.length, 200)
  assert.equal(firstBody.notes[0]?.id, 205)
  assert.equal(firstBody.notes.at(-1)?.id, 6)
  assert.deepEqual(firstBody.notes_page, { has_more: true, next_before_note_id: 6 })

  reset({ scenario: 'busy place' })
  const older = await app.request('/api/place/2?before_note_id=6&note_limit=10')
  assert.equal(older.status, 200)
  const olderBody = await older.json() as {
    notes: Array<{ id: number }>
    notes_page: { has_more: boolean; next_before_note_id: number | null }
  }
  assert.deepEqual(olderBody.notes.map(note => note.id), [5, 4, 3, 2, 1])
  assert.deepEqual(olderBody.notes_page, { has_more: false, next_before_note_id: null })

  const invalid = await app.request('/api/place/2?before_note_id=nope')
  assert.equal(invalid.status, 400)
})

test('public thing and note detail reads expose full active records without writes', async () => {
  reset({ scenario: 'public details' })
  const thing = await app.request('/api/thing/41')
  assert.equal(thing.status, 200)
  const thingBody = await thing.json() as { thing: { id: number; body: string; owner: string } }
  assert.deepEqual(thingBody.thing, {
    ...thingBody.thing,
    id: 41,
    body: 'warm light',
    owner: 'tiny-lantern',
  })

  const note = await app.request('/api/note/51')
  assert.equal(note.status, 200)
  const noteBody = await note.json() as { note: { id: number; body: string; author: string } }
  assert.deepEqual(noteBody.note, {
    ...noteBody.note,
    id: 51,
    body: 'hello from the square',
    author: 'tiny-lantern',
  })
  assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)

  reset({ scenario: 'public details', thingWithdrawn: true })
  assert.equal((await app.request('/api/thing/41')).status, 404)
  assert.equal((await app.request('/api/thing/not-an-id')).status, 400)
  assert.equal((await app.request('/api/note/not-an-id')).status, 400)
})

test('each place permission is independent and an allowed visitor owns what they build', async () => {
  reset({
    scenario: 'place permissions', actorId: 8, actorHandle: 'neighbor', placeOwnerId: 7,
    openToBuilding: true, openToThings: false, openToNotes: true,
  })
  const founded = await app.request('/api/place', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({
      parent_id: 2,
      name: 'Neighbor Plot',
      description: 'mine',
      open_to_building: true,
      open_to_things: false,
      open_to_notes: true,
    }),
  })
  assert.equal(founded.status, 201)
  const placeBody = await founded.json() as {
    place: { owner: string; open_to_building: boolean; open_to_things: boolean; open_to_notes: boolean }
  }
  assert.equal(placeBody.place.owner, 'neighbor')
  assert.equal(placeBody.place.open_to_building, true)
  assert.equal(placeBody.place.open_to_things, false)
  assert.equal(placeBody.place.open_to_notes, true)
  assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)

  const thing = await app.request('/api/thing', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ place_id: 2, name: 'uninvited box', body: '' }),
  })
  assert.equal(thing.status, 403)

  const note = await app.request('/api/note', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ place_id: 2, body: 'hello from the square' }),
  })
  assert.equal(note.status, 201)
})

test('only a place owner can edit its description and three permission switches', async () => {
  reset({ scenario: 'place patch', placeOwnerId: 7 })
  const changed = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({
      description: 'changed by its owner',
      open_to_building: true,
      open_to_things: true,
      open_to_notes: false,
    }),
  })
  assert.equal(changed.status, 200)

  setActor(8, 'neighbor')
  const rejected = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(OTHER_SECRET), body: JSON.stringify({ open_to_building: false }),
  })
  assert.equal(rejected.status, 403)
})

test('traits are globally named, free, and mechanical only when an inert recipe is present', async () => {
  reset({ scenario: 'traits', traitHasRecipe: true })
  const created = await app.request('/api/trait', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      name: 'glowing', description: 'gives off light',
      recipe: { use: [{ effect: 'label', target: 'source', label: 'lit' }] },
    }),
  })
  assert.equal(created.status, 201)
  const body = await created.json() as { trait: { name: string; mechanical: boolean } }
  assert.equal(body.trait.name, 'glowing')
  assert.equal(body.trait.mechanical, true)
  assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)

  const listed = await app.request('/api/traits')
  assert.equal(listed.status, 200)
})

test('kind revision is paid but never rewrites existing things', async () => {
  reset({
    scenario: 'kind revision', chainFrom: SELLER_WALLET, chainTo: TREASURY,
    facilitatorVerify: true, facilitatorSettle: true,
  })
  const revised = await app.request('/api/kind/3/revise', {
    method: 'POST', headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({
      description: 'a small dependable light', traits: ['glowing'], recipe: [],
    }),
  })
  assert.equal(revised.status, 200)
  const body = await revised.json() as { kind: { revision: number } }
  assert.equal(body.kind.revision, 2)
  assert.equal(sqlCalls().some(call => /update\s+things/i.test(call.query ?? '')), false)
})

test('duplicate trait names fail before charging for a kind', async () => {
  reset({ scenario: 'duplicate kind traits', chainFrom: SELLER_WALLET, chainTo: TREASURY })
  const response = await app.request('/api/kind', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      name: 'double-glow', description: 'invalid', traits: ['glowing', 'glowing'], recipe: [],
    }),
  })
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /duplicate|unique/i)
  assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)
  assert.equal(inserted('kinds'), 0)
})

test('an uncoined kind trait answers with the reason, not "internal"', async () => {
  reset({ scenario: 'uncoined kind trait', chainFrom: SELLER_WALLET, chainTo: TREASURY })
  const response = await app.request('/api/kind', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      name: 'erratum', description: 'corrects a claim', traits: ['never-coined'], recipe: [],
    }),
  })
  assert.equal(response.status, 400)
  const body = JSON.stringify(await response.json())
  assert.match(body, /unknown or duplicate trait/)
  assert.match(body, /POST \/api\/trait/)
  assert.doesNotMatch(body, /internal/)
})

test('an uncoined trait on kind revision answers with the reason, not "internal"', async () => {
  reset({ scenario: 'uncoined kind trait', chainFrom: SELLER_WALLET, chainTo: TREASURY })
  const response = await app.request('/api/kind/3/revise', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      description: 'corrected again', traits: ['never-coined'], recipe: [],
    }),
  })
  assert.equal(response.status, 400)
  const body = JSON.stringify(await response.json())
  assert.match(body, /unknown or duplicate trait/)
  assert.match(body, /POST \/api\/trait/)
  assert.doesNotMatch(body, /internal/)
})

test('things pin their birth revision and only their owner may voluntarily upgrade', async () => {
  reset({ scenario: 'thing revision', kindRevision: 1, openToThings: true })
  const made = await app.request('/api/thing', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, name: 'porch lantern', body: 'warm light', kind_id: 3 }),
  })
  assert.equal(made.status, 201)
  const born = await made.json() as { thing: { birth_revision: number; current_revision: number } }
  assert.equal(born.thing.birth_revision, 1)
  assert.equal(born.thing.current_revision, 1)
  assert.ok(sqlCalls().some(call =>
    /things_today[\s\S]*things_today\s*\+\s*1/i.test(call.query ?? '') &&
    /insert\s+into\s+things/i.test(call.query ?? '')))

  state = { ...state, kindRevision: 2 }
  const edited = await app.request('/api/thing/41', {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({ body: 'new words', birth_revision: 2 }),
  })
  assert.equal(edited.status, 400)

  const upgraded = await app.request('/api/thing/41/upgrade', { method: 'POST', headers: authHeaders() })
  assert.equal(upgraded.status, 200)
  const current = await upgraded.json() as { thing: { birth_revision: number; current_revision: number } }
  assert.equal(current.thing.birth_revision, 1)
  assert.equal(current.thing.current_revision, 2)

  setActor(8, 'neighbor')
  const nonOwner = await app.request('/api/thing/41/upgrade', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
  })
  assert.equal(nonOwner.status, 403)
})

test('note and agreement quotas fail atomically without a partial public record', async () => {
  reset({
    scenario: 'quotas', openToNotes: true,
    quota: { things: true, notes: false, agreements: false },
  })
  const note = await app.request('/api/note', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ place_id: 2, body: 'too many' }),
  })
  assert.equal(note.status, 429)
  assert.equal(inserted('notes'), 0)

  const agreement = await app.request('/api/agreement', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ parties: ['tiny-lantern', 'neighbor'], body: 'we keep the square open' }),
  })
  assert.equal(agreement.status, 429)
  assert.equal(inserted('agreements'), 0)
})

test('a timer-moved note author receives the engine proximity status instead of a 500', async () => {
  reset({ scenario: 'timer moved note author', currentPlaceId: 3, openToNotes: true })
  const response = await app.request('/api/note', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, body: 'already gone' }),
  })
  assert.equal(response.status, 403)
  assert.match(JSON.stringify(await response.json()), /current place/i)
  assert.equal(inserted('notes'), 0)
})

test('agreements remain unenforced public text and each party signs for itself', async () => {
  reset({ scenario: 'agreements' })
  const created = await app.request('/api/agreement', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ parties: ['tiny-lantern', 'neighbor'], body: 'we keep the square open' }),
  })
  assert.equal(created.status, 201)
  const createdBody = await created.json() as { agreement: { accession_open: boolean } }
  assert.equal(createdBody.agreement.accession_open, false)

  const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
  assert.equal(signed.status, 200)

  const publicRecord = await app.request('/api/agreements?party=tiny-lantern&open=true')
  assert.equal(publicRecord.status, 200)
  const body = await publicRecord.json() as { agreements: { body: string; signatures: string[]; open: boolean }[] }
  assert.equal(body.agreements[0]?.body, 'we keep the square open')
  assert.deepEqual(body.agreements[0]?.signatures, ['tiny-lantern'])
  assert.equal(body.agreements[0]?.open, true)
})

test('a new agreement may explicitly open itself to later accession', async () => {
  reset({ scenario: 'agreements' })

  const created = await app.request('/api/agreement', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      parties: ['tiny-lantern', 'neighbor'],
      body: 'we keep the square open',
      accession_open: true,
    }),
  })

  assert.equal(created.status, 201, await created.clone().text())
  const body = await created.json() as { agreement: { accession_open: boolean } }
  assert.equal(body.agreement.accession_open, true)
  assert.equal(inserted('agreement_accession_openings'), 1)
})

test('a later arrival cannot accede until the author explicitly opens the agreement', async () => {
  reset({ scenario: 'agreements', agreementParties: ['neighbor'], agreementAccessionOpen: false })
  setActor(9, 'latecomer')

  const blocked = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
  assert.equal(blocked.status, 403)
  assert.equal(inserted('agreement_parties'), 0)
  assert.equal(inserted('agreement_signatures'), 0)
})

test('a later arrival accedes and signs atomically after author opt-in', async () => {
  reset({
    scenario: 'agreements',
    agreementParties: ['neighbor'],
    agreementAccessionOpen: true,
  })
  setActor(9, 'latecomer')

  const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
  assert.equal(signed.status, 200, await signed.clone().text())
  const body = await signed.json() as { signature: { handle: string; acceded: boolean } }
  assert.equal(body.signature.handle, 'latecomer')
  assert.equal(body.signature.acceded, true)
  // One statement carries both inserts, so this asserts the accession path was
  // taken at all -- whether its WHERE clause suppresses the party row for a
  // named signer is Postgres semantics no fake can decide.
  assert.equal(inserted('agreement_parties'), 1)
  assert.equal(inserted('agreement_signatures'), 1)
})

test('a named party signs without acceding', async () => {
  reset({ scenario: 'agreements' })

  const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
  assert.equal(signed.status, 200, await signed.clone().text())
  const body = await signed.json() as { signature: { acceded: boolean } }
  assert.equal(body.signature.acceded, false)
  assert.equal(inserted('agreement_signatures'), 1)
})

test('only the original author may permanently open an existing agreement to accession', async () => {
  reset({ scenario: 'agreements', agreementCreatorId: 7, agreementAccessionOpen: false })

  setActor(8, 'neighbor')
  const denied = await app.request('/api/agreement/61/open-accession', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
  })
  assert.equal(denied.status, 403)
  assert.equal(inserted('agreement_accession_openings'), 0)

  setActor(7, 'tiny-lantern')
  const opened = await app.request('/api/agreement/61/open-accession', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(opened.status, 201, await opened.clone().text())
  const body = await opened.json() as { agreement: { id: number; accession_open: boolean } }
  assert.deepEqual(body.agreement, {
    id: 61,
    accession_open: true,
    opened_at: '2026-08-11T00:00:00.000Z',
  })
  assert.equal(inserted('agreement_accession_openings'), 1)

  const retried = await app.request('/api/agreement/61/open-accession', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(retried.status, 200, await retried.clone().text())
  assert.equal(inserted('agreement_accession_openings'), 1)
})

test('opening accession distinguishes missing agreements and exhausted quota', async () => {
  reset({ scenario: 'agreements', agreementExists: false })
  const missing = await app.request('/api/agreement/61/open-accession', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(missing.status, 404)

  reset({ scenario: 'agreements', quota: { things: true, notes: true, agreements: false } })
  const capped = await app.request('/api/agreement/61/open-accession', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(capped.status, 429)
  assert.equal(inserted('agreement_accession_openings'), 0)
})

test('the public record separates the parties an author named from those who acceded', async () => {
  reset({
    scenario: 'agreements',
    agreementParties: ['neighbor', 'tiny-lantern'],
    agreementAcceded: ['tiny-lantern'],
  })

  const record = await app.request('/api/agreements?party=tiny-lantern')
  assert.equal(record.status, 200)
  const body = await record.json() as {
    agreements: { parties: string[]; acceded: string[]; accession_open: boolean }[]
  }
  assert.deepEqual(body.agreements[0]?.parties, ['neighbor', 'tiny-lantern'])
  assert.deepEqual(body.agreements[0]?.acceded, ['tiny-lantern'])
  assert.equal(body.agreements[0]?.accession_open, false)
})

test('a gift moves immediately, while an open sale offer locks the asset', async () => {
  reset({ scenario: 'transfers' })
  const gift = await app.request('/api/transfer', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ type: 'thing', id: 41, to_handle: 'neighbor' }),
  })
  assert.equal(gift.status, 200, await gift.clone().text())

  reset({ scenario: 'offer lock' })
  const offered = await app.request('/api/transfer/offer', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      type: 'thing', id: 41, to_handle: 'neighbor', price_usdc: 2, seller_wallet: SELLER_WALLET,
    }),
  })
  assert.equal(offered.status, 201)

  const lockedGift = await app.request('/api/transfer', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ type: 'thing', id: 41, to_handle: 'someone-else' }),
  })
  assert.equal(lockedGift.status, 409)
})

test('a withdrawn thing cannot be gifted or offered for sale', async () => {
  reset({ scenario: 'withdrawn transfer', thingWithdrawn: true })
  const gift = await app.request('/api/transfer', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ type: 'thing', id: 41, to_handle: 'neighbor' }),
  })
  assert.equal(gift.status, 404)

  const offer = await app.request('/api/transfer/offer', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      type: 'thing', id: 41, to_handle: 'neighbor', price_usdc: 2, seller_wallet: SELLER_WALLET,
    }),
  })
  assert.equal(offer.status, 404)
  assert.equal(inserted('transfers'), 0)
  assert.equal(inserted('transfer_offers'), 0)
})

test('generic transfer claim and cancel routes cannot operate on a world offer', async () => {
  reset({
    scenario: 'world offer direct-route isolation',
    offer: { id: 90, channel: 'world', status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const claim = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(claim.status, 404)

  setActor(7, 'tiny-lantern')
  const cancel = await app.request('/api/transfer/90/cancel', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(cancel.status, 404)
  assert.equal(networkCalled('base-rpc.test'), false)
})

test('an unpaid buyer claim reserves five minutes and temporarily blocks seller cancellation', async () => {
  reset({
    scenario: 'reservation',
    chainFrom: BUYER_WALLET,
    chainTo: SELLER_WALLET,
    offer: { id: 90, status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const claim = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(claim.status, 402)
  const challenge = await claim.json() as { accepts: { payTo: string; maxAmountRequired: string }[] }
  assert.equal(challenge.accepts[0]?.payTo.toLowerCase(), SELLER_WALLET)
  assert.equal(challenge.accepts[0]?.maxAmountRequired, '2000000')
  assert.ok(state.offer.reservedUntil)
  const remaining = Date.parse(state.offer.reservedUntil!) - Date.now()
  assert.ok(remaining > 4 * 60_000 && remaining <= 5 * 60_000)

  setActor(7, 'tiny-lantern')
  const blockedCancel = await app.request('/api/transfer/90/cancel', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(blockedCancel.status, 409)

  state = { ...state, offer: { ...state.offer, reservedUntil: new Date(Date.now() - 1).toISOString() } }
  const canceled = await app.request('/api/transfer/90/cancel', { method: 'POST', headers: authHeaders() })
  assert.equal(canceled.status, 200)
})

test('a reserved buyer can retry with signed x402 and ownership closes atomically', async () => {
  reset({
    scenario: 'direct sale',
    chainFrom: BUYER_WALLET,
    chainTo: SELLER_WALLET,
    facilitatorVerify: true,
    facilitatorSettle: true,
    offer: { id: 90, status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const reservation = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(reservation.status, 402)
  state = { ...state, chainAgeSeconds: 0 }
  const settled = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': SALE_X_PAYMENT },
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(settled.status, 200)
  const settledText = await settled.clone().text()
  const settledPaymentResponse = settled.headers.get('X-PAYMENT-RESPONSE')
  const body = await settled.json() as { offer: { status: string }; transfer: { to: string } }
  assert.equal(body.offer.status, 'claimed')
  assert.equal(body.transfer.to, 'neighbor')
  assert.ok(sqlCalls().some(call =>
    /payment_uses/i.test(call.query ?? '') && /transfer_offers/i.test(call.query ?? '') && /update\s+things/i.test(call.query ?? '')))

  const settlementsBeforeReplay = state.calls.filter(call => call.url.includes('/settle')).length
  const replay = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': SALE_X_PAYMENT },
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(replay.status, 200)
  assert.equal(await replay.text(), settledText)
  assert.equal(replay.headers.get('X-PAYMENT-RESPONSE'), settledPaymentResponse)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, settlementsBeforeReplay)
})

test('a completed direct-sale replay preserves its x402 response header', async () => {
  reset({
    scenario: 'direct sale',
    chainFrom: BUYER_WALLET,
    chainTo: SELLER_WALLET,
    facilitatorVerify: true,
    facilitatorSettle: true,
    offer: { id: 90, status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const reservation = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(reservation.status, 402)

  const exactBody = '{\n  "transfer": {"id":91,"type":"thing","asset_id":42,"from":"tiny-lantern","to":"neighbor","price_usdc":2,"tx_hash":"' + TX1.toLowerCase() + '"},\n  "offer": {"status":"claimed","id":90}\n}'
  const completedAttempt: FakePaymentAttempt = {
    public_id: 'pay_' + '88'.repeat(32),
    actor_id: 8,
    counterparty_id: 7,
    operation: 'direct_sale',
    target_key: 'direct-sale:90',
    offer_id: 90,
    asset_type: 'thing',
    asset_id: 42,
    request_hash: '99'.repeat(32),
    method: 'x402',
    network: 'base',
    token: USDC.toLowerCase(),
    payer_wallet: BUYER_WALLET.toLowerCase(),
    payee_wallet: SELLER_WALLET.toLowerCase(),
    amount_units: '2000000',
    x402_nonce: '0x' + 'cc'.repeat(32),
    x402_payload_digest: 'aa'.repeat(32),
    x402_valid_after: String(AUTHORIZATION_NOW - 120),
    x402_valid_before: String(AUTHORIZATION_NOW + 3600),
    start_block: '256',
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date(Date.now() + 240_000).toISOString(),
    status: 'completed',
    lease_owner: null,
    lease_expires_at: null,
    tx_hash: TX1.toLowerCase(),
    finalized_block_number: '256',
    finalized_block_hash: TX2,
    finalized_block_time: new Date().toISOString(),
    finalized_at: new Date().toISOString(),
    invalid_reason: null,
    result_json: { kind: 'transfer_offer', id: 90 },
    response_status: 200,
    response_json: {
      offer: { id: 90, status: 'claimed' },
      transfer: {
        id: 91,
        type: 'thing',
        asset_id: 42,
        from: 'tiny-lantern',
        to: 'neighbor',
        price_usdc: 2,
        tx_hash: TX1.toLowerCase(),
      },
    },
    response_body_bytes: Buffer.from(exactBody, 'utf8'),
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  }
  state = {
    ...state,
    paymentAttempts: new Map([[completedAttempt.public_id, completedAttempt]]),
  }

  const replay = await app.request('/api/transfer/90/claim', {
    method: 'POST',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })

  assert.equal(replay.status, 200, await replay.clone().text())
  assert.equal(await replay.text(), exactBody)
  assert.ok(replay.headers.get('X-PAYMENT-RESPONSE'))
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 0)
})

test('raw transaction proof cannot create a payment window or bypass its buyer binding', async () => {
  reset({
    scenario: 'sale wallet binding', chainFrom: BUYER_WALLET, chainTo: SELLER_WALLET,
    chainAgeSeconds: 0, offer: { id: 90, status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const premature = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET, tx_hash: TX1 }),
  })
  assert.equal(premature.status, 400)
  assert.equal(state.offer.reservedUntil, null)
  assert.equal(networkCalled('base-rpc.test'), false)

  const reservation = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(reservation.status, 402)
  state = { ...state, chainFrom: STRANGER_WALLET, calls: [] }

  const mismatched = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': STRANGER_SALE_X_PAYMENT },
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(mismatched.status, 400)
  assert.equal(inserted('sale_payments'), 0)
  assert.equal(inserted('payment_uses'), 0)
  assert.equal(state.offer.status, 'open')
})

test('x402 payer must match the wallet bound to the active reservation', async () => {
  reset({
    scenario: 'x402 sale wallet binding', chainFrom: BUYER_WALLET, chainTo: SELLER_WALLET,
    facilitatorVerify: true, facilitatorSettle: true,
    offer: { id: 90, status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const reservation = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(reservation.status, 402)
  state = { ...state, chainFrom: STRANGER_WALLET, calls: [] }

  const mismatched = await app.request('/api/transfer/90/claim', {
    method: 'POST',
    headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': STRANGER_SALE_X_PAYMENT },
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(mismatched.status, 400)
  assert.equal(networkCalled('/settle'), false)
  assert.equal(inserted('sale_payments'), 0)
  assert.equal(state.offer.status, 'open')
  const attemptIndex = state.calls.findIndex(call => /insert\s+into\s+payment_attempts/i.test(call.query ?? ''))
  const settleIndex = state.calls.findIndex(call => call.url.includes('/settle'))
  assert.equal(attemptIndex, -1)
  assert.equal(settleIndex, -1)
})

test('x402 paid creation uses the signed nonce without a payment-identifier extension', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
  })
  const response = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT_NO_ID },
    body: JSON.stringify({ parent_id: null, name: 'Needs Id', description: 'frontier' }),
  })

  assert.equal(response.status, 201, await response.clone().text())
  assert.equal(networkCalled('/settle'), true)
})

test('hosted production paid routes fail closed before custody schema readiness', async () => {
  const previousVercel = process.env.VERCEL
  const previousVercelEnv = process.env.VERCEL_ENV
  const previousReady = process.env.PAYMENT_CUSTODY_READY
  process.env.VERCEL = '1'
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  try {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
    })
    const frontier = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ parent_id: null, name: 'Paused Continent', description: 'frontier' }),
    })
    const kind = await app.request('/api/kind', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        name: 'paused-lantern',
        description: 'payment custody is not ready',
        traits: [],
        recipe: [],
      }),
    })
    const kindRevision = await app.request('/api/kind/3/revise', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        description: 'still blocked',
        traits: ['glowing'],
        recipe: [],
      }),
    })
    const directSale = await app.request('/api/transfer/90/claim', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })

    for (const response of [frontier, kind, kindRevision, directSale]) {
      assert.equal(response.status, 503, await response.clone().text())
      assert.match(await response.text(), /payments are temporarily unavailable/i)
    }
    assert.equal(networkCalled('/settle'), false)
    assert.equal(state.calls.some(call => /payment_attempts/i.test(call.query ?? '')), false)
  } finally {
    if (previousVercel == null) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
    if (previousVercelEnv == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousVercelEnv
    if (previousReady == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousReady
  }
})

test('the same signed x402 nonce cannot be rebound to a different paid purpose', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
  })
  const frontier = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({ parent_id: null, name: 'Bound Continent', description: 'frontier' }),
  })
  assert.equal(frontier.status, 201, await frontier.clone().text())

  const rebound = await app.request('/api/kind', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({
      name: 'rebound-lantern',
      description: 'should fail',
      traits: [],
      recipe: [],
    }),
  })
  assert.equal(rebound.status, 409, await rebound.clone().text())
  assert.match(await rebound.text(), /payment attempt|immutable|different/i)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)
})

test('frontier x402 records custody before settlement and raw transaction proofs stay disabled', async () => {
  reset({
    scenario: 'paid claims', facilitatorVerify: true, facilitatorSettle: true,
    chainFrom: SELLER_WALLET, chainTo: TREASURY,
  })
  const frontier = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({ parent_id: null, name: 'Second Continent', description: 'frontier' }),
  })
  assert.equal(frontier.status, 201, await frontier.clone().text())
  const verifyIndex = state.calls.findIndex(call => call.url.includes('/verify'))
  const settleIndex = state.calls.findIndex(call => call.url.includes('/settle'))
  const attemptIndex = state.calls.findIndex(call => /insert\s+into\s+payment_attempts/i.test(call.query ?? ''))
  const insertIndex = state.calls.findIndex(call => /insert\s+into\s+places/i.test(call.query ?? ''))
  assert.ok(verifyIndex >= 0 && attemptIndex >= 0 && settleIndex > attemptIndex && insertIndex > settleIndex)

  const first = await app.request('/api/kind', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      name: 'lantern', description: 'a light', traits: [], recipe: [],
      payer_wallet: SELLER_WALLET, fee_tx_hash: TX1,
    }),
  })
  assert.equal(first.status, 400)

  const replay = await app.request('/api/place', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      parent_id: null, name: 'Replay Continent', description: 'must fail',
      payer_wallet: SELLER_WALLET, fee_tx_hash: TX_CASE_UPPER,
    }),
  })
  assert.equal(replay.status, 400)
  assert.match(JSON.stringify(await replay.json()), /unsupported field|x-payment/i)
})

test('frontier x402 retry uses the same signed authorization and does not settle twice', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
    failPaidWriteOnce: true,
  })
  const requestBody = JSON.stringify({
    parent_id: null,
    name: 'Retry Continent',
    description: 'same logical purchase',
  })

  const first = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: requestBody,
  })
  assert.equal(first.status, 202, await first.clone().text())
  assert.match(await first.text(), /pending|payment/i)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)

  const retry = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: requestBody,
  })
  assert.equal(retry.status, 201)
  assert.ok(retry.headers.get('X-PAYMENT-RESPONSE'))
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)
  assert.equal(state.paymentHashes.size, 1)
})

test('events keep the public contract while paging stably by kind and id', async () => {
  reset({ scenario: 'public pagination' })
  const firstResponse = await app.request('/api/events?kind=note_created&before_id=65&limit=3')
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as {
    events: Array<{ id: number }>
    has_more: boolean
    next_before_id: number | null
  }
  assert.deepEqual(first.events.map(event => event.id), [64, 62, 60])
  assert.equal(first.has_more, true)
  assert.equal(first.next_before_id, 60)
  const firstRead = sqlCalls().find(call => /from\s+events/i.test(call.query ?? ''))
  assert.deepEqual(
    firstRead?.params?.map((value, index) => index === 0 ? value : Number(value)),
    ['note_created', 65, 4],
    'the database fetches one lookahead row',
  )
  assert.match(firstRead?.query ?? '', /id\s*<\s*\$2::integer/i)
  assert.match(firstRead?.query ?? '', /order\s+by\s+id\s+desc/i)

  state = { ...state, calls: [] }
  const secondResponse = await app.request('/api/events?kind=note_created&before_id=60&limit=3')
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json() as typeof first
  assert.deepEqual(second.events.map(event => event.id), [58, 56, 54])
  assert.equal(second.events.some(event => first.events.some(previous => previous.id === event.id)), false)
})

test('place reads return newest bounded slices and independent continuation cursors', async () => {
  reset({ scenario: 'public pagination' })
  const firstResponse = await app.request('/api/place/2')
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as {
    subplaces: Array<{ id: number }>
    things: Array<{ id: number }>
    notes: Array<{ id: number }>
    subplaces_page: { has_more: boolean; next_before_subplace_id: number | null }
    things_page: { has_more: boolean; next_before_thing_id: number | null }
    notes_page: { has_more: boolean; next_before_note_id: number | null }
  }
  assert.deepEqual(first.subplaces.map(row => row.id), Array.from({ length: 10 }, (_, index) => 160 - index))
  assert.deepEqual(first.things.map(row => row.id), Array.from({ length: 10 }, (_, index) => 260 - index))
  assert.deepEqual(first.notes.map(row => row.id), Array.from({ length: 10 }, (_, index) => 360 - index))
  assert.deepEqual(first.subplaces_page, { has_more: true, next_before_subplace_id: 151 })
  assert.deepEqual(first.things_page, { has_more: true, next_before_thing_id: 251 })
  assert.deepEqual(first.notes_page, { has_more: true, next_before_note_id: 351 })

  for (const pattern of [/from\s+places\s+p[\s\S]*p\.parent_id/i, /from\s+things\s+t/i, /from\s+notes\s+n/i]) {
    const read = sqlCalls().find(call => pattern.test(call.query ?? ''))
    assert.deepEqual(
      read?.params?.map(value => value == null ? null : Number(value)),
      [2, null, 11],
      `lookahead query missing for ${pattern}`,
    )
    assert.match(read?.query ?? '', /order\s+by\s+(?:p\.|t\.|n\.)?id\s+desc/i)
  }

  state = { ...state, calls: [] }
  const secondResponse = await app.request(
    '/api/place/2?before_subplace_id=151&subplace_limit=5' +
      '&before_thing_id=251&thing_limit=5&before_note_id=351&note_limit=5',
  )
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json() as typeof first
  assert.deepEqual(second.subplaces.map(row => row.id), [150, 149, 148, 147, 146])
  assert.deepEqual(second.things.map(row => row.id), [250, 249, 248, 247, 246])
  assert.deepEqual(second.notes.map(row => row.id), [350, 349, 348, 347, 346])
  assert.deepEqual(second.subplaces_page, { has_more: true, next_before_subplace_id: 146 })
  assert.deepEqual(second.things_page, { has_more: true, next_before_thing_id: 246 })
  assert.deepEqual(second.notes_page, { has_more: true, next_before_note_id: 346 })
  assert.equal(second.subplaces.some(row => first.subplaces.some(previous => previous.id === row.id)), false)
  assert.equal(second.things.some(row => first.things.some(previous => previous.id === row.id)), false)
  assert.equal(second.notes.some(row => first.notes.some(previous => previous.id === row.id)), false)
})

test('place reads apply the common limit to every embedded collection', async () => {
  reset({ scenario: 'public pagination' })
  const response = await app.request('/api/place/2?limit=4')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    subplaces: Array<{ id: number }>
    things: Array<{ id: number }>
    notes: Array<{ id: number }>
    subplaces_page: { has_more: boolean; next_before_subplace_id: number | null }
    things_page: { has_more: boolean; next_before_thing_id: number | null }
    notes_page: { has_more: boolean; next_before_note_id: number | null }
  }
  assert.deepEqual(body.subplaces.map(row => row.id), [160, 159, 158, 157])
  assert.deepEqual(body.things.map(row => row.id), [260, 259, 258, 257])
  assert.deepEqual(body.notes.map(row => row.id), [360, 359, 358, 357])
  assert.deepEqual(body.subplaces_page, { has_more: true, next_before_subplace_id: 157 })
  assert.deepEqual(body.things_page, { has_more: true, next_before_thing_id: 257 })
  assert.deepEqual(body.notes_page, { has_more: true, next_before_note_id: 357 })

  for (const pattern of [/from\s+places\s+p[\s\S]*p\.parent_id/i, /from\s+things\s+t/i, /from\s+notes\s+n/i]) {
    const read = sqlCalls().find(call => pattern.test(call.query ?? ''))
    assert.deepEqual(
      read?.params?.map(value => value == null ? null : Number(value)),
      [2, null, 5],
      `common limit lookahead query missing for ${pattern}`,
    )
  }
})

test('place collection-specific limits override the common limit', async () => {
  reset({ scenario: 'public pagination' })
  const response = await app.request(
    '/api/place/2?limit=4&subplace_limit=2&thing_limit=3&note_limit=5',
  )
  assert.equal(response.status, 200)
  const body = await response.json() as {
    subplaces: Array<{ id: number }>
    things: Array<{ id: number }>
    notes: Array<{ id: number }>
  }
  assert.deepEqual(body.subplaces.map(row => row.id), [160, 159])
  assert.deepEqual(body.things.map(row => row.id), [260, 259, 258])
  assert.deepEqual(body.notes.map(row => row.id), [360, 359, 358, 357, 356])
})

test('public listing routes reject invalid and duplicate pagination parameters', async () => {
  const paths = [
    '/api/events?before_id=nope',
    '/api/events?limit=2&limit=3',
    '/api/events?kind=note_created&kind=thing_created',
    '/api/place/2?subplace_limit=201',
    '/api/place/2?before_thing_id=0',
    '/api/place/2?note_limit=2&note_limit=3',
    '/api/place/2?limit=nope',
    '/api/place/2?limit=nope&subplace_limit=2&thing_limit=2&note_limit=2',
    '/api/place/2?limit=2&limit=3',
  ]
  for (const path of paths) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
  }
})

test('non-census growing public collections keep their newest-first 10-row default', async () => {
  const cases = [
    ['/api/kinds', 'kinds', 1170],
    ['/api/traits', 'traits', 1270],
    ['/api/agreements', 'agreements', 1370],
    ['/api/moderation', 'moderation', 1470],
  ] as const

  for (const [path, key, newest] of cases) {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 200, path)
    const body = await response.json() as Record<string, unknown>
    const rows = body[key] as Array<{ id: number }>
    assert.equal(rows.length, 10, path)
    assert.deepEqual(rows.slice(0, 2).map(row => row.id), [newest, newest - 1], path)
    assert.equal(body.has_more, true, path)
    assert.equal(body.next_before_id, newest - 9, path)
  }
})

test('parameterless resident census returns every resident below its 200-row default', async () => {
  reset({ scenario: 'remaining pagination' })
  const response = await app.request('/api/residents')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    residents: Array<{ id: number }>
    count: number
    total: number
    returned: number
    page_size: number
    has_more: boolean
    next_before_id: number | null
  }

  const expectedIds = recentIds(1070)
  assert.deepEqual(body.residents.map(row => row.id), expectedIds)
  assert.equal(body.count, expectedIds.length)
  assert.equal(body.total, expectedIds.length)
  assert.equal(body.returned, expectedIds.length)
  assert.equal(body.page_size, 200)
  assert.equal(body.has_more, false)
  assert.equal(body.next_before_id, null)

  const residentRead = sqlCalls().find(call => /\/\* public:residents \*\//i.test(call.query ?? ''))
  assert.deepEqual(
    residentRead?.params?.map(value => value == null ? null : Number(value)),
    [null, 201],
    'the default census query must fetch one lookahead row beyond its 200-row page',
  )
  const censusReads = sqlCalls().filter(call => (
    /\/\* public:residents \*\//i.test(call.query ?? '')
      || /\/\* public:resident-count \*\//i.test(call.query ?? '')
  ))
  assert.equal(censusReads.length, 1, 'the census page and total must share one database snapshot')
  assert.match(censusReads[0]?.query ?? '', /count\s*\(\s*\*\s*\)/i)
})

test('resident census pages by arrival time with stable id ties and no boundary repeats', async () => {
  reset({ scenario: 'resident arrival pagination' })
  const firstResponse = await app.request('/api/residents?limit=2')
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as {
    residents: Array<{ id: number }>
    count: number
    total: number
    returned: number
    page_size: number
    has_more: boolean
    next_before_id: number | null
  }
  assert.deepEqual(first.residents.map(row => row.id), [800, 5])
  assert.equal(first.count, 6)
  assert.equal(first.total, 6)
  assert.equal(first.returned, 2)
  assert.equal(first.page_size, 2)
  assert.equal(first.has_more, true)
  assert.equal(first.next_before_id, 5)

  const firstRead = sqlCalls().find(call => /\/\* public:residents \*\//i.test(call.query ?? ''))
  assert.match(
    firstRead?.query ?? '',
    /\(resident\.joined_at\s*,\s*resident\.id\)\s*<\s*\(\s*select\s+boundary\.joined_at\s*,\s*boundary\.id/i,
  )
  assert.match(firstRead?.query ?? '', /order\s+by\s+resident\.joined_at\s+desc\s*,\s*resident\.id\s+desc/i)
  assert.deepEqual(firstRead?.params?.map(value => value == null ? null : Number(value)), [null, 3])

  state = { ...state, calls: [] }
  const secondResponse = await app.request('/api/residents?before_id=5&limit=2')
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json() as typeof first
  assert.deepEqual(second.residents.map(row => row.id), [910, 200])
  assert.equal(second.count, 6)
  assert.equal(second.total, 6)
  assert.equal(second.returned, 2)
  assert.equal(second.page_size, 2)
  assert.equal(second.has_more, true)
  assert.equal(second.next_before_id, 200)
  assert.equal(second.residents.some(row => first.residents.some(previous => previous.id === row.id)), false)

  state = { ...state, calls: [] }
  const thirdResponse = await app.request('/api/residents?before_id=200&limit=2')
  assert.equal(thirdResponse.status, 200)
  const third = await thirdResponse.json() as typeof first
  assert.deepEqual(third.residents.map(row => row.id), [100, 1000])
  assert.equal(third.count, 6)
  assert.equal(third.total, 6)
  assert.equal(third.returned, 2)
  assert.equal(third.page_size, 2)
  assert.equal(third.has_more, false)
  assert.equal(third.next_before_id, null)

  const emptyResponse = await app.request('/api/residents?limit=2&before_id=1000')
  assert.equal(emptyResponse.status, 200)
  const empty = await emptyResponse.json() as typeof first
  assert.deepEqual(empty.residents, [])
  assert.equal(empty.count, 6)
  assert.equal(empty.total, 6)
  assert.equal(empty.returned, 0)
  assert.equal(empty.page_size, 2)
  assert.equal(empty.has_more, false)
  assert.equal(empty.next_before_id, null)
})

test('public collection cursors preserve agreement filters and never repeat the boundary', async () => {
  reset({ scenario: 'remaining pagination' })
  const response = await app.request(
    '/api/agreements?party=tiny-lantern&open=true&before_id=1360&limit=3',
  )
  assert.equal(response.status, 200)
  const body = await response.json() as {
    agreements: Array<{ id: number; open: boolean }>
    has_more: boolean
    next_before_id: number | null
  }
  assert.deepEqual(body.agreements.map(row => row.id), [1358, 1356, 1354])
  assert.equal(body.agreements.every(row => row.open), true)
  assert.equal(body.has_more, true)
  assert.equal(body.next_before_id, 1354)
  const read = sqlCalls().find(call => /\/\* public:agreements \*\//i.test(call.query ?? ''))
  assert.deepEqual(
    read?.params?.map((value, index) => index === 1 ? String(value) : value == null ? null : String(value)),
    ['tiny-lantern', 'true', '1360', '4'],
  )

  state = { ...state, calls: [] }
  const nextResponse = await app.request(
    '/api/agreements?party=tiny-lantern&open=true&before_id=1354&limit=3',
  )
  const next = await nextResponse.json() as typeof body
  assert.deepEqual(next.agreements.map(row => row.id), [1352, 1350, 1348])
  assert.equal(next.agreements.some(row => body.agreements.some(previous => previous.id === row.id)), false)
})

test('remaining public collections reject invalid or duplicate page parameters', async () => {
  for (const path of [
    '/api/residents?before_id=0',
    '/api/kinds?limit=201',
    '/api/traits?before_id=nope',
    '/api/agreements?party=tiny-lantern&party=neighbor',
    '/api/agreements?open=true&open=false',
    '/api/agreements?limit=2&limit=3',
    '/api/moderation?before_id=2&before_id=1',
  ]) {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
  }
})

test('/api/me independently pages every growing holdings and history collection', async () => {
  reset({ scenario: 'remaining pagination' })
  const firstResponse = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as Record<string, unknown>
  const newestByCollection = {
    places: 1570,
    things: 1670,
    kinds: 1770,
    agreements: 1870,
    notes: 1970,
    offers: 2070,
  } as const
  const pages = first.pages as Record<string, Record<string, unknown>>
  for (const [collection, newest] of Object.entries(newestByCollection)) {
    const rows = first[collection] as Array<{ id: number }>
    assert.equal(rows.length, 10, collection)
    assert.deepEqual(rows.slice(0, 2).map(row => row.id), [newest, newest - 1], collection)
    assert.equal(pages[collection]?.has_more, true, collection)
    assert.equal(pages[collection]?.[`next_before_${collection.replace(/s$/, '')}_id`], newest - 9, collection)
  }

  state = { ...state, calls: [] }
  const secondResponse = await app.request(
    '/api/me?before_place_id=1561&place_limit=3' +
      '&before_thing_id=1661&thing_limit=3&before_kind_id=1761&kind_limit=3' +
      '&before_agreement_id=1861&agreement_limit=3&before_note_id=1961&note_limit=3' +
      '&before_offer_id=2061&offer_limit=3',
    { headers: authHeaders() },
  )
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json() as Record<string, unknown>
  for (const [collection, newest] of Object.entries(newestByCollection)) {
    const rows = second[collection] as Array<{ id: number }>
    assert.deepEqual(rows.map(row => row.id), [newest - 10, newest - 11, newest - 12], collection)
    const previous = first[collection] as Array<{ id: number }>
    assert.equal(rows.some(row => previous.some(item => item.id === row.id)), false, collection)
  }
})

test('/api/me rejects invalid independent page parameters after authentication', async () => {
  for (const path of [
    '/api/me?place_limit=201',
    '/api/me?before_thing_id=0',
    '/api/me?note_limit=2&note_limit=3',
    '/api/me?before_offer_id=wat',
  ]) {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request(path, { headers: authHeaders() })
    assert.equal(response.status, 400, path)
  }
})

test('official facts, events, residents, and treasury are public and anti-token', async () => {
  reset({ scenario: 'public books' })
  const official = await app.request('/api/official')
  assert.equal(official.status, 200)
  const facts = await official.json() as {
    domain: string; treasury: string; network: string; token: null; statement: string
  }
  assert.equal(facts.domain, 'https://1f3d9.com')
  assert.equal(facts.treasury.toLowerCase(), TREASURY)
  assert.equal(facts.network, 'base')
  assert.equal(facts.token, null)
  assert.match(facts.statement, /no .*token|there is no/i)

  const [events, residents, treasury] = await Promise.all([
    app.request('/api/events'), app.request('/api/residents'), app.request('/treasury'),
  ])
  assert.equal(events.status, 200)
  assert.equal(residents.status, 200)
  assert.equal(treasury.status, 200)
  assert.equal(JSON.stringify(await residents.json()).includes('secret'), false)
  const books = await treasury.json() as { address: string; fees_collected_usdc: number; note: string }
  assert.equal(books.address.toLowerCase(), TREASURY)
  assert.equal(books.fees_collected_usdc, 1)
  assert.match(books.note, /sales.*never|peer.to.peer|wallet/i)
})

test('anonymous flags are rate-limited without publishing the report text', async () => {
  reset({ scenario: 'flag quota' })
  const body = JSON.stringify({ target_type: 'thing', target_id: 41, reason: 'private report detail' })
  for (let index = 0; index < 5; index += 1) {
    const accepted = await app.request('/api/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'spoof, 203.0.113.30' },
      body,
    })
    assert.equal(accepted.status, 201)
  }
  const limited = await app.request('/api/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'other-spoof, 203.0.113.30' },
    body,
  })
  assert.equal(limited.status, 429)
  assert.equal(inserted('flags'), 5)
  const flagWrite = sqlCalls().find(call => /insert\s+into\s+flags\b/i.test(call.query ?? ''))
  assert.ok(flagWrite)
  assert.doesNotMatch(flagWrite.query ?? '', /jsonb_build_object\([\s\S]*?'reason'/i)

  state = { ...state, calls: [] }
  const authenticated = await app.request('/api/flag', {
    method: 'POST', headers: authHeaders(), body,
  })
  assert.equal(authenticated.status, 201)
  assert.equal(sqlCalls().some(call => /anonymous_flag_limits/i.test(call.query ?? '')), false)
})

test('MCP advertises the city tools and dispatches through bearer-header API auth', async () => {
  reset({ scenario: 'mcp', openToNotes: true })
  const listed = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as {
    result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }
  }
  assert.deepEqual(listBody.result.tools.map(tool => tool.name), [
    'look', 'found', 'make', 'act', 'laws', 'home', 'withdraw',
    'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'transfer',
    'agree', 'open_agreement_accession', 'sign', 'say', 'me', 'moderate',
  ])
  assert.equal(listBody.result.tools.every(tool => !('secret' in (tool.inputSchema.properties ?? {}))), true)
  const transferTool = listBody.result.tools.find(tool => tool.name === 'transfer')
  assert.ok(transferTool?.inputSchema.properties && 'buyer_wallet' in transferTool.inputSchema.properties)
  const makeTool = listBody.result.tools.find(tool => tool.name === 'make')
  assert.ok(makeTool?.inputSchema.properties && 'open_to_use' in makeTool.inputSchema.properties)

  for (const key of ['secret', 'authorization', 'token', 'api_key', 'unexpected']) {
    const unsafeArgument = await app.request('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'say', arguments: { [key]: SECRET, place_id: 2, body: 'unsafe' } },
      }),
    })
    const rejected = await unsafeArgument.json() as {
      result: { isError: boolean; content: { text: string }[] }
    }
    assert.equal(rejected.result.isError, true)
    assert.match(rejected.result.content[0]!.text, /authorization header|unsupported tool argument/i)
  }
  assert.equal(inserted('notes'), 0)

  const said = await app.request('/mcp', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'say', arguments: { place_id: 2, body: 'hello from the square' } },
    }),
  })
  const dispatched = await said.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(dispatched.result.isError, false)
  assert.equal((JSON.parse(dispatched.result.content[0]!.text) as { note: { author: string } }).note.author, 'tiny-lantern')

  state = {
    ...state,
    actorId: 8,
    actorHandle: 'neighbor',
    offer: { id: 90, status: 'open', reservedAt: null, reservedUntil: null, buyerWallet: null },
  }
  const claim = await app.request('/mcp', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        name: 'transfer',
        arguments: { action: 'claim', offer_id: 90, buyer_wallet: BUYER_WALLET },
      },
    }),
  })
  const challenged = await claim.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(challenged.result.isError, true)
  assert.match(challenged.result.content[0]!.text, /reservation opened|five minutes/i)
  assert.equal(state.offer.buyerWallet, BUYER_WALLET)
})

test('front door and human window surface the event names the world actually emits', async () => {
  reset({ scenario: 'activity surfaces' })
  const front = await app.request('/')
  assert.equal(front.status, 200)
  const frontText = await front.text()
  assert.match(frontText, /founded a place/i)
  assert.match(frontText, /bought property/i)
  assert.match(frontText, /canceled a sale offer/i)

  state = { ...state, calls: [] }
  const snapshot = await app.request('/api/window')
  assert.equal(snapshot.status, 200)
  const payload = await snapshot.json() as {
    events: { kind: string }[]
    body_limits: { notes: number; things: number; agreements: number }
  }
  assert.deepEqual(payload.events.map(event => event.kind), ['place_created', 'sale', 'transfer_cancel'])
  assert.deepEqual(payload.body_limits, { notes: 2_000, things: 1_000, agreements: 4_000 })
  const eventKindParams = JSON.stringify(sqlCalls().flatMap(call => call.params ?? []))
  for (const kind of ['place_created', 'thing_created', 'kind_invented', 'kind_revised', 'trait_coined', 'sale', 'transfer_cancel']) {
    assert.ok(eventKindParams.includes(kind), `public event query should include ${kind}`)
  }

  const script = await app.request('/window.js')
  const source = await script.text()
  assert.match(source, /place_created[^\n]*founded a place/i)
  assert.match(source, /sale[^\n]*bought property/i)
  assert.match(source, /transfer_cancel[^\n]*canceled a sale offer/i)
})

test('the human window is hardened, query-blind, credential-blind, and read-only', async () => {
  reset({ scenario: 'window' })
  const query = await app.request('/api/window?nonce=cache-bust')
  assert.equal(query.status, 400)
  assert.equal(sqlCalls().length, 0)

  const credentialed = await app.request('/api/window', { headers: { Authorization: `Bearer ${SECRET}` } })
  assert.equal(credentialed.status, 400)
  assert.equal(sqlCalls().length, 0)

  const page = await app.request('/window')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.match(page.headers.get('permissions-policy') ?? '', /payment=\(\)/)

  const attemptedWrite = await app.request('/window', { method: 'POST', body: 'human action' })
  assert.equal(attemptedWrite.status, 404)
})

test('physics publishes one frozen mechanism vocabulary with hard safety ceilings', async () => {
  reset({ scenario: 'physics contract' })
  const response = await app.request('/api/physics')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    basic_actions: string[]
    effect_bricks: string[]
    limits: {
      max_block_seconds: number
      max_generation: number
      max_timer_seconds: number
      max_craft_ingredients: number
      max_pending_effects_per_place: number
      max_pending_effects_per_actor: number
      max_due_effects_per_observation: number
    }
  }
  assert.deepEqual(body.basic_actions, ['talk', 'move', 'use', 'give', 'consume', 'make', 'go_home'])
  assert.deepEqual(body.effect_bricks, ['destroy', 'move', 'transfer', 'label', 'block', 'wait', 'check_label'])
  assert.equal(body.limits.max_block_seconds, 86_400)
  assert.equal(body.limits.max_generation, 8)
  assert.equal(body.limits.max_timer_seconds, 86_400)
  assert.equal(body.limits.max_craft_ingredients, 1_024)
  assert.equal(body.limits.max_pending_effects_per_place, 512)
  assert.equal(body.limits.max_pending_effects_per_actor, 1_024)
  assert.equal(body.limits.max_due_effects_per_observation, 512)
})

test('a place owner replaces local laws while a visitor cannot legislate there', async () => {
  reset({ scenario: 'place laws', placeOwnerId: 7 })
  const changed = await app.request('/api/place/2/laws', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify({ traits: ['war-zone'] }),
  })
  assert.equal(changed.status, 200)
  const body = await changed.json() as { laws: { name: string }[] }
  assert.deepEqual(body.laws.map(law => law.name), ['war-zone'])
  assert.ok(inserted('place_law_changes') > 0)
  const lawWrite = sqlCalls().find(call => /insert\s+into\s+place_law_changes/i.test(call.query ?? ''))
  assert.match(lawWrite?.query ?? '', /\$\d+::integer\s+as\s+actor_id/i)
  assert.match(lawWrite?.query ?? '', /union\s+all[\s\S]*\$\d+::integer\s*,\s*'add'/i)

  setActor(8, 'neighbor')
  const rejected = await app.request('/api/place/2/laws', {
    method: 'PUT', headers: authHeaders(OTHER_SECRET), body: JSON.stringify({ traits: [] }),
  })
  assert.equal(rejected.status, 403)
})

test('go_home remains available when ordinary movement is actively blocked', async () => {
  reset({ scenario: 'bedrock home', actionBlocked: true, currentPlaceId: 2, homePlaceId: 2 })
  const moved = await app.request('/api/action', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'move', to_place_id: 3 }),
  })
  assert.equal(moved.status, 403)
  assert.match(JSON.stringify(await moved.json()), /blocked/i)

  const home = await app.request('/api/action', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'go_home' }),
  })
  assert.equal(home.status, 200)
  const body = await home.json() as { action: { action: string; place_id: number } }
  assert.equal(body.action.action, 'go_home')
  assert.equal(body.action.place_id, 2)
})

test('thing withdrawal is owner-only, one-way, and refused during an open sale', async () => {
  reset({ scenario: 'thing withdrawal' })
  const withdrawn = await app.request('/api/thing/41/withdraw', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(withdrawn.status, 200)
  const body = await withdrawn.json() as { thing: { id: number; withdrawn_at: string } }
  assert.equal(body.thing.id, 41)
  assert.ok(Number.isFinite(Date.parse(body.thing.withdrawn_at)))
  assert.ok(sqlCalls().some(call =>
    /update\s+things\s+set\s+withdrawn_at/i.test(call.query ?? '') &&
    /insert\s+into\s+events/i.test(call.query ?? '')))
  const withdrawalWrite = sqlCalls().find(call =>
    /update\s+things\s+set\s+withdrawn_at/i.test(call.query ?? '') &&
    /insert\s+into\s+events/i.test(call.query ?? ''))
  assert.match(
    withdrawalWrite?.query ?? '',
    /jsonb_build_object\(\s*'thing_id'\s*,\s*id\s*,\s*'reason'\s*,\s*\$\d+::text\s*\)/i,
  )

  reset({ scenario: 'thing withdrawal sale', offer: { ...initialState().offer, status: 'open' } })
  const locked = await app.request('/api/thing/41/withdraw', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(locked.status, 409)
})

test('only resident one can remove or restore public content and every use is logged', async () => {
  reset({ scenario: 'maintainer moderation' })
  const denied = await app.request('/api/moderation', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ action: 'remove', target_type: 'thing', target_id: 41, reason: 'illegal content' }),
  })
  assert.equal(denied.status, 403)
  assert.equal(inserted('moderation_actions'), 0)

  setActor(1, 'founder')
  const removed = await app.request('/api/moderation', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ action: 'remove', target_type: 'thing', target_id: 41, reason: 'illegal content' }),
  })
  assert.equal(removed.status, 201)
  assert.ok(inserted('moderation_actions') > 0)
  assert.ok(sqlCalls().some(call =>
    /insert\s+into\s+events/i.test(call.query ?? '') && /'moderation'/i.test(call.query ?? '')))
})

test('withdrawing a thing hides it from the street and freezes further edits', async () => {
  reset({ scenario: 'withdraw thing' })
  const withdrawn = await app.request('/api/thing/41/withdraw', {
    method: 'POST', headers: authHeaders(),
  })
  assert.equal(withdrawn.status, 200)
  const withdrawnBody = await withdrawn.json() as { thing: { id: number; withdrawn_at: string } }
  assert.equal(withdrawnBody.thing.id, 41)
  assert.match(withdrawnBody.thing.withdrawn_at, /2026-08-11T/)

  state = { ...state, calls: [] }
  const place = await app.request('/api/place/2')
  assert.equal(place.status, 200)
  const placeBody = await place.json() as { things: { id: number }[] }
  assert.equal(placeBody.things.some(thing => thing.id === 41), false)

  const edited = await app.request('/api/thing/41', {
    method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ body: 'too late' }),
  })
  assert.equal(edited.status, 404)
})

test('thing detail and place reads expose open_to_use, defaulting to false', async () => {
  reset({ scenario: 'thing open_to_use read', thingOpenToUse: false })

  const [thingResponse, placeResponse] = await Promise.all([
    app.request('/api/thing/41'),
    app.request('/api/place/2'),
  ])
  assert.equal(thingResponse.status, 200)
  assert.equal(placeResponse.status, 200)

  const thingBody = await thingResponse.json() as { thing: { open_to_use: boolean } }
  const placeBody = await placeResponse.json() as {
    things: Array<{ id: number; open_to_use: boolean }>
  }
  assert.equal(thingBody.thing.open_to_use, false)
  assert.equal(placeBody.things.find(thing => thing.id === 41)?.open_to_use, false)
  const detailRead = sqlCalls().find(call => (
    /from\s+things\s+thing/i.test(call.query ?? '') && /where\s+thing\.id/i.test(call.query ?? '')
  ))
  const placeRead = sqlCalls().find(call => /from\s+things\s+t\b/i.test(call.query ?? ''))
  assert.match(detailRead?.query ?? '', /thing\.open_to_use/i)
  assert.match(placeRead?.query ?? '', /t\.open_to_use/i)

  reset({ scenario: 'remaining pagination' })
  const meResponse = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(meResponse.status, 200)
  const meBody = await meResponse.json() as { things: Array<{ open_to_use: boolean }> }
  assert.equal(meBody.things[0]?.open_to_use, false)
  const meRead = sqlCalls().find(call => /\/\*\s*public:me_things\s*\*\//i.test(call.query ?? ''))
  assert.match(meRead?.query ?? '', /\bopen_to_use\b/i)
})

test('new things default closed and may be opened explicitly by their creator', async () => {
  reset({ scenario: 'thing open_to_use create default', openToThings: true })
  const closed = await app.request('/api/thing', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, name: 'closed lantern', body: 'owner use only' }),
  })
  assert.equal(closed.status, 201)
  const closedBody = await closed.json() as { thing: { open_to_use: boolean } }
  assert.equal(closedBody.thing.open_to_use, false)

  reset({ scenario: 'thing open_to_use create explicit', openToThings: true, thingOpenToUse: true })
  const opened = await app.request('/api/thing', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      place_id: 2, name: 'public lantern', body: 'visitors may use this', open_to_use: true,
    }),
  })
  assert.equal(opened.status, 201, await opened.clone().text())
  const openedBody = await opened.json() as { thing: { open_to_use: boolean } }
  assert.equal(openedBody.thing.open_to_use, true)
  const insert = sqlCalls().find(call => /insert\s+into\s+things/i.test(call.query ?? ''))
  assert.match(insert?.query ?? '', /\bopen_to_use\b/i)
  assert.equal(insert?.params?.some(value => value === true || value === 'true'), true)

  for (const invalid of [null, 'yes', 1]) {
    const response = await app.request('/api/thing', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        place_id: 2, name: 'invalid lantern', body: '', open_to_use: invalid,
      }),
    })
    assert.equal(response.status, 400)
  }
})

test('the thing owner can toggle open_to_use and a visitor cannot edit it', async () => {
  reset({ scenario: 'thing open_to_use patch', thingOwnerId: 7, thingOpenToUse: false })

  const changed = await app.request('/api/thing/41', {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ open_to_use: true }),
  })
  assert.equal(changed.status, 200)
  const changedBody = await changed.json() as { thing: { open_to_use: boolean } }
  assert.equal(changedBody.thing.open_to_use, true)
  const update = sqlCalls().find(call => /update\s+things\s+set/i.test(call.query ?? ''))
  assert.match(update?.query ?? '', /\bopen_to_use\b/i)

  reset({ scenario: 'thing open_to_use patch denied', thingOwnerId: 7, thingOpenToUse: false })
  setActor(8, 'neighbor')
  const denied = await app.request('/api/thing/41', {
    method: 'PATCH',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ open_to_use: true }),
  })
  assert.equal(denied.status, 403)

  reset({ scenario: 'thing open_to_use validation' })
  for (const invalid of [null, 'yes', 1]) {
    const response = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ open_to_use: invalid }),
    })
    assert.equal(response.status, 400)
  }

  reset({
    scenario: 'thing open_to_use offer lock',
    offer: { id: 90, status: 'open', reservedAt: null, reservedUntil: null, buyerWallet: null },
  })
  const offered = await app.request('/api/thing/41', {
    method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ open_to_use: true }),
  })
  assert.equal(offered.status, 409)
})

test('use composes effects, local laws act on talk, and going home stays unblockable', async () => {
  reset({
    scenario: 'effects and laws',
    actorId: 8,
    actorHandle: 'neighbor',
    thingOwnerId: 8,
    openToNotes: true,
    currentPlaceId: 2,
    homePlaceId: 3,
    thingTraitRecipe: {
      use: [
        { effect: 'label', target: 'actor', label: 'authorized' },
        {
          effect: 'check_label', target: 'actor', label: 'authorized', then: [
            { effect: 'move', target: 'actor', to: 'destination' },
            { effect: 'wait', seconds: 60, then: [
              { effect: 'label', target: 'place', label: 'echo' },
            ] },
          ],
        },
      ],
    },
    placeLawNames: ['quiet-hours'],
    lawTraitRecipe: { talk: [{ effect: 'block', action: 'talk', target: 'actor', seconds: 60 }] },
  })
  const used = await app.request('/api/action', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ action: 'use', thing_id: 41, to_place_id: 3 }),
  })
  assert.equal(used.status, 200, await used.clone().text())
  const usedBody = await used.json() as {
    action: { place_id: number | null; effects_applied: number }
  }
  assert.equal(usedBody.action.place_id, 3)
  assert.ok(usedBody.action.effects_applied >= 3)
  assert.deepEqual(state.actorLabels, ['authorized'])
  assert.notEqual(state.scheduledLabelAt, null)

  state = { ...state, calls: [], currentPlaceId: 2, actionBlocked: false }
  const firstTalk = await app.request('/api/note', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ place_id: 2, body: 'one last word' }),
  })
  assert.equal(firstTalk.status, 201)
  assert.equal(state.actionBlocked, true)

  const blocked = await app.request('/api/note', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ place_id: 2, body: 'temporarily blocked' }),
  })
  assert.equal(blocked.status, 403)
  assert.match(JSON.stringify(await blocked.json()), /blocked/i)

  const home = await app.request('/api/go-home', {
    method: 'POST',
    headers: { ...authHeaders(OTHER_SECRET), 'Content-Length': '0' },
  })
  assert.equal(home.status, 200)
  const homeBody = await home.json() as { action: { place_id: number | null } }
  assert.equal(homeBody.action.place_id, 3)
})

test('a visitor may use an open thing but not consume it', async () => {
  reset({
    scenario: 'shared use allowed',
    actorId: 8,
    actorHandle: 'neighbor',
    thingOwnerId: 7,
    thingOpenToUse: true,
    currentPlaceId: 2,
    thingTraitRecipe: { use: [{ effect: 'label', target: 'actor', label: 'welcomed' }] },
  })
  const used = await app.request('/api/action', {
    method: 'POST',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ action: 'use', thing_id: 41 }),
  })
  assert.equal(used.status, 200, await used.clone().text())

  const consumed = await app.request('/api/action', {
    method: 'POST',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ action: 'consume', thing_id: 41 }),
  })
  assert.equal(consumed.status, 403)
})

for (const [label, recipe] of [
  ['destroy', [{ effect: 'destroy', target: 'source' }]],
  ['move', [{ effect: 'move', target: 'source', to: 'destination' }]],
  ['transfer', [{ effect: 'transfer', target: 'source', to: 'recipient' }]],
  ['wait-destroy', [{ effect: 'wait', seconds: 60, then: [{ effect: 'destroy', target: 'source' }] }]],
] as const) {
  test(`shared use blocks ${label} against the open source thing`, async () => {
    reset({
      scenario: `shared use ${label} blocked`,
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 7,
      thingOpenToUse: true,
      currentPlaceId: 2,
      thingTraitRecipe: { use: recipe },
    })
    const response = await app.request('/api/action', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({
        action: 'use',
        thing_id: 41,
        to_place_id: 3,
        to_handle: 'tiny-lantern',
      }),
    })
    assert.equal(response.status, 403, await response.clone().text())
  })
}

test('damage stays off unless the place consents, and stored timers resolve on observation', async () => {
  const originalNow = Date.now
  try {
    const startedAt = Date.parse('2026-08-11T00:00:00.000Z')
    Date.now = () => startedAt
    reset({
      scenario: 'damage and timers',
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 8,
      targetThingOwnerId: 7,
      thingTraitRecipe: {
        use: [{ effect: 'destroy', target: 'target' }],
      },
    })
    const peaceful = await app.request('/api/action', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ action: 'use', thing_id: 41, target_type: 'thing', target_id: 42 }),
    })
    assert.equal(peaceful.status, 403, await peaceful.clone().text())
    assert.equal(state.targetThingWithdrawn, false)

    reset({
      scenario: 'damage and timers',
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 8,
      targetThingOwnerId: 7,
      thingTraitRecipe: {
        use: [
          {
            effect: 'check_label', target: 'place', label: 'war-zone', then: [
              { effect: 'destroy', target: 'target' },
            ],
          },
          { effect: 'wait', seconds: 60, then: [{ effect: 'label', target: 'place', label: 'echo' }] },
        ],
      },
      placeLawNames: ['war-zone'],
      lawTraitRecipe: null,
    })
    const violent = await app.request('/api/action', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ action: 'use', thing_id: 41, target_type: 'thing', target_id: 42 }),
    })
    assert.equal(violent.status, 200)
    assert.equal(state.targetThingWithdrawn, true, JSON.stringify(sqlCalls()))
    assert.equal(state.placeLabels.includes('echo'), false)

    Date.now = () => startedAt + 61_000
    const humanLook = await app.request('/api/place/2')
    const humanBody = await humanLook.json() as { place: { labels?: string[] } }
    assert.deepEqual(humanBody.place.labels, [])
    assert.equal(state.pendingResolved, false)

    const observed = await app.request('/api/place/2', { headers: authHeaders(OTHER_SECRET) })
    assert.equal(observed.status, 200)
    const observedBody = await observed.json() as { place: { labels?: string[] } }
    assert.deepEqual(observedBody.place.labels, ['echo'])
  } finally {
    Date.now = originalNow
  }
})

test('founder moderation is remove-or-restore tombstoning, never governance', async () => {
  reset({ scenario: 'moderation' })
  setActor(1, 'founder')
  const removed = await app.request('/api/moderation', {
    method: 'POST',
    headers: authHeaders('1f3d9_sk_' + 'ef'.repeat(24)),
    body: JSON.stringify({ action: 'remove', target_type: 'note', target_id: 51, reason: 'illegal content' }),
  })
  assert.equal(removed.status, 201)

  state = { ...state, calls: [] }
  const tombstoned = await app.request('/api/place/2')
  assert.equal(tombstoned.status, 200)
  const tombstonedBody = await tombstoned.json() as {
    notes: Array<{ id: number; body: string; moderated?: boolean; moderation?: { reason: string } }>
  }
  assert.equal(tombstonedBody.notes[0]?.id, 51, JSON.stringify(tombstonedBody))
  assert.equal(tombstonedBody.notes[0]?.body, '[removed by maintainer]')
  assert.equal(tombstonedBody.notes[0]?.moderated, true)
  assert.equal(tombstonedBody.notes[0]?.moderation?.reason, 'illegal content')

  const pinned = await app.request('/api/moderation', {
    method: 'POST',
    headers: authHeaders('1f3d9_sk_' + 'ef'.repeat(24)),
    body: JSON.stringify({ action: 'pin', target_type: 'note', target_id: 51, reason: 'town notice' }),
  })
  assert.equal(pinned.status, 400)

  setActor(8, 'neighbor')
  const forbidden = await app.request('/api/moderation', {
    method: 'POST',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ action: 'restore', target_type: 'note', target_id: 51, reason: 'no power' }),
  })
  assert.equal(forbidden.status, 403)

  setActor(1, 'founder')
  const restored = await app.request('/api/moderation', {
    method: 'POST',
    headers: authHeaders('1f3d9_sk_' + 'ef'.repeat(24)),
    body: JSON.stringify({ action: 'restore', target_type: 'note', target_id: 51, reason: 'restored' }),
  })
  assert.equal(restored.status, 201)
  assert.equal(state.noteRemoved, false)

  const visible = await app.request('/api/place/2')
  const visibleBody = await visible.json() as { notes: Array<{ body: string; moderated?: boolean }> }
  assert.equal(visibleBody.notes[0]?.body, 'hello from the square')
  assert.equal(visibleBody.notes[0]?.moderated, undefined)
})

test('removed kind and trait names cannot leak through place laws or nested kind references', async () => {
  const lawRecipe = { talk: [{ effect: 'label', target: 'place', label: 'secret-law-effect' }] }
  reset({
    scenario: 'nested moderation references',
    placeLawNames: ['quiet-hours'],
    lawTraitRecipe: lawRecipe,
    kindTraitNames: ['glowing', 'safe-trait'],
    kindRecipe: [
      { kind: 'banned-material', quantity: 1 },
      { kind: 'safe-material', quantity: 2 },
    ],
    moderatedKindIds: [3],
    moderatedKindNames: ['banned-material'],
    moderatedTraitIds: [4],
    moderatedTraitNames: ['glowing', 'quiet-hours'],
  })

  const placeResponse = await app.request('/api/place/2')
  assert.equal(placeResponse.status, 200)
  const place = await placeResponse.json() as {
    place: { id: number; owner_id: number; laws: Array<Record<string, unknown>> }
    things: Array<Record<string, unknown>>
  }
  assert.equal(place.place.id, 2)
  assert.equal(place.things[0]?.id, 41)
  assert.equal(place.things[0]?.owner_id, state.thingOwnerId)
  assert.equal(place.things[0]?.kind_id, 3)
  assert.equal(place.things[0]?.kind, '[removed by maintainer]')
  assert.equal(place.place.laws[0]?.traitId, 4)
  assert.equal(place.place.laws[0]?.name, '[removed by maintainer]')
  assert.equal(place.place.laws[0]?.recipe, null)
  assert.equal(JSON.stringify(place).includes('secret-law-effect'), false)
  assert.deepEqual(state.lawTraitRecipe, lawRecipe, 'stored law recipe remains unchanged')

  state = { ...state, calls: [], moderatedKindIds: [] }
  const kindsResponse = await app.request('/api/kinds')
  assert.equal(kindsResponse.status, 200)
  const kindsBody = await kindsResponse.json() as { kinds: Array<Record<string, unknown>> }
  const kind = kindsBody.kinds[0]!
  assert.equal(kind.id, 3)
  assert.equal(kind.owner_id, state.kindOwnerId)
  assert.deepEqual(kind.traits, ['[removed by maintainer]', 'safe-trait'])
  assert.deepEqual(kind.recipe, [
    { kind: '[removed by maintainer]', quantity: 1 },
    { kind: 'safe-material', quantity: 2 },
  ])
  const moderationReads = sqlCalls().filter(call => /from moderation_actions/i.test(call.query ?? ''))
  assert.ok(moderationReads.length <= 3, `nested moderation must stay batched: ${moderationReads.length}`)
  assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)
})

test('event history supports bounded cursor pages without changing the events array', async () => {
  reset({ scenario: 'event pagination' })
  const page = await app.request('/api/events?kind=note&before_id=204&limit=2')
  assert.equal(page.status, 200)
  const body = await page.json() as {
    events: Array<{ id: number }>
    has_more: boolean
    next_before_id: number | null
  }
  assert.deepEqual(body.events.map(event => event.id), [203, 202])
  assert.equal(body.has_more, true)
  assert.equal(body.next_before_id, 202)
  const eventRead = sqlCalls().find(call => /select\s+id,\s*at,\s*kind,\s*actor,\s*detail[\s\S]*from\s+events/i
    .test(call.query ?? ''))
  assert.match(eventRead?.query ?? '', /\$2::integer\s+is\s+null\s+or\s+id\s*<\s*\$2::integer/i)
  assert.match(eventRead?.query ?? '', /limit\s+\$3::integer/i)
  assert.deepEqual(eventRead?.params, ['note', '204', '3'])

  reset({ scenario: 'event pagination' })
  assert.equal((await app.request('/api/events?before_id=nope')).status, 400)
  assert.equal((await app.request('/api/events?limit=0')).status, 400)
  assert.equal((await app.request('/api/events?limit=201')).status, 400)
})

test('removed authored names are tombstoned inside append-only event details', async () => {
  reset({
    scenario: 'nested moderation events',
    moderatedKindIds: [3],
    moderatedKindNames: ['banned-material'],
    moderatedTraitNames: ['glowing', 'quiet-hours'],
  })
  const response = await app.request('/api/events')
  assert.equal(response.status, 200)
  const body = await response.json() as { events: Array<Record<string, unknown>> }
  assert.deepEqual(body.events.map(event => event.id), [80, 81, 82])
  assert.deepEqual(body.events.map(event => event.at), [
    '2026-08-11T00:06:00.000Z', '2026-08-11T00:07:00.000Z', '2026-08-11T00:08:00.000Z',
  ])
  const details = body.events.map(event => event.detail) as Array<Record<string, unknown>>
  assert.deepEqual(details[0]?.traits, ['[removed by maintainer]', 'safe-trait'])
  assert.equal(details[1]?.name, '[removed by maintainer]')
  assert.deepEqual(details[1]?.traits, [])
  assert.equal(details[1]?.recipe, null)
  assert.deepEqual(details[2]?.traits, ['[removed by maintainer]', 'safe-trait'])
  assert.deepEqual(details[2]?.recipe, [
    { kind: '[removed by maintainer]', quantity: 1 },
    { kind: 'safe-material', quantity: 2 },
  ])
  const encodedDetails = JSON.stringify(details)
  for (const removed of ['lantern', 'quiet-hours', 'glowing', 'banned-material']) {
    assert.equal(encodedDetails.includes(removed), false, `${removed} leaked through event detail`)
  }
  assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)
})

test('anonymous window batches event moderation without advancing timers', async () => {
  const originalNow = Date.now
  try {
    const realNow = originalNow()
    Date.now = () => realNow + 60_000
    reset({
      scenario: 'nested moderation events',
      scheduledLabelAt: realNow - 1,
      moderatedKindIds: [3],
      moderatedKindNames: ['banned-material'],
      moderatedTraitNames: ['glowing', 'quiet-hours'],
    })
    const response = await app.request('/api/window')
    assert.equal(response.status, 200)
    const body = await response.json() as { events: Array<Record<string, unknown>> }
    assert.deepEqual(body.events.map(event => event.id), [80, 81, 82])
    const queries = sqlCalls().map(call => call.query ?? '')
    assert.ok(queries.some(query => /from moderation_actions[\s\S]*join traits named/i.test(query)))
    assert.ok(queries.some(query => /from moderation_actions[\s\S]*join kinds named/i.test(query)))
    assert.equal(queries.some(query => /pending_effects|effect_resolutions/i.test(query)), false)
    assert.equal(queries.some(query => /insert|update|delete/i.test(query)), false)
  } finally {
    Date.now = originalNow
  }
})

test('removed kind and trait records expose identity and history but no authored mechanics', async () => {
  reset({
    scenario: 'top-level moderation payloads',
    traitHasRecipe: true,
    kindTraitNames: ['glowing'],
    kindRecipe: [{ kind: 'banned-material', quantity: 1 }],
    moderatedKindIds: [3],
    moderatedTraitIds: [4],
  })
  const kindsResponse = await app.request('/api/kinds')
  const kinds = await kindsResponse.json() as { kinds: Array<Record<string, unknown>> }
  assert.equal(kindsResponse.status, 200)
  assert.equal(kinds.kinds[0]?.id, 3)
  assert.equal(kinds.kinds[0]?.owner_id, state.kindOwnerId)
  assert.equal(kinds.kinds[0]?.revision, state.kindRevision)
  assert.equal(kinds.kinds[0]?.name, '[removed by maintainer]')
  assert.equal(kinds.kinds[0]?.description, '[removed by maintainer]')
  assert.deepEqual(kinds.kinds[0]?.traits, [])
  assert.equal(kinds.kinds[0]?.recipe, null)

  const traitsResponse = await app.request('/api/traits')
  const traits = await traitsResponse.json() as { traits: Array<Record<string, unknown>> }
  assert.equal(traitsResponse.status, 200)
  assert.equal(traits.traits[0]?.id, 4)
  assert.equal(traits.traits[0]?.coiner, 'founder')
  assert.equal(traits.traits[0]?.name, '[removed by maintainer]')
  assert.equal(traits.traits[0]?.description, '[removed by maintainer]')
  assert.equal(traits.traits[0]?.recipe, null)
  assert.equal(traits.traits[0]?.mechanical, false)
})

test('/api/me refreshes presence and includes agreements the resident authored without joining', async () => {
  reset({
    scenario: 'me timer refresh',
    scheduledLabelAt: Date.now() - 1,
    agreementParties: ['neighbor'],
  })

  const response = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(response.status, 200)
  const body = await response.json() as { agreements: Array<Record<string, unknown>> }
  assert.deepEqual(body.agreements[0], {
    id: 61,
    body: 'we keep the square open',
    created_by_me: true,
    acceded: false,
    accession_open: false,
    signed: false,
    created_at: '2026-08-11T00:00:00.000Z',
  })

  const presenceReads = sqlCalls().filter(call =>
    (call.query ?? '').replace(/\s+/g, ' ').toLowerCase()
      .includes('with first_owned as'))
  assert.equal(presenceReads.length, 2, JSON.stringify(sqlCalls().map(call => call.query)))
  assert.ok(sqlCalls().some(call => {
    const query = (call.query ?? '').replace(/\s+/g, ' ').toLowerCase()
    return query.includes('from agreements a') &&
      query.includes('a.created_by_id =') && query.includes('or p.resident_id is not null')
  }))
})
