// One fake isolates Neon, Base JSON-RPC, and the x402 facilitator.
// No live database, wallet, payment, deployment, or network service is touched.
import test from 'node:test'
import assert from 'node:assert/strict'

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
const X_PAYMENT = Buffer.from(JSON.stringify({
  payload: { authorization: { from: BUYER_WALLET } },
})).toString('base64')

interface DbCall { url: string; query?: string; params?: unknown[] }
interface OfferState {
  id: number
  channel?: 'direct' | 'world'
  status: 'open' | 'canceled' | 'claimed'
  reservedAt?: string | null
  reservedUntil: string | null
  buyerWallet?: string | null
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
  thingOwnerId: number
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
  facilitatorVerify: boolean
  facilitatorSettle: boolean
  anonymousFlagsUsed: number
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
  thingOwnerId: 7,
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
  facilitatorVerify: false,
  facilitatorSettle: false,
  anonymousFlagsUsed: 0,
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
  kind_id: 3,
  kind: 'lantern',
  birth_revision: 1,
  current_revision: state.kindRevision,
  withdrawn_at: id === 41
    ? (state.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
    : (state.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null),
  created_at: '2026-08-11T00:00:00.000Z',
})

function reset(patch: Partial<FakeState> = {}) {
  state = { ...initialState(), ...patch }
}

function setActor(id: number, handle: string) {
  state = { ...state, actorId: id, actorHandle: handle }
}

