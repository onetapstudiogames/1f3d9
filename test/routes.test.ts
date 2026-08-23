// One fake isolates Neon, Base JSON-RPC, and the x402 facilitator.
// No live database, wallet, payment, deployment, or network service is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { canonicalPaymentRequest } from '../src/payment-attempts.ts'
import {
  PUBLIC_PAGE_DEFAULT,
  PUBLIC_PAGE_MAX,
  allowedPublicQuery,
  finalizePublicPage,
  parsePublicPage,
  utf8TextBytes,
} from '../src/public-pagination.ts'
import { PUBLIC_SEARCH_RATE_CAPACITY } from '../src/public-search-rate-limit.ts'
import { encodePublicSearchCursor } from '../src/public-search.ts'
import { setOAuthResidentResolver } from '../src/core.ts'
import { PUBLIC_CREDENTIAL_REDACTION } from '../src/credential-safety.ts'
import {
  createLaterHolderCursorCodec,
  isLaterHolderCursor,
} from '../src/later-holder.ts'
import { mcp } from '../src/mcp.ts'

const LATER_HOLDER_CURSOR_KEY = '11'.repeat(32)
process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.BASE_RPC_URL = 'https://base-rpc.test'
process.env.FACILITATOR_URL = 'https://facilitator.test'
process.env.LATER_HOLDER_CURSOR_KEY = LATER_HOLDER_CURSOR_KEY

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
  status: 'settling' | 'payment_pending' | 'completed' | 'credit_returned' | 'invalid' | 'expired' | 'needs_review' | 'founder_review'
  lease_owner: string | null
  lease_expires_at: string | null
  recovery_started_at?: string | null
  recovery_deadline_at?: string | null
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
  request_json?: Record<string, unknown> | null
}
interface FakeCityCreditEntry {
  id: string
  resident_id: number
  entry_kind: 'founder_issue' | 'spend' | 'return'
  amount_units: string
  founder_id: number | null
  source_key: string | null
  request_id: string | null
  payment_attempt_id: string | null
  related_spend_id: string | null
  reason: string | null
  created_at: string
}
interface FakeLaterHolderItem {
  mark_id: string
  id: number
  title: string
  place_id: number
  place_title: string
  date: string
  body_text_bytes: number
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
  cityCreditBalances: Map<number, bigint>
  cityCreditEntries: FakeCityCreditEntry[]
  nextCityCreditEntryId: number
  paymentReplaySchemaReady: boolean
  facilitatorVerify: boolean
  facilitatorSettle: boolean
  flagSlotsUsed: Record<string, number>
  failPaidWriteOnce: boolean
  interruptTreasuryCompletionOnce: boolean
  treasuryCompletionHeader?: string
  placeDescription: string
  roomPurpose: string
  frontMatterThingIds: number[]
  frontMatterMovedThingIds: number[]
  frontMatterHiddenThingIds: number[]
  frontMatterRaceLost: boolean
  noteBody: string
  exactTotalsBusy: boolean
  exactTotalsBusyAfter: number | null
  exactTotalsSuccessfulReads: number
  publicChangeMarker: string
  laterHolderItems: FakeLaterHolderItem[]
  actionResolved?: boolean
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
  cityCreditBalances: new Map(),
  cityCreditEntries: [],
  nextCityCreditEntryId: 1,
  paymentReplaySchemaReady: true,
  facilitatorVerify: false,
  facilitatorSettle: false,
  flagSlotsUsed: {},
  failPaidWriteOnce: false,
  interruptTreasuryCompletionOnce: false,
  placeDescription: 'a place made from words',
  roomPurpose: '',
  frontMatterThingIds: [],
  frontMatterMovedThingIds: [],
  frontMatterHiddenThingIds: [],
  frontMatterRaceLost: false,
  noteBody: 'hello from the square',
  exactTotalsBusy: false,
  exactTotalsBusyAfter: null,
  exactTotalsSuccessfulReads: 0,
  publicChangeMarker: '9',
  laterHolderItems: [{
    mark_id: '2', id: 41, title: 'porch lantern', place_id: 2,
    place_title: 'Lantern Town', date: '2026-08-11T00:00:00.000000Z',
    body_text_bytes: Buffer.byteLength('warm light', 'utf8'),
  }],
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
  purpose: state.roomPurpose,
  description: state.placeDescription,
  front_matter_thing_ids: [...state.frontMatterThingIds],
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

const residentHandleForFakeId = (id: number) => id === 7
  ? 'tiny-lantern'
  : id === 8 ? 'neighbor' : 'founder'

const thingRow = (id = 41) => ({
  id,
  place_id: 2,
  name: id === 41 ? 'porch lantern' : 'neighbor chest',
  body: id === 41 ? 'warm light' : 'locked shut',
  maker_id: id === 41 ? 7 : 8,
  made_by: id === 41 ? 'tiny-lantern' : 'neighbor',
  current_owner_id: id === 41 ? state.thingOwnerId : state.targetThingOwnerId,
  current_owner: residentHandleForFakeId(id === 41 ? state.thingOwnerId : state.targetThingOwnerId),
  owner_id: id === 41 ? state.thingOwnerId : state.targetThingOwnerId,
  owner: residentHandleForFakeId(id === 41 ? state.thingOwnerId : state.targetThingOwnerId),
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

const roomOrientationThingRow = (id: number) => {
  const fixtures = {
    41: {
      name: 'porch lantern', body: 'warm light', maker_id: 7, made_by: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern',
    },
    42: {
      name: 'neighbor chest', body: 'locked shut', maker_id: 8, made_by: 'neighbor',
      owner_id: 8, owner: 'neighbor',
    },
    43: {
      name: 'borrowed field guide', body: 'three careful routes 🏙',
      maker_id: 8, made_by: 'neighbor', owner_id: 7, owner: 'tiny-lantern',
    },
    44: {
      name: 'unselected stool', body: 'plain pine', maker_id: 7, made_by: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern',
    },
  } as const
  const fixture = fixtures[id as keyof typeof fixtures]
  if (!fixture) throw new Error(`unknown room-orientation thing fixture: ${id}`)
  return {
    id,
    type: 'thing' as const,
    place_id: state.frontMatterMovedThingIds.includes(id) ? 3 : 2,
    name: fixture.name,
    body: fixture.body,
    body_text_bytes: Buffer.byteLength(fixture.body, 'utf8'),
    maker_id: fixture.maker_id,
    made_by: fixture.made_by,
    current_owner_id: fixture.owner_id,
    current_owner: fixture.owner,
    owner_id: fixture.owner_id,
    owner: fixture.owner,
    withdrawn_at: id === 41
      ? (state.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
      : id === 42
        ? (state.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null)
        : null,
  }
}

const visibleRoomFrontMatter = () => state.frontMatterThingIds
  .map(roomOrientationThingRow)
  .filter(row => row.place_id === 2 && row.withdrawn_at === null)
  .filter(row => !state.frontMatterHiddenThingIds.includes(row.id))
  .map(({ body: _body, place_id: _placeId, withdrawn_at: _withdrawnAt, ...heading }) => heading)

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
    at: new Date(Date.UTC(2026, 7, 11, 0, 0, id)).toISOString(),
    kind: id % 2 === 0 ? 'note_created' : 'thing_created',
    actor: 'tiny-lantern',
    detail: id === 70 ? { id, body: 'city 🏙' } : { id },
  }
})

const paginationSubplaces = () => Array.from({ length: 60 }, (_, index) => ({
  ...placeRow(160 - index, 2),
  name: `Subplace ${160 - index}`,
}))

const mapOutlineRows = () => Array.from({ length: 60 }, (_, index) => ({
  ...placeRow(160 - index, 1),
  name: `Map place ${160 - index}`,
  description: `Map description ${160 - index} 🏙`,
  places: index === 0 ? 2 : 0,
}))

const mapOutlineParent = (id: number) => id === 1
  ? { ...placeRow(1, null), owner_id: null, owner: null, name: 'the world', places: 60 }
  : { ...placeRow(id, 1), name: `Map place ${id}`, places: id === 160 ? 2 : 0 }

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
      ...common,
      handle: `resident-${id}`,
      model: 'test-model',
      joined_at: common.created_at,
      current_place_id: id % 2 === 0 ? 2 : null,
      asleep: id % 3 === 0,
    }
    if (collection === 'kinds') return {
      ...common, name: `kind-${id}`, owner_id: 7, owner: 'tiny-lantern',
      revision: 1, description: id === newest ? 'kind 🏙' : '', traits: [], recipe: [],
    }
    if (collection === 'traits') return {
      ...common, name: `trait-${id}`, description: id === newest ? 'trait 🏙' : '', recipe: null,
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
      maker_id: 6, made_by: 'archive-smith',
      current_owner_id: 7, current_owner: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern',
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

async function withVercelForwarding(run: () => Promise<void>) {
  const previous = process.env.VERCEL
  process.env.VERCEL = '1'
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previous
  }
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

function integerArrayValue(value: unknown): number[] | null {
  let decoded: unknown = value
  if (typeof value === 'string') {
    try {
      decoded = value.startsWith('[')
        ? JSON.parse(value)
        : value.startsWith('{')
          ? value.slice(1, -1).split(',').filter(Boolean)
          : value
    } catch {
      return null
    }
  }
  if (!Array.isArray(decoded)) return null
  const ids = decoded.map(item => Number(
    typeof item === 'string' ? item.replace(/^"|"$/gu, '') : item,
  ))
  return ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids : null
}

function frontMatterIdsIn(params: readonly unknown[]): number[] | null {
  for (const value of params) {
    const ids = integerArrayValue(value)
    if (ids !== null) return ids
  }
  const individualIds = params
    .map(Number)
    .filter(id => Number.isSafeInteger(id) && id >= 41 && id <= 44)
  return individualIds.length > 0 ? individualIds : null
}

function roomPurposeIn(params: readonly unknown[]): string | null {
  return (params.find(value => typeof value === 'string' && (
    [
      'safe',
      'two\nlines',
      'A small room for deliberate reading.',
      'A retry-safe reading room.',
      'Keep the old description.',
    ].includes(value) || value.length === 281
  )) as string | undefined) ?? null
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
  recordPayment(query, params)

  if (q.includes('front_matter_thing_ids') && q.includes('select')
      && /\b(?:from|join)\s+things\b/iu.test(q)
      && !/\b(?:insert|update|delete)\b/iu.test(q)) {
    return state.scenario === 'room orientation'
      ? visibleRoomFrontMatter().map((heading, position) => ({ ...heading, place_id: 2, position }))
      : []
  }

  if (state.scenario === 'room orientation') {
    const writesFrontMatter = q.includes('front_matter_thing_ids')
      && /\b(?:insert|update|delete)\b/iu.test(q)
    const updatesOrientation = q.includes('update places')
      && (q.includes('purpose') || q.includes('front_matter_thing_ids'))
    if (writesFrontMatter || updatesOrientation) {
      if (state.frontMatterRaceLost) return []
      const parsedIds = frontMatterIdsIn(params)
      const ids = parsedIds
      if (ids && ids.some(id => {
        const row = roomOrientationThingRow(id)
        return row.place_id !== 2 || row.withdrawn_at !== null
          || state.frontMatterHiddenThingIds.includes(id)
      })) {
        throw Object.assign(
          new Error('front matter must use active public things in the same place'),
          { code: '23514' },
        )
      }
      const purpose = roomPurposeIn(params)
      state = {
        ...state,
        ...(ids === null ? {} : { frontMatterThingIds: [...ids] }),
        ...(purpose === null ? {} : { roomPurpose: purpose }),
      }
      return [{
        ...placeRow(2, 1),
        purpose: state.roomPurpose,
        front_matter_thing_ids: [...state.frontMatterThingIds],
        active_offer_id: null,
        has_open_offer: false,
      }]
    }
    if (q.includes('from things') && !q.includes('/* public:place-collections')) {
      const requested = frontMatterIdsIn(params) ?? []
      return requested.map(roomOrientationThingRow)
        .filter(row => row.place_id === 2 && row.withdrawn_at === null)
        .filter(row => !state.frontMatterHiddenThingIds.includes(row.id))
    }
    if (q.includes('from places') && q.includes('purpose') && !q.includes('/* public:')) {
      return [{
        ...placeRow(2, 1),
        purpose: state.roomPurpose,
        front_matter_thing_ids: [...state.frontMatterThingIds],
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
  if (q.includes('/* city-credit:issue */')) {
    const founderId = Number(params[0])
    const residentId = Number(params[1])
    const sourceKey = String(params[2])
    const reason = String(params[3])
    const amountUnits = String(params[4])
    const existing = state.cityCreditEntries.find(entry => entry.source_key === sourceKey)
    if (existing) {
      return [{
        ...existing,
        entry_id: existing.id,
        created: false,
        balance_units: String(state.cityCreditBalances.get(existing.resident_id) ?? 0n),
      }]
    }
    if (![1, 7, 8].includes(residentId)) return []
    const entry: FakeCityCreditEntry = {
      id: String(state.nextCityCreditEntryId),
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
    const balance = (state.cityCreditBalances.get(residentId) ?? 0n) + BigInt(amountUnits)
    state = {
      ...state,
      cityCreditBalances: new Map(state.cityCreditBalances).set(residentId, balance),
      cityCreditEntries: [...state.cityCreditEntries, entry],
      nextCityCreditEntryId: state.nextCityCreditEntryId + 1,
    }
    return [{ ...entry, entry_id: entry.id, created: true, balance_units: String(balance) }]
  }
  if (q.includes('/* city-credit:read-account */')) {
    const residentId = Number(params[0])
    const beforeId = params[1] == null ? null : BigInt(String(params[1]))
    const limit = params[2] == null ? 20 : Number(params[2])
    const matching = state.cityCreditEntries
      .filter(entry => entry.resident_id === residentId && (beforeId === null || BigInt(entry.id) < beforeId))
      .sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)))
    const history = matching.slice(0, limit).map(entry => {
      const attempt = entry.payment_attempt_id == null
        ? null
        : state.paymentAttempts.get(entry.payment_attempt_id) ?? null
      return {
        ...entry,
        operation: attempt?.operation ?? null,
        target_key: attempt?.target_key ?? null,
      }
    })
    return [{
      resident_id: residentId,
      balance_units: String(state.cityCreditBalances.get(residentId) ?? 0n),
      history,
      has_more: matching.length > limit,
    }]
  }
  if (q.includes('/* city-credit:issue-balance */')) {
    const residentId = Number(params[0])
    const balance = state.cityCreditBalances.get(residentId)
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
    let spend = state.cityCreditEntries.find(entry =>
      entry.entry_kind === 'spend'
      && entry.resident_id === actorId
      && entry.request_id === requestId)
    if (!spend) {
      spend = state.cityCreditEntries.find(entry => {
        if (entry.entry_kind !== 'spend' || entry.payment_attempt_id == null) return false
        const attempt = state.paymentAttempts.get(entry.payment_attempt_id)
        return attempt?.operation === operation
          && attempt.target_key === targetKey
          && ['settling', 'payment_pending', 'needs_review', 'completed'].includes(attempt.status)
      })
    }
    if (!spend) {
      const balance = state.cityCreditBalances.get(actorId) ?? 0n
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
        id: String(state.nextCityCreditEntryId),
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
      state = {
        ...state,
        cityCreditBalances: new Map(state.cityCreditBalances).set(actorId, balance - BigInt(amountUnits)),
        cityCreditEntries: [...state.cityCreditEntries, spend],
        nextCityCreditEntryId: state.nextCityCreditEntryId + 1,
        paymentAttempts: new Map(state.paymentAttempts).set(newAttemptId, attempt),
      }
    }
    let attempt = state.paymentAttempts.get(spend.payment_attempt_id!)!
    let leaseAcquired = attempt.lease_owner === newLeaseOwner
    if (attempt.status === 'payment_pending' && attempt.lease_owner == null) {
      attempt = {
        ...attempt,
        lease_owner: newLeaseOwner,
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      }
      state = {
        ...state,
        paymentAttempts: new Map(state.paymentAttempts).set(attempt.public_id, attempt),
      }
      leaseAcquired = true
    }
    const returned = state.cityCreditEntries.find(entry =>
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
  if (q.includes('/* city-credit:return-spend */')) {
    const actorId = Number(params[0])
    const attemptId = String(params[1])
    const leaseOwner = String(params[2])
    const reason = String(params[3])
    const responseStatus = Number(params[4])
    const response = JSON.parse(String(params[5])) as Record<string, unknown>
    const amountUnits = String(params[7])
    const attempt = state.paymentAttempts.get(attemptId)
    const spend = state.cityCreditEntries.find(entry =>
      entry.entry_kind === 'spend' && entry.payment_attempt_id === attemptId)
    if (!attempt || !spend || attempt.actor_id !== actorId) return []
    let returned = state.cityCreditEntries.find(entry =>
      entry.entry_kind === 'return' && entry.related_spend_id === spend.id)
    const returnCreated = returned == null
    if (!returned) {
      if (attempt.lease_owner !== leaseOwner || attempt.status !== 'payment_pending') return []
      returned = {
        id: String(state.nextCityCreditEntryId),
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
      state = {
        ...state,
        cityCreditBalances: new Map(state.cityCreditBalances).set(
          actorId,
          (state.cityCreditBalances.get(actorId) ?? 0n) + BigInt(amountUnits),
        ),
        cityCreditEntries: [...state.cityCreditEntries, returned],
        nextCityCreditEntryId: state.nextCityCreditEntryId + 1,
        paymentAttempts: new Map(state.paymentAttempts).set(attemptId, completed),
      }
    }
    const completed = state.paymentAttempts.get(attemptId)!
    return [{
      ...completed,
      prior_return_id: returnCreated ? null : returned.id,
    }]
  }
  if (q.includes('/* city-credit:return-result */')) {
    const actorId = Number(params[0])
    const attemptId = String(params[1])
    const attempt = state.paymentAttempts.get(attemptId)
    const spend = state.cityCreditEntries.find(entry =>
      entry.entry_kind === 'spend' && entry.payment_attempt_id === attemptId)
    const returned = spend == null ? null : state.cityCreditEntries.find(entry =>
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
    return [{ count: state.laterHolderItems.length }]
  }
  if (q.includes('/* private:later-holder-index */')) {
    const beforeMarkId = params[1] == null ? null : BigInt(String(params[1]))
    const limit = Number(params[2])
    const page = state.laterHolderItems
      .filter(item => beforeMarkId === null || BigInt(item.mark_id) < beforeMarkId)
      .sort((left, right) => Number(BigInt(right.mark_id) - BigInt(left.mark_id)))
      .slice(0, limit)
      .map(item => ({
        ...item, total_count: state.laterHolderItems.length,
      }))
    return page.length > 0
      ? page
      : [{ total_count: state.laterHolderItems.length }]
  }
  if (q.includes('/* private:later-holder-mark */')) {
    const thingId = Number(params[1])
    const existing = state.laterHolderItems.find(item => item.id === thingId)
    if (existing) return [{ thing_id: thingId, changed: false }]
    if (thingId !== 41 || state.thingOwnerId !== state.actorId || state.thingWithdrawn) return []
    const next: FakeLaterHolderItem = {
      mark_id: String(1 + Math.max(0, ...state.laterHolderItems.map(item => Number(item.mark_id)))),
      id: 41, title: 'porch lantern', place_id: 2, place_title: 'Lantern Town',
      date: '2026-08-11T00:00:00.000000Z', body_text_bytes: Buffer.byteLength('warm light'),
    }
    state = { ...state, laterHolderItems: [next, ...state.laterHolderItems] }
    return [{ thing_id: thingId, changed: true }]
  }
  if (q.includes('/* private:later-holder-unmark */')) {
    const thingId = Number(params[1])
    const changed = state.laterHolderItems.some(item => item.id === thingId)
    state = {
      ...state,
      laterHolderItems: state.laterHolderItems.filter(item => item.id !== thingId),
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
      total_items: 1, total_body_bytes: '19', change_marker: state.publicChangeMarker,
    }]
  }
  if (q.includes('/* public:changes-checkpoint */')) {
    return [{ checkpoint: state.publicChangeMarker }]
  }
  if (q.includes('/* public:changes */')) {
    return [{
      checkpoint: state.publicChangeMarker, id: 701, change_id: state.publicChangeMarker,
      kind: 'action', actor: 'tiny-lantern',
      detail: { channel: 'public' }, created_at: '2026-08-11T00:00:09.000Z',
    }]
  }

  // Once the action resolution committed, every later presence read breaks.
  if (state.scenario === 'post-action observation failure'
    && state.actionResolved && q.includes('resident_presence')) {
    throw Object.assign(
      new Error('connection reset while re-reading presence'),
      { code: '57P01' },
    )
  }

  if (q.includes('/* payment-attempts:find-operation */')) {
    const row = [...state.paymentAttempts.values()].reverse().find(attempt =>
      attempt.actor_id === Number(params[0])
      && attempt.operation === String(params[1])
      && attempt.offer_id === Number(params[2]))
    return row ? [{ ...row }] : []
  }
  if (q.includes('/* payment-attempts:response-replay-ready */')) {
    return [{ ready: state.paymentReplaySchemaReady }]
  }
  if (q.includes('/* payment-attempts:find-replayable-target */')) {
    const row = [...state.paymentAttempts.values()].reverse().find(attempt =>
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
    state = { ...state, paymentAttempts: next }
    return [{ ...row }]
  }
  if (q.includes('/* payment-attempts:lease */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
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
    const recoveryStartAt = state.scenario === 'treasury deadline passed'
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
  if (q.includes('/* payment-attempts:founder-review */')) {
    const key = String(params[0])
    const current = state.paymentAttempts.get(key)
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
    state = {
      ...state,
      paymentAttempts: new Map(state.paymentAttempts).set(key, updated),
    }
    return [{ ...updated }]
  }
  if (
    q.includes('/* payment-attempts:invalidate-read */')
    || q.includes('/* payment-attempts:needs-review-read */')
    || q.includes('/* payment-attempts:founder-review-read */')
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

  if (q.includes('/* payment-sale-operations:read-attempt */')) {
    const attempt = state.paymentAttempts.get(String(params[0]))
    if (!attempt || attempt.offer_id !== state.offer.id) return []
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
      offer_id: state.offer.id,
      channel: state.offer.channel ?? 'direct',
      asset_type: attempt.asset_type,
      asset_id: assetId,
      seller_id: 7,
      seller: 'tiny-lantern',
      buyer_id: 8,
      buyer: 'neighbor',
      price_usdc: price,
      seller_wallet: sellerWallet,
      buyer_wallet: state.offer.buyerWallet ?? buyerWallet,
      offer_status: state.offer.status,
      reserved_by: state.offer.reservedUntil == null ? null : 8,
      reserved_at: state.offer.reservedAt,
      reserved_until: state.offer.reservedUntil,
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
      current_owner_id: state.thingOwnerId,
      active_offer_id: state.offer.status === 'open' ? state.offer.id : null,
      withdrawn_at: state.thingWithdrawn ? new Date().toISOString() : null,
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
    const attempt = state.paymentAttempts.get(attemptId)
    if (
      !attempt || attempt.lease_owner !== leaseOwner || attempt.status !== 'payment_pending'
      || attempt.offer_id !== state.offer.id || state.offer.status !== 'open'
    ) return []
    const createdAt = '2026-08-11T00:00:00.000Z'
    const response = {
      offer: { id: state.offer.id, status: 'claimed' },
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
      result_json: { kind: 'transfer_offer', id: state.offer.id },
      response_status: 200,
      response_json: wrapper?.header == null
        ? response
        : { __1f3d9_x402_response_v1: { header: wrapper.header, body: response } },
      response_body_bytes: Buffer.from(responseBody, 'utf8'),
      updated_at: createdAt,
      completed_at: createdAt,
    }
    state = {
      ...state,
      offer: { ...state.offer, status: 'claimed' },
      thingOwnerId: attempt.actor_id,
      paymentHashes: new Set(state.paymentHashes).add(String(attempt.tx_hash)),
      paymentAttempts: new Map(state.paymentAttempts).set(attemptId, completed),
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
    const attempt = state.paymentAttempts.get(attemptId)
    if (!attempt || attempt.lease_owner !== leaseOwner) return []
    const closed: FakePaymentAttempt = {
      ...attempt,
      status: terminalState,
      invalid_reason: attempt.invalid_reason ?? String(params[3]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }
    state = {
      ...state,
      offer: attempt.operation === 'direct_sale'
        ? { ...state.offer, status: 'canceled' }
        : state.offer,
      paymentAttempts: new Map(state.paymentAttempts).set(attemptId, closed),
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
    const attempt = state.paymentAttempts.get(attemptId)
    if (
      !attempt
      || attempt.lease_owner !== leaseOwner
      || attempt.status !== 'payment_pending'
    ) return []
    if (state.interruptTreasuryCompletionOnce) {
      state = {
        ...state,
        interruptTreasuryCompletionOnce: false,
        paymentAttempts: new Map(state.paymentAttempts).set(attemptId, {
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
    if (deadline == null || state.failPaidWriteOnce || !attempt.request_json) {
      if (state.failPaidWriteOnce) state = { ...state, failPaidWriteOnce: false }
      return [{
        state: 'target_changed',
        attempt_id: attemptId,
        reason: 'stored treasury request is invalid or its target changed',
      }]
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
        revision: state.kindRevision + 1,
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
      if (!attempt.tx_hash || state.paymentHashes.has(attempt.tx_hash)) {
        return [{
          state: 'target_changed',
          attempt_id: attemptId,
          reason: 'stored treasury request is invalid or its target changed',
        }]
      }
      response = { ...response, fee_tx: attempt.tx_hash }
      state = {
        ...state,
        paymentHashes: new Set([...state.paymentHashes, attempt.tx_hash]),
      }
    } else {
      const balance = state.cityCreditBalances.get(attempt.actor_id) ?? 0n
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
    const paymentResponseHeader = state.treasuryCompletionHeader ?? (
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
    state = {
      ...state,
      paymentAttempts: new Map(state.paymentAttempts).set(attemptId, completed),
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
  if (q.includes('insert into action_resolutions')) {
    state = { ...state, actionResolved: true }
    return [{ id: 201 }]
  }
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
    const all = remainingPaginationRows('moderation')
    const totalTextBytes = all.reduce(
      (total, row) => total + Buffer.byteLength(
        String((row as Record<string, unknown>).reason ?? ''),
        'utf8',
      ),
      0,
    )
    const page = descendingPage(all, params[0], params[1])
    return page.length > 0
      ? page.map(row => ({ ...row, total_items: all.length, total_text_bytes: totalTextBytes }))
      : [{ id: null, total_items: all.length, total_text_bytes: totalTextBytes }]
  }
  if (q.includes('/* public:moderation */')) {
    return [{ id: null, total_items: 0, total_text_bytes: 0 }]
  }
  if (
    q.includes('from moderation_actions')
    && !q.includes('update places set')
    && !q.includes('/* public:window-directory */')
  ) {
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
    const callerKey = String(params[0])
    const hourlyLimit = Number(params[1])
    const used = state.flagSlotsUsed[callerKey] ?? 0
    if (used >= hourlyLimit) return []
    state = { ...state, flagSlotsUsed: { ...state.flagSlotsUsed, [callerKey]: used + 1 } }
    return [{ used: used + 1 }]
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

  if (q.includes('/* public:window-directory */')) {
    return [{
      entry_type: 'place', id: 1, parent_id: null, name: 'the world',
      handle: null, description: 'must not escape', owner_id: null,
      joined_at: null, model: 'must not escape', current_place_id: null,
      asleep: null, secret_hash: 'must not escape',
    }, {
      entry_type: 'place', id: 2, parent_id: 1, name: '[removed by maintainer]',
      handle: null, description: 'removed original body', owner_id: 7,
      joined_at: null, model: 'must not escape', current_place_id: 2,
      asleep: null, secret_hash: 'must not escape',
    }, {
      entry_type: 'resident', id: 7, parent_id: null, name: null, handle: 'tiny-lantern',
      description: 'must not escape', owner_id: null,
      joined_at: '2026-08-11T00:00:00.000Z', model: 'openai-codex',
      current_place_id: 2, asleep: false, secret_hash: 'must not escape',
    }]
  }

  if (q.includes('/* public:resident-presence */')) {
    if (params[0] !== 'tiny-lantern') return []
    return [{
      id: 7,
      handle: 'tiny-lantern',
      joined_at: '2026-08-11T00:00:00.000Z',
      current_place_id: 2,
      asleep: false,
      model: 'openai-codex',
      secret_hash: 'must not escape',
      quota_day: '2026-08-11',
    }]
  }

  if (state.scenario === 'remaining pagination' || state.scenario === 'window outline') {
    if (q.includes('/* public:residents */')) {
      const residentRows = remainingPaginationRows('residents') as Array<{
        id: number
        handle: string
        model: string
        joined_at: string
        current_place_id: number | null
        asleep: boolean
      }>
      const total = residentRows.length
      const includesPresence = q.includes('current_place_id') && q.includes('asleep')
      const rows = residentRows.map(row => ({
        id: row.id,
        handle: row.handle,
        model: row.model,
        joined_at: row.joined_at,
        ...(includesPresence
          ? { current_place_id: row.current_place_id, asleep: row.asleep }
          : {}),
      }))
      const page = descendingPage(rows, params[0], params[1])
      return page.length > 0
        ? page.map(row => ({ ...row, total_items: total, total_text_bytes: 0 }))
        : [{ id: null, total_items: total, total_text_bytes: 0 }]
    }
    const publicCollection = ['kinds', 'traits', 'moderation']
      .find(collection => q.includes(`/* public:${collection} */`))
    if (publicCollection) {
      const all = remainingPaginationRows(publicCollection)
      const field = publicCollection === 'moderation' ? 'reason' : 'description'
      const totalTextBytes = all.reduce(
        (total, row) => total + Buffer.byteLength(String((row as Record<string, unknown>)[field] ?? ''), 'utf8'),
        0,
      )
      const page = descendingPage(all, params[0], params[1])
      return page.length > 0
        ? page.map(row => ({ ...row, total_items: all.length, total_text_bytes: totalTextBytes }))
        : [{ id: null, total_items: all.length, total_text_bytes: totalTextBytes }]
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
      const totalTextBytes = filtered.reduce(
        (total, row) => total + Buffer.byteLength(String((row as Record<string, unknown>).body ?? ''), 'utf8'),
        0,
      )
      const page = descendingPage(filtered, params[2], params[3])
      return page.length > 0
        ? page.map(row => ({ ...row, total_items: filtered.length, total_text_bytes: totalTextBytes }))
        : [{ id: null, total_items: filtered.length, total_text_bytes: totalTextBytes }]
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
    return page.length > 0
      ? page.map(row => ({ ...row, total_items: total, total_text_bytes: 0 }))
      : [{ id: null, total_items: total, total_text_bytes: 0 }]
  }

  if (q.includes('/* public:place-collections-budgeted */')) {
    const paged = state.scenario === 'public pagination'
    const allSubplaces = paged ? paginationSubplaces() : [placeRow(2, 1)]
    const allThings = paged
      ? paginationThings()
      : state.thingWithdrawn ? [] : [thingRow(41)]
    const allNotes = paged
      ? paginationNotes()
      : state.scenario === 'busy place'
        ? Array.from({ length: 205 }, (_, index) => ({
            id: index + 1,
            place_id: 2,
            author: 'tiny-lantern',
            body: `note ${index + 1}`,
            created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index + 1)).toISOString(),
          }))
        : [{ id: 51, place_id: 2, author: 'tiny-lantern', body: state.noteBody, created_at: '2026-08-11T00:00:00.000Z' }]
    const pack = <T extends { id: number }>(
      rows: readonly T[],
      cursor: unknown,
      fetchLimit: unknown,
      textLimit: unknown,
      field: keyof T,
    ) => {
      const candidates = descendingPage(rows, cursor, fetchLimit)
      const itemLimit = Number(fetchLimit) - 1
      const limit = textLimit == null ? null : Number(textLimit)
      const items: T[] = []
      let returnedTextBytes = 0
      let blocked: T | null = null
      let blockedBytes: number | null = null
      for (const row of candidates.slice(0, itemLimit)) {
        const bytes = Buffer.byteLength(String(row[field] ?? ''), 'utf8')
        if (limit != null && returnedTextBytes + bytes > limit) {
          blocked = row
          blockedBytes = bytes
          break
        }
        items.push(row)
        returnedTextBytes += bytes
      }
      const hasMore = candidates.length > items.length
      return {
        items,
        returnedTextBytes,
        hasMore,
        nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
        stoppedForTextLimit: blocked != null,
        nextItemId: blocked?.id ?? null,
        nextItemTextBytes: blockedBytes,
      }
    }
    const subplaces = pack(allSubplaces, params[1], params[2], params[7], 'description')
    const things = pack(allThings, params[3], params[4], params[8], 'body')
    const notes = pack(allNotes, params[5], params[6], params[9], 'body')
    return [{
      subplaces: subplaces.items,
      things: things.items,
      notes: notes.items,
      subplace_items: paged ? 160 : allSubplaces.length,
      subplace_text_bytes: paged ? 1600 : allSubplaces.reduce(
        (total, row) => total + Buffer.byteLength(String(row.description ?? ''), 'utf8'), 0,
      ),
      thing_items: paged ? 260 : allThings.length,
      thing_text_bytes: paged ? 2600 : allThings.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
      note_items: paged ? 360 : allNotes.length,
      note_text_bytes: paged ? 3600 : allNotes.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
      subplace_returned_text_bytes: subplaces.returnedTextBytes,
      subplace_has_more: subplaces.hasMore,
      subplace_next_cursor: subplaces.nextCursor,
      subplace_stopped_for_text_limit: subplaces.stoppedForTextLimit,
      subplace_next_item_id: subplaces.nextItemId,
      subplace_next_item_text_bytes: subplaces.nextItemTextBytes,
      thing_returned_text_bytes: things.returnedTextBytes,
      thing_has_more: things.hasMore,
      thing_next_cursor: things.nextCursor,
      thing_stopped_for_text_limit: things.stoppedForTextLimit,
      thing_next_item_id: things.nextItemId,
      thing_next_item_text_bytes: things.nextItemTextBytes,
      note_returned_text_bytes: notes.returnedTextBytes,
      note_has_more: notes.hasMore,
      note_next_cursor: notes.nextCursor,
      note_stopped_for_text_limit: notes.stoppedForTextLimit,
      note_next_item_id: notes.nextItemId,
      note_next_item_text_bytes: notes.nextItemTextBytes,
    }]
  }

  if (q.includes('/* public:place-collections */')) {
    const paged = state.scenario === 'public pagination'
    const allSubplaces = paged ? paginationSubplaces() : [placeRow(2, 1)]
    const allThings = paged
      ? paginationThings()
      : state.thingWithdrawn ? [] : [thingRow(41)]
    const allNotes = paged
      ? paginationNotes()
      : state.scenario === 'busy place'
        ? Array.from({ length: 205 }, (_, index) => ({
            id: index + 1,
            place_id: 2,
            author: 'tiny-lantern',
            body: `note ${index + 1}`,
            created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index + 1)).toISOString(),
          }))
        : [{ id: 51, place_id: 2, author: 'tiny-lantern', body: state.noteBody, created_at: '2026-08-11T00:00:00.000Z' }]
    const subplaces = descendingPage(
      allSubplaces,
      params[1],
      params[2],
    ).map(row => q.includes('as description_text_bytes')
      ? Object.fromEntries(Object.entries({
          ...row,
          description_text_bytes: Buffer.byteLength(String(row.description ?? ''), 'utf8'),
        }).filter(([key]) => key !== 'description'))
      : row)
    const things = descendingPage(
      allThings,
      params[3],
      params[4],
    ).map(row => q.includes('as body_text_bytes')
      ? Object.fromEntries(Object.entries({
          ...row,
          body_text_bytes: Buffer.byteLength(String(row.body ?? ''), 'utf8'),
        }).filter(([key]) => key !== 'body'))
      : row)
    const notes = descendingPage(
      allNotes,
      params[5],
      params[6],
    ).map(row => q.includes('author.handle as author, octet_length(n.body)')
      ? Object.fromEntries(Object.entries({
          ...row,
          body_text_bytes: Buffer.byteLength(String(row.body ?? ''), 'utf8'),
        }).filter(([key]) => key !== 'body'))
      : row)
    return [{
      subplaces,
      things,
      notes,
      subplace_items: paged ? 160 : allSubplaces.length,
      subplace_text_bytes: paged ? 1600 : allSubplaces.reduce(
        (total, row) => total + Buffer.byteLength(String(row.description ?? ''), 'utf8'), 0,
      ),
      thing_items: paged ? 260 : allThings.length,
      thing_text_bytes: paged ? 2600 : allThings.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
      note_items: paged ? 360 : allNotes.length,
      note_text_bytes: paged ? 3600 : allNotes.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
    }]
  }

  if (q.includes('count(*)') && q.includes('octet_length') && !q.includes('/* public:')) {
    if (q.includes('subplace_items') && q.includes('thing_items') && q.includes('note_items')) {
      return state.scenario === 'public pagination'
        ? [{ subplace_items: 160, subplace_text_bytes: 1600, thing_items: 260, thing_text_bytes: 2600, note_items: 360, note_text_bytes: 3600 }]
        : [{ subplace_items: 1, subplace_text_bytes: 21, thing_items: 1, thing_text_bytes: 21, note_items: 1, note_text_bytes: 21 }]
    }
    if (state.scenario === 'public pagination') {
      if (q.includes('from places p')) return [{ items: 160, text_bytes: 1600 }]
      if (q.includes('from things t')) return [{ items: 260, text_bytes: 2600 }]
      if (q.includes('from notes n')) return [{ items: 360, text_bytes: 3600 }]
    }
    return [{ items: 1, text_bytes: Buffer.byteLength(state.noteBody, 'utf8') }]
  }
  if (q.includes('/* public:reading_cost */')) {
    if (state.scenario === 'reading cost unavailable') throw new Error('meter read failed')
    return [{ stored_text_bytes: 1234, first_read_text_bytes: 456 }]
  }
  if (state.scenario === 'public pagination' && q.includes('from places p') && q.includes('where p.parent_id')) {
    if (q.includes('count(*)')) return [{ items: 160, text_bytes: 1600 }]
    return descendingPage(paginationSubplaces(), params[1], params[2])
  }
  if (state.scenario === 'public pagination' && q.includes('from things t') && q.includes('t.place_id')) {
    if (q.includes('count(*)')) return [{ items: 260, text_bytes: 2600 }]
    return descendingPage(paginationThings(), params[1], params[2])
  }
  if (state.scenario === 'public pagination' && q.includes('from notes n') && q.includes('n.place_id')) {
    if (q.includes('count(*)')) return [{ items: 360, text_bytes: 3600 }]
    return descendingPage(paginationNotes(), params[1], params[2])
  }

  if (['map outline', 'window outline'].includes(state.scenario) &&
      q.includes('/* public:map-parent */')) {
    return [mapOutlineParent(Number(params[0] ?? 1))]
  }
  if (['map outline', 'window outline'].includes(state.scenario) &&
      q.includes('/* public:map-outline */')) {
    const parentId = Number(params[0] ?? 1)
    const all = mapOutlineRows().filter(row => row.parent_id === parentId)
    const totalTextBytes = all.reduce(
      (total, row) => total + Buffer.byteLength(row.description, 'utf8'),
      0,
    )
    const page = descendingPage(all, params[2], params[3])
    return page.length > 0
      ? page.map(row => ({
          ...row,
          outline_parent: mapOutlineParent(parentId),
          total_items: all.length,
          total_text_bytes: totalTextBytes,
        }))
      : [{
          id: null,
          outline_parent: mapOutlineParent(parentId),
          total_items: all.length,
          total_text_bytes: totalTextBytes,
        }]
  }
  if (state.scenario === 'window outline' && (
    q.includes('/* public:window-outline-totals */') ||
    q.includes('(select count(*)::int from places) as places')
  )) {
    return [{
      places: 61,
      residents: 60,
      conversations: 60,
      things: 60,
      agreements: 60,
      events: 70,
    }]
  }
  if (state.scenario === 'window outline' && q.includes('from notes note')) {
    return descendingPage(paginationNotes(), params[0], params.at(-1))
  }
  if (state.scenario === 'window outline' && q.includes('from things thing')) {
    return descendingPage(paginationThings(), params[0], params.at(-1))
  }
  if (state.scenario === 'window outline' && q.includes('from agreements agreement')) {
    return descendingPage(remainingPaginationRows('agreements'), params[0], params.at(-1))
  }
  if (state.scenario === 'window outline' && (
    q.includes('select id, at, kind, actor, detail') || q.includes('/* public:events */')
  )) {
    const events = paginationEvents().map((event, index) => ({
      ...event,
      kind: index % 2 === 0 ? 'note' : 'thing_created',
    }))
    return descendingPage(events, null, params.at(-1))
  }

  if (q.includes('left join resident_presence presence')) {
    return [
      { id: 9, handle: 'long-gone', current_place_id: 1, joined_at: '2026-07-01T00:00:00.000Z', asleep: true },
      { id: 7, handle: 'tiny-lantern', current_place_id: 2, joined_at: '2026-08-11T00:00:00.000Z', asleep: false },
    ]
  }
  if (q.includes('with recursive place_tree')) {
    if (state.scenario === 'large map') {
      const rows = [placeRow(1, null)]
      for (let id = 2; id <= 1401; id += 1) rows.push(placeRow(id, 1))
      for (let step = 0; step < 16; step += 1) {
        rows.push(placeRow(3000 + step, step === 0 ? 1 : 2999 + step))
      }
      return rows
    }
    return [placeRow(1, null), placeRow(2, 1)]
  }
  if (q.includes('insert into places')) {
    if (state.failPaidWriteOnce) {
      state = { ...state, failPaidWriteOnce: false }
      return []
    }
    const returned = placeRow(3, 2)
    const creditAttemptId = String(params.find(value =>
      typeof value === 'string' && value.startsWith('credit_attempt_')) ?? '')
    if (creditAttemptId && q.includes('complete_city_credit_attempt')) {
      const attempt = state.paymentAttempts.get(creditAttemptId)
      const assetMatches = !q.includes("asset_type = 'kind' AND asset_id =")
        || (attempt?.asset_type === 'kind' && attempt.asset_id === 3)
      if (attempt && assetMatches) {
        const balance = state.cityCreditBalances.get(attempt.actor_id) ?? 0n
        const response = {
          place: returned,
          city_fee_credit: {
            spent_usdc: '1.000000',
            balance_usdc: `${balance / 1_000_000n}.${String(balance % 1_000_000n).padStart(6, '0')}`,
          },
        }
        const responseBody = JSON.stringify(response)
        state = {
          ...state,
          paymentAttempts: new Map(state.paymentAttempts).set(creditAttemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'place', id: returned.id },
            response_status: 201,
            response_json: response,
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
        return [{ ...returned, response_body: responseBody }]
      }
    }
    if (q.includes('complete_payment_attempt')) {
      const attemptId = String(params.find(value => typeof value === 'string' && value.startsWith('pay_')) ?? '')
      const attempt = state.paymentAttempts.get(attemptId)
      if (attempt) {
        const responseBody = JSON.stringify({ place: returned, fee_tx: TX1.toLowerCase() })
        const durable = attempt.response_json?.__1f3d9_x402_response_v1
        const header = durable && typeof durable === 'object' && !Array.isArray(durable)
          ? String((durable as Record<string, unknown>).header ?? '')
          : ''
        state = {
          ...state,
          paymentAttempts: new Map(state.paymentAttempts).set(attemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'place', id: returned.id },
            response_status: 201,
            response_json: {
              __1f3d9_x402_response_v1: {
                ...(header ? { header } : {}),
                body: JSON.parse(responseBody) as Record<string, unknown>,
              },
            },
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
      }
    }
    return [{
      ...returned,
      ...(q.includes('complete_payment_attempt') ? {
        response_body: JSON.stringify({ place: returned, fee_tx: TX1.toLowerCase() }),
      } : {}),
    }]
  }
  if (q.includes('update places set'))
    return state.actorId === state.placeOwnerId ? [{ ...placeRow(2, 1), description: 'changed by its owner' }] : []
  if (q.includes('from places') && q.includes('parent_id') && !q.includes('update things')) {
    return [placeRow(2, 1)]
  }
  if (q.includes('from places') && (q.includes('where p.id') || q.includes('where id'))) return [placeRow(2, 1)]

  if (q.includes('insert into kinds') || q.includes('insert into kind_revisions') || q.includes('update kinds')) {
    if (state.failPaidWriteOnce) {
      state = { ...state, failPaidWriteOnce: false }
      return []
    }
    const returned = { ...kindRow(), revision: state.kindRevision + 1 }
    const creditAttemptId = String(params.find(value =>
      typeof value === 'string' && value.startsWith('credit_attempt_')) ?? '')
    if (creditAttemptId && q.includes('complete_city_credit_attempt')) {
      const attempt = state.paymentAttempts.get(creditAttemptId)
      const assetMatches = !q.includes("asset_type = 'kind' AND asset_id =")
        || (attempt?.asset_type === 'kind' && attempt.asset_id === 3)
      if (attempt && assetMatches) {
        const balance = state.cityCreditBalances.get(attempt.actor_id) ?? 0n
        const response = {
          kind: returned,
          city_fee_credit: {
            spent_usdc: '1.000000',
            balance_usdc: `${balance / 1_000_000n}.${String(balance % 1_000_000n).padStart(6, '0')}`,
          },
        }
        const responseBody = JSON.stringify(response)
        const status = q.includes('insert into kinds') ? 201 : 200
        state = {
          ...state,
          paymentAttempts: new Map(state.paymentAttempts).set(creditAttemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'kind_revision', id: returned.id, revision: returned.revision },
            response_status: status,
            response_json: response,
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
        return [{ ...returned, response_body: responseBody }]
      }
    }
    if (q.includes('complete_payment_attempt')) {
      const attemptId = String(params.find(value => typeof value === 'string' && value.startsWith('pay_')) ?? '')
      const attempt = state.paymentAttempts.get(attemptId)
      if (attempt) {
        const responseBody = JSON.stringify({ kind: returned, fee_tx: TX1.toLowerCase() })
        const durable = attempt.response_json?.__1f3d9_x402_response_v1
        const header = durable && typeof durable === 'object' && !Array.isArray(durable)
          ? String((durable as Record<string, unknown>).header ?? '')
          : ''
        state = {
          ...state,
          paymentAttempts: new Map(state.paymentAttempts).set(attemptId, {
            ...attempt,
            status: 'completed',
            lease_owner: null,
            lease_expires_at: null,
            result_json: { kind: 'kind_revision', id: returned.id, revision: returned.revision },
            response_status: q.includes('insert into kinds') ? 201 : 200,
            response_json: {
              __1f3d9_x402_response_v1: {
                ...(header ? { header } : {}),
                body: JSON.parse(responseBody) as Record<string, unknown>,
              },
            },
            response_body_bytes: Buffer.from(responseBody, 'utf8'),
            updated_at: '2026-08-11T00:00:00.000Z',
            completed_at: '2026-08-11T00:00:00.000Z',
          }),
        }
      }
    }
    return [{
      ...returned,
      ...(q.includes('complete_payment_attempt') ? {
        response_body: JSON.stringify({ kind: returned, fee_tx: TX1.toLowerCase() }),
      } : {}),
    }]
  }
  if (q.includes('/* public:kinds */')) {
    const row = kindRow()
    return [{
      ...row,
      total_items: 1,
      total_text_bytes: Buffer.byteLength(String(row.description ?? ''), 'utf8'),
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
  if (q.includes('/* public:traits */')) {
    const row = {
      id: 4,
      name: state.placeLawNames.length ? state.lawTraitName : 'glowing',
      description: 'gives off light',
      recipe: state.placeLawNames.length ? state.lawTraitRecipe : null,
      mechanical: state.placeLawNames.length ? Boolean(state.lawTraitRecipe) : false,
      coiner: 'founder',
    }
    return [{
      ...row,
      total_items: 1,
      total_text_bytes: Buffer.byteLength(row.description, 'utf8'),
    }]
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
  // Event reads name things and notes inside their EXISTS place guards, so
  // they must dispatch on their distinctive SELECT list before the generic
  // notes/things branches can swallow them.
  if (q.includes('select id, at, kind, actor, detail') ||
      q.includes('select at, kind, actor, detail') ||
      q.includes('/* public:events */')) {
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
    if (state.scenario === 'public pagination') {
      const kind = params[0] == null ? null : String(params[0])
      const actor = params[1] == null ? null : String(params[1])
      const placeId = params[2] == null ? null : Number(params[2])
      const matching = paginationEvents().filter(event =>
        (kind == null || event.kind === kind) &&
        (actor == null || event.actor === actor) &&
        (placeId == null ||
          Number((event.detail as Record<string, unknown>).place_id) === placeId))
      return withEventTotals(descendingPage(matching, params[3], params[4]), matching)
    }
    if (state.scenario === 'event pagination') {
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
    if (state.scenario === 'activity surfaces') {
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
    if (state.scenario === 'nested moderation events') {
      const all = [
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
      body: state.noteBody,
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
  if (q.includes('/* public:agreements */')) {
    const row = {
      id: 61,
      body: 'we keep the square open',
      created_by: state.actorHandle,
      parties: state.agreementParties,
      acceded: state.agreementAcceded,
      signatures: ['tiny-lantern'],
      accession_open: state.agreementAccessionOpen,
      open: true,
      created_at: '2026-08-11T00:00:00.000Z',
    }
    return state.agreementExists
      ? [{
          ...row,
          total_items: 1,
          total_text_bytes: Buffer.byteLength(row.body, 'utf8'),
        }]
      : [{ id: null, total_items: 0, total_text_bytes: 0 }]
  }
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
  if (q.includes('from things') && !q.includes('update places set')) {
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
  const databaseCalls = Array.isArray(body?.queries)
    ? body.queries.map((query: { query?: string; params?: unknown[] }) => ({
      url, query: query.query, params: query.params,
    }))
    : [{ url, query: body?.query, params: body?.params }]
  state = { ...state, calls: [...state.calls, ...databaseCalls] }
  if (url.includes('/sql') && Array.isArray(body?.queries)) {
    const results = body.queries.map((query: { query: string; params?: unknown[] }) => {
      if (/^\s*SET\s+LOCAL\b/iu.test(query.query)) return neonEncode([])
      if (query.query.includes('/* public:budgeted-exact */')) {
        const shouldReject = state.exactTotalsBusy || (
          state.exactTotalsBusyAfter !== null &&
          state.exactTotalsSuccessfulReads >= state.exactTotalsBusyAfter
        )
        if (shouldReject) return neonEncode([{ __exact_read_slot: null }])
        state = {
          ...state,
          exactTotalsSuccessfulReads: state.exactTotalsSuccessfulReads + 1,
        }
      }
      const rows = dbRespond(query.query, query.params ?? [])
        .map(row => ({ ...row, __exact_read_slot: 0 }))
      return neonEncode(rows)
    })
    return jsonResponse({ results })
  }
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
  const acceptedBody = await accepted.json() as {
    note: { body: string }
    reading_cost: { size_unit: string; new_item_text_bytes: number; room_stored_text_bytes: number; current_first_read_text_bytes: number }
  }
  assert.equal(acceptedBody.note.body, body)
  assert.deepEqual(acceptedBody.reading_cost, {
    available: true,
    size_unit: 'utf8_bytes',
    counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
    new_item_text_bytes: Buffer.byteLength(body, 'utf8'),
    room_stored_text_bytes: 1234,
    current_first_read_text_bytes: 456,
  })
})

test('a meter read failure never turns a committed note into a retryable write failure', async () => {
  reset({ scenario: 'reading cost unavailable' })
  const response = await app.request('/api/note', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, body: 'already committed' }),
  })
  assert.equal(response.status, 201)
  const body = await response.json() as { reading_cost: Record<string, unknown> }
  assert.deepEqual(body.reading_cost, {
    available: false,
    reason: 'measurement_failed',
    measurement_timeout_ms: 1500,
    size_unit: 'utf8_bytes',
    counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
    new_item_text_bytes: Buffer.byteLength('already committed', 'utf8'),
    room_stored_text_bytes: null,
    current_first_read_text_bytes: null,
    note: 'the write succeeded; only this informational meter is unavailable; do not retry',
  })
})

test('a hung meter read stops its loader and reports a bounded database timeout', async () => {
  const { safeReadingCostMeter } = await import('../src/reading-cost.ts')
  let queryOptions: {
    readonly signal: AbortSignal
    readonly statementTimeoutMs: number
  } | undefined
  let loaderStopped = false
  const startedAt = Date.now()
  const meter = await safeReadingCostMeter(2, 'already committed', {
    timeoutMs: 20,
    load: (_placeId, _newItemText, options) => {
      queryOptions = options
      return new Promise((_resolve, reject) => {
        options?.signal.addEventListener('abort', () => {
          loaderStopped = true
          reject(new Error('loader stopped'))
        }, { once: true })
      })
    },
  })
  assert.deepEqual(meter, {
    available: false,
    reason: 'measurement_timeout',
    measurement_timeout_ms: 20,
    size_unit: 'utf8_bytes',
    counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
    new_item_text_bytes: Buffer.byteLength('already committed', 'utf8'),
    room_stored_text_bytes: null,
    current_first_read_text_bytes: null,
    note: 'the write succeeded; the reading-cost measurement timed out and its database query has a bounded deadline; do not retry',
  })
  assert.ok(queryOptions, 'the loader must receive cancellation controls')
  assert.ok(queryOptions.statementTimeoutMs > 0)
  assert.ok(queryOptions.statementTimeoutMs < 20)
  assert.equal(queryOptions.signal.aborted, true)
  assert.equal(loaderStopped, true)
  assert.ok(Date.now() - startedAt < 500, 'a meter must not hold a successful write open')
})

test('the reading-cost query installs its database deadline before measuring', async () => {
  const { safeReadingCostMeter } = await import('../src/reading-cost.ts')
  reset({ scenario: 'validation' })

  const meter = await safeReadingCostMeter(2, 'already committed')

  assert.equal(meter.available, true)
  const calls = sqlCalls()
  const timeoutIndex = calls.findIndex(call => /^\s*SET\s+LOCAL\s+statement_timeout/iu.test(
    call.query ?? '',
  ))
  const meterIndex = calls.findIndex(call => /\/\* public:reading_cost \*\//iu.test(
    call.query ?? '',
  ))
  assert.ok(timeoutIndex >= 0, 'the database must receive a statement timeout')
  assert.ok(meterIndex > timeoutIndex, 'the database deadline must precede the meter query')
  assert.match(calls[timeoutIndex]?.query ?? '', /'\d+ms'/u)
})

test('the legacy full public map stays exact and explicit full shares its short cache', async () => {
  const originalNow = Date.now
  try {
    // Backdate the clock so the map cache this test warms is already expired
    // for every later test.
    const realNow = originalNow()
    Date.now = () => realNow - 180_000
    reset({ scenario: 'map' })
    const response = await app.request('/api/map')
    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
    )
    const body = await response.json() as { places: { id: number; owner: string; children: { id: number }[] }[] }
    assert.equal(Object.hasOwn(body, 'view'), false, 'the no-query compatibility response stays exact')
    assert.equal(body.places[0]?.id, 1)
    assert.equal(body.places[0]?.owner, 'founder')
    assert.equal(body.places[0]?.children[0]?.id, 2)
    assert.ok(sqlCalls().some(call => /with\s+recursive/i.test(call.query ?? '')))

    const queriesAfterFirst = sqlCalls().length
    const cached = await app.request('/api/map')
    assert.equal(cached.status, 200)
    assert.equal(sqlCalls().length, queriesAfterFirst, 'a map within the TTL reuses the shared build')

    const explicit = await app.request('/api/map?view=full')
    assert.equal(explicit.status, 200)
    const explicitBody = await explicit.json() as { view: string; places: typeof body.places }
    assert.equal(explicitBody.view, 'full')
    assert.deepEqual(explicitBody.places, body.places)
    assert.equal(
      sqlCalls().length,
      queriesAfterFirst,
      'explicit and compatibility full reads share one full-map cache entry',
    )
  } finally {
    Date.now = originalNow
  }
})

test('the outline map pages one flat branch newest-first and caches its hot root page', async () => {
  const originalNow = Date.now
  try {
    const realNow = originalNow()
    Date.now = () => realNow - 140_000
    reset({ scenario: 'map outline' })
    const firstPath = '/api/map?view=outline'
    const firstResponse = await app.request(firstPath)
    assert.equal(firstResponse.status, 200)
    assert.equal(
      firstResponse.headers.get('cache-control'),
      'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
    )
    const first = await firstResponse.json() as {
      view: string
      place: { id: number; children: unknown[] }
      subplaces: Array<{ id: number; description?: string; children: unknown[]; places: number }>
      subplaces_page: {
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before_subplace_id: number | null
      }
      map_complete: boolean
    }
    assert.equal(first.view, 'outline')
    assert.equal(first.place.id, 1)
    assert.deepEqual(first.place.children, [])
    assert.deepEqual(first.subplaces.map(place => place.id), recentIds(160).slice(0, 10))
    assert.equal(first.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
    assert.equal(first.subplaces.every(place => Array.isArray(place.children) && place.children.length === 0), true)
    assert.equal(first.subplaces[0]?.places, 2)
    assert.deepEqual(first.subplaces_page, {
      total_items: 60,
      total_text_bytes: mapOutlineRows().reduce(
        (total, row) => total + Buffer.byteLength(row.description, 'utf8'),
        0,
      ),
      returned_items: 10,
      returned_text_bytes: 0,
      has_more: true,
      next_before_subplace_id: 151,
    })
    assert.equal(first.map_complete, false)
    assert.equal(
      sqlCalls().some(call => /with\s+recursive\s+place_tree/i.test(call.query ?? '')),
      false,
      'an outline branch must not materialize the complete recursive map',
    )

    const callsAfterFirst = sqlCalls().length
    const cached = await app.request(firstPath)
    assert.equal(cached.status, 200)
    assert.deepEqual(await cached.json(), first)
    assert.equal(sqlCalls().length, callsAfterFirst, 'the initial root outline reuses its cache entry')

    const secondResponse = await app.request(
      '/api/map?view=outline&parent_id=1&before_subplace_id=151&subplace_limit=3',
    )
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as typeof first
    assert.deepEqual(second.subplaces.map(place => place.id), [150, 149, 148])
    assert.equal(
      second.subplaces.some(place => first.subplaces.some(previous => previous.id === place.id)),
      false,
    )
    assert.equal(second.subplaces_page.next_before_subplace_id, 148)

    const read = sqlCalls().find(call => /\/\* public:map-outline \*\//i.test(call.query ?? ''))
    assert.deepEqual(
      read?.params?.map((value, index) => index === 1
        ? String(value)
        : value == null ? null : Number(value)),
      [null, 'the world', null, 11],
      'one statement selects the root and fetches one lookahead row',
    )
    assert.equal(
      sqlCalls().some(call => /\/\* public:map-parent \*\//i.test(call.query ?? '')),
      false,
      'the parent, totals, and page share one database snapshot',
    )
  } finally {
    Date.now = originalNow
  }
})

test('map modes reject ambiguous, unsupported, and cross-mode options before PostgreSQL', async () => {
  for (const path of [
    '/api/map?view=outline&view=full',
    '/api/map?view=sideways',
    '/api/map?parent_id=1',
    '/api/map?view=full&parent_id=1',
    '/api/map?view=full&before_subplace_id=2',
    '/api/map?view=full&subplace_limit=2',
    '/api/map?view=outline&parent_id=0',
    '/api/map?view=outline&parent_id=2147483648',
    '/api/map?view=outline&before_subplace_id=1.5',
    '/api/map?view=outline&subplace_limit=0',
    '/api/map?view=outline&subplace_limit=201',
    '/api/map?view=outline&subplace_limit=2&subplace_limit=3',
    '/api/map?view=outline&after_change_marker=-1',
    '/api/map?view=outline&after_change_marker=01',
    '/api/map?view=outline&after_change_marker=9&after_change_marker=10',
    '/api/map?after_change_marker=9',
    '/api/map?view=outline&unknown=1',
  ]) {
    reset({ scenario: 'map outline' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
  }
})

test('lazy map and history pages prove they cover the caller-held change marker', async () => {
  reset({ scenario: 'map outline', publicChangeMarker: '9' })
  const map = await app.request(
    '/api/map?view=outline&parent_id=1&subplace_limit=3&after_change_marker=9',
  )
  assert.equal(map.status, 200)
  assert.equal(map.headers.get('cache-control'), 'no-store')
  assert.equal((await map.json() as { change_marker: string }).change_marker, '9')
  assert.ok(sqlCalls().some(call => /\/\* public:changes-checkpoint \*\//iu.test(call.query ?? '')))
  assert.ok(sqlCalls().some(call => /\/\* public:map-outline \*\//iu.test(call.query ?? '')))

  reset({ scenario: 'public pagination', publicChangeMarker: '9' })
  const history = await app.request(
    '/api/window?collection=things&limit=2&after_change_marker=9',
  )
  assert.equal(history.status, 200)
  assert.equal(history.headers.get('cache-control'), 'no-store')
  assert.equal((await history.json() as { change_marker: string }).change_marker, '9')

  reset({ scenario: 'public pagination', publicChangeMarker: '9' })
  const events = await app.request('/api/events?limit=2&after_change_marker=9')
  assert.equal(events.status, 200)
  assert.equal(events.headers.get('cache-control'), 'no-store')
  assert.equal((await events.json() as { change_marker: string }).change_marker, '9')

  for (const path of [
    '/api/map?view=outline&parent_id=1&after_change_marker=10',
    '/api/window?collection=things&after_change_marker=10',
    '/api/events?after_change_marker=10',
  ]) {
    reset({ scenario: 'public pagination', publicChangeMarker: '9' })
    const response = await app.request(path)
    assert.equal(response.status, 409, path)
    assert.deepEqual(await response.json(), {
      error: 'since marker 10 is ahead of checkpoint 9',
    })
    assert.equal(
      sqlCalls().filter(call => !/\/\* public:changes-checkpoint \*\//iu.test(call.query ?? '')).length,
      0,
      `${path} stops before its page read`,
    )
  }
})

test('a large, deep, credential-free map is served instead of withheld', async () => {
  const originalNow = Date.now
  try {
    // A different backdate than the previous map test so its cache entry is
    // already stale here, and this test's own entry is stale for later ones.
    const realNow = originalNow()
    Date.now = () => realNow - 120_000
    reset({ scenario: 'large map' })
    const response = await app.request('/api/map')
    assert.equal(response.status, 200)
    const body = await response.json() as { places: Array<{ id: number; children: Array<{ id: number }> }> }
    assert.equal(body.places[0]?.id, 1)
    assert.ok((body.places[0]?.children.length ?? 0) >= 1400)
    let depth = 0
    let cursor = body.places[0]?.children.find(child => child.id === 3000) as
      { id: number; children: { id: number; children: unknown[] }[] } | undefined
    while (cursor) {
      depth += 1
      cursor = cursor.children[0] as typeof cursor
    }
    assert.equal(depth, 16)
  } finally {
    Date.now = originalNow
  }
})

test('the window snapshot marks residents asleep from their last public act', async () => {
  const originalNow = Date.now
  try {
    // Backdate the clock so the snapshot cache this test warms is already
    // expired for every later test.
    const realNow = originalNow()
    Date.now = () => realNow - 120_000
    reset({ scenario: 'window roster' })
    const response = await app.request('/api/window')
    assert.equal(response.status, 200)
    const body = await response.json() as { residents: Array<{ handle: string; asleep: boolean }> }
    assert.deepEqual(body.residents.map(resident => [resident.handle, resident.asleep]), [
      ['long-gone', true],
      ['tiny-lantern', false],
    ])
    const roster = sqlCalls().find(call => /left join resident_presence/i.test(call.query ?? ''))
    assert.match(roster?.query ?? '', /recent_public_act/i)
    assert.match(roster?.query ?? '', /interval '1 day'/i)
  } finally {
    Date.now = originalNow
  }
})

test('the legacy full window stays exact and explicit full shares its snapshot cache', async () => {
  const originalNow = Date.now
  try {
    const realNow = originalNow()
    Date.now = () => realNow - 80_000
    reset({ scenario: 'window roster' })

    const legacyResponse = await app.request('/api/window')
    assert.equal(legacyResponse.status, 200)
    const legacy = await legacyResponse.json() as Record<string, unknown>
    assert.equal(Object.hasOwn(legacy, 'view'), false)
    const callsAfterLegacy = sqlCalls().length

    const explicitResponse = await app.request('/api/window?view=full')
    assert.equal(explicitResponse.status, 200)
    const explicit = await explicitResponse.json() as Record<string, unknown>
    assert.equal(explicit.view, 'full')
    assert.deepEqual(
      Object.fromEntries(Object.entries(explicit).filter(([key]) => key !== 'view')),
      legacy,
    )
    assert.equal(
      sqlCalls().length,
      callsAfterLegacy,
      'compatibility and explicit full reads share one full-snapshot cache entry',
    )
  } finally {
    Date.now = originalNow
  }
})

test('the outline window bounds its map and presence pages without changing recent histories', async () => {
  const originalNow = Date.now
  try {
    const realNow = originalNow()
    Date.now = () => realNow - 40_000
    reset({ scenario: 'window outline' })
    const response = await app.request('/api/window?view=outline')
    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
    )
    const body = await response.json() as {
      view: string
      places: Array<{
        id: number
        children: Array<{ id: number; description?: string; children: unknown[] }>
      }>
      residents: Array<{ id: number; current_place_id: number | null; asleep: boolean }>
      notes: Array<{ id: number }>
      things: Array<{ id: number }>
      agreements: Array<{ id: number }>
      events: Array<{ id: number }>
      pages: {
        places: { has_more: boolean; next_before_subplace_id: number | null }
        residents: { has_more: boolean; next_before_id: number | null }
      }
      totals: Record<string, number>
      shown: Record<string, number>
      limits: Record<string, number | null>
      change_marker: string
    }
    assert.equal(body.view, 'outline')
    assert.equal(body.change_marker, '9')
    assert.deepEqual(body.places.map(place => place.id), [1])
    assert.deepEqual(body.places[0]?.children.map(place => place.id), recentIds(160).slice(0, 10))
    assert.equal(body.places[0]?.children.every(place => (
      place.children.length === 0 && !Object.hasOwn(place, 'description')
    )), true)
    assert.deepEqual(body.residents.map(resident => resident.id), recentIds(1070).slice(0, 25))
    assert.equal(body.residents.every(resident => (
      Object.hasOwn(resident, 'current_place_id') && Object.hasOwn(resident, 'asleep')
    )), true)
    assert.deepEqual(
      [body.notes.length, body.things.length, body.agreements.length, body.events.length],
      [10, 10, 10, 10],
      'the four already-bounded histories stay at ten rows',
    )
    assert.deepEqual(body.totals, {
      places: 61,
      residents: 60,
      conversations: 60,
      things: 60,
      agreements: 60,
      events: 70,
    })
    assert.deepEqual(body.shown, {
      places: 11,
      residents: 25,
      conversations: 10,
      things: 10,
      agreements: 10,
      events: 10,
    })
    assert.deepEqual(body.limits, {
      places: 10,
      residents: 25,
      conversations: 10,
      things: 10,
      agreements: 10,
      events: 10,
    })
    assert.deepEqual(body.pages.places, {
      has_more: true,
      next_before_subplace_id: 151,
    })
    assert.deepEqual(body.pages.residents, {
      has_more: true,
      next_before_id: 1046,
    })
    assert.equal(
      sqlCalls().some(call => /with\s+recursive\s+world/i.test(call.query ?? '')),
      false,
      'the outline window must not materialize the complete map',
    )
  } finally {
    Date.now = originalNow
  }
})

test('window modes reject mixed, duplicate, and unknown options before PostgreSQL', async () => {
  for (const path of [
    '/api/window?view=outline&view=full',
    '/api/window?view=sideways',
    '/api/window?view=full&collection=notes',
    '/api/window?view=outline&before_id=2',
    '/api/window?view=outline&unknown=1',
    '/api/window?view=full&after_change_marker=9',
    '/api/window?after_change_marker=9',
    '/api/window?view=outline&after_change_marker=-1',
    '/api/window?view=outline&after_change_marker=01',
    '/api/window?view=outline&after_change_marker=9223372036854775808',
    '/api/window?view=outline&after_change_marker=9&after_change_marker=10',
  ]) {
    reset({ scenario: 'window outline' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
  }
})

test('the directory window is one cached, moderated, body-free statement with exact keys', async () => {
  const originalNow = Date.now
  try {
    const frozenNow = originalNow() - 120_000
    Date.now = () => frozenNow
    reset({ scenario: 'window directory' })

    const firstResponse = await app.request('/api/window?view=directory')
    assert.equal(firstResponse.status, 200)
    assert.equal(
      firstResponse.headers.get('cache-control'),
      'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
    )
    const directory = await firstResponse.json() as Record<string, unknown> & {
      places: Array<Record<string, unknown>>
      residents: Array<Record<string, unknown>>
    }
    assert.deepEqual(Object.keys(directory).sort(), ['places', 'residents', 'view'])
    assert.equal(directory.view, 'directory')
    assert.deepEqual(Object.keys(directory.places[0] ?? {}).sort(), ['id', 'name', 'parent_id'])
    assert.deepEqual(Object.keys(directory.residents[0] ?? {}).sort(), ['handle', 'id'])
    assert.deepEqual(directory.places, [
      { id: 1, parent_id: null, name: 'the world' },
      { id: 2, parent_id: 1, name: '[removed by maintainer]' },
    ])
    assert.deepEqual(directory.residents, [{ id: 7, handle: 'tiny-lantern' }])

    const directoryCalls = sqlCalls().filter(call =>
      /\/\* public:window-directory \*\//iu.test(call.query ?? ''))
    assert.equal(directoryCalls.length, 1)
    assert.match(directoryCalls[0]?.query ?? '', /moderation_actions/iu)
    assert.doesNotMatch(
      directoryCalls[0]?.query ?? '',
      /\b(?:description|purpose|owner_id|secret_hash|model|joined_at|current_place_id|asleep)\b/iu,
    )

    const callsAfterFirst = sqlCalls().length
    const cachedResponse = await app.request('/api/window?view=directory')
    assert.equal(cachedResponse.status, 200)
    assert.deepEqual(await cachedResponse.json(), directory)
    assert.equal(sqlCalls().length, callsAfterFirst)
  } finally {
    Date.now = originalNow
  }
})

test('the directory window rejects mixed, duplicate, unknown, and credentialed input before PostgreSQL', async () => {
  const cases: Array<{ path: string; headers?: Record<string, string> }> = [
    { path: '/api/window?view=directory&view=outline' },
    { path: '/api/window?view=directory&after_change_marker=9' },
    { path: '/api/window?view=directory&collection=places' },
    { path: '/api/window?view=directory&unknown=1' },
    { path: '/api/window?view=directory', headers: { Authorization: `Bearer ${SECRET}` } },
    { path: '/api/window?view=directory', headers: { Cookie: 'session=private' } },
  ]
  for (const entry of cases) {
    reset({ scenario: 'window directory' })
    const response = await app.request(
      entry.path,
      entry.headers === undefined ? undefined : { headers: entry.headers },
    )
    assert.equal(response.status, 400, entry.path)
    assert.equal(sqlCalls().length, 0, `${entry.path} must fail before PostgreSQL work`)
  }
})

test('a marker-covered outline bypasses stale caches and rejects a future marker', async () => {
  reset({ scenario: 'window outline', publicChangeMarker: '10' })
  const covered = await app.request('/api/window?view=outline&after_change_marker=10')
  assert.equal(covered.status, 200)
  assert.equal(covered.headers.get('cache-control'), 'no-store')
  const body = await covered.json() as { change_marker: string }
  assert.equal(body.change_marker, '10')
  assert.ok(
    sqlCalls().some(call => /\/\* public:map-outline \*\//iu.test(call.query ?? '')),
    'a covered snapshot reads the map directly instead of accepting a nested stale cache',
  )
  const callsAfterCoveredRead = sqlCalls().length
  const repeated = await app.request('/api/window?view=outline&after_change_marker=10')
  assert.equal(repeated.status, 200)
  assert.equal(repeated.headers.get('cache-control'), 'no-store')
  assert.equal(
    sqlCalls().length,
    callsAfterCoveredRead,
    'the same covered marker shares its proven in-process snapshot',
  )

  reset({ scenario: 'window outline', publicChangeMarker: '10' })
  const future = await app.request('/api/window?view=outline&after_change_marker=11')
  assert.equal(future.status, 409)
  assert.deepEqual(await future.json(), {
    error: 'since marker 11 is ahead of checkpoint 10',
  })
  assert.equal(
    sqlCalls().some(call => /\/\* public:map-outline \*\//iu.test(call.query ?? '')),
    false,
    'a future marker stops before the snapshot fanout',
  )
  const callsAfterFuture = sqlCalls().length
  const ordinary = await app.request('/api/window?view=outline')
  assert.equal(ordinary.status, 200)
  assert.equal(
    sqlCalls().length,
    callsAfterFuture,
    'a rejected future marker does not poison or evict the valid shared snapshot',
  )
})

test('a busy outline-window census starts no secondary public reads', async () => {
  const originalNow = Date.now
  try {
    const now = originalNow()
    Date.now = () => now + 40_000
    reset({ scenario: 'window outline', exactTotalsBusy: true })
    const response = await app.request('/api/window?view=outline')
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '1')
    assert.deepEqual(await response.json(), {
      error: 'exact public totals are temporarily busy; retry',
    })
    const secondaryRead = sqlCalls().find(call => /public:map-(?:parent|outline)|from notes note|from things thing|from agreements agreement|select id, at, kind, actor, detail|select count\(\*\)::int from places/iu.test(call.query ?? ''))
    assert.equal(
      secondaryRead,
      undefined,
      'admission must reject before map, history, or global-total work starts',
    )
  } finally {
    Date.now = originalNow
  }
})

test('busy outline-window global totals stop before map or history reads', async () => {
  const originalNow = Date.now
  try {
    const now = originalNow()
    Date.now = () => now + 80_000
    reset({
      scenario: 'window outline',
      exactTotalsBusyAfter: 1,
    })
    const response = await app.request('/api/window?view=outline')
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '1')
    assert.deepEqual(await response.json(), {
      error: 'exact public totals are temporarily busy; retry',
    })
    const budgetedReads = sqlCalls().filter(call =>
      call.query?.includes('/* public:budgeted-exact */'))
    assert.equal(budgetedReads.length, 2, 'census passes before global totals reject')
    const secondaryRead = sqlCalls().find(call =>
      /public:map-(?:parent|outline)|from notes note|from things thing|from agreements agreement|select id, at, kind, actor, detail/iu.test(call.query ?? ''))
    assert.equal(
      secondaryRead,
      undefined,
      'global-total admission must reject before map or history work starts',
    )
  } finally {
    Date.now = originalNow
  }
})

test('the legal pages answer as plain text naming the operator', async () => {
  for (const path of ['/terms', '/privacy']) {
    const response = await app.request(path)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/)
    const body = await response.text()
    assert.match(body, /TWAMD LLC/)
    assert.match(body, /adam@twamd\.com/)
    assert.doesNotMatch(body, /1f3d9_(?:sk|at|rt|ac|rc)_/)
  }
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
  assert.deepEqual({ has_more: firstBody.notes_page.has_more, next_before_note_id: firstBody.notes_page.next_before_note_id }, { has_more: true, next_before_note_id: 6 })

  reset({ scenario: 'busy place' })
  const older = await app.request('/api/place/2?before_note_id=6&note_limit=10')
  assert.equal(older.status, 200)
  const olderBody = await older.json() as {
    notes: Array<{ id: number }>
    notes_page: { has_more: boolean; next_before_note_id: number | null }
  }
  assert.deepEqual(olderBody.notes.map(note => note.id), [5, 4, 3, 2, 1])
  assert.deepEqual({ has_more: olderBody.notes_page.has_more, next_before_note_id: olderBody.notes_page.next_before_note_id }, { has_more: false, next_before_note_id: null })

  const invalid = await app.request('/api/place/2?before_note_id=nope')
  assert.equal(invalid.status, 400)
})

test('public thing and note detail reads expose full active records without writes', async () => {
  reset({ scenario: 'public details' })
  const thing = await app.request('/api/thing/41')
  assert.equal(thing.status, 200)
  const thingBody = await thing.json() as { thing: Record<string, unknown> }
  assert.deepEqual(thingBody.thing, {
    ...thingBody.thing,
    id: 41,
    body: 'warm light',
    maker_id: 7,
    made_by: 'tiny-lantern',
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner_id: 7,
    owner: 'tiny-lantern',
  })
  const detailRead = sqlCalls().find(call => (
    /from\s+things\s+thing/i.test(call.query ?? '') && /where\s+thing\.id/i.test(call.query ?? '')
  ))
  assert.match(detailRead?.query ?? '', /thing\.maker_id/i)
  assert.match(detailRead?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
  assert.match(detailRead?.query ?? '', /thing\.owner_id\s+AS\s+current_owner_id/i)
  assert.match(detailRead?.query ?? '', /owner\.handle\s+AS\s+current_owner/i)
  assert.match(detailRead?.query ?? '', /JOIN\s+residents\s+maker\s+ON\s+maker\.id\s*=\s*thing\.maker_id/i)

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
  assert.equal(changed.status, 200, await changed.clone().text())

  setActor(8, 'neighbor')
  const rejected = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(OTHER_SECRET), body: JSON.stringify({ open_to_building: false }),
  })
  assert.equal(rejected.status, 403)
})

type RoomFrontMatterHeading = {
  id: number
  type: string
  name: string
  body_text_bytes: number
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
  owner_id: number
  owner: string
  body?: unknown
  body_snippet?: unknown
  snippet?: unknown
}

function assertRoomFrontMatter(
  headings: readonly RoomFrontMatterHeading[],
  expectedIds: readonly number[],
) {
  assert.deepEqual(headings.map(heading => heading.id), expectedIds)
  for (const heading of headings) {
    assert.equal(heading.type, 'thing')
    assert.equal(typeof heading.name, 'string')
    assert.ok(heading.body_text_bytes > 0)
    assert.ok(heading.maker_id > 0)
    assert.match(heading.made_by, /^(?:tiny-lantern|neighbor)$/u)
    assert.ok(heading.current_owner_id > 0)
    assert.match(heading.current_owner, /^(?:tiny-lantern|neighbor)$/u)
    assert.equal(heading.owner_id, heading.current_owner_id)
    assert.equal(heading.owner, heading.current_owner)
    assert.equal(Object.hasOwn(heading, 'body'), false)
    assert.equal(Object.hasOwn(heading, 'body_snippet'), false)
    assert.equal(Object.hasOwn(heading, 'snippet'), false)
  }
}

test('a place owner sets purpose and two or three ordered front-matter headings without changing description', async () => {
  reset({ scenario: 'room orientation', placeOwnerId: 7 })
  const payload = {
    purpose: 'A small room for deliberate reading.',
    front_matter_thing_ids: [43, 41, 42],
  }
  const changed = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(), body: JSON.stringify(payload),
  })
  assert.equal(changed.status, 200, await changed.clone().text())
  const body = await changed.json() as {
    place: { purpose: string; description: string }
    front_matter: RoomFrontMatterHeading[]
  }
  assert.equal(body.place.purpose, payload.purpose)
  assert.equal(body.place.description, 'a place made from words')
  assert.equal(Object.hasOwn(body.place, 'front_matter_thing_ids'), false)
  assertRoomFrontMatter(body.front_matter, payload.front_matter_thing_ids)
  assert.deepEqual(body.front_matter[0], {
    ...body.front_matter[0],
    id: 43,
    type: 'thing',
    name: 'borrowed field guide',
    body_text_bytes: Buffer.byteLength('three careful routes 🏙', 'utf8'),
    maker_id: 8,
    made_by: 'neighbor',
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner_id: 7,
    owner: 'tiny-lantern',
  })

  const retried = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(), body: JSON.stringify(payload),
  })
  assert.equal(retried.status, 200, await retried.clone().text())
  const retriedBody = await retried.json() as {
    place: { purpose: string; description: string }
    front_matter: RoomFrontMatterHeading[]
  }
  assert.equal(retriedBody.place.purpose, payload.purpose)
  assert.equal(retriedBody.place.description, 'a place made from words')
  assertRoomFrontMatter(retriedBody.front_matter, payload.front_matter_thing_ids)
})

test('room orientation is owner-only and rejects malformed or ineligible selections', async () => {
  reset({
    scenario: 'room orientation', placeOwnerId: 7,
    roomPurpose: 'A retry-safe reading room.', frontMatterThingIds: [41, 42],
  })
  setActor(8, 'neighbor')
  const forbidden = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ purpose: 'Keep the old description.' }),
  })
  assert.equal(forbidden.status, 403, await forbidden.text())
  assert.equal(state.roomPurpose, 'A retry-safe reading room.')
  assert.deepEqual(state.frontMatterThingIds, [41, 42])

  setActor(7, 'tiny-lantern')
  const malformedBodies: readonly Record<string, unknown>[] = [
    { purpose: 'safe', surprise: true },
    { purpose: 42 },
    { purpose: 'two\nlines' },
    { purpose: 'x'.repeat(281) },
    { front_matter_thing_ids: '41,42' },
    { front_matter_thing_ids: [41] },
    { front_matter_thing_ids: [41, 42, 43, 44] },
    { front_matter_thing_ids: [41, 41] },
    { front_matter_thing_ids: [0, 42] },
  ]
  for (const malformed of malformedBodies) {
    const response = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify(malformed),
    })
    assert.equal(response.status, 400, JSON.stringify({ malformed, body: await response.text() }))
    assert.equal(state.roomPurpose, 'A retry-safe reading room.')
    assert.deepEqual(state.frontMatterThingIds, [41, 42])
  }

  for (const patch of [
    { frontMatterMovedThingIds: [42] },
    { targetThingWithdrawn: true },
    { frontMatterHiddenThingIds: [42] },
  ] satisfies readonly Partial<FakeState>[]) {
    reset({ scenario: 'room orientation', placeOwnerId: 7, ...patch })
    const response = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ front_matter_thing_ids: [41, 42] }),
    })
    assert.equal(response.status, 400, await response.text())
    assert.equal(state.roomPurpose, '')
    assert.deepEqual(state.frontMatterThingIds, [])
  }
})

test('public outline and full place reads expose ordered body-free orientation headings only while eligible', async () => {
  reset({
    scenario: 'room orientation',
    roomPurpose: 'A small room for deliberate reading.',
    frontMatterThingIds: [43, 41, 42],
  })
  for (const view of ['outline', 'full'] as const) {
    const response = await app.request(`/api/place/2?view=${view}`)
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      place: { purpose: string; description?: string }
      front_matter: RoomFrontMatterHeading[]
    }
    assert.equal(body.place.purpose, 'A small room for deliberate reading.')
    assertRoomFrontMatter(body.front_matter, [43, 41, 42])
  }

  state = { ...state, calls: [], frontMatterMovedThingIds: [43] }
  const afterMove = await app.request('/api/place/2?view=outline')
  assert.equal(afterMove.status, 200)
  assertRoomFrontMatter(
    (await afterMove.json() as { front_matter: RoomFrontMatterHeading[] }).front_matter,
    [41, 42],
  )

  state = { ...state, calls: [], thingWithdrawn: true }
  const afterWithdrawal = await app.request('/api/place/2?view=full')
  assert.equal(afterWithdrawal.status, 200)
  assertRoomFrontMatter(
    (await afterWithdrawal.json() as { front_matter: RoomFrontMatterHeading[] }).front_matter,
    [42],
  )

  state = { ...state, calls: [], frontMatterHiddenThingIds: [42] }
  const afterModeration = await app.request('/api/place/2?view=outline')
  assert.equal(afterModeration.status, 200)
  const hiddenBody = await afterModeration.json() as { front_matter: RoomFrontMatterHeading[] }
  assertRoomFrontMatter(hiddenBody.front_matter, [])
  assert.equal(hiddenBody.front_matter.some(heading => heading.id === 44), false)

  const orientationRead = sqlCalls().find(call => {
    const query = call.query ?? ''
    return /front_matter_thing_ids/iu.test(query) && /\bthings\b|\bunnest\s*\(/iu.test(query)
  })
  assert.ok(orientationRead, 'public place reads must load only the selected front-matter rows')
  assert.match(orientationRead.query ?? '', /with\s+ordinality|order\s+by[\s\S]*(?:position|ordinality)/iu)
})

test('an empty selection clears front matter and a stale eligibility race returns a retryable conflict', async () => {
  reset({
    scenario: 'room orientation', placeOwnerId: 7,
    roomPurpose: 'A retry-safe reading room.', frontMatterThingIds: [41, 42],
  })
  const cleared = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({ front_matter_thing_ids: [] }),
  })
  assert.equal(cleared.status, 200, await cleared.clone().text())
  const clearedBody = await cleared.json() as {
    place: { purpose: string; description: string }
    front_matter: RoomFrontMatterHeading[]
  }
  assert.equal(clearedBody.place.purpose, 'A retry-safe reading room.')
  assert.equal(clearedBody.place.description, 'a place made from words')
  assertRoomFrontMatter(clearedBody.front_matter, [])

  reset({ scenario: 'room orientation', placeOwnerId: 7, frontMatterRaceLost: true })
  const raced = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({ front_matter_thing_ids: [41, 42] }),
  })
  assert.equal(raced.status, 409, await raced.clone().text())
  assert.match((await raced.json() as { error: string }).error, /retry/iu)

  state = { ...state, frontMatterRaceLost: false, calls: [] }
  const retry = await app.request('/api/place/2', {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({ front_matter_thing_ids: [41, 42] }),
  })
  assert.equal(retry.status, 200, await retry.clone().text())
  assertRoomFrontMatter(
    (await retry.json() as { front_matter: RoomFrontMatterHeading[] }).front_matter,
    [41, 42],
  )
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

test('credential-shaped names and recipes fail before any public write or payment', async () => {
  const paidFields = { payer_wallet: SELLER_WALLET, fee_tx_hash: TX1 }
  const credentials = [
    `1f3d9_sk_${'a1'.repeat(24)}`,
    `1f3d9_at_${'b2'.repeat(32)}`,
    `1f3d9_rt_${'c3'.repeat(32)}`,
    `1f3d9_ac_${'d4'.repeat(32)}`,
  ]

  for (const leaked of credentials) {
    const cases = [
      ['/api/kind', 'POST', {
        name: leaked, description: 'safe', traits: [], recipe: [], ...paidFields,
      }],
      ['/api/kind', 'POST', {
        name: 'safe-kind', description: 'safe', traits: [leaked], recipe: [], ...paidFields,
      }],
      ['/api/kind', 'POST', {
        name: 'safe-kind', description: 'safe', traits: [],
        recipe: [{ kind: leaked, quantity: 1 }], ...paidFields,
      }],
      ['/api/kind/3/revise', 'POST', {
        description: 'safe', traits: [leaked], recipe: [], ...paidFields,
      }],
      ['/api/kind/3/revise', 'POST', {
        description: 'safe', traits: [], recipe: [{ kind: leaked, quantity: 1 }], ...paidFields,
      }],
      ['/api/trait', 'POST', { name: leaked, description: 'safe' }],
      ['/api/trait', 'POST', {
        name: 'safe-trait', description: 'safe',
        recipe: { use: [{ effect: 'label', target: 'actor', label: leaked }] },
      }],
      ['/api/trait', 'POST', {
        name: 'safe-trait', description: 'safe',
        recipe: { use: [{ effect: 'check_label', target: 'actor', label: leaked, then: [] }] },
      }],
      ['/api/place/2/laws', 'PUT', { traits: [leaked] }],
    ] as const

    for (const [path, method, body] of cases) {
      reset({ scenario: `credential write guard ${path}` })
      const response = await app.request(path, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, `${path}: ${await response.clone().text()}`)
      assert.doesNotMatch(await response.text(), new RegExp(leaked, 'i'), path)
      assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false, path)
      assert.equal(
        sqlCalls().some(call => (
          /\b(?:insert|update|delete)\b/i.test(call.query ?? '') &&
          /\b(?:kinds|kind_revisions|traits|place_law_changes|payment_uses|fees|events)\b/i
            .test(call.query ?? '')
        )),
        false,
        `${path}: ${JSON.stringify(sqlCalls())}`,
      )
    }
  }
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
  const upgradeWrite = sqlCalls().find(call => /WITH\s+upgradeable/i.test(call.query ?? ''))
  assert.match(upgradeWrite?.query ?? '', /changed\.maker_id/i)
  assert.match(upgradeWrite?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
  assert.match(upgradeWrite?.query ?? '', /changed\.owner_id\s+AS\s+current_owner_id/i)
  assert.match(upgradeWrite?.query ?? '', /current_owner\.handle\s+AS\s+current_owner/i)
  assert.match(upgradeWrite?.query ?? '', /JOIN\s+residents\s+maker\s+ON\s+maker\.id\s*=\s*changed\.maker_id/i)
  assert.match(upgradeWrite?.query ?? '', /JOIN\s+residents\s+current_owner\s+ON\s+current_owner\.id\s*=\s*changed\.owner_id/i)

  setActor(8, 'neighbor')
  const nonOwner = await app.request('/api/thing/41/upgrade', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
  })
  assert.equal(nonOwner.status, 403)

  reset({
    scenario: 'transferred thing upgrade keeps maker',
    actorId: 8,
    actorHandle: 'neighbor',
    thingOwnerId: 8,
    kindRevision: 2,
  })
  const transferred = await app.request('/api/thing/41/upgrade', {
    method: 'POST',
    headers: authHeaders(OTHER_SECRET),
  })
  assert.equal(transferred.status, 200)
  const transferredBody = await transferred.json() as { thing: Record<string, unknown> }
  assert.deepEqual({
    maker_id: transferredBody.thing.maker_id,
    made_by: transferredBody.thing.made_by,
    current_owner_id: transferredBody.thing.current_owner_id,
    current_owner: transferredBody.thing.current_owner,
    owner_id: transferredBody.thing.owner_id,
    owner: transferredBody.thing.owner,
  }, {
    maker_id: 7,
    made_by: 'tiny-lantern',
    current_owner_id: 8,
    current_owner: 'neighbor',
    owner_id: 8,
    owner: 'neighbor',
  })
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
  const giftWrite = sqlCalls().find(call => /WITH\s+recipient[\s\S]*moved_asset/i.test(call.query ?? ''))
  assert.match(giftWrite?.query ?? '', /UPDATE\s+things\s+SET\s+owner_id\s*=\s*recipient\.id/i)
  assert.doesNotMatch(giftWrite?.query ?? '', /SET\s+maker_id\s*=/i)

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
  const settledWrite = sqlCalls().find(call =>
    /payment_uses/i.test(call.query ?? '') && /transfer_offers/i.test(call.query ?? '') && /update\s+things/i.test(call.query ?? ''))
  assert.ok(settledWrite)
  assert.match(settledWrite?.query ?? '', /UPDATE\s+things\s+SET\s+owner_id\s*=\s*offer\.actor_id/i)
  assert.doesNotMatch(settledWrite?.query ?? '', /SET\s+maker_id\s*=/i)

  const settlementsBeforeReplay = state.calls.filter(call => call.url.includes('/settle')).length
  const missingWallet = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET), body: '{}',
  })
  assert.equal(missingWallet.status, 409)
  const changedWallet = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: STRANGER_WALLET }),
  })
  assert.equal(changedWallet.status, 409)

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
  const storedHeader = Buffer.from('{"ok":true}', 'utf8').toString('base64')
  const completedAttempt: FakePaymentAttempt = {
    public_id: 'pay_' + '88'.repeat(32),
    actor_id: 8,
    counterparty_id: 7,
    operation: 'direct_sale',
    target_key: 'direct-sale:90',
    offer_id: 90,
    asset_type: 'thing',
    asset_id: 41,
    request_hash: canonicalPaymentRequest({
      offer_id: 90,
      buyer_wallet: BUYER_WALLET,
      seller_wallet: SELLER_WALLET,
      price_usdc: 2,
      asset_type: 'thing',
      asset_id: 41,
    }).hash,
    request_json: {
      offer_id: 90,
      buyer_wallet: BUYER_WALLET,
      seller_wallet: SELLER_WALLET,
      price_usdc: 2,
      asset_type: 'thing',
      asset_id: 41,
    },
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
      __1f3d9_x402_response_v1: {
        header: storedHeader,
        body: {
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
  assert.equal(replay.headers.get('X-PAYMENT-RESPONSE'), storedHeader)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 0)
})

test('a completed direct-sale replay rejects a different buyer wallet without settling again', async () => {
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
    method: 'POST',
    headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': SALE_X_PAYMENT },
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(settled.status, 200, await settled.clone().text())
  const settlementsBeforeReplay = state.calls.filter(call => call.url.includes('/settle')).length

  const replay = await app.request('/api/transfer/90/claim', {
    method: 'POST',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: STRANGER_WALLET }),
  })
  assert.equal(replay.status, 409, await replay.clone().text())
  assert.match(await replay.text(), /buyer_wallet does not match the settled payment/i)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, settlementsBeforeReplay)
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

test('paid routes never verify or settle when exact replay storage is absent', async () => {
  reset({
    scenario: 'paid claims',
    paymentReplaySchemaReady: false,
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
  })
  const response = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({ parent_id: null, name: 'Schema Guard', description: 'must not settle' }),
  })

  assert.equal(response.status, 503, await response.clone().text())
  assert.deepEqual(await response.json(), {
    error: 'payments are temporarily unavailable while durable payment custody is being upgraded; do not pay or retry yet',
    do_not_pay_again: true,
  })
  assert.equal(networkCalled('/verify'), false)
  assert.equal(networkCalled('/settle'), false)
  assert.ok(state.calls.some(call =>
    call.query?.includes('payment-attempts:response-replay-ready')))
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

test('frontier x402 retry after an interrupted completion uses the same authorization and does not settle twice', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
    interruptTreasuryCompletionOnce: true,
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
  assert.equal(first.status, 500, await first.clone().text())
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

test('frontier x402 retry can resume an interrupted payment without replaying X-PAYMENT', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
    interruptTreasuryCompletionOnce: true,
  })
  const requestBody = JSON.stringify({
    parent_id: null,
    name: 'Headerless Retry Continent',
    description: 'same logical purchase',
  })

  const first = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: requestBody,
  })
  assert.equal(first.status, 500, await first.clone().text())
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)

  const retry = await app.request('/api/place', {
    method: 'POST',
    headers: authHeaders(),
    body: requestBody,
  })
  assert.equal(retry.status, 201, await retry.clone().text())
  assert.ok(retry.headers.get('X-PAYMENT-RESPONSE'))
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)
  assert.equal(state.paymentHashes.size, 1)
})

test('frontier x402 headerless retry fails closed when the request body changed', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
    interruptTreasuryCompletionOnce: true,
  })
  const first = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({
      parent_id: null,
      name: 'Frozen Continent',
      description: 'original body',
    }),
  })
  assert.equal(first.status, 500, await first.clone().text())

  const retry = await app.request('/api/place', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      parent_id: null,
      name: 'Frozen Continent',
      description: 'mutated body',
    }),
  })
  assert.equal(retry.status, 409, await retry.clone().text())
  assert.match(await retry.text(), /payment attempt|immutable|different/i)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)
})

