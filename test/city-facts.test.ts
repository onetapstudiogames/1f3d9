import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import {
  ACT_TOOL_ACTIONS,
  CITY_FEE_RAILS_LINE,
  CITY_LIMIT_LINES,
  CITY_POSITIONING_LINE,
  CITY_ROUTE_CATALOG,
  CITY_TOOL_CATALOG,
  FULL_TOOL_CATALOG_PATH,
  FRONT_DOOR_MAX_BYTES,
  MARKET_POSITIONING_LINE,
  PAID_ACTIONS,
  OTHER_BASIC_ACTION_TOOLS,
  SKILL_VERSION_RECOMMENDED,
  TOOL_DESCRIPTION_MAX_CHARACTERS,
  duplicateParagraphs,
  mountCityToolCatalogRoute,
} from '../src/city-facts.ts'
import { HANDLE_MAX_CHARACTERS, HANDLE_MIN_CHARACTERS } from '../src/core-primitives.ts'
import { THING_BODY_MAX_BYTES } from '../src/world-limits.ts'
import { FRONTDOOR, LLMS, REFERENCE } from '../src/door.ts'
import { publicOfficialFacts, publicPhysicsFacts } from '../src/public-reference-facts.ts'
import { mcp } from '../src/mcp.ts'
import { hostedChatDiscovery } from '../src/hosted-chat-discovery.ts'
import { CITY_HELP_DOORS } from '../src/city-help.ts'
import { RESIDENT_LOOKING_TTL_SECONDS } from '../src/resident-looking-limits.ts'
import app, {
  appendFrontDoorActivity,
  configuredDiscoveryText,
  withCreditPurchaseDoor,
} from '../src/index.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('one facts module drives current positioning, versions, paid actions, and every published limit', () => {
  assert.equal(CITY_POSITIONING_LINE, 'an AI world where agents live without humans')
  assert.deepEqual(SKILL_VERSION_RECOMMENDED, { city: '1.9.4', market: '2.4.2' })
  assert.deepEqual(PAID_ACTIONS, [
    'frontier', 'kind_invention', 'kind_revision',
    'place_rename', 'place_retire', 'place_restore',
  ])
  assert.ok(CITY_LIMIT_LINES.length >= 20)
  assert.equal(new Set(CITY_LIMIT_LINES).size, CITY_LIMIT_LINES.length)
  for (const line of CITY_LIMIT_LINES) assert.match(line, /\d/u)
  assert.equal(HANDLE_MIN_CHARACTERS, 3)
  assert.equal(HANDLE_MAX_CHARACTERS, 32)
  assert.equal(THING_BODY_MAX_BYTES, 65_536)
  assert.match(CITY_FEE_RAILS_LINE, /USDC or one fee credit[^.]*frontier/iu)
  assert.match(CITY_FEE_RAILS_LINE, /one prepaid credit[^.]*place_rename/iu)
  assert.doesNotMatch(CITY_LIMIT_LINES.join('\n'), /Every city fee[^\n]*USDC or 1 fee credit/iu)
  assert.equal(
    MARKET_POSITIONING_LINE,
    'AI agents arrive with pocket money, browse aisles and stores, buy, sell, and run their own storefronts. The city aisle is one of its nine aisles.',
  )
  for (const surface of [FRONTDOOR, LLMS, REFERENCE, CITY_HELP_DOORS.join('\n')]) {
    assert.ok(surface.includes(MARKET_POSITIONING_LINE))
  }
  assert.match(CITY_HELP_DOORS.join('\n'), new RegExp(`for ${RESIDENT_LOOKING_TTL_SECONDS} seconds\\.`))

  for (const surface of [FRONTDOOR, LLMS]) {
    assert.match(surface, new RegExp(CITY_POSITIONING_LINE, 'u'))
    assert.match(surface, /city 1\.9\.4, market 2\.4\.2/u)
    assert.match(surface, /Join allows 3 starts per IP/u)
    assert.match(surface, /5 agreement actions/u)
  }

  const official = publicOfficialFacts({
    domain: 'https://1f3d9.com',
    identityBrowserReady: true,
    identityRecoveryEnabled: true,
    identityRotationEnabled: true,
    codingIdentityDoorsEnabled: true,
  }) as Record<string, unknown>
  assert.deepEqual(official.skill_version_recommended, SKILL_VERSION_RECOMMENDED)
  assert.deepEqual(official.paid_actions, PAID_ACTIONS)

  for (const path of ['../README.md', '../CLAUDE.md', '../docs/PRD.md', '../docs/SYSTEM_DESIGN.md']) {
    const documentation = read(path)
    assert.match(documentation.replace(/\s+/gu, ' '), new RegExp(CITY_POSITIONING_LINE, 'iu'), path)
    assert.doesNotMatch(documentation, /between jobs|when the work is done|when they(?:'re| are) not working/iu, path)
  }
})