function recordPayment(query: string, params: unknown[]) {
  if (!/insert\s+into\s+payment_uses/i.test(query)) return
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
  if (q.includes('agreement_actions_today = agreement_actions_today + 1'))
    return state.quota.agreements ? [{ id: state.actorId }] : []

  if (q.includes('with recursive place_tree')) return [placeRow(1, null), placeRow(2, 1)]
  if (q.includes('insert into places')) return [placeRow(3, 2)]
  if (q.includes('from places') && q.includes('parent_id') && !q.includes('update things')) {
    return [placeRow(2, 1)]
  }
  if (q.includes('from places') && (q.includes('where p.id') || q.includes('where id'))) return [placeRow(2, 1)]
  if (q.includes('update places set'))
    return state.actorId === state.placeOwnerId ? [{ ...placeRow(2, 1), description: 'changed by its owner' }] : []

  if (q.includes('insert into kinds') || q.includes('insert into kind_revisions') || q.includes('update kinds'))
    return [{ ...kindRow(), revision: state.kindRevision + 1 }]
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
      const beforeId = q.includes('n.id < coalesce') && params[1] != null ? Number(params[1]) : null
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

  if (q.includes('insert into agreements')) return [{
    id: 61, body: 'we keep the square open', created_by: state.actorHandle, status: 'open',
  }]
  if (q.includes('insert into agreement_parties')) return []
  if (q.includes('insert into agreement_signatures')) return [{
    agreement_id: 61, handle: state.actorHandle, signed_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('from agreements')) return [{
    id: 61,
    body: 'we keep the square open',
    parties: ['tiny-lantern', 'neighbor'],
    signatures: ['tiny-lantern'],
    open: true,
    created_at: '2026-08-11T00:00:00.000Z',
  }]
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
    return [{ id: state.offer.id, status: 'claimed', new_owner: state.actorHandle }]
  }
  if (q.includes('from transfer_offers') && !q.includes('from things thing') && !q.includes('update things')) {
    const directOnlyWorld = q.includes("o.channel = 'direct'") && state.offer.channel === 'world'
    return state.offer.status === 'open' && !directOnlyWorld ? [{
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
  if (q.includes('update things set'))
    return state.actorId === state.thingOwnerId && !state.thingWithdrawn ? [thingRow()] : []
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

  if (q.includes('from residents')) return [residentRow(), {
    ...residentRow(), id: 8, handle: 'neighbor', joined_at: '2026-08-11T00:01:00.000Z',
  }]
  if (q.includes('from events') && q.includes('count(')) return [{ n: 0 }]
  if (q.includes('from events') && state.scenario === 'event pagination') {
    const beforeId = q.includes('id < coalesce') ? Number(params[1]) : null
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
    const result = body.method === 'eth_getTransactionReceipt'
      ? {
        status: '0x1',
        blockHash: '0x' + 'bb'.repeat(32),
        blockNumber: '0x100',
        logs: [{
          address: USDC,
          topics: [TRANSFER_TOPIC, pad32(state.chainFrom), pad32(state.chainTo)],
          data: '0x1e8480',
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

test('registration returns a bearer secret once and rotation kills the stored old hash', async () => {
  reset({ scenario: 'identity' })
  const registered = await app.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: ' Tiny-Lantern ', model: 'openai-codex' }),
  })
  assert.equal(registered.status, 201)
  const first = await registered.json() as { handle: string; secret: string; warning: string }
  assert.equal(first.handle, 'tiny-lantern')
  assert.match(first.secret, /^1f3d9_sk_[0-9a-f]{48}$/)
  assert.match(first.warning, /once|save/i)
  assert.equal(JSON.stringify(sqlCalls()).includes(first.secret), false)
  const registrationInsert = sqlCalls().find(call => /insert\s+into\s+residents\b/i.test(call.query ?? ''))
  assert.match(
    registrationInsert?.query ?? '',
    /jsonb_build_object\(\s*'resident_id',\s*id,\s*'model',\s*\$\d+::text\s*\)/i,
    'registration event parameters must have an explicit PostgreSQL type',
  )

  const rotated = await app.request('/api/rotate', { method: 'POST', headers: authHeaders() })
  assert.equal(rotated.status, 200)
  const second = await rotated.json() as { handle: string; secret: string }
  assert.equal(second.handle, 'tiny-lantern')
  assert.match(second.secret, /^1f3d9_sk_[0-9a-f]{48}$/)
  assert.notEqual(second.secret, first.secret)
  assert.equal(JSON.stringify(sqlCalls()).includes(second.secret), false)
})

test('registration IP throttling ignores spoofed leftmost forwarding hops', async () => {
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

  await register('edge-one', '198.51.100.1, 203.0.113.9', '192.0.2.7')
  await register('edge-two', '198.51.100.2, 203.0.113.10', '192.0.2.7')
  const trustedHashes = sqlCalls()
    .filter(call => /count\(\*\)[\s\S]*from\s+reg_log/i.test(call.query ?? ''))
    .map(call => call.params?.[0])
  assert.equal(trustedHashes.length, 2)
  assert.equal(trustedHashes[0], trustedHashes[1])

  state = { ...state, calls: [] }
  await register('proxy-one', '198.51.100.1, 203.0.113.20')
  await register('proxy-two', '198.51.100.2, 203.0.113.20')
  const proxyHashes = sqlCalls()
    .filter(call => /count\(\*\)[\s\S]*from\s+reg_log/i.test(call.query ?? ''))
    .map(call => call.params?.[0])
  assert.equal(proxyHashes.length, 2)
  assert.equal(proxyHashes[0], proxyHashes[1])
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
  assert.equal(firstBody.notes[0]?.id, 6)
  assert.equal(firstBody.notes.at(-1)?.id, 205)
  assert.deepEqual(firstBody.notes_page, { has_more: true, next_before_note_id: 6 })

  reset({ scenario: 'busy place' })
  const older = await app.request('/api/place/2?before_note_id=6&note_limit=10')
  assert.equal(older.status, 200)
  const olderBody = await older.json() as {
    notes: Array<{ id: number }>
    notes_page: { has_more: boolean; next_before_note_id: number | null }
  }
  assert.deepEqual(olderBody.notes.map(note => note.id), [1, 2, 3, 4, 5])
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
  reset({ scenario: 'kind revision', chainFrom: SELLER_WALLET, chainTo: TREASURY })
  const revised = await app.request('/api/kind/3/revise', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      description: 'a small dependable light', traits: ['glowing'], recipe: [],
      payer_wallet: SELLER_WALLET, fee_tx_hash: TX1,
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
      payer_wallet: SELLER_WALLET, fee_tx_hash: TX1,
    }),
  })
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /duplicate|unique/i)
  assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)
  assert.equal(inserted('kinds'), 0)
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

  const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
  assert.equal(signed.status, 200)

  const publicRecord = await app.request('/api/agreements?party=tiny-lantern&open=true')
  assert.equal(publicRecord.status, 200)
  const body = await publicRecord.json() as { agreements: { body: string; signatures: string[]; open: boolean }[] }
  assert.equal(body.agreements[0]?.body, 'we keep the square open')
  assert.deepEqual(body.agreements[0]?.signatures, ['tiny-lantern'])
  assert.equal(body.agreements[0]?.open, true)
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

test('a reserved buyer can retry with direct proof and ownership closes atomically', async () => {
  reset({
    scenario: 'direct sale',
    chainFrom: BUYER_WALLET,
    chainTo: SELLER_WALLET,
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
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET, tx_hash: TX1 }),
  })
  assert.equal(settled.status, 200)
  const body = await settled.json() as { offer: { status: string }; transfer: { to: string } }
  assert.equal(body.offer.status, 'claimed')
  assert.equal(body.transfer.to, 'neighbor')
  assert.ok(sqlCalls().some(call =>
    /payment_uses/i.test(call.query ?? '') && /transfer_offers/i.test(call.query ?? '') && /update\s+things/i.test(call.query ?? '')))
})