test('frontier x402 completion at the recovery deadline has no domain effect and enters founder review', async () => {
  reset({
    scenario: 'treasury deadline passed',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
  })

  const response = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({
      parent_id: null,
      name: 'Too Late Continent',
      description: 'must remain uncreated',
    }),
  })

  assert.equal(response.status, 409, await response.clone().text())
  const attempt = [...state.paymentAttempts.values()][0]
  assert.deepEqual(await response.json(), {
    payment: 'founder_review',
    payment_attempt_id: [...state.paymentAttempts.keys()][0],
    fee_tx: attempt?.tx_hash,
    do_not_pay_again: true,
    reason: 'frontier recovery deadline passed before completion',
  })
  assert.equal(attempt?.status, 'founder_review')
  assert.equal(attempt?.lease_owner, null)
  assert.equal(state.paymentHashes.size, 0)
  assert.equal(state.calls.filter(call =>
    /payment-treasury-operations:complete/iu.test(call.query ?? '')).length, 1)
})

test('kind invention can replay its completed canonical response without replaying X-PAYMENT', async () => {
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
  })
  const requestBody = JSON.stringify({
    name: 'replayable-kind',
    description: 'paid once',
    traits: [],
    recipe: [],
  })

  const first = await app.request('/api/kind', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: requestBody,
  })
  assert.equal(first.status, 201, await first.clone().text())
  const firstPaymentResponse = first.headers.get('X-PAYMENT-RESPONSE')
  const firstText = await first.clone().text()
  assert.ok(firstPaymentResponse)

  const replay = await app.request('/api/kind', {
    method: 'POST',
    headers: authHeaders(),
    body: requestBody,
  })
  assert.equal(replay.status, 201, await replay.clone().text())
  assert.equal(replay.headers.get('X-PAYMENT-RESPONSE'), firstPaymentResponse)
  assert.equal(await replay.text(), firstText)
  assert.equal(state.calls.filter(call => call.url.includes('/settle')).length, 1)
})

