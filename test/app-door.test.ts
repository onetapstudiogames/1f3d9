import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb',
  TREASURY_ADDRESS: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  PUBLIC_ORIGIN: 'https://1f3d9.com',
  BASE_RPC_URL: 'https://base-rpc.test',
  FACILITATOR_URL: 'https://facilitator.test',
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
  IDENTITY_RECOVERY_ENABLED: 'true',
  IDENTITY_ROTATION_ENABLED: 'true',
  CODING_IDENTITY_DOORS_ENABLED: 'true',
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_WEBHOOK_ID: 'test-webhook-id',
})

const {
  APP_SAFETY_BLOCK_GUIDANCE,
  FRONT_DOOR_MAX_BYTES,
  TOOL_DESCRIPTION_MAX_CHARACTERS,
} = await import('../src/city-facts.ts')
const {
  APP_BANNED_TEXT,
  APP_DROPPED_TOOLS,
  APP_FRONT_DOOR_SECTIONS,
} = await import('../src/door-profile.ts')
const { appMeAnswer, appOfficialFacts } = await import('../src/app-door-outputs.ts')
const { mcp } = await import('../src/mcp.ts')
const { REFERENCE_SECTION_SLUGS } = await import('../src/door.ts')
const { default: app, setFrontDoorActivityReaderForTests } = await import('../src/index.ts')

setFrontDoorActivityReaderForTests(async () => [
  ...Array.from({ length: 4 }, (_, index) => ({
    at: '2026-09-11T23:59:59.999Z', actor: `${index}${'a'.repeat(31)}`, kind: 'world_sale',
  })),
  { at: '2026-09-11T23:59:59.999Z', actor: 'buyer-bot', kind: 'note' },
  { at: '2026-09-11T23:59:59.999Z', actor: 'quiet-maker', kind: 'thing_created' },
])
test.after(() => setFrontDoorActivityReaderForTests(null))

const APP_TOOLS = Object.freeze([
  'front_door', 'help', 'official_facts', 'physics', 'search', 'changes', 'look', 'browse',
  'drawing', 'drawing_history', 'credit_preflight', 'found', 'place_edit', 'coin_trait',
  'invent_kind', 'revise_kind', 'make', 'thing_edit', 'thing_upgrade', 'draw_self', 'act', 'laws',
  'home', 'withdraw', 'transfer', 'agree', 'open_agreement_accession', 'sign', 'say', 'ping',
  'wait_here', 'read_here', 'flag', 'later_holder_items', 'mark_for_later', 'me',
])

// The one shared pattern from src/door-profile.ts, global so a report names every hit.
const BANNED = new RegExp(APP_BANNED_TEXT.source, 'giu')

function bannedHits(label: string, text: string): string[] {
  return [...text.matchAll(BANNED)].map(match => (
    `${label}: ...${text.slice(Math.max(0, match.index! - 40), match.index! + 30).replace(/\s+/gu, ' ')}...`
  ))
}

interface Tool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown> & { properties: Record<string, { enum?: unknown[]; description?: string }> }
  annotations: Record<string, unknown>
}

type Door = 'key' | 'connect' | 'app'

