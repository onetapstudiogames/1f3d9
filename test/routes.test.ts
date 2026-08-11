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
  status: 'open' | 'canceled' | 'claimed'
  reservedAt?: string | null
  reservedUntil: string | null
  buyerWallet?: string | null
}
interface FakeState {
  scenario: string
  calls: DbCall[]
  authValid: boolean
  actorId: number
  actorHandle: string
  placeOwnerId: number
  openToBuilding: boolean
  openToThings: boolean
  openToNotes: boolean
  quota: { things: boolean; notes: boolean; agreements: boolean }
  thingOwnerId: number
  thingWithdrawn: boolean
  kindOwnerId: number
  kindRevision: number
  traitHasRecipe: boolean
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
  placeOwnerId: 7,
  openToBuilding: false,
  openToThings: false,
  openToNotes: false,
  quota: { things: true, notes: true, agreements: true },
  thingOwnerId: 7,
  thingWithdrawn: false,
  kindOwnerId: 7,
  kindRevision: 1,
  traitHasRecipe: false,
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
  things_today: state.quota.things ? 0 : 10,
  notes_today: state.quota.notes ? 0 : 20,
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
  things: 0,
  notes: 0,
  created_at: '2026-08-11T00:00:00.000Z',
})

const kindRow = () => ({
  id: 3,
  name: 'lantern',
  owner_id: state.kindOwnerId,
  owner: 'tiny-lantern',
  revision: state.kindRevision,
  description: state.kindRevision === 1 ? 'a small light' : 'a small dependable light',
  traits: ['glowing'],
  recipe: [{ kind: 'glass', quantity: 1 }],
  created_at: '2026-08-11T00:00:00.000Z',
})

const thingRow = () => ({
  id: 41,
  place_id: 2,
  name: 'porch lantern',
  body: 'warm light',
  owner_id: state.thingOwnerId,
  owner: state.thingOwnerId === state.actorId ? state.actorHandle : 'founder',
  kind_id: 3,
  kind: 'lantern',
  birth_revision: 1,
  current_revision: state.kindRevision,
  withdrawn_at: state.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null,
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

  if (q.includes('things_today = things_today + 1') && q.includes('insert into things'))
    return state.quota.things ? [thingRow()] : []
  if (q.includes('things_today = things_today + 1')) return state.quota.things ? [{ id: state.actorId }] : []
  if (q.includes('notes_today = notes_today + 1')) return state.quota.notes ? [{ id: state.actorId }] : []
  if (q.includes('agreement_actions_today = agreement_actions_today + 1'))
    return state.quota.agreements ? [{ id: state.actorId }] : []

  if (q.includes('with recursive') && q.includes('places')) return [placeRow(1, null), placeRow(2, 1)]
  if (q.includes('insert into places')) return [placeRow(3, 2)]
  if (q.includes('from places') && q.includes('parent_id')) return [placeRow(2, 1)]
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
  if (q.includes('from traits')) return [{
    id: 4, name: 'glowing', description: 'gives off light', recipe: null, mechanical: false, coiner: 'founder',
  }]

  if (q.includes('insert into notes')) return [{
    id: 51, place_id: 2, author: state.actorHandle, body: 'hello from the square',
    created_at: '2026-08-11T00:00:00.000Z',
  }]
  if (q.includes('from notes')) return []

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
  if (q.includes('from transfer_offers')) return state.offer.status === 'open' ? [{
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

  if (q.includes('insert into things')) return [thingRow()]
  if (q.includes('update things set'))
    return state.actorId === state.thingOwnerId ? [thingRow()] : []
  if (q.includes('from things')) {
    if (state.thingWithdrawn && q.includes('withdrawn_at is null')) return []
    return [thingRow()]
  }

  if (q.includes('from residents')) return [residentRow(), {
    ...residentRow(), id: 8, handle: 'neighbor', joined_at: '2026-08-11T00:01:00.000Z',
  }]
  if (q.includes('from events') && q.includes('count(')) return [{ n: 0 }]
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
    if (Array.isArray(value)) return 1009
    if (value != null && typeof value === 'object') return 3802
    return 25
  }
  const encode = (value: unknown) => {
    if (value === null) return null
    if (typeof value === 'boolean') return value ? 't' : 'f'
    if (Array.isArray(value)) return pgArray(value)
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
        logs: [{
          address: USDC,
          topics: [TRANSFER_TOPIC, pad32(state.chainFrom), pad32(state.chainTo)],
          data: '0x1e8480',
        }],
      }
      : body.method === 'eth_getBlockByHash'
        ? { timestamp: '0x' + Math.floor((Date.now() - state.chainAgeSeconds * 1000) / 1000).toString(16) }
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
      name: 'glowing', description: 'gives off light', recipe: [{ effect: 'label', value: 'lit' }],
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
    /things_today\s*=\s*things_today\s*\+\s*1/i.test(call.query ?? '') &&
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
  assert.equal(gift.status, 200)

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
    'register', 'look', 'found', 'make', 'transfer', 'agree', 'sign', 'say', 'me',
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