test('treasury completion returns the canonical stored x402 response header', async () => {
  const canonicalHeader = Buffer.from(JSON.stringify({
    success: true,
    transaction: TX_CASE_UPPER,
    recovered: true,
  })).toString('base64')
  reset({
    scenario: 'paid claims',
    facilitatorVerify: true,
    facilitatorSettle: true,
    chainFrom: SELLER_WALLET,
    chainTo: TREASURY,
    treasuryCompletionHeader: canonicalHeader,
  })

  const response = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({
      parent_id: null,
      name: 'Canonical Header Continent',
      description: 'uses the durable header reloaded by completion',
    }),
  })

  assert.equal(response.status, 201, await response.clone().text())
  assert.equal(response.headers.get('X-PAYMENT-RESPONSE'), canonicalHeader)
})

test('only founder resident one issues one private city fee credit and exact retries do not issue twice', async () => {
  reset()
  const issuanceBody = JSON.stringify({
    resident_handle: 'tiny-lantern',
    source_key: 'wave4-grant-0001',
    reason: 'Wave 4 route test grant',
  })

  const nonFounder = await app.request('/api/founder/city-credit', {
    method: 'POST', headers: authHeaders(), body: issuanceBody,
  })
  assert.equal(nonFounder.status, 403)
  assert.equal(state.cityCreditEntries.length, 0)

  setActor(1, 'founder')
  const issued = await app.request('/api/founder/city-credit', {
    method: 'POST', headers: authHeaders(), body: issuanceBody,
  })
  assert.equal(issued.status, 201, await issued.clone().text())
  const issuedBody = await issued.json() as {
    resident_handle: string
    city_fee_credit: Record<string, unknown>
  }
  assert.equal(issuedBody.resident_handle, 'tiny-lantern')
  assert.deepEqual(issuedBody.city_fee_credit, {
    disposition: 'created',
    entry_id: '1',
    resident_id: 7,
    amount: '1.000000',
    amount_units: '1000000',
    balance: '1.000000',
    balance_usdc: '1.000000',
    balance_units: '1000000',
    reason: 'Wave 4 route test grant',
    created_at: '2026-08-11T00:00:00.000Z',
  })
  assert.equal(issued.headers.get('cache-control'), 'no-store')

  const retried = await app.request('/api/founder/city-credit', {
    method: 'POST', headers: authHeaders(), body: issuanceBody,
  })
  assert.equal(retried.status, 200, await retried.clone().text())
  assert.equal((await retried.json() as {
    city_fee_credit: { disposition: string }
  }).city_fee_credit.disposition, 'existing')
  assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'founder_issue').length, 1)
  assert.equal(state.cityCreditBalances.get(7), 1_000_000n)

  const changed = await app.request('/api/founder/city-credit', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      resident_handle: 'tiny-lantern',
      source_key: 'wave4-grant-0001',
      reason: 'changed reason must conflict',
    }),
  })
  assert.equal(changed.status, 409, await changed.clone().text())
  assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'founder_issue').length, 1)

  const founderRead = await app.request('/api/founder/city-credit/tiny-lantern', {
    headers: authHeaders(),
  })
  assert.equal(founderRead.status, 200)
  assert.equal(founderRead.headers.get('cache-control'), 'no-store')

  setActor(7, 'tiny-lantern')
  const me = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(me.status, 200, await me.clone().text())
  const meBody = await me.json() as {
    city_fee_credit: { balance_usdc: string; history: Array<{ kind: string }> }
  }
  assert.equal(meBody.city_fee_credit.balance_usdc, '1.000000')
  assert.deepEqual(meBody.city_fee_credit.history.map(entry => entry.kind), ['founder_issue'])
  assert.equal(me.headers.get('cache-control'), 'no-store')

  const officialText = await (await app.request('/api/official')).text()
  const treasuryText = await (await app.request('/treasury')).text()
  assert.doesNotMatch(officialText + treasuryText, /wave4-grant-0001|1000000/u)
})