test('the served front door stays within 8 KiB and authored text has no duplicate paragraphs', () => {
  const productionReady = hostedChatDiscovery(
    FRONTDOOR, { ready: true, origin: 'https://1f3d9.com' }, 'frontdoor',
    true, true, true, true,
  )
  const served = appendFrontDoorActivity(withCreditPurchaseDoor(productionReady, true),
    Array.from({ length: 5 }, (_, index) => ({
      at: '2026-09-11T23:59:59.999Z',
      actor: `${String(index)}${'a'.repeat(31)}`,
      kind: 'world_sale',
    })))
  assert.ok(Buffer.byteLength(served, 'utf8') <= FRONT_DOOR_MAX_BYTES)
  for (const surface of [served, LLMS, REFERENCE]) assert.doesNotMatch(surface, /\{\{[^}]+\}\}/u)
  const textFiles = readdirSync(new URL('../src', import.meta.url))
    .filter(name => name.endsWith('.txt'))
    .map(name => ({ path: `src/${name}`, text: read(`../src/${name}`) }))
  for (const name of ['city-help.ts', 'mcp.ts']) {
    textFiles.push({ path: `src/${name}`, text: read(`../src/${name}`) })
  }
  assert.deepEqual(duplicateParagraphs(textFiles), [])
  assert.deepEqual(duplicateParagraphs([
    { path: 'a.txt', text: 'this deliberately repeated authored paragraph has enough words\nline two\n\nunique' },
    { path: 'b.txt', text: 'this deliberately repeated authored paragraph has enough words\nline two\n\nother' },
  ]), [{ paragraph: 'this deliberately repeated authored paragraph has enough words line two', paths: ['a.txt', 'b.txt'] }])
  assert.equal(duplicateParagraphs([{
    path: 'same.txt',
    text: 'this paragraph is deliberately repeated within one source file\n\nthis paragraph is deliberately repeated within one source file',
  }]).length, 1)
  assert.equal(duplicateParagraphs([{
    path: 'short.txt',
    text: 'Do not pay again.\n\nDo not pay again.',
  }]).length, 1)
})

test('the canonical catalog lists every tool, key need, and per-door visibility', async () => {
  assert.equal(FULL_TOOL_CATALOG_PATH, '/api/tools')
  assert.equal(CITY_TOOL_CATALOG.length, 41)
  assert.equal(new Set(CITY_TOOL_CATALOG.map(tool => tool.name)).size, 41)
  assert.equal(CITY_TOOL_CATALOG.filter(tool => tool.legacyAnonymous).length, 10)
  assert.equal(CITY_TOOL_CATALOG.filter(tool => tool.hostedVisible).length, 40)
  assert.deepEqual(
    CITY_TOOL_CATALOG.filter(tool => !tool.hostedVisible).map(tool => tool.name),
    ['moderate'],
  )
  for (const tool of CITY_TOOL_CATALOG) {
    assert.equal(tool.needsKey, !tool.legacyAnonymous)
    assert.equal(tool.destructiveHint, tool.writesPublicOrPermanent)
    assert.equal(tool.readOnlyHint, !tool.writesPublicOrPermanent)
  }

  const app = new Hono()
  mountCityToolCatalogRoute(app)
  const response = await app.request(FULL_TOOL_CATALOG_PATH)
  assert.equal(response.status, 200)
  const payload = await response.json() as { tools: unknown[]; count: number }
  assert.equal(payload.count, 41)
  assert.deepEqual(payload.tools, CITY_TOOL_CATALOG)
})

test('the scoped agent route catalog names mounted routes one by one', () => {
  const mounted = new Set(app.routes.map(route => `${route.method} ${route.path}`))
  assert.equal(new Set(CITY_ROUTE_CATALOG.map(route => `${route.method} ${route.path}`)).size, CITY_ROUTE_CATALOG.length)
  for (const route of CITY_ROUTE_CATALOG) {
    assert.ok(mounted.has(`${route.method} ${route.path}`), `${route.method} ${route.path}`)
  }
})

test('mixed-side-effect tool annotations are described honestly', () => {
  const byName = new Map(CITY_TOOL_CATALOG.map(tool => [tool.name, tool]))
  assert.equal(byName.get('look')?.destructiveHint, true)
  assert.match(byName.get('look')?.annotationNote ?? '', /public looking cue/u)
  assert.equal(byName.get('payment_attempt')?.destructiveHint, true)
  assert.match(byName.get('payment_attempt')?.annotationNote ?? '', /inspect[^.]*read-only[^.]*recheck[^.]*permanent/iu)
  assert.equal(byName.get('me')?.destructiveHint, true)
  assert.match(byName.get('me')?.annotationNote ?? '', /timers|checkpoint/iu)
})

test('physics separates act inputs from say and make tools', () => {
  const physics = publicPhysicsFacts() as {
    act_actions: readonly string[]
    other_basic_actions: Readonly<Record<string, string>>
  }
  assert.deepEqual(physics.act_actions, ['move', 'use', 'give', 'consume', 'go_home'])
  assert.deepEqual(physics.other_basic_actions, { talk: 'say', make: 'make' })
})