async function rpc(door: Door, method: string, params?: unknown, backing: Hono = new Hono(), headers: Record<string, string> = {}) {
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, backing, { door, authenticateLegacyCatalog: async () => true }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

async function toolsOn(door: Door): Promise<Tool[]> {
  const { body } = await rpc(door, 'tools/list')
  return body.result.tools as Tool[]
}

async function instructionsOn(door: Door): Promise<string> {
  const { body } = await rpc(door, 'initialize')
  return body.result.instructions as string
}

/** One tool call through the real /mcp/app route of the city app. */
async function appCall(name: string, args: Record<string, unknown> = {}) {
  const response = await app.request('/mcp/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> }
}

async function appText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const { body } = await appCall(name, args)
  assert.equal(body.result?.isError, false, JSON.stringify(body))
  return body.result.content[0].text as string
}

const count = (text: string, part: string) => text.split(part).length - 1

test('the app door lists exactly the 36 tools the owner kept', async () => {
  const tools = await toolsOn('app')
  assert.deepEqual(tools.map(tool => tool.name), APP_TOOLS)
  assert.equal(tools.length, 36)
  const viaRoute = await app.request('/mcp/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const routeTools = (await viaRoute.json() as { result: { tools: Tool[] } }).result.tools
  assert.deepEqual(routeTools.map(tool => tool.name), APP_TOOLS, 'anonymous callers see the same list')
})

test('the other doors keep their counts and the safety sentence exactly once', async () => {
  assert.equal((await toolsOn('key')).length, 44)
  assert.equal((await toolsOn('connect')).length, 43)
  for (const door of ['key', 'connect'] as const) {
    for (const tool of await toolsOn(door)) {
      assert.equal(count(tool.description, APP_SAFETY_BLOCK_GUIDANCE), 1, `${door} ${tool.name}`)
    }
    assert.equal(count(await instructionsOn(door), APP_SAFETY_BLOCK_GUIDANCE), 1, door)
  }
  for (const tool of await toolsOn('app')) {
    assert.equal(count(tool.description, APP_SAFETY_BLOCK_GUIDANCE), 0, `app ${tool.name}`)
    assert.ok(tool.description.endsWith(' Lost? Call front_door.'), tool.name)
    assert.ok(tool.description.length <= TOOL_DESCRIPTION_MAX_CHARACTERS, tool.name)
    assert.doesNotMatch(tool.description, /\{\{|  /u, tool.name)
  }
  assert.equal(count(await instructionsOn('app'), APP_SAFETY_BLOCK_GUIDANCE), 0)
})

test('every dropped tool is refused by name on the app door, though the other doors still have it', async () => {
  for (const name of APP_DROPPED_TOOLS) {
    const { body } = await rpc('app', 'tools/call', { name, arguments: {} })
    assert.equal(body.error?.code, -32602, name)
    assert.equal(body.error.message, `no such tool: ${name}; call tools/list and use one advertised tool name`)
    assert.equal(Object.hasOwn(body.error.data, 'front_door'), false, 'no web address')
    assert.equal(Object.hasOwn(body.error.data, 'all_tools'), false, 'no catalog pointer')
    const viaRoute = await appCall(name)
    assert.equal(viaRoute.body.error?.code, -32602, `${name} through the route`)
    const onConnect = await rpc('connect', 'tools/call', { name, arguments: {} })
    assert.equal(onConnect.body.error, undefined, `${name} still exists on /mcp/connect`)
  }
  const moderate = await rpc('app', 'tools/call', {
    name: 'moderate', arguments: { action: 'remove', target_type: 'note', target_id: 1, reason: 'x' },
  })
  assert.match(moderate.body.result.content[0].text, /Moderation is unavailable through hosted chat/u)
})

test('transfer offers, the treasury view, and money arguments are refused by the app schema', async () => {
  const tools = await toolsOn('app')
  const transfer = tools.find(tool => tool.name === 'transfer')!
  assert.deepEqual(transfer.inputSchema.properties.action!.enum, ['give'])
  for (const key of ['price_usdc', 'seller_wallet', 'offer_id', 'buyer_wallet']) {
    assert.equal(Object.hasOwn(transfer.inputSchema.properties, key), false, key)
  }
  const browse = tools.find(tool => tool.name === 'browse')!
  assert.equal(browse.inputSchema.properties.view!.enum!.includes('treasury'), false)
  const frontDoor = tools.find(tool => tool.name === 'front_door')!
  assert.deepEqual(frontDoor.inputSchema.properties.section!.enum, [...APP_FRONT_DOOR_SECTIONS])

  const offer = await rpc('app', 'tools/call', { name: 'transfer', arguments: { action: 'offer', type: 'thing', id: 1 } })
  assert.match(offer.body.result.content[0].text, /Unsupported action value for transfer\. Use one of: give\./u)
  const treasury = await rpc('app', 'tools/call', { name: 'browse', arguments: { view: 'treasury' } })
  assert.match(treasury.body.result.content[0].text, /Unsupported view value for browse/u)
  const wallet = await rpc('app', 'tools/call', { name: 'transfer', arguments: { type: 'thing', id: 1, to_handle: 'abc', buyer_wallet: 'x' } })
  assert.match(wallet.body.result.content[0].text, /Unsupported tool argument: buyer_wallet/u)
  const money = await rpc('app', 'tools/call', { name: 'front_door', arguments: { section: 'money' } })
  assert.match(money.body.result.content[0].text, /Unsupported section value for front_door/u)
})

test('no description, schema, or server instruction on the app door names money rails or app blocks', async () => {
  const hits: string[] = []
  const droppedNames = new RegExp(`\\b(?:${APP_DROPPED_TOOLS.join('|')})\\b`, 'u')
  for (const tool of await toolsOn('app')) {
    hits.push(...bannedHits(`${tool.name} description`, tool.description))
    hits.push(...bannedHits(`${tool.name} schema`, JSON.stringify(tool.inputSchema)))
    hits.push(...bannedHits(`${tool.name} title`, tool.title))
    assert.doesNotMatch(tool.description, droppedNames, `${tool.name} names a dropped tool`)
    for (const match of tool.description.matchAll(/front_door sections? ([a-z0-9, -]+?)(?:\.|$)/gu)) {
      for (const slug of match[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/u)) {
        assert.ok((APP_FRONT_DOOR_SECTIONS as readonly string[]).includes(slug.trim()), `${tool.name} points at ${slug}`)
      }
    }
  }
  const instructions = await instructionsOn('app')
  hits.push(...bannedHits('instructions', instructions))
  assert.deepEqual(hits, [])
  assert.doesNotMatch(instructions, /https?:\/\/|\/api\/tools|reference\.txt/u)
  assert.ok(instructions.endsWith('Lost? Call front_door.'))
  assert.match(instructions, /going home cannot be blocked/u)
  assert.match(instructions, /each cost one fee credit; call credit_preflight first\./u)
})

test('the app front door, its sections, help, and official facts carry no money rail or app-block wording', async () => {
  const hits: string[] = []
  const frontDoor = await appText('front_door')
  hits.push(...bannedHits('front_door', frontDoor))
  assert.ok(Buffer.byteLength(frontDoor, 'utf8') < FRONT_DOOR_MAX_BYTES)
  assert.match(frontDoor, /This hosted `\/mcp\/app` door lists 36 tools/u)
  assert.match(frontDoor, /FEE CREDIT\n----------\n\nThese actions each cost one fee credit: frontier, kind_invention, kind_revision, place_rename, place_retire, place_restore\./u)
  assert.match(frontDoor, /Use exactly https:\/\/1f3d9\.com\/mcp\/app\./u)
  assert.doesNotMatch(frontDoor, /\/api\/tools|reference\.txt|action-requests|MONEY\n|\/window/u)
  assert.match(frontDoor, /quiet-maker/u)
  assert.doesNotMatch(frontDoor, /buyer-bot|world market/u)
  for (const section of APP_FRONT_DOOR_SECTIONS) {
    assert.ok(REFERENCE_SECTION_SLUGS.includes(section), section)
    hits.push(...bannedHits(`section ${section}`, await appText('front_door', { section })))
  }
  const help = await appText('help')
  hits.push(...bannedHits('help', help))
  assert.doesNotMatch(help, /buy_credit|credit_gift|1f3ea|\/api\/tools|\/window|abilities\.txt/u)
  const official = await appText('official_facts')
  hits.push(...bannedHits('official_facts', official))
  const facts = JSON.parse(official) as Record<string, unknown>
  for (const key of ['treasury', 'network', 'usdc_contract', 'claim_fee_usdc', 'market', 'market_bridge']) {
    assert.equal(Object.hasOwn(facts, key), false, key)
  }
  assert.match(String(facts.statement), /no 1F3D9 token/u)
  assert.match(String(facts.statement), /cannot be sold or redeemed/u)
  assert.deepEqual(Object.keys(facts.city_fee_credit as object), ['eligible_actions', 'request_id', 'limits'])
  assert.deepEqual(hits, [])
})

test('the web and the other doors keep the full front door, help, and official facts', async () => {
  const web = await (await app.request('/')).text()
  assert.match(web, /fund a resident's fee credit at \/buy/u)
  assert.equal(count(web, APP_SAFETY_BLOCK_GUIDANCE), 1)
  assert.match(web, /\nMONEY\n-----\n/u)
  const viaConnect = new Hono()
  viaConnect.post('/mcp/connect', c => mcp(c, app, { door: 'connect' }))
  const connected = await viaConnect.request('/mcp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'front_door', arguments: {} } }),
  })
  const connectText = (await connected.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text
  assert.equal(connectText, web)
  const help = await (await app.request('/api/help')).json() as { doors: string[] }
  assert.ok(help.doors.some(line => line.startsWith('Buy or gift fee credit:')))
  const official = await (await app.request('/api/official')).json() as Record<string, unknown>
  assert.ok(Object.hasOwn(official, 'treasury'))
  const money = await app.request('/reference/money.txt')
  assert.equal(money.status, 200)
})

test('app door hints are explicit booleans, look is read-only there, and home adds only on every door', async () => {
  const appTools = await toolsOn('app')
  for (const tool of appTools) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} ${hint}`)
    }
    if (tool.annotations.readOnlyHint === true) assert.equal(tool.annotations.destructiveHint, false, tool.name)
  }
  const look = appTools.find(tool => tool.name === 'look')!
  assert.equal(look.annotations.readOnlyHint, true)
  assert.equal(look.annotations.destructiveHint, false)
  assert.match(look.description, /On this door look only reads; it publishes no looking cue\./u)
  assert.doesNotMatch(look.description, /Annotation:/u)
  for (const door of ['key', 'connect'] as const) {
    const tools = await toolsOn(door)
    assert.equal(tools.find(tool => tool.name === 'look')!.annotations.readOnlyHint, false, door)
    assert.equal(tools.find(tool => tool.name === 'home')!.annotations.destructiveHint, false, door)
  }
  assert.equal(appTools.find(tool => tool.name === 'home')!.annotations.destructiveHint, false)
})

test('the justification doc lists every app tool once with the hints the door serves', async () => {
  const doc = readFileSync(new URL('../docs/features/APP_DOOR.md', import.meta.url), 'utf8')
  const rows = [...doc.matchAll(/^\| `([a-z_]+)` \| (true|false) \| (true|false) \| (true|false) \| (true|false) \| ([^|\n]+) \|$/gmu)]
  assert.deepEqual(rows.map(row => row[1]).sort(), [...APP_TOOLS].sort())
  const tools = new Map((await toolsOn('app')).map(tool => [tool.name, tool]))
  for (const row of rows) {
    const annotations = tools.get(row[1]!)!.annotations
    assert.deepEqual(
      [row[2], row[3], row[4], row[5]].map(value => value === 'true'),
      [annotations.readOnlyHint, annotations.destructiveHint, annotations.idempotentHint, annotations.openWorldHint],
      row[1],
    )
    assert.ok(row[6]!.trim().length > 10, `${row[1]} has a reason`)
  }
  const dashes = new RegExp('[' + String.fromCodePoint(0x2013, 0x2014) + ']', 'u')
  assert.doesNotMatch(doc, dashes, 'no en or em dash')
})

test('the app door records no looking cue and never forwards a payment proof', async () => {
  const seen: Array<{ path: string; payment: string | null }> = []
  const backing = new Hono()
  backing.all('*', c => {
    seen.push({ path: c.req.path, payment: c.req.header('x-payment') ?? null })
    return c.json({ ok: true })
  })
  await rpc('app', 'tools/call', { name: 'look', arguments: {} }, backing)
  assert.deepEqual(seen.map(entry => entry.path), ['/api/map'])
  seen.length = 0
  await rpc('connect', 'tools/call', { name: 'look', arguments: {} }, backing)
  assert.ok(seen.some(entry => entry.path === '/api/internal/mcp-looking'), 'the hosted connect door keeps the cue')
  seen.length = 0
  await rpc('app', 'tools/call', { name: 'found', arguments: { parent_id: null, name: 'x' } }, backing, { 'X-PAYMENT': 'proof' })
  assert.deepEqual(seen, [{ path: '/api/place', payment: null }])
  seen.length = 0
  await rpc('connect', 'tools/call', { name: 'found', arguments: { parent_id: null, name: 'x' } }, backing, { 'X-PAYMENT': 'proof' })
  assert.deepEqual(seen, [{ path: '/api/place', payment: 'proof' }])
})

test('an unsigned app call names the app door and its own protected resource', async () => {
  const response = await app.request('/mcp/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} } }),
  })
  assert.equal(response.status, 401)
  assert.match(
    response.headers.get('www-authenticate') ?? '',
    /resource_metadata="https:\/\/1f3d9\.com\/\.well-known\/oauth-protected-resource\/mcp\/app"/u,
  )
  const body = await response.json() as { result: { content: Array<{ text: string }> } }
  assert.match(body.result.content[0]!.text, /You are connected at https:\/\/1f3d9\.com\/mcp\/app without a completed 1F3D9 sign-in/u)
  assert.equal((await app.request('/mcp/app')).status, 405)
})

const FULL_ME = Object.freeze({
  pending_pings: { total: 0, senders: [], receipts: [], has_more: false, next_pending_before_ping_id: null },
  help: '/api/help',
  attention: [],
  since_last_visit: {
    city_updates: { count: 2, href: '/changelog' },
    tools_changed: 'The city\'s tool list last changed.',
    fee_credit_received: {
      accepted_gifts: { amount: '1.000000', amount_units: '1000000', record_link: 'city_fee_credit.receipts' },
      settled_purchases: { amount: '2.000000', amount_units: '2000000', record_link: 'city_fee_credit.receipts' },
      founder_issues: { amount: '3.000000', amount_units: '3000000', sentence: 'The founder gave you 3.000000 fee credit.', receipts: [], record_link: 'city_fee_credit.receipts', page: { has_more: false, next_before_credit_id: null } },
      pending_gifts: { count: 1, record_link: 'city_fee_credit.pending_gifts', items: [{ sentence: 'A human bought you 1.000000 fee credit.' }], page: { has_more: false, next_before_gift_id: null } },
    },
    around_you: {},
    last_visit_at: '2026-10-01T00:00:00.000Z',
  },
  front_door_tool: 'front_door',
  front_door: 'https://1f3d9.com/',
  if_blocked: APP_SAFETY_BLOCK_GUIDANCE,
  handle: 'reviewer',
  offers: [{ id: 1, price_usdc: 5, status: 'open' }],
  city_fee_credit: {
    resident_id: 7,
    balance: '4.000000',
    balance_usdc: '4.000000',
    balance_units: '4000000',
    history: [],
    receipts: [
      { id: '5', kind: 'spend', amount: '-1.000000', amount_units: '-1000000', operation: 'frontier', request_id: 'r-1', target_key: 'frontier:9', related_spend_id: null, reason: null, created_at: 't', purchase_kind: null, gift_id: null, source_key: null },
      { id: '4', kind: 'purchase', amount: '2.000000', amount_units: '2000000', operation: 'credit_purchase', request_id: null, target_key: null, related_spend_id: null, reason: null, created_at: 't', purchase_kind: 'x402', gift_id: null, source_key: null },
      { id: '3', kind: 'gift_pending', amount: '0.000000', amount_units: '0', operation: null, request_id: null, target_key: null, related_spend_id: null, reason: null, created_at: 't', purchase_kind: null, gift_id: 'city_gift_00000000000000000000000000000001', source_key: null },
      { id: '2', kind: 'founder_issue', amount: '3.000000', amount_units: '3000000', operation: null, request_id: null, target_key: null, related_spend_id: null, reason: 'review credit', created_at: 't', purchase_kind: null, gift_id: null, source_key: 'openai-review-2026-10-09' },
    ],
    page: { has_more: false, next_before_credit_id: null },
    pending_gifts: [{ gift_id: 'city_gift_00000000000000000000000000000001' }],
  },
  pages: { offers: { has_more: false }, pending_gifts: { has_more: false }, places: { has_more: false } },
})

test('the app me answer keeps fee credit held, spends, and credit received, and nothing about buying', () => {
  const answer = appMeAnswer(FULL_ME) as Record<string, any>
  const text = JSON.stringify(answer)
  assert.deepEqual(bannedHits('me', text), [])
  assert.doesNotMatch(text, /gift|offers|if_blocked|\/api\/help|\/changelog|https?:/u)
  assert.equal(answer.city_fee_credit.balance, '4.000000')
  assert.deepEqual(answer.city_fee_credit.receipts.map((entry: { kind: string }) => entry.kind), ['spend', 'received', 'founder_issue'])
  assert.equal(answer.city_fee_credit.receipts[0].operation, 'frontier')
  assert.equal(answer.city_fee_credit.receipts[1].operation, null)
  assert.equal(answer.since_last_visit.fee_credit_received.amount, '6.000000')
  assert.equal(answer.since_last_visit.city_updates.count, 2)
  assert.equal(Object.hasOwn(answer.since_last_visit, 'tools_changed'), false)
  assert.deepEqual(Object.keys(answer.pages), ['places'])
})

test('the app official facts keep fee credit rules and drop the rails', () => {
  const facts = appOfficialFacts({
    domain: 'https://1f3d9.com', treasury: '0x1', network: 'base', usdc_contract: '0x2', claim_fee_usdc: 1,
    market: 'https://1f3ea.com', market_bridge: {}, statement: 'x', enforced_limits: [],
    city_fee_credit: { unit_usdc: '1.000000', eligible_actions: ['frontier'], request_id: 'rule', funding: 'x402', gifts: 'g', receipts: 'r', limits: 'l' },
    paid_actions: ['frontier'],
  }) as Record<string, any>
  assert.deepEqual(Object.keys(facts).sort(), ['city_fee_credit', 'domain', 'enforced_limits', 'paid_actions', 'statement'])
  assert.deepEqual(bannedHits('official', JSON.stringify(facts)), [])
})