test('/api/me reports a private exact zero city fee credit account before any issuance', async () => {
  reset()
  const response = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json() as {
    city_fee_credit: Record<string, unknown>
    pages: { city_fee_credit: Record<string, unknown> }
  }
  assert.deepEqual(body.city_fee_credit, {
    resident_id: 7,
    balance: '0.000000',
    balance_usdc: '0.000000',
    balance_units: '0',
    history: [],
    page: { has_more: false, next_before_credit_id: null },
  })
  assert.deepEqual(body.pages.city_fee_credit, {
    has_more: false,
    next_before_credit_id: null,
  })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

const CITY_CREDIT_ROUTE_CASES = [
  {
    label: 'frontier',
    path: '/api/place',
    status: 201,
    requestId: 'wave4-frontier-0001',
    body: { parent_id: null, name: 'Credit Continent', description: 'founded with credit' },
    invalidBody: { parent_id: null, name: '', description: 'invalid before debit' },
    resultKey: 'place',
    failureReason: 'frontier target changed before completion',
  },
  {
    label: 'kind invention',
    path: '/api/kind',
    status: 201,
    requestId: 'wave4-kind-0000001',
    body: { name: 'credit-lantern', description: 'made with credit', traits: [], recipe: [] },
    invalidBody: {
      name: 'invalid-credit-kind', description: 'invalid before debit',
      traits: ['glowing', 'glowing'], recipe: [],
    },
    resultKey: 'kind',
    failureReason: 'kind invention target changed before completion',
  },
  {
    label: 'kind revision',
    path: '/api/kind/3/revise',
    status: 200,
    requestId: 'wave4-revision-001',
    body: { description: 'revised with credit', traits: ['glowing'], recipe: [] },
    invalidBody: {
      description: 'invalid before debit', traits: ['glowing', 'glowing'], recipe: [],
    },
    resultKey: 'kind',
    failureReason: 'kind revision target changed before completion',
  },
] as const

const cityCreditDomainWriteCount = () => sqlCalls().filter(call =>
  /complete_city_credit_attempt/iu.test(call.query ?? '')).length

const assertCityCreditNoStore = (response: Response, label: string) => {
  assert.match(
    response.headers.get('cache-control') ?? '',
    /(?:^|,)\s*no-store\s*(?:,|$)/iu,
    `${label}: city fee credit response must be private and non-cacheable`,
  )
}

test('each eligible paid action deliberately spends one own city fee credit and replays exactly', async () => {

  for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
    reset({
      scenario: 'paid claims',
      cityCreditBalances: new Map([[7, 1_000_000n]]),
    })
    const requestBody = JSON.stringify(creditCase.body)
    const headers = {
      ...authHeaders(),
      'X-1F3D9-FEE-CREDIT': creditCase.requestId,
    }
    const first = await app.request(creditCase.path, {
      method: 'POST', headers, body: requestBody,
    })
    assert.equal(first.status, creditCase.status, `${creditCase.label}: ${await first.clone().text()}`)
    assertCityCreditNoStore(first, `${creditCase.label} success`)
    const firstText = await first.text()
    const firstBody = JSON.parse(firstText) as Record<string, unknown>
    assert.ok(firstBody[creditCase.resultKey], creditCase.label)
    assert.deepEqual(firstBody.city_fee_credit, {
      spent_usdc: '1.000000',
      balance_usdc: '0.000000',
    }, creditCase.label)
    assert.equal(Object.hasOwn(firstBody, 'fee_tx'), false, creditCase.label)
    assert.equal(first.headers.get('x-payment-response'), null, creditCase.label)
    assert.equal(state.cityCreditBalances.get(7), 0n, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
    assert.equal(state.paymentHashes.size, 0, creditCase.label)
    assert.equal(networkCalled('/verify'), false, creditCase.label)
    assert.equal(networkCalled('/settle'), false, creditCase.label)
    const paidWrite = sqlCalls().find(call => /complete_city_credit_attempt/iu.test(call.query ?? ''))
    assert.ok(paidWrite?.query, `${creditCase.label}: missing atomic paid write`)
    const eventStart = paidWrite.query.indexOf('INSERT INTO events')
    const responseStart = paidWrite.query.indexOf('completed_x402_attempt AS', eventStart)
    assert.ok(eventStart >= 0 && responseStart > eventStart, `${creditCase.label}: missing public event boundary`)
    assert.doesNotMatch(
      paidWrite.query.slice(eventStart, responseStart),
      /city_fee_credit|balance_usdc|request_id|source_key/iu,
      `${creditCase.label}: private credit accounting leaked into its public event`,
    )
    const domainWrites = sqlCalls().filter(call =>
      /insert\s+into\s+(?:places|kinds|kind_revisions)|update\s+kinds/iu.test(call.query ?? '')).length

    const replay = await app.request(creditCase.path, {
      method: 'POST', headers, body: requestBody,
    })
    assert.equal(replay.status, creditCase.status, `${creditCase.label}: ${await replay.clone().text()}`)
    assertCityCreditNoStore(replay, `${creditCase.label} replay`)
    assert.equal(await replay.text(), firstText, creditCase.label)
    assert.equal(state.cityCreditBalances.get(7), 0n, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
    assert.equal(sqlCalls().filter(call =>
      /insert\s+into\s+(?:places|kinds|kind_revisions)|update\s+kinds/iu.test(call.query ?? '')).length,
    domainWrites, `${creditCase.label}: replay must not repeat the domain write`)
  }
})

test('city fee credit selection rejects insufficient balance, mixed rails, and free interior use before debit', async () => {
  reset({ scenario: 'paid claims' })
  const insufficient = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-1F3D9-FEE-CREDIT': 'wave4-empty-00001' },
    body: JSON.stringify({ parent_id: null, name: 'No Credit Continent', description: '' }),
  })
  assert.equal(insufficient.status, 409, await insufficient.clone().text())
  assertCityCreditNoStore(insufficient, 'insufficient credit')
  assert.match(await insufficient.text(), /insufficient city fee credit/i)
  assert.equal(state.cityCreditEntries.length, 0)
  assert.equal(networkCalled('/verify'), false)
  assert.equal(networkCalled('/settle'), false)

  reset({ scenario: 'paid claims', cityCreditBalances: new Map([[7, 1_000_000n]]) })
  const mixed = await app.request('/api/place', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'X-PAYMENT': X_PAYMENT,
      'X-1F3D9-FEE-CREDIT': 'wave4-mixed-00001',
    },
    body: JSON.stringify({ parent_id: null, name: 'Mixed Rail Continent', description: '' }),
  })
  assert.equal(mixed.status, 400, await mixed.clone().text())
  assertCityCreditNoStore(mixed, 'mixed payment rails')
  assert.match(await mixed.text(), /choose one payment method/i)
  assert.equal(state.cityCreditEntries.length, 0)
  assert.equal(state.paymentAttempts.size, 0)
  assert.equal(networkCalled('/verify'), false)
  assert.equal(networkCalled('/settle'), false)
  const mixedStorageWrites = sqlCalls().filter(call =>
    /\b(?:insert|update|delete)\b/iu.test(call.query ?? '')
      && !/update\s+residents\s+set\s+things_today/iu.test(call.query ?? ''))
  assert.equal(
    mixedStorageWrites.length,
    0,
    `mixed payment rails reached storage: ${mixedStorageWrites[0]?.query?.replace(/\s+/gu, ' ').trim() ?? 'unknown write'}`,
  )

  reset({ cityCreditBalances: new Map([[7, 1_000_000n]]) })
  const freeInterior = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-1F3D9-FEE-CREDIT': 'wave4-free-000001' },
    body: JSON.stringify({ parent_id: 2, name: 'Free Interior', description: '' }),
  })
  assert.equal(freeInterior.status, 400, await freeInterior.clone().text())
  assertCityCreditNoStore(freeInterior, 'free interior selector')
  assert.match(await freeInterior.text(), /only supported for the paid/i)
  assert.equal(state.cityCreditBalances.get(7), 1_000_000n)
  assert.equal(state.cityCreditEntries.length, 0)
  assert.equal(state.paymentAttempts.size, 0)
})