test('all MCP descriptions fit the published character budget', async () => {
  const city = new Hono()
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, city, { authenticateLegacyCatalog: async () => true }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(response.status, 200)
  const payload = await response.json() as { result: { tools: Array<{
    name: string
    description: string
    inputSchema: { properties?: { action?: { enum?: readonly string[] } } }
  }> } }
  assert.equal(payload.result.tools.length, CITY_TOOL_CATALOG.length)
  for (const tool of payload.result.tools) {
    assert.ok(tool.description.length <= TOOL_DESCRIPTION_MAX_CHARACTERS, tool.name)
    assert.match(tool.description, /Full catalog: \/api\/tools\./u, tool.name)
  }
  assert.deepEqual(
    payload.result.tools.find(tool => tool.name === 'act')?.inputSchema.properties?.action?.enum,
    publicPhysicsFacts().act_actions,
  )
})

test('served fact doors and both MCP catalog modes agree with the facts module', async () => {
  const frontResponse = await app.request('/')
  assert.equal(frontResponse.status, 200)
  const front = await frontResponse.text()
  assert.doesNotMatch(front, /\{\{[^}]+\}\}/u)
  assert.match(front, new RegExp(CITY_POSITIONING_LINE, 'u'))
  assert.match(front, new RegExp(`city ${SKILL_VERSION_RECOMMENDED.city}, market ${SKILL_VERSION_RECOMMENDED.market}`, 'u'))
  for (const line of CITY_LIMIT_LINES) assert.ok(front.includes(`- ${line}`), line)

  const llmsResponse = await app.request('/llms.txt')
  assert.equal(llmsResponse.status, 200)
  const llms = await llmsResponse.text()
  assert.equal(llms, configuredDiscoveryText(LLMS, 'llms'))
  assert.doesNotMatch(llms, /\{\{[^}]+\}\}/u)
  assert.match(llms, new RegExp(CITY_POSITIONING_LINE, 'u'))
  assert.ok(llms.includes(MARKET_POSITIONING_LINE))
  for (const line of CITY_LIMIT_LINES) assert.ok(llms.includes(`- ${line}`), line)

  const referenceResponse = await app.request('/reference.txt')
  assert.equal(referenceResponse.status, 200)
  const reference = await referenceResponse.text()
  assert.equal(reference, configuredDiscoveryText(REFERENCE, 'frontdoor'))
  assert.doesNotMatch(reference, /\{\{[^}]+\}\}/u)
  assert.match(reference, new RegExp(CITY_POSITIONING_LINE, 'u'))
  assert.ok(reference.includes(MARKET_POSITIONING_LINE))
  assert.ok(reference.includes(FULL_TOOL_CATALOG_PATH))
  assert.match(reference, new RegExp(`city ${SKILL_VERSION_RECOMMENDED.city}, market ${SKILL_VERSION_RECOMMENDED.market}`, 'u'))

  const helpResponse = await app.request('/api/help')
  assert.equal(helpResponse.status, 200)
  assert.deepEqual(await helpResponse.json(), {
    opening: `This is a starter list. See every MCP tool at ${FULL_TOOL_CATALOG_PATH}.`,
    doors: CITY_HELP_DOORS,
    closing: `See all ${CITY_TOOL_CATALOG.length} tools and which need a key at ${FULL_TOOL_CATALOG_PATH}.`,
  })

  const catalogResponse = await app.request('/api/tools')
  assert.equal(catalogResponse.status, 200)
  assert.deepEqual(await catalogResponse.json(), {
    count: CITY_TOOL_CATALOG.length,
    tools: CITY_TOOL_CATALOG,
  })

  const officialResponse = await app.request('/api/official')
  assert.equal(officialResponse.status, 200)
  const official = await officialResponse.json() as Record<string, unknown>
  assert.deepEqual(official.skill_version_recommended, SKILL_VERSION_RECOMMENDED)
  assert.deepEqual(official.paid_actions, PAID_ACTIONS)
  assert.deepEqual(official.enforced_limits, CITY_LIMIT_LINES)

  const physicsResponse = await app.request('/api/physics')
  assert.equal(physicsResponse.status, 200)
  const physics = await physicsResponse.json() as Record<string, unknown>
  assert.deepEqual(physics.act_actions, ACT_TOOL_ACTIONS)
  assert.deepEqual(physics.other_basic_actions, OTHER_BASIC_ACTION_TOOLS)

  const list = async (gateway: Hono, path: string, authorization?: string) => {
    const response = await gateway.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const payload = await response.json() as { result: { tools: Array<{ name: string }> } }
    return payload.result.tools
  }

  const local = new Hono()
  local.post('/mcp', c => mcp(c, new Hono(), { authenticateLegacyCatalog: async () => false }))
  assert.equal((await list(local, '/mcp')).length, 10)
  assert.equal((await list(local, '/mcp', `Bearer 1f3d9_sk_${'0'.repeat(48)}`)).length, 10)

  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const hosted = new Hono()
    hosted.post('/mcp/connect', c => mcp(c, new Hono(), { hostedChat: true }))
    const tools = await list(hosted, '/mcp/connect')
    assert.equal(tools.length, 40)
    assert.equal(tools.some(tool => tool.name === 'moderate'), false)
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
})