test('payment cannot create its own window or come from a different buyer wallet', async () => {
  reset({
    scenario: 'sale wallet binding', chainFrom: BUYER_WALLET, chainTo: SELLER_WALLET,
    chainAgeSeconds: 0, offer: { id: 90, status: 'open', reservedUntil: null },
  })
  setActor(8, 'neighbor')
  const premature = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET, tx_hash: TX1 }),
  })
  assert.equal(premature.status, 409)
  assert.equal(state.offer.reservedUntil, null)
  assert.equal(networkCalled('base-rpc.test'), false)

  const reservation = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(reservation.status, 402)
  state = { ...state, chainFrom: STRANGER_WALLET, calls: [] }

  const mismatched = await app.request('/api/transfer/90/claim', {
    method: 'POST', headers: authHeaders(OTHER_SECRET),
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET, tx_hash: TX2 }),
  })
  assert.equal(mismatched.status, 402)
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
    headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
  })
  assert.equal(mismatched.status, 402)
  assert.equal(networkCalled('/settle'), true)
  assert.equal(inserted('sale_payments'), 0)
  assert.equal(state.offer.status, 'open')
})

test('frontier x402 settles before creation and one tx proof cannot pay twice', async () => {
  reset({
    scenario: 'paid claims', facilitatorVerify: true, facilitatorSettle: true,
    chainFrom: SELLER_WALLET, chainTo: TREASURY,
  })
  const frontier = await app.request('/api/place', {
    method: 'POST',
    headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
    body: JSON.stringify({ parent_id: null, name: 'Second Continent', description: 'frontier' }),
  })
  assert.equal(frontier.status, 201)
  const verifyIndex = state.calls.findIndex(call => call.url.includes('/verify'))
  const settleIndex = state.calls.findIndex(call => call.url.includes('/settle'))
  const insertIndex = state.calls.findIndex(call => /insert\s+into\s+places/i.test(call.query ?? ''))
  assert.ok(verifyIndex >= 0 && settleIndex > verifyIndex && insertIndex > settleIndex)

  const first = await app.request('/api/kind', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      name: 'lantern', description: 'a light', traits: [], recipe: [],
      payer_wallet: SELLER_WALLET, fee_tx_hash: TX1,
    }),
  })
  assert.equal(first.status, 201)

  const replay = await app.request('/api/place', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      parent_id: null, name: 'Replay Continent', description: 'must fail',
      payer_wallet: SELLER_WALLET, fee_tx_hash: TX_CASE_UPPER,
    }),
  })
  assert.equal(replay.status, 409)
  assert.match(JSON.stringify(await replay.json()), /used|payment|proof/i)
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as {
    result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }
  }
  assert.deepEqual(listBody.result.tools.map(tool => tool.name), [
    'register', 'look', 'found', 'make', 'act', 'laws', 'home', 'withdraw',
    'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'transfer',
    'agree', 'sign', 'say', 'me', 'moderate',
  ])
  assert.equal(listBody.result.tools.every(tool => !('secret' in (tool.inputSchema.properties ?? {}))), true)
  const transferTool = listBody.result.tools.find(tool => tool.name === 'transfer')
  assert.ok(transferTool?.inputSchema.properties && 'buyer_wallet' in transferTool.inputSchema.properties)

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
  const payload = await snapshot.json() as { events: { kind: string }[] }
  assert.deepEqual(payload.events.map(event => event.kind), ['place_created', 'sale', 'transfer_cancel'])
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
  assert.match(eventRead?.query ?? '', /id\s*<\s*coalesce\(\$2::bigint,\s*2147483648\)/i)
  assert.match(eventRead?.query ?? '', /limit\s+\$3/i)

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

test('/api/me refreshes presence after observation resolves due effects', async () => {
  reset({ scenario: 'me timer refresh', scheduledLabelAt: Date.now() - 1 })

  const response = await app.request('/api/me', { headers: authHeaders() })
  assert.equal(response.status, 200)

  const presenceReads = sqlCalls().filter(call =>
    (call.query ?? '').replace(/\s+/g, ' ').toLowerCase()
      .includes('with first_owned as'))
  assert.equal(presenceReads.length, 2, JSON.stringify(sqlCalls().map(call => call.query)))
})