test('every city-credit fee action fails validation before debit', async () => {
  for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
    reset({
      scenario: 'paid claims',
      cityCreditBalances: new Map([[7, 1_000_000n]]),
    })
    const response = await app.request(creditCase.path, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-before`,
      },
      body: JSON.stringify(creditCase.invalidBody),
    })
    assert.equal(response.status, 400, `${creditCase.label}: ${await response.clone().text()}`)
    assertCityCreditNoStore(response, `${creditCase.label} pre-debit failure`)
    assert.equal(state.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
    assert.equal(state.cityCreditEntries.length, 0, creditCase.label)
    assert.equal(state.paymentAttempts.size, 0, creditCase.label)
    assert.equal(cityCreditDomainWriteCount(), 0, creditCase.label)
    assert.equal(networkCalled('/verify'), false, creditCase.label)
    assert.equal(networkCalled('/settle'), false, creditCase.label)
  }
})

test('every post-debit city-credit fee failure appends one exact return and replays it', async () => {
  for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
    reset({
      scenario: 'paid claims',
      cityCreditBalances: new Map([[7, 1_000_000n]]),
      failPaidWriteOnce: true,
    })
    const requestBody = JSON.stringify(creditCase.body)
    const headers = {
      ...authHeaders(),
      'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-return`,
    }
    const first = await app.request(creditCase.path, {
      method: 'POST', headers, body: requestBody,
    })
    assert.equal(first.status, 409, `${creditCase.label}: ${await first.clone().text()}`)
    assertCityCreditNoStore(first, `${creditCase.label} returned error`)
    const firstText = await first.text()
    assert.deepEqual(JSON.parse(firstText), {
      error: `${creditCase.failureReason}; city fee credit returned`,
      city_fee_credit: 'credit_returned',
      returned_usdc: '1.000000',
    }, creditCase.label)
    assert.equal(state.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 1, creditCase.label)
    assert.equal(cityCreditDomainWriteCount(), 1, creditCase.label)

    const replay = await app.request(creditCase.path, {
      method: 'POST', headers, body: requestBody,
    })
    assert.equal(replay.status, 409, `${creditCase.label}: ${await replay.clone().text()}`)
    assertCityCreditNoStore(replay, `${creditCase.label} returned replay`)
    assert.equal(await replay.text(), firstText, creditCase.label)
    assert.equal(state.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 1, creditCase.label)
    assert.equal(cityCreditDomainWriteCount(), 1, `${creditCase.label}: replay repeated the failed domain write`)
    assert.equal(networkCalled('/settle'), false, creditCase.label)
  }
})

test('concurrent duplicate city-credit fee calls make one debit and one domain effect for every action', async () => {
  for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
    reset({
      scenario: 'paid claims',
      cityCreditBalances: new Map([[7, 1_000_000n]]),
    })
    const requestBody = JSON.stringify(creditCase.body)
    const headers = {
      ...authHeaders(),
      'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-race`,
    }
    const responses = await Promise.all([
      app.request(creditCase.path, { method: 'POST', headers, body: requestBody }),
      app.request(creditCase.path, { method: 'POST', headers, body: requestBody }),
    ])
    const success = responses.find(response => response.status === creditCase.status)
    assert.ok(success, `${creditCase.label}: concurrent calls did not complete one domain effect`)
    for (const response of responses) {
      assertCityCreditNoStore(response, `${creditCase.label} concurrent response`)
      assert.ok(
        response.status === creditCase.status || response.status === 202,
        `${creditCase.label}: unexpected concurrent status ${response.status}: ${await response.clone().text()}`,
      )
    }
    const successText = await success.text()
    const exactReplay = await app.request(creditCase.path, {
      method: 'POST', headers, body: requestBody,
    })
    assert.equal(exactReplay.status, creditCase.status, `${creditCase.label}: ${await exactReplay.clone().text()}`)
    assertCityCreditNoStore(exactReplay, `${creditCase.label} concurrent replay`)
    assert.equal(await exactReplay.text(), successText, creditCase.label)
    assert.equal(state.cityCreditBalances.get(7), 0n, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
    assert.equal(state.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 0, creditCase.label)
    assert.equal(state.paymentAttempts.size, 1, creditCase.label)
    assert.equal(cityCreditDomainWriteCount(), 1, creditCase.label)
    assert.equal(networkCalled('/verify'), false, creditCase.label)
    assert.equal(networkCalled('/settle'), false, creditCase.label)
  }
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
    firstRead?.params?.map((value, index) => index >= 3 ? Number(value) : value),
    ['note_created', null, null, 65, 4],
    'the database fetches one lookahead row',
  )
  assert.match(firstRead?.query ?? '', /id\s*<\s*\$4::integer/i)
  assert.match(firstRead?.query ?? '', /order\s+by\s+event\.id\s+desc/i)

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
    subplaces_page: { has_more: boolean; next_before_subplace_id: number | null; returned_items: number; returned_text_bytes: number }
    things_page: { has_more: boolean; next_before_thing_id: number | null; returned_items: number; returned_text_bytes: number }
    notes_page: { has_more: boolean; next_before_note_id: number | null; returned_items: number; returned_text_bytes: number }
  }
  assert.deepEqual(first.subplaces.map(row => row.id), Array.from({ length: 10 }, (_, index) => 160 - index))
  assert.deepEqual(first.things.map(row => row.id), Array.from({ length: 10 }, (_, index) => 260 - index))
  assert.deepEqual(first.notes.map(row => row.id), Array.from({ length: 10 }, (_, index) => 360 - index))
  assert.equal(first.subplaces_page.returned_items, 10)
  assert.equal(first.things_page.returned_items, 10)
  assert.equal(first.notes_page.returned_items, 10)
  assert.ok(first.subplaces_page.returned_text_bytes > 0)
  assert.ok(first.things_page.returned_text_bytes > 0)
  assert.ok(first.notes_page.returned_text_bytes > 0)
  assert.equal(first.subplaces_page.has_more, true)
  assert.equal(first.subplaces_page.next_before_subplace_id, 151)
  assert.equal(first.things_page.has_more, true)
  assert.equal(first.things_page.next_before_thing_id, 251)
  assert.equal(first.notes_page.has_more, true)
  assert.equal(first.notes_page.next_before_note_id, 351)

  const collectionReads = sqlCalls().filter(call => /\/\* public:place-collections \*\//i.test(call.query ?? ''))
  assert.equal(collectionReads.length, 1, 'all room pages and totals share one database snapshot')
  assert.deepEqual(
    collectionReads[0]?.params?.map(value => value == null ? null : Number(value)),
    [2, null, 11, null, 11, null, 11],
  )
  assert.match(collectionReads[0]?.query ?? '', /from\s+place_reading_totals/i)
  assert.doesNotMatch(collectionReads[0]?.query ?? '', /count\s*\(\s*\*\s*\)/i)

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
  assert.equal(second.subplaces_page.next_before_subplace_id, 146)
  assert.equal(second.things_page.next_before_thing_id, 246)
  assert.equal(second.notes_page.next_before_note_id, 346)
  assert.equal(second.subplaces.some(row => first.subplaces.some(previous => previous.id === row.id)), false)
  assert.equal(second.things.some(row => first.things.some(previous => previous.id === row.id)), false)
  assert.equal(second.notes.some(row => first.notes.some(previous => previous.id === row.id)), false)
})

test('outline place reads keep truthful headings and sizes without returning authored collection text', async () => {
  reset({ scenario: 'public pagination' })
  const response = await app.request('/api/place/2?view=outline&limit=2')
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json() as {
    view: string
    subplaces: Array<{
      id: number
      name: string
      description?: string
      description_text_bytes: number
    }>
    things: Array<{ id: number; name: string; body?: string; body_text_bytes: number }>
    notes: Array<{ id: number; author: string; body?: string; body_text_bytes: number }>
    subplaces_page: { returned_text_bytes: number }
    things_page: {
      total_items: number
      total_text_bytes: number
      returned_items: number
      returned_text_bytes: number
    }
    notes_page: { returned_text_bytes: number }
  }
  assert.equal(body.view, 'outline')
  assert.deepEqual(body.subplaces.map(place => place.id), [160, 159])
  assert.equal(body.subplaces.every(place => typeof place.name === 'string'), true)
  assert.equal(body.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
  assert.equal(body.subplaces.every(place => place.description_text_bytes > 0), true)
  assert.deepEqual(body.things.map(thing => thing.id), [260, 259])
  assert.equal(body.things.every(thing => typeof thing.name === 'string'), true)
  assert.equal(body.things.every(thing => !Object.hasOwn(thing, 'body')), true)
  assert.equal(body.things.every(thing => thing.body_text_bytes > 0), true)
  assert.deepEqual(body.notes.map(note => note.id), [360, 359])
  assert.equal(body.notes.every(note => typeof note.author === 'string'), true)
  assert.equal(body.notes.every(note => !Object.hasOwn(note, 'body')), true)
  assert.equal(body.notes.every(note => note.body_text_bytes > 0), true)
  assert.equal(body.subplaces_page.returned_text_bytes, 0)
  assert.equal(body.things_page.total_items, 260)
  assert.equal(body.things_page.total_text_bytes, 2600)
  assert.equal(body.things_page.returned_items, 2)
  assert.equal(body.things_page.returned_text_bytes, 0)
  assert.equal(body.notes_page.returned_text_bytes, 0)
  const read = sqlCalls().find(call => /\/\* public:place-collections \*\//i.test(call.query ?? ''))
  assert.doesNotMatch(read?.query ?? '', /\bp\.description\s*,/i, 'outline SQL must not return child descriptions')
  assert.doesNotMatch(read?.query ?? '', /\bt\.body\s*,/i, 'outline SQL must not return large thing bodies')
  assert.doesNotMatch(read?.query ?? '', /\bn\.body\s*,/i, 'outline SQL must not return note bodies')
})

test('full place reads remain the default compatibility shape and can be requested explicitly', async () => {
  for (const path of ['/api/place/2?thing_limit=1', '/api/place/2?view=full&thing_limit=1']) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 200, path)
    const body = await response.json() as {
      view: string
      things: Array<{ body?: string; body_text_bytes?: number }>
      things_page: { returned_text_bytes: number }
    }
    if (path.includes('view=full')) assert.equal(body.view, 'full')
    else assert.equal(body.view, undefined, 'implicit full must preserve the exact legacy shape')
    assert.equal(typeof body.things[0]?.body, 'string')
    assert.equal(body.things[0]?.body_text_bytes, undefined)
    assert.ok(body.things_page.returned_text_bytes > 0)
  }
})

test('large full-room pages receive a hard server text ceiling without changing ordinary reads', async () => {
  const serverCollectionTextLimit = 655_360

  reset({ scenario: 'public pagination' })
  const response = await app.request('/api/place/2?view=full&limit=200')
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json() as Record<string, unknown>
  for (const pageName of ['subplaces_page', 'things_page', 'notes_page']) {
    const page = body[pageName] as Record<string, unknown>
    assert.equal(page.text_limit_bytes, serverCollectionTextLimit, pageName)
    assert.equal(page.server_text_limit_applied, true, pageName)
  }
  const bulkRead = sqlCalls().find(call =>
    /\/\* public:place-collections-budgeted \*\//i.test(call.query ?? ''))
  assert.deepEqual(
    bulkRead?.params?.map(value => value == null ? null : Number(value)),
    [
      2,
      null, 201,
      null, 201,
      null, 201,
      serverCollectionTextLimit,
      serverCollectionTextLimit,
      serverCollectionTextLimit,
    ],
    'a 200-row bulk request must not bypass the server-authored-text ceiling',
  )

  reset({ scenario: 'public pagination' })
  const mixed = await app.request('/api/place/2?view=full&limit=10&thing_limit=200')
  assert.equal(mixed.status, 200, await mixed.clone().text())
  const mixedBody = await mixed.json() as Record<string, Record<string, unknown>>
  assert.equal(mixedBody.subplaces_page?.server_text_limit_applied, undefined)
  assert.equal(mixedBody.things_page?.server_text_limit_applied, true)
  assert.equal(mixedBody.notes_page?.server_text_limit_applied, undefined)
  const mixedRead = sqlCalls().find(call =>
    /\/\* public:place-collections-budgeted \*\//i.test(call.query ?? ''))
  assert.deepEqual(
    mixedRead?.params?.map(value => value == null ? null : Number(value)),
    [2, null, 11, null, 201, null, 11, null, serverCollectionTextLimit, null],
    'only the oversized specific collection needs the automatic ceiling',
  )
})

test('full place reads stop on whole records at each reader-chosen UTF-8 byte limit', async () => {
  reset({ scenario: 'public pagination' })
  const response = await app.request(
    '/api/place/2?view=full&limit=10' +
      '&subplace_text_limit_bytes=20&thing_text_limit_bytes=20&note_text_limit_bytes=20',
  )
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json() as {
    subplaces: Array<{ id: number; description: string }>
    things: Array<{ id: number; body: string }>
    notes: Array<{ id: number; body: string }>
    subplaces_page: {
      returned_items: number
      returned_text_bytes: number
      has_more: boolean
      next_before_subplace_id: number | null
      text_limit_bytes: number
      stopped_for_text_limit: boolean
      next_item_id: number | null
      next_item_text_bytes: number | null
    }
    things_page: {
      returned_items: number
      returned_text_bytes: number
      has_more: boolean
      next_before_thing_id: number | null
      text_limit_bytes: number
      stopped_for_text_limit: boolean
      next_item_id: number | null
      next_item_text_bytes: number | null
    }
    notes_page: {
      returned_items: number
      returned_text_bytes: number
      has_more: boolean
      next_before_note_id: number | null
      text_limit_bytes: number
      stopped_for_text_limit: boolean
      next_item_id: number | null
      next_item_text_bytes: number | null
    }
  }

  assert.deepEqual(body.subplaces, [])
  assert.deepEqual(body.things.map(thing => thing.id), [260])
  assert.deepEqual(body.notes.map(note => note.id), [360, 359])
  for (const [name, page] of [
    ['subplaces', body.subplaces_page],
    ['things', body.things_page],
    ['notes', body.notes_page],
  ] as const) {
    assert.equal(page.text_limit_bytes, 20, name)
    assert.equal(page.stopped_for_text_limit, true, name)
    assert.equal(page.has_more, true, name)
    assert.ok(page.returned_text_bytes <= page.text_limit_bytes, name)
    assert.ok((page.next_item_id ?? 0) > 0, name)
    assert.ok((page.next_item_text_bytes ?? 0) > 0, name)
  }
  assert.equal(body.subplaces_page.next_before_subplace_id, null)
  assert.equal(body.subplaces_page.next_item_id, 160)
  assert.equal(body.things_page.next_before_thing_id, 260)
  assert.equal(body.things_page.next_item_id, 259)
  assert.equal(body.notes_page.next_before_note_id, 359)
  assert.equal(body.notes_page.next_item_id, 358)
  assert.equal(
    body.things_page.returned_text_bytes,
    body.things.reduce((total, thing) => total + Buffer.byteLength(thing.body, 'utf8'), 0),
  )
  assert.equal(
    body.notes_page.returned_text_bytes,
    body.notes.reduce((total, note) => total + Buffer.byteLength(note.body, 'utf8'), 0),
  )
  const budgetedRead = sqlCalls().find(call =>
    /\/\* public:place-collections-budgeted \*\//i.test(call.query ?? ''))
  for (const [source, candidates, fetchParameter] of [
    ['subplace_source', 'subplace_candidates', 3],
    ['thing_source', 'thing_candidates', 5],
    ['note_source', 'note_candidates', 7],
  ] as const) {
    assert.match(
      budgetedRead?.query ?? '',
      new RegExp(
        `${source}\\s+AS\\s+MATERIALIZED[\\s\\S]*?LIMIT\\s+\\$${fetchParameter}::integer` +
          `[\\s\\S]*?${candidates}\\s+AS\\s+MATERIALIZED[\\s\\S]*?FROM\\s+${source}`,
        'iu',
      ),
      `${source} must apply the item bound before its cumulative-byte window`,
    )
  }

  state = { ...state, calls: [] }
  const continued = await app.request(
    '/api/place/2?view=full&limit=10' +
      '&subplace_text_limit_bytes=50&thing_text_limit_bytes=20&note_text_limit_bytes=20' +
      '&before_thing_id=260&before_note_id=359',
  )
  assert.equal(continued.status, 200, await continued.clone().text())
  const next = await continued.json() as typeof body
  assert.deepEqual(next.subplaces.map(place => place.id), [160, 159])
  assert.deepEqual(next.things.map(thing => thing.id), [259])
  assert.deepEqual(next.notes.map(note => note.id), [358, 357])
  assert.equal(next.subplaces_page.text_limit_bytes, 50)
  assert.equal(next.things.some(thing => body.things.some(previous => previous.id === thing.id)), false)
  assert.equal(next.notes.some(note => body.notes.some(previous => previous.id === note.id)), false)
})

test('place text limits accept zero and reject duplicates or unsafe integers before PostgreSQL', async () => {
  reset({ scenario: 'public pagination' })
  const zero = await app.request(
    '/api/place/2?view=full' +
      '&subplace_text_limit_bytes=0&thing_text_limit_bytes=0&note_text_limit_bytes=0',
  )
  assert.equal(zero.status, 200, await zero.clone().text())
  const zeroBody = await zero.json() as {
    subplaces: unknown[]
    things: unknown[]
    notes: unknown[]
    subplaces_page: { stopped_for_text_limit: boolean }
  }
  assert.deepEqual([zeroBody.subplaces, zeroBody.things, zeroBody.notes], [[], [], []])
  assert.equal(zeroBody.subplaces_page.stopped_for_text_limit, true)

  for (const path of [
    '/api/place/2?subplace_text_limit_bytes=-1',
    '/api/place/2?thing_text_limit_bytes=1.5',
    '/api/place/2?thing_text_limit_bytes=655361',
    '/api/place/2?note_text_limit_bytes=9007199254740992',
    '/api/place/2?note_text_limit_bytes=1&note_text_limit_bytes=2',
    '/api/place/2?note_text_limit_bytes=nope',
    '/api/place/2?view=outline&note_text_limit_bytes=10',
  ]) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, path)
  }
})

test('place view rejects duplicates and unknown values before reading PostgreSQL', async () => {
  for (const path of [
    '/api/place/2?view=compact',
    '/api/place/2?view=outline&view=full',
  ]) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, path)
  }
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
  assert.equal(body.subplaces_page.next_before_subplace_id, 157)
  assert.equal(body.things_page.next_before_thing_id, 257)
  assert.equal(body.notes_page.next_before_note_id, 357)

  const read = sqlCalls().find(call => /\/\* public:place-collections \*\//i.test(call.query ?? ''))
  assert.deepEqual(
    read?.params?.map(value => value == null ? null : Number(value)),
    [2, null, 5, null, 5, null, 5],
    'the common limit applies one lookahead to all three bounded page CTEs',
  )
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
    '/api/place/2?q=pretend-search',
    '/api/map?q=pretend-search',
    '/api/thing/41?q=pretend-search',
    '/api/note/51?q=pretend-search',
    '/api/residents?q=pretend-search',
    '/api/events?q=pretend-search',
    '/api/kinds?q=pretend-search',
    '/api/traits?q=pretend-search',
    '/api/agreements?q=pretend-search',
    '/api/moderation?q=pretend-search',
    '/api/official?q=pretend-search',
    '/api/physics?q=pretend-search',
    '/api/world/resident/tiny-lantern?q=pretend-search',
    '/api/world/offer/90?q=pretend-search',
    '/treasury?q=pretend-search',
    '/api/search',
    '/api/search?q=',
    '/api/search?q=moss&q=fern',
    '/api/search?q=moss&mode=ranked',
    '/api/search?q=moss&before=not-a-cursor',
    '/api/search?q=moss&unknown=true',
    '/api/changes?since=-1',
    '/api/changes?since=1&limit=01',
    '/api/changes?since=1&limit=1e2',
    '/api/changes?since=1&limit=0x10',
    '/api/changes?since=1&limit=1.0',
    '/api/changes?since=1&limit=%2B1',
    '/api/changes?since=1&limit=%201',
    '/api/changes?since=1&since=2',
    '/api/changes?unknown=true',
  ]
  for (const path of paths) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
  }
})

test('search and changes succeed through their real Hono routes without returning authored bodies', async () => {
  await withVercelForwarding(async () => {
    reset({ scenario: 'public pagination' })
    const headers = { 'X-Vercel-Forwarded-For': '203.0.113.180' }
    const searched = await app.request(
      '/api/search?q=archive+lantern&mode=phrase&type=thing',
      { headers },
    )
    assert.equal(searched.status, 200)
    assert.equal(searched.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await searched.json(), {
      query: 'archive lantern', mode: 'phrase', type: 'thing',
      results: [{
        type: 'thing', id: 41, place_id: 2, name: 'archive_lantern',
        maker_id: 5, made_by: 'archive-smith',
        current_owner_id: 7, current_owner: 'tiny-lantern',
        owner_id: 7, owner: 'tiny-lantern', open_to_use: true,
        body_text_bytes: 19, created_at: '2026-08-11T00:00:00.000000Z',
        href: '/api/thing/41',
      }],
      total_items: 1, total_text_bytes: 19, returned_items: 1,
      returned_text_bytes: 0, has_more: false, next_before: null, change_marker: '9',
    })
    const searchRead = sqlCalls().find(call => /\/\* public:search \*\//iu.test(call.query ?? ''))
    assert.match(searchRead?.query ?? '', /thing\.maker_id/iu)
    assert.match(searchRead?.query ?? '', /maker\.handle\s+AS\s+made_by/iu)
    assert.match(searchRead?.query ?? '', /thing\.owner_id\s+AS\s+current_owner_id/iu)
    assert.match(searchRead?.query ?? '', /owner\.handle\s+AS\s+current_owner/iu)

    const checkpoint = await app.request('/api/changes')
    assert.equal(checkpoint.status, 200)
    assert.deepEqual(await checkpoint.json(), { change_marker: '9' })
    const changes = await app.request('/api/changes?since=8&limit=1')
    assert.equal(changes.status, 200)
    assert.deepEqual(await changes.json(), {
      change_marker: '9',
      changes: [{
        id: 701, change_id: '9', kind: 'action', actor: 'tiny-lantern',
        detail: { channel: 'public' }, created_at: '2026-08-11T00:00:09.000Z',
      }],
      returned_items: 1, unchanged: false, has_more: false, next_since: '9',
    })
  })
})

test('anonymous search parses before applying its per-caller fairness limit and exact database work', async () => {
  await withVercelForwarding(async () => {
    reset({ scenario: 'public pagination' })
    const headers = { 'X-Vercel-Forwarded-For': '203.0.113.181' }
    for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
      const invalid = await app.request('/api/search?q=', { headers })
      assert.equal(invalid.status, 400, `invalid search ${index + 1}`)
    }
    for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
      const response = await app.request('/api/search?q=archive', { headers })
      assert.equal(response.status, 200, `admitted search ${index + 1}`)
    }
    const limited = await app.request('/api/search?q=archive', { headers })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    assert.deepEqual(await limited.json(), { error: 'public search rate limit reached; retry' })
    assert.equal(
      sqlCalls().filter(call => /\/\* public:search \*\//iu.test(call.query ?? '')).length,
      PUBLIC_SEARCH_RATE_CAPACITY,
    )
  })
})

test('anonymous search trusts only the final Vercel forwarding hop for caller fairness', async () => {
  await withVercelForwarding(async () => {
    reset({ scenario: 'public pagination' })
    const finalHop = '203.0.113.182'
    for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
      const response = await app.request('/api/search?q=archive', {
        headers: { 'X-Vercel-Forwarded-For': `198.51.100.${index + 1}, ${finalHop}` },
      })
      assert.equal(response.status, 200, `admitted search ${index + 1}`)
    }
    const spoofed = await app.request('/api/search?q=archive', {
      headers: { 'X-Vercel-Forwarded-For': `192.0.2.200, ${finalHop}` },
    })
    assert.equal(spoofed.status, 429)
    const otherCaller = await app.request('/api/search?q=archive', {
      headers: { 'X-Vercel-Forwarded-For': '192.0.2.200, 203.0.113.183' },
    })
    assert.equal(otherCaller.status, 200)
  })
})

test('outside Vercel, spoofed forwarding headers share the anonymous fallback bucket', async () => {
  const previous = process.env.VERCEL
  process.env.VERCEL = '0'
  try {
    reset({ scenario: 'public pagination' })
    for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
      const response = await app.request('/api/search?q=archive', {
        headers: {
          'X-Vercel-Forwarded-For': `203.0.113.${index + 20}`,
          'X-Forwarded-For': `198.51.100.${index + 20}`,
        },
      })
      assert.equal(response.status, 200, `fallback search ${index + 1}`)
    }
    const limited = await app.request('/api/search?q=archive', {
      headers: {
        'X-Vercel-Forwarded-For': '203.0.113.250',
        'X-Forwarded-For': '198.51.100.250',
      },
    })
    assert.equal(limited.status, 429)
  } finally {
    process.env.VERCEL = previous
  }
})

test('a search continuation rejects a forged future reconciliation marker', async () => {
  await withVercelForwarding(async () => {
    reset({ scenario: 'public pagination', publicChangeMarker: '12' })
    const before = encodePublicSearchCursor({
      q: 'archive', mode: 'words', type: 'all',
      createdAt: '2026-08-11T00:00:00.000000Z', itemType: 'thing', id: 41,
      changeMarker: '999',
    })
    const response = await app.request(
      `/api/search?q=archive&before=${encodeURIComponent(before)}`,
      { headers: { 'X-Vercel-Forwarded-For': '203.0.113.184' } },
    )
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'search marker 999 is ahead of checkpoint 12',
    })
  })
})

test('public direct resource ids reject PostgreSQL integer overflow before database work', async () => {
  for (const path of [
    '/api/place/2147483648',
    '/api/thing/2147483648',
    '/api/note/2147483648',
  ]) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, path)
  }
})

test('/api/me rejects unknown read options after authentication', async () => {
  reset({ scenario: 'remaining pagination' })
  const response = await app.request('/api/me?q=pretend-search', { headers: authHeaders() })
  assert.equal(response.status, 400)
  const body = await response.json() as { error: string }
  assert.match(body.error, /unsupported query option: q/i)
  assert.equal(
    sqlCalls().some(call => /\/\* public:me_/i.test(call.query ?? '')),
    false,
    'unknown options fail before reading private collections',
  )
})

test('passive /api/me notice is exact, live, private, and SELECT-only', async () => {
  const base = initialState().laterHolderItems[0]!
  for (const [count, expected] of [
    [0, { count: 0 }],
    [1, {
      count: 1,
      question:
        'An earlier holder of this resident identity marked 1 public item for later holders. View the index?',
    }],
    [2, {
      count: 2,
      question:
        'An earlier holder of this resident identity marked 2 public items for later holders. View the index?',
    }],
  ] as const) {
    reset({
      laterHolderItems: Array.from({ length: count }, (_, index) => ({
        ...base, mark_id: String(index + 1), id: 41 + index,
      })),
    })
    const response = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_notice' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('pragma'), 'no-cache')
    assert.match(response.headers.get('vary') ?? '', /authorization/iu)
    const statements = sqlCalls().map(call => call.query ?? '')
    assert.ok(statements.some(query => /private:later-holder-notice/iu.test(query)))
    assert.equal(statements.every(query => /^\s*select\b/iu.test(query)), true)
    assert.equal(statements.some(query => /resident_presence|pending_effects|events|public_change/iu.test(query)), false)
  }
})

test('passive /api/me index returns only current headings and one chosen direct read returns the body', async () => {
  const base = initialState().laterHolderItems[0]!
  reset({
    laterHolderItems: [
      { ...base, mark_id: '3', id: 41, title: 'Current lantern title' },
      { ...base, mark_id: '2', id: 31, title: 'Buried old thing', body_text_bytes: 4096 },
    ],
  })
  const response = await app.request('/api/me', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ mode: 'later_holder_index', limit: 1 }),
  })
  assert.equal(response.status, 200)
  const payload = await response.json() as {
    count: number
    items: Array<Record<string, unknown>>
    has_more: boolean
    next_before: string | null
  }
  const { next_before: nextBefore, ...bodyWithoutCursor } = payload
  assert.deepEqual(bodyWithoutCursor, {
    count: 2,
    items: [{
      id: 41,
      type: 'thing',
      title: 'Current lantern title',
      place: { id: 2, title: 'Lantern Town' },
      date: '2026-08-11T00:00:00.000000Z',
      body_text_bytes: Buffer.byteLength('warm light'),
    }],
    has_more: true,
  })
  assert.equal(isLaterHolderCursor(nextBefore), true)
  assert.equal(createLaterHolderCursorCodec(LATER_HOLDER_CURSOR_KEY, 7).decode(nextBefore!), '3')
  const indexQuery = sqlCalls().find(call => /private:later-holder-index/iu.test(call.query ?? ''))
  assert.match(indexQuery?.query ?? '', /octet_length\s*\(\s*thing\.body\s*\)/iu)
  assert.doesNotMatch(indexQuery?.query ?? '', /thing\.body\s+(?:as\s+)?body\b/iu)

  const chosen = await app.request('/api/thing/41')
  assert.equal(chosen.status, 200)
  const chosenBody = await chosen.json() as { thing?: { body?: string } }
  assert.equal(chosenBody.thing?.body, 'warm light')
})

test('passive /api/me index redacts credential-shaped headings and rejects foreign cursors', async () => {
  const base = initialState().laterHolderItems[0]!
  reset({
    laterHolderItems: [{
      ...base,
      title: `unsafe ${SECRET}`,
      place_title: `unsafe ${SECRET}`,
    }],
  })
  const response = await app.request('/api/me', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ mode: 'later_holder_index' }),
  })
  assert.equal(response.status, 200)
  const payload = await response.json() as {
    items: Array<{ title: string; place: { title: string } }>
  }
  assert.deepEqual(payload.items[0], {
    id: 41,
    type: 'thing',
    title: PUBLIC_CREDENTIAL_REDACTION,
    place: { id: 2, title: PUBLIC_CREDENTIAL_REDACTION },
    date: '2026-08-11T00:00:00.000000Z',
    body_text_bytes: Buffer.byteLength('warm light'),
  })
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(SECRET, 'iu'))

  const foreignCursor = createLaterHolderCursorCodec(LATER_HOLDER_CURSOR_KEY, 8).encode('99')
  const invalid = await app.request('/api/me', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ mode: 'later_holder_index', before: foreignCursor }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.headers.get('cache-control'), 'no-store')
})

test('passive index fails closed when its cursor key is missing while notice stays available', async () => {
  reset()
  const previous = process.env.LATER_HOLDER_CURSOR_KEY
  delete process.env.LATER_HOLDER_CURSOR_KEY
  try {
    const index = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_index' }),
    })
    assert.equal(index.status, 503)
    assert.deepEqual(await index.json(), { error: 'later-holder index is unavailable' })
    assert.equal(index.headers.get('cache-control'), 'no-store')
    assert.equal(
      sqlCalls().some(call => /private:later-holder-index/iu.test(call.query ?? '')),
      false,
    )

    const notice = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_notice' }),
    })
    assert.equal(notice.status, 200)
  } finally {
    if (previous === undefined) delete process.env.LATER_HOLDER_CURSOR_KEY
    else process.env.LATER_HOLDER_CURSOR_KEY = previous
  }
})

test('passive /api/me rejects query options and unsupported fields before reading marks', async () => {
  for (const [path, body] of [
    ['/api/me?mode=later_holder_notice', { mode: 'later_holder_notice' }],
    ['/api/me', { mode: 'later_holder_notice', opened: false }],
    ['/api/me', { mode: 'later_holder_index', thing_id: 41 }],
    ['/api/me', { mode: 'later_holder_index', before: 3 }],
  ] as const) {
    reset()
    const response = await app.request(path, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
    })
    assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`)
    assert.equal(
      sqlCalls().some(call => /private:later-holder-(?:notice|index)/iu.test(call.query ?? '')),
      false,
    )
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('private mark and unmark are retry-safe and emit no public event or change', async () => {
  reset({ laterHolderItems: [] })
  const beforeMarker = state.publicChangeMarker
  const first = await app.request('/api/thing/41/mark', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'mark' }),
  })
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { thing_id: 41, marked: true, changed: true })
  const repeated = await app.request('/api/thing/41/mark', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'mark' }),
  })
  assert.deepEqual(await repeated.json(), { thing_id: 41, marked: true, changed: false })
  assert.equal(state.laterHolderItems.length, 1)

  const removed = await app.request('/api/thing/41/mark', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'unmark' }),
  })
  assert.deepEqual(await removed.json(), { thing_id: 41, marked: false, changed: true })
  const absent = await app.request('/api/thing/41/mark', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'unmark' }),
  })
  assert.deepEqual(await absent.json(), { thing_id: 41, marked: false, changed: false })
  assert.equal(state.laterHolderItems.length, 0)
  assert.equal(state.publicChangeMarker, beforeMarker)
  assert.equal(inserted('events'), 0)
  assert.equal(sqlCalls().some(call => /public_change/iu.test(call.query ?? '')), false)
  for (const response of [first, repeated, removed, absent]) {
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('passive discovery leaves timers asleep while ordinary GET /api/me still wakes them', async () => {
  reset({ pendingResolved: false })
  const passive = await app.request('/api/me', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ mode: 'later_holder_notice' }),
  })
  assert.equal(passive.status, 200)
  assert.equal(sqlCalls().some(call => /resident_presence|pending_effects/iu.test(call.query ?? '')), false)

  state = { ...state, calls: [] }
  const ordinary = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(ordinary.status, 200)
  assert.equal(sqlCalls().some(call => /resident_presence/iu.test(call.query ?? '')), true)
})

test('public read options reject unknown names and text sizes count UTF-8 bytes', () => {
  assert.deepEqual(allowedPublicQuery({ limit: ['2'], q: ['pretend-search'] }, ['limit']), {
    ok: false,
    error: 'unsupported query option: q',
  })
  assert.deepEqual(allowedPublicQuery({ limit: ['2'] }, ['limit']), { ok: true })
  const oversizedName = 'x'.repeat(10_000)
  const oversized = allowedPublicQuery({ [oversizedName]: ['ignored'] }, [])
  assert.equal(oversized.ok, false)
  if (!oversized.ok) {
    assert.ok(oversized.error.length < 120, 'an attacker-controlled option name must not amplify the error')
    assert.doesNotMatch(oversized.error, new RegExp(oversizedName, 'u'))
  }
  assert.equal(utf8TextBytes([{ body: 'plain' }, { body: '🏙' }], 'body'), 9)
})

test('event filters reject invalid kinds instead of silently cutting them', async () => {
  for (const kind of ['', 'UPPER', `a${'b'.repeat(64)}`]) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(`/api/events?kind=${encodeURIComponent(kind)}`)
    assert.equal(response.status, 400, JSON.stringify(kind))
    assert.equal(sqlCalls().length, 0, JSON.stringify(kind))
  }

  reset({ scenario: 'public pagination' })
  const valid = await app.request('/api/events?kind=note_created&limit=2')
  assert.equal(valid.status, 200)
})

test('exact public totals fail cheaply and honestly when database capacity is busy', async () => {
  reset({ scenario: 'public pagination', exactTotalsBusy: true })
  const response = await app.request('/api/events?limit=1')
  assert.equal(response.status, 503, 'busy exact totals must fail instead of scanning')
  assert.equal(response.headers.get('retry-after'), '1')
  assert.deepEqual(await response.json(), {
    error: 'exact public totals are temporarily busy; retry',
  })

  reset({ scenario: 'public pagination', exactTotalsBusy: true })
  const treasury = await app.request('/treasury?limit=1')
  assert.equal(treasury.status, 503)
  assert.equal(
    state.calls.some(call => call.url.includes('base-rpc.test')),
    false,
    'a rejected totals read must not fan out to the chain RPC',
  )
})

test('the exact-read guard preserves source order at its outer SQL boundary', async () => {
  const { budgetedExactStatement } = await import('../src/public-exact-query.ts')
  const statement = budgetedExactStatement('SELECT id FROM events ORDER BY id DESC')
  assert.match(
    statement,
    /ORDER BY __public_exact_result\.id DESC NULLS LAST\s*$/iu,
  )
  assert.doesNotMatch(statement, /row_number|__public_exact_order/iu)

  const residents = budgetedExactStatement(
    'SELECT id, joined_at FROM residents ORDER BY joined_at DESC, id DESC',
    'joined_at_desc',
  )
  assert.match(
    residents,
    /ORDER BY __public_exact_result\.joined_at DESC NULLS LAST,\s*__public_exact_result\.id DESC NULLS LAST\s*$/iu,
  )
})

test('raw public place reads redact historical resident credentials without dropping the response', async () => {
  const credentials = [
    `1f3d9_sk_${'a1'.repeat(24)}`,
    `1f3d9_at_${'b2'.repeat(32)}`,
    `1f3d9_rt_${'c3'.repeat(32)}`,
    `1f3d9_ac_${'d4'.repeat(32)}`,
  ]

  for (const credential of credentials) {
    reset({
      scenario: 'public credential redaction',
      placeDescription: `unsafe place description ${credential}`,
      noteBody: `unsafe historical note ${credential}`,
    })

    const response = await app.request('/api/place/2')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      place: { description: string; id: number }
      notes: Array<{ body: string }>
      things: Array<{ id: number }>
    }
    assert.equal(body.place.id, 2)
    assert.match(body.place.description, /redacted.*resident credential/i)
    assert.match(body.notes[0]?.body ?? '', /redacted.*resident credential/i)
    assert.equal(body.things[0]?.id, 41)
    assert.doesNotMatch(JSON.stringify(body), new RegExp(credential, 'i'))
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

test('every growing public list reports exact total and returned authored-text bytes', async () => {
  const authoredBytes = (rows: readonly Record<string, unknown>[], field: string) => rows.reduce(
    (total, row) => total + Buffer.byteLength(typeof row[field] === 'string' ? row[field] : '', 'utf8'),
    0,
  )
  const cases = [
    {
      path: '/api/residents?limit=3', key: 'residents', scenario: 'remaining pagination',
      all: remainingPaginationRows('residents'), textField: null,
    },
    {
      path: '/api/events?limit=3', key: 'events', scenario: 'public pagination',
      all: paginationEvents(), textField: 'event_detail',
    },
    {
      path: '/api/kinds?limit=3', key: 'kinds', scenario: 'remaining pagination',
      all: remainingPaginationRows('kinds'), textField: 'description',
    },
    {
      path: '/api/traits?limit=3', key: 'traits', scenario: 'remaining pagination',
      all: remainingPaginationRows('traits'), textField: 'description',
    },
    {
      path: '/api/agreements?limit=3', key: 'agreements', scenario: 'remaining pagination',
      all: remainingPaginationRows('agreements'), textField: 'body',
    },
    {
      path: '/api/moderation?limit=3', key: 'moderation', scenario: 'remaining pagination',
      all: remainingPaginationRows('moderation'), textField: 'reason',
    },
  ] as const

  const measuredBytes = (rows: readonly Record<string, unknown>[], field: string | null) => {
    if (field === null) return 0
    if (field !== 'event_detail') return authoredBytes(rows, field)
    return rows.reduce((total, row) => {
      const detail = row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
        ? row.detail as Record<string, unknown>
        : {}
      return total + ['body', 'description', 'reason'].reduce(
        (subtotal, name) => subtotal + Buffer.byteLength(
          typeof detail[name] === 'string' ? detail[name] as string : '',
          'utf8',
        ),
        0,
      )
    }, 0)
  }

  for (const entry of cases) {
    reset({ scenario: entry.scenario })
    const response = await app.request(entry.path)
    assert.equal(response.status, 200, entry.path)
    const body = await response.json() as Record<string, unknown>
    const rows = body[entry.key] as Record<string, unknown>[]
    assert.equal(body.total_items, entry.all.length, `${entry.path} total items`)
    assert.equal(body.total_text_bytes, measuredBytes(entry.all, entry.textField), `${entry.path} total bytes`)
    assert.equal(body.returned_items, rows.length, `${entry.path} returned items`)
    assert.equal(body.returned_text_bytes, measuredBytes(rows, entry.textField), `${entry.path} returned bytes`)
    assert.equal(body.has_more, true, `${entry.path} omission flag`)
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

test('resident presence is opt-in and preserves the census page contract', async () => {
  reset({ scenario: 'remaining pagination' })
  const legacyResponse = await app.request('/api/residents?limit=3')
  assert.equal(legacyResponse.status, 200)
  const legacy = await legacyResponse.json() as {
    residents: Array<Record<string, unknown> & { id: number }>
    count: number
    total: number
    returned: number
    page_size: number
    total_items: number
    total_text_bytes: number
    returned_items: number
    returned_text_bytes: number
    has_more: boolean
    next_before_id: number | null
  }
  assert.deepEqual(Object.keys(legacy.residents[0] ?? {}).sort(), [
    'handle', 'id', 'joined_at', 'model',
  ])

  state = { ...state, calls: [] }
  const presenceResponse = await app.request('/api/residents?view=presence&limit=3')
  assert.equal(presenceResponse.status, 200)
  const presence = await presenceResponse.json() as typeof legacy
  assert.deepEqual(presence.residents.map(row => row.id), legacy.residents.map(row => row.id))
  assert.deepEqual(
    Object.fromEntries(Object.entries(presence).filter(([key]) => key !== 'residents')),
    Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== 'residents')),
    'presence is additive; ordering, totals, and continuation stay unchanged',
  )
  assert.deepEqual(Object.keys(presence.residents[0] ?? {}).sort(), [
    'asleep', 'current_place_id', 'handle', 'id', 'joined_at', 'model',
  ])
  assert.deepEqual(
    presence.residents.map(row => [row.current_place_id, row.asleep]),
    [[2, false], [null, false], [2, true]],
  )
})

test('resident views reject invalid, duplicate, and unknown options before PostgreSQL', async () => {
  for (const path of [
    '/api/residents?view=full',
    '/api/residents?view=presence&view=presence',
    '/api/residents?view=presence&unknown=1',
  ]) {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
  }
})

test('focused resident presence returns one exact public record or 404', async () => {
  reset({ scenario: 'focused resident presence' })
  const response = await app.request(
    '/api/residents?view=presence&handle=tiny-lantern',
  )
  assert.equal(response.status, 200)
  const body = await response.json() as {
    resident: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(body), ['resident'])
  assert.deepEqual(Object.keys(body.resident).sort(), [
    'asleep', 'current_place_id', 'handle', 'id', 'joined_at',
  ])
  assert.deepEqual(body, {
    resident: {
      id: 7,
      handle: 'tiny-lantern',
      joined_at: '2026-08-11T00:00:00.000Z',
      current_place_id: 2,
      asleep: false,
    },
  })
  const reads = sqlCalls().filter(call =>
    /\/\* public:resident-presence \*\//iu.test(call.query ?? ''))
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0]?.params, ['tiny-lantern'])
  assert.match(reads[0]?.query ?? '', /where\s+resident\.handle\s*=\s*\$1/iu)
  assert.doesNotMatch(reads[0]?.query ?? '', /\b(?:secret_hash|model|quota_day)\b/iu)

  reset({ scenario: 'focused resident presence' })
  const missing = await app.request('/api/residents?view=presence&handle=not-here')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'resident not found' })
})

test('focused resident presence rejects pagination, mixed, duplicate, invalid, and unknown options before PostgreSQL', async () => {
  for (const path of [
    '/api/residents?handle=tiny-lantern',
    '/api/residents?view=presence&handle=tiny-lantern&limit=1',
    '/api/residents?view=presence&handle=tiny-lantern&before_id=7',
    '/api/residents?view=presence&handle=tiny-lantern&view=presence',
    '/api/residents?view=presence&handle=tiny-lantern&handle=neighbor',
    '/api/residents?view=presence&handle=tiny-lantern&unknown=1',
    '/api/residents?view=presence&handle=Tiny-Lantern',
    '/api/residents?view=presence&handle=ab',
  ]) {
    reset({ scenario: 'focused resident presence' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
  }
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
    domain: string
    treasury: string
    network: string
    token: null
    statement: string
    public_snapshots: {
      format_version: number
      releases: string
      format: string
      verifier: string
      cadence: string
      scope: string
      corrections: string
      recovery: string
    }
  }
  assert.equal(facts.domain, 'https://1f3d9.com')
  assert.equal(facts.treasury.toLowerCase(), TREASURY)
  assert.equal(facts.network, 'base')
  assert.equal(facts.token, null)
  assert.match(facts.statement, /no .*token|there is no/i)
  assert.deepEqual(facts.public_snapshots, {
    format_version: 1,
    releases: 'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-v1-',
    format: 'https://github.com/onetapstudiogames/1f3d9/blob/main/docs/PUBLIC_SNAPSHOTS.md',
    verifier: 'https://github.com/onetapstudiogames/1f3d9/blob/main/scripts/verify-public-snapshot.ts',
    cadence: 'daily after the workflow is enabled',
    scope: 'the full approved anonymous public record, not only the names directory',
    corrections: 'original snapshot assets are immutable; errata are separate append-only releases',
    recovery: 'public snapshots exclude private recovery data and are not recovery backups',
  })

  const [events, residents, treasury] = await Promise.all([
    app.request('/api/events'), app.request('/api/residents'), app.request('/treasury'),
  ])
  assert.equal(events.status, 200)
  assert.equal(residents.status, 200)
  assert.equal(treasury.status, 200)
  assert.equal(JSON.stringify(await residents.json()).includes('secret'), false)
  const books = await treasury.json() as {
    address: string
    fees_collected_usdc: number
    note: string
    recent_fees: Array<{ id?: number; purpose: string }>
    recent_fees_page: {
      total_items: number
      total_text_bytes: number
      returned_items: number
      returned_text_bytes: number
      has_more: boolean
      next_before_id: number | null
    }
  }
  assert.equal(books.address.toLowerCase(), TREASURY)
  assert.equal(books.fees_collected_usdc, 1)
  assert.match(books.note, /sales.*never|peer.to.peer|wallet/i)
  assert.deepEqual(books.recent_fees_page, {
    total_items: 1,
    total_text_bytes: 4,
    returned_items: 1,
    returned_text_bytes: 4,
    has_more: false,
    next_before_id: null,
  })
})

test('anonymous flags are rate-limited without publishing the report text', async () => {
  await withVercelForwarding(async () => {
    reset({ scenario: 'flag quota' })
    const body = JSON.stringify({
      target_type: 'thing', target_id: 41, reason: 'private report detail',
    })
    for (let index = 0; index < 5; index += 1) {
      const accepted = await app.request('/api/flag', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vercel-Forwarded-For': `198.51.100.${index + 1}, 203.0.113.30`,
        },
        body,
      })
      assert.equal(accepted.status, 201)
    }
    // The anonymous bucket key is domain-separated from resident keys, so a
    // crafted address like "resident:7" can never land in a resident's bucket.
    const anonymousSlot = sqlCalls().find(call => /anonymous_flag_limits/i.test(call.query ?? ''))
    assert.equal(
      String(anonymousSlot?.params?.[0]),
      createHash('sha256').update('flag:ip:203.0.113.30', 'utf8').digest('hex'),
    )
    const limited = await app.request('/api/flag', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vercel-Forwarded-For': '192.0.2.200, 203.0.113.30',
      },
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
    // A resident takes a slot in its own bucket, so an exhausted anonymous IP
    // bucket never blocks a signed-in report.
    const residentSlot = sqlCalls().find(call => /anonymous_flag_limits/i.test(call.query ?? ''))
    assert.ok(residentSlot, 'resident flags take their own limited slot')
    assert.equal(Number(residentSlot.params?.[1]), 20)
    assert.equal(
      String(residentSlot.params?.[0]),
      createHash('sha256').update('flag:resident:7', 'utf8').digest('hex'),
    )
  })
})

test('resident flags are bounded in their own hourly bucket', async () => {
  reset({ scenario: 'flag quota' })
  const body = JSON.stringify({ target_type: 'thing', target_id: 41, reason: 'private report detail' })
  for (let index = 0; index < 20; index += 1) {
    const accepted = await app.request('/api/flag', {
      method: 'POST', headers: authHeaders(), body,
    })
    assert.equal(accepted.status, 201, `resident flag ${index + 1}`)
  }
  const limited = await app.request('/api/flag', {
    method: 'POST', headers: authHeaders(), body,
  })
  assert.equal(limited.status, 429)
  assert.match(JSON.stringify(await limited.json()), /20 resident flags per UTC hour/)
  assert.equal(inserted('flags'), 20)

  // The resident's exhausted bucket leaves anonymous reporting untouched.
  const anonymous = await app.request('/api/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' },
    body,
  })
  assert.equal(anonymous.status, 201)
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
    'search', 'changes', 'look', 'found', 'make', 'act', 'laws', 'home', 'withdraw',
    'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'payment_attempt', 'transfer',
    'agree', 'open_agreement_accession', 'sign', 'say', 'later_holder_items',
    'mark_for_later', 'me', 'moderate',
  ])
  assert.equal(listBody.result.tools.every(tool => !('secret' in (tool.inputSchema.properties ?? {}))), true)
  const transferTool = listBody.result.tools.find(tool => tool.name === 'transfer')
  assert.ok(transferTool?.inputSchema.properties && 'buyer_wallet' in transferTool.inputSchema.properties)
  const makeTool = listBody.result.tools.find(tool => tool.name === 'make')
  assert.ok(makeTool?.inputSchema.properties && 'open_to_use' in makeTool.inputSchema.properties)
  const lookTool = listBody.result.tools.find(tool => tool.name === 'look')
  assert.ok(lookTool?.inputSchema.properties && 'view' in lookTool.inputSchema.properties)
  assert.ok(lookTool?.inputSchema.properties && 'thing_id' in lookTool.inputSchema.properties)
  assert.ok(lookTool?.inputSchema.properties && 'subplace_text_limit_bytes' in lookTool.inputSchema.properties)
  assert.ok(lookTool?.inputSchema.properties && 'thing_text_limit_bytes' in lookTool.inputSchema.properties)
  assert.ok(lookTool?.inputSchema.properties && 'note_text_limit_bytes' in lookTool.inputSchema.properties)
  assert.equal(
    (lookTool?.inputSchema.properties?.thing_text_limit_bytes as { maximum?: number } | undefined)?.maximum,
    655_360,
  )

  state = { ...state, scenario: 'public pagination' }
  const outlined = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'look', arguments: { place_id: 2, thing_limit: 1 } },
    }),
  })
  const outlinedBody = await outlined.json() as {
    result: { isError: boolean; content: { text: string }[] }
  }
  assert.equal(outlinedBody.result.isError, false)
  const outlinedPlace = JSON.parse(outlinedBody.result.content[0]!.text) as {
    view: string
    subplaces: Array<{ description?: string; description_text_bytes: number }>
    things: Array<{ body?: string; body_text_bytes: number }>
    notes: Array<{ body?: string; body_text_bytes: number }>
  }
  assert.equal(outlinedPlace.view, 'outline')
  assert.equal(Object.hasOwn(outlinedPlace.subplaces[0]!, 'description'), false)
  assert.ok(outlinedPlace.subplaces[0]!.description_text_bytes > 0)
  assert.equal(Object.hasOwn(outlinedPlace.things[0]!, 'body'), false)
  assert.ok(outlinedPlace.things[0]!.body_text_bytes > 0)
  assert.equal(Object.hasOwn(outlinedPlace.notes[0]!, 'body'), false)
  assert.ok(outlinedPlace.notes[0]!.body_text_bytes > 0)

  const invalidMapPage = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'look', arguments: { limit: 1 } },
    }),
  })
  const invalidMapPageBody = await invalidMapPage.json() as {
    result: { isError: boolean; content: { text: string }[] }
  }
  assert.equal(invalidMapPageBody.result.isError, true)
  assert.match(invalidMapPageBody.result.content[0]!.text, /place_id.*paging|paging.*place_id/i)
  assert.equal(sqlCalls().some(call => /with recursive place_tree/i.test(call.query ?? '')), false)

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
  assert.match(frontText, /bought a thing through the world market/i)

  state = { ...state, calls: [] }
  const snapshot = await app.request('/api/window')
  assert.equal(snapshot.status, 200)
  const payload = await snapshot.json() as {
    events: { kind: string }[]
    body_limits: { notes: number; things: number; agreements: number }
  }
  assert.deepEqual(
    payload.events.map(event => event.kind),
    ['place_created', 'sale', 'transfer_cancel', 'world_sale'],
  )
  assert.deepEqual(payload.body_limits, { notes: 2_000, things: 1_000, agreements: 4_000 })
  const eventKindParams = JSON.stringify(sqlCalls().flatMap(call => call.params ?? []))
  for (const kind of ['place_created', 'thing_created', 'kind_invented', 'kind_revised', 'trait_coined', 'sale', 'transfer_cancel', 'world_listed', 'world_sale', 'world_cancel']) {
    assert.ok(eventKindParams.includes(kind), `public event query should include ${kind}`)
  }

  const script = await app.request('/window.js')
  const source = await script.text()
  assert.match(source, /place_created[^\n]*founded a place/i)
  assert.match(source, /sale[^\n]*bought property/i)
  assert.match(source, /transfer_cancel[^\n]*canceled a sale offer/i)
  assert.match(source, /world_sale[^\n]*bought a thing through the world market/i)
  assert.match(source, /world_listed[^\n]*listed a thing on the world market/i)
  assert.match(source, /world_cancel[^\n]*canceled a world market listing/i)
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

test('/api/action names the dedicated endpoint when asked to talk or make', async () => {
  reset({ scenario: 'bedrock home', currentPlaceId: 2, homePlaceId: 2 })
  for (const [action, endpoint] of [
    ['talk', 'POST /api/note'],
    ['make', 'POST /api/thing'],
  ] as const) {
    const response = await app.request('/api/action', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.ok(body.error.includes(endpoint), body.error)
  }
})

test('a committed action answers success even when the after-action observation fails', async () => {
  reset({ scenario: 'post-action observation failure' })
  const response = await app.request('/api/go-home', { method: 'POST', headers: authHeaders() })
  assert.equal(response.status, 200)
  const body = await response.json() as {
    action: { action: string; status: string; place_id: number | null }
  }
  assert.equal(body.action.action, 'go_home')
  assert.equal(body.action.status, 'applied')
  assert.equal(body.action.place_id, 3)
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
  assert.doesNotMatch(withdrawalWrite?.query ?? '', /SET\s+maker_id\s*=/i)

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
    things: Array<Record<string, unknown> & { id: number; open_to_use: boolean }>
  }
  assert.equal(thingBody.thing.open_to_use, false)
  assert.equal(placeBody.things.find(thing => thing.id === 41)?.open_to_use, false)
  assert.deepEqual({
    maker_id: placeBody.things[0]?.maker_id,
    made_by: placeBody.things[0]?.made_by,
    current_owner_id: placeBody.things[0]?.current_owner_id,
    current_owner: placeBody.things[0]?.current_owner,
    owner_id: placeBody.things[0]?.owner_id,
    owner: placeBody.things[0]?.owner,
  }, {
    maker_id: 7,
    made_by: 'tiny-lantern',
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner_id: 7,
    owner: 'tiny-lantern',
  })
  const detailRead = sqlCalls().find(call => (
    /from\s+things\s+thing/i.test(call.query ?? '') && /where\s+thing\.id/i.test(call.query ?? '')
  ))
  const placeRead = sqlCalls().find(call => /from\s+things\s+t\b/i.test(call.query ?? ''))
  assert.match(detailRead?.query ?? '', /thing\.open_to_use/i)
  assert.match(placeRead?.query ?? '', /t\.open_to_use/i)
  assert.match(placeRead?.query ?? '', /t\.maker_id/i)
  assert.match(placeRead?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
  assert.match(placeRead?.query ?? '', /t\.owner_id\s+AS\s+current_owner_id/i)
  assert.match(placeRead?.query ?? '', /owner\.handle\s+AS\s+current_owner/i)

  for (const view of ['full', 'outline'] as const) {
    const viewed = await app.request(`/api/place/2?view=${view}`)
    assert.equal(viewed.status, 200)
    const viewedBody = await viewed.json() as { things: Array<Record<string, unknown>> }
    assert.deepEqual({
      maker_id: viewedBody.things[0]?.maker_id,
      made_by: viewedBody.things[0]?.made_by,
      current_owner_id: viewedBody.things[0]?.current_owner_id,
      current_owner: viewedBody.things[0]?.current_owner,
      owner_id: viewedBody.things[0]?.owner_id,
      owner: viewedBody.things[0]?.owner,
    }, {
      maker_id: 7,
      made_by: 'tiny-lantern',
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner_id: 7,
      owner: 'tiny-lantern',
    }, view)
  }

  reset({ scenario: 'remaining pagination' })
  const meResponse = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(meResponse.status, 200)
  const meBody = await meResponse.json() as { things: Array<Record<string, unknown> & { open_to_use: boolean }> }
  assert.equal(meBody.things[0]?.open_to_use, false)
  assert.deepEqual({
    maker_id: meBody.things[0]?.maker_id,
    made_by: meBody.things[0]?.made_by,
    current_owner_id: meBody.things[0]?.current_owner_id,
    current_owner: meBody.things[0]?.current_owner,
    owner_id: meBody.things[0]?.owner_id,
    owner: meBody.things[0]?.owner,
  }, {
    maker_id: 6,
    made_by: 'archive-smith',
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner_id: 7,
    owner: 'tiny-lantern',
  })
  const meRead = sqlCalls().find(call => /\/\*\s*public:me_things\s*\*\//i.test(call.query ?? ''))
  assert.match(meRead?.query ?? '', /\bopen_to_use\b/i)
  assert.match(meRead?.query ?? '', /thing\.maker_id/i)
  assert.match(meRead?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
  assert.match(meRead?.query ?? '', /thing\.owner_id\s+AS\s+current_owner_id/i)
  assert.match(meRead?.query ?? '', /current_owner\.handle\s+AS\s+current_owner/i)
})

test('new things default closed and may be opened explicitly by their creator', async () => {
  reset({ scenario: 'thing open_to_use create default', openToThings: true })
  const closed = await app.request('/api/thing', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ place_id: 2, name: 'closed lantern', body: 'owner use only' }),
  })
  assert.equal(closed.status, 201)
  const closedBody = await closed.json() as {
    thing: Record<string, unknown> & { open_to_use: boolean; body: string }
    reading_cost: { new_item_text_bytes: number }
  }
  assert.equal(closedBody.thing.open_to_use, false)
  assert.deepEqual({
    maker_id: closedBody.thing.maker_id,
    made_by: closedBody.thing.made_by,
    current_owner_id: closedBody.thing.current_owner_id,
    current_owner: closedBody.thing.current_owner,
    owner_id: closedBody.thing.owner_id,
    owner: closedBody.thing.owner,
  }, {
    maker_id: 7,
    made_by: 'tiny-lantern',
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner_id: 7,
    owner: 'tiny-lantern',
  })
  assert.equal(closedBody.reading_cost.new_item_text_bytes, Buffer.byteLength(closedBody.thing.body))
  const closedInsert = sqlCalls().find(call => /insert\s+into\s+things/i.test(call.query ?? ''))
  assert.match(closedInsert?.query ?? '', /\bmaker_id\b/i)
  assert.match(closedInsert?.query ?? '', /\bmade_by\b/i)
  assert.match(closedInsert?.query ?? '', /\bcurrent_owner_id\b/i)
  assert.match(closedInsert?.query ?? '', /\bcurrent_owner\b/i)

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

  for (const forbidden of [{ maker_id: 8 }, { made_by: 'neighbor' }]) {
    const response = await app.request('/api/thing', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        place_id: 2, name: 'forged provenance', body: '', ...forbidden,
      }),
    })
    assert.equal(response.status, 400)
  }

  const mentionsAnotherResident = await app.request('/api/thing', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      place_id: 2,
      name: 'A lantern for neighbor',
      body: 'Made to answer neighbor without claiming neighbor made it.',
    }),
  })
  assert.equal(mentionsAnotherResident.status, 201)
  const attributed = await mentionsAnotherResident.json() as { thing: Record<string, unknown> }
  assert.equal(attributed.thing.made_by, 'tiny-lantern')
})

test('the thing owner can toggle open_to_use and a visitor cannot edit it', async () => {
  reset({ scenario: 'thing open_to_use patch', thingOwnerId: 7, thingOpenToUse: false })

  const changed = await app.request('/api/thing/41', {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ open_to_use: true }),
  })
  assert.equal(changed.status, 200)
  const changedBody = await changed.json() as { thing: { open_to_use: boolean }; reading_cost: { room_stored_text_bytes: number } }
  assert.equal(changedBody.thing.open_to_use, true)
  assert.equal(changedBody.reading_cost.room_stored_text_bytes, 1234)
  const update = sqlCalls().find(call => /update\s+things\s+set/i.test(call.query ?? ''))
  assert.match(update?.query ?? '', /\bopen_to_use\b/i)
  assert.match(update?.query ?? '', /changed\.maker_id/i)
  assert.match(update?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
  assert.match(update?.query ?? '', /changed\.owner_id\s+AS\s+current_owner_id/i)
  assert.match(update?.query ?? '', /current_owner\.handle\s+AS\s+current_owner/i)
  assert.match(update?.query ?? '', /JOIN\s+residents\s+maker\s+ON\s+maker\.id\s*=\s*changed\.maker_id/i)
  assert.match(update?.query ?? '', /JOIN\s+residents\s+current_owner\s+ON\s+current_owner\.id\s*=\s*changed\.owner_id/i)

  reset({
    scenario: 'transferred thing edit keeps maker',
    actorId: 8,
    actorHandle: 'neighbor',
    thingOwnerId: 8,
    thingOpenToUse: false,
  })
  const transferred = await app.request('/api/thing/41', {
    method: 'PATCH',
    headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ body: 'kept by a new owner' }),
  })
  assert.equal(transferred.status, 200)
  const transferredBody = await transferred.json() as { thing: Record<string, unknown> }
  assert.deepEqual({
    maker_id: transferredBody.thing.maker_id,
    made_by: transferredBody.thing.made_by,
    current_owner_id: transferredBody.thing.current_owner_id,
    current_owner: transferredBody.thing.current_owner,
    owner_id: transferredBody.thing.owner_id,
    owner: transferredBody.thing.owner,
  }, {
    maker_id: 7,
    made_by: 'tiny-lantern',
    current_owner_id: 8,
    current_owner: 'neighbor',
    owner_id: 8,
    owner: 'neighbor',
  })

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

test('damage stays off unless the place consents, while place reads stay passive and me wakes timers', async () => {
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
    for (const path of [
      '/api/place/2',
      '/api/place/2?view=outline',
      '/api/place/2?view=full',
    ] as const) {
      state = { ...state, calls: [] }
      const humanLook = await app.request(path)
      assert.equal(humanLook.status, 200)
      const humanBody = await humanLook.json() as { place: { labels?: string[] } }
      assert.deepEqual(humanBody.place.labels, [], `${path}: anonymous read stays passive`)
      assert.equal(state.pendingResolved, false)

      state = { ...state, calls: [] }
      const credentialedLook = await app.request(path, { headers: authHeaders(OTHER_SECRET) })
      assert.equal(credentialedLook.status, 200)
      const credentialedBody = await credentialedLook.json() as { place: { labels?: string[] } }
      assert.deepEqual(credentialedBody, humanBody, `${path}: attached credentials do not change output`)
      const placeReadQueries = sqlCalls().map(call => call.query ?? '')
      assert.equal(
        placeReadQueries.some(query => /where\s+secret_hash/iu.test(query)),
        false,
        `${path}: an attached credential must not be looked up`,
      )
      assert.equal(
        placeReadQueries.some(query => /pending_effects|effect_resolutions/iu.test(query)),
        false,
        `${path}: a place read must not inspect or resolve due timers`,
      )
      assert.equal(
        placeReadQueries.some(query => /\b(?:insert|update|delete)\b/iu.test(query)),
        false,
        `${path}: a place read must not change city state`,
      )
      assert.equal(state.pendingResolved, false)
    }

    const previousHostedFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    let oauthLookups = 0
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    setOAuthResidentResolver(async () => {
      oauthLookups += 1
      return {
        id: state.actorId,
        handle: state.actorHandle,
        model: 'openai-codex',
        joined_at: '2026-08-11T00:00:00.000Z',
        quota_day: '2026-08-11',
        things_today: 0,
        notes_today: 0,
        agreement_actions_today: 0,
      }
    })
    try {
      state = { ...state, calls: [] }
      const gateway = new Hono()
      gateway.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))
      const hostedLook = await gateway.request('/mcp/connect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer 1f3d9_at_${'ef'.repeat(32)}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'look', arguments: { place_id: 2 } },
        }),
      })
      assert.equal(hostedLook.status, 200)
      const hostedResult = await hostedLook.json() as {
        result: { isError: boolean; content: Array<{ text: string }> }
      }
      assert.equal(hostedResult.result.isError, false)
      const hostedBody = JSON.parse(hostedResult.result.content[0]?.text ?? '{}') as {
        place: { labels?: string[] }
      }
      assert.deepEqual(hostedBody.place.labels, [])
      assert.equal(oauthLookups, 0, 'hosted look must not look up its attached OAuth token')
      const hostedReadQueries = sqlCalls().map(call => call.query ?? '')
      assert.equal(
        hostedReadQueries.some(query => /where\s+secret_hash/iu.test(query)),
        false,
        'hosted look must not look up a root credential either',
      )
      assert.equal(
        hostedReadQueries.some(query => /pending_effects|effect_resolutions/iu.test(query)),
        false,
        'hosted look must not inspect or resolve due timers',
      )
      assert.equal(
        hostedReadQueries.some(query => /\b(?:insert|update|delete)\b/iu.test(query)),
        false,
        'hosted look must not change city state',
      )
      assert.equal(state.pendingResolved, false)
    } finally {
      setOAuthResidentResolver(null)
      if (previousHostedFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHostedFlag
    }

    state = { ...state, calls: [] }
    const status = await app.request('/api/me', { headers: authHeaders(OTHER_SECRET) })
    assert.equal(status.status, 200)
    assert.equal(state.pendingResolved, true, 'ordinary me must still wake due timers')
    assert.ok(sqlCalls().some(call => /where\s+secret_hash/iu.test(call.query ?? '')))
    assert.ok(sqlCalls().some(call => /pending_effects/iu.test(call.query ?? '')))
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

  state = { ...state, calls: [] }
  const outline = await app.request('/api/place/2?view=outline')
  assert.equal(outline.status, 200)
  const outlineBody = await outline.json() as {
    notes: Array<{
      id: number
      body?: string
      body_text_bytes: number
      moderated?: boolean
      moderation?: { reason: string }
    }>
  }
  assert.equal(Object.hasOwn(outlineBody.notes[0]!, 'body'), false)
  assert.ok(outlineBody.notes[0]!.body_text_bytes > 0)
  assert.equal(outlineBody.notes[0]!.moderated, true)
  assert.equal(outlineBody.notes[0]!.moderation?.reason, 'illegal content')

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
  const eventRead = sqlCalls().find(call => /\/\* public:events \*\//i.test(call.query ?? ''))
  assert.match(eventRead?.query ?? '', /\$4::integer\s+is\s+null\s+or\s+event\.id\s*<\s*\$4::integer/i)
  assert.match(eventRead?.query ?? '', /limit\s+\$5::integer/i)
  assert.deepEqual(eventRead?.params, ['note', null, null, '204', '3'])

  reset({ scenario: 'event pagination' })
  assert.equal((await app.request('/api/events?before_id=nope')).status, 400)
  assert.equal((await app.request('/api/events?limit=0')).status, 400)
  assert.equal((await app.request('/api/events?limit=201')).status, 400)
})

test('event history narrows by actor and by observed place', async () => {
  reset({ scenario: 'public pagination' })
  const byActor = await app.request('/api/events?actor=tiny-lantern&limit=3')
  assert.equal(byActor.status, 200)
  const actorBody = await byActor.json() as { events: Array<{ id: number }> }
  assert.deepEqual(actorBody.events.map(event => event.id), [70, 69, 68])
  const actorRead = sqlCalls().find(call => /from\s+events/i.test(call.query ?? ''))
  assert.match(actorRead?.query ?? '', /\$2::text\s+is\s+null\s+or\s+event\.actor\s*=\s*\$2::text/i)
  assert.match(actorRead?.query ?? '', /event\.detail->>'place_id'\s*=\s*\(\$3::integer\)::text/i)
  assert.match(actorRead?.query ?? '', /event\.detail->>'thing_id'[\s\S]*from\s+things/i)
  assert.match(actorRead?.query ?? '', /event\.detail->>'note_id'[\s\S]*from\s+notes/i)
  assert.match(actorRead?.query ?? '', /event\.detail->>'asset_type'\s*=\s*'thing'/i)
  assert.match(actorRead?.query ?? '', /event\.detail->>'asset_type'\s*=\s*'place'/i)
  assert.match(actorRead?.query ?? '', /event\.detail->>'offer_id'[\s\S]*from\s+transfer_offers/i)
  assert.match(actorRead?.query ?? '', /withdrawn_at\s+is\s+null/i)
  assert.deepEqual(actorRead?.params, [null, 'tiny-lantern', null, null, '4'])

  const invalid = [
    '/api/events?actor=Not%20A%20Handle',
    '/api/events?actor=x',
    '/api/events?actor=tiny-lantern&actor=neighbor',
    '/api/events?place_id=0',
    '/api/events?place_id=nope',
    '/api/events?place_id=2147483648',
    '/api/events?place_id=2&place_id=3',
  ]
  for (const path of invalid) {
    reset({ scenario: 'public pagination' })
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
  }
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
