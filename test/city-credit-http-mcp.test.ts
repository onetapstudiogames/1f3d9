import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'

const read = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
)

const readIfPresent = (relativePath: string) => {
  try {
    return read(relativePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return ''
    throw error
  }
}

const indexSource = read('../src/index.ts')
const cityCreditSource = readIfPresent('../src/city-credit.ts')
const mcpSource = read('../src/mcp.ts')
const worldSource = read('../src/world.ts')
const worldSupportSource = read('../src/world-support.ts')
const publicSurfaceSources = [
  '../src/public-events.ts',
  '../src/public-map.ts',
  '../src/public-residents.ts',
  '../src/public-search.ts',
  '../src/window.ts',
  '../src/window-client.ts',
].map(read).join('\n')

const CREDIT_HEADER = 'x-1f3d9-fee-credit'
const VALID_REQUEST_ID = 'fee-frontier-20260822-0001'

type ToolPayload = {
  result?: {
    isError?: boolean
    content?: Array<{ text: string }>
    tools?: Array<{
      name: string
      description?: string
      inputSchema: { properties?: Record<string, unknown> }
    }>
  }
  error?: { message: string }
}

function toolRequest(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }
}

async function callTool(
  app: Hono,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  const response = await callToolResponse(app, name, args)
  return response.json() as Promise<ToolPayload>
}

async function callToolResponse(
  app: Hono,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer resident-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(toolRequest(name, args)),
  })
}

test('the explicit credit selector branches before x402 without changing the headerless x402 path', () => {
  const feeSources = `${worldSupportSource}\n${cityCreditSource}`
  assert.match(feeSources, /x-1f3d9-fee-credit/iu)
  assert.match(feeSources, /x-payment[\s\S]{0,600}x-1f3d9-fee-credit|x-1f3d9-fee-credit[\s\S]{0,600}x-payment/iu)
  assert.match(feeSources, /(?:cannot|must not|choose one|one payment)[^\n]{0,180}(?:x-payment|city fee credit)/iu)
  assert.match(feeSources, /beginCityCreditSpend/iu)
  assert.match(worldSupportSource, /runDurableX402/iu)
  assert.match(worldSupportSource, /replayTreasuryFee/iu)

  // The city has exactly three treasury-fee actions. Peer sales and free actions
  // must not silently become credit-eligible when the central helper is extended.
  assert.equal((worldSource.match(/\btreasuryFee\s*\(/gu) ?? []).length, 3)
  for (const operation of ['frontier', 'kind_invention', 'kind_revision']) {
    assert.match(worldSource, new RegExp(`operation:\\s*'${operation}'`, 'u'))
  }
  assert.doesNotMatch(indexSource, /(?:direct_sale|world_sale)[\s\S]{0,500}treasuryFee\s*\(/iu)
})

test('credit settlement has success, replay, busy, insufficient, returned, and exact-return handling', () => {
  const sources = `${cityCreditSource}\n${worldSupportSource}\n${worldSource}`
  for (const contractName of [
    'completeCityCreditAttempt',
    'returnCityCreditSpend',
    'insufficient',
    'payment_pending',
    'credit_returned',
  ]) {
    assert.match(sources, new RegExp(contractName, 'iu'), `${contractName} is not wired into fee handling`)
  }
  assert.match(sources, /request[^\n]{0,80}(?:conflict|changed|same)/iu)
  assert.match(sources, /catch\s*\([^)]+\)[\s\S]{0,1200}returnCityCreditSpend/iu)
  assert.match(sources, /related_spend_id|exact[^\n]{0,100}spend/iu)

  // A credit spend is private accounting, not an on-chain receipt or public
  // treasury payment. The paid write must branch before these public inserts.
  assert.match(worldSource, /(?:method|rail)[^\n]{0,80}(?:credit|x402)/iu)
  assert.match(worldSource, /completeTreasuryPaymentOperation/iu)
  assert.match(read('../src/payment-treasury-operations.ts'), /INSERT INTO payment_uses/iu)
  assert.match(read('../src/payment-treasury-operations.ts'), /INSERT INTO fees[\s\S]{0,400}FROM payment_use/iu)
})

test('free interior founding rejects a credit selector before any debit', () => {
  const interiorStart = worldSource.indexOf('if (parentId != null)')
  const feeStart = worldSource.indexOf('const fee = await treasuryFee', interiorStart)
  assert.ok(interiorStart >= 0 && feeStart > interiorStart, 'frontier and interior branches must remain distinct')
  const interiorBranch = worldSource.slice(interiorStart, feeStart)
  assert.match(interiorBranch, /x-1f3d9-fee-credit|cityCredit|city fee credit/iu)
  assert.match(interiorBranch, /(?:reject|unsupported|only)[^\n]{0,180}(?:credit|fee)/iu)
  assert.doesNotMatch(interiorBranch, /beginCityCreditSpend|INSERT INTO city_credit_entries/iu)
})

test('founder issuance is root-key-only, fixed at one fee unit, and idempotent by source key', () => {
  const routeStart = indexSource.indexOf("app.post('/api/founder/city-credit'")
  assert.ok(routeStart >= 0, 'POST /api/founder/city-credit is missing')
  const nextRoute = indexSource.indexOf('\napp.', routeStart + 10)
  const route = indexSource.slice(routeStart, nextRoute < 0 ? undefined : nextRoute)
  const implementation = `${route}\n${cityCreditSource}`

  assert.match(route, /authRootKey|root key/iu)
  assert.match(route, /resident_handle/iu)
  assert.match(route, /source_key/iu)
  assert.match(route, /reason/iu)
  assert.match(route, /hasOnly|unsupported field/iu)
  assert.match(implementation, /1_000_000|1000000|CLAIM_FEE/iu)
  assert.doesNotMatch(route, /body\.(?:amount|value)|amount_usdc\s*=/iu)
  assert.match(implementation, /(?:23505|conflict|idempot)/iu)
  assert.match(implementation, /(?:changed|different|same)[^\n]{0,160}(?:terms|request|resident|reason)/iu)
  assert.match(implementation, /founder_id[^\n]{0,100}(?:1|resident\.id)/iu)
})

test('the founder can privately inspect one resident credit account but cannot expose it publicly', () => {
  const routeStart = indexSource.indexOf("app.get('/api/founder/city-credit/:handle'")
  assert.ok(routeStart >= 0, 'GET /api/founder/city-credit/:handle is missing')
  const nextRoute = indexSource.indexOf('\napp.', routeStart + 10)
  const route = indexSource.slice(routeStart, nextRoute < 0 ? undefined : nextRoute)
  const implementation = `${route}\n${cityCreditSource}`

  assert.match(route, /privateResidentHeaders|no-store/iu)
  assert.match(route, /authRootKey|root key/iu)
  assert.match(route, /(?:founder|resident)[^\n]{0,100}(?:id|#)\s*(?:===?|=)\s*1/iu)
  assert.match(route, /before_credit_id/iu)
  assert.match(route, /credit_limit/iu)
  assert.match(implementation, /city_credit_accounts/iu)
  assert.match(implementation, /city_credit_entries/iu)
  assert.match(implementation, /balance_usdc/iu)
  assert.match(route, /c\.req\.param\(['"]handle['"]\)/iu)
  assert.doesNotMatch(mcpSource, /name:\s*['"](?:founder_)?city_credit/iu)
})

test('/api/me is the private balance/history surface and public windows do not expose credit', () => {
  const meStart = indexSource.indexOf("app.get('/api/me'")
  const meEnd = indexSource.indexOf('\napp.', meStart + 10)
  assert.ok(meStart >= 0 && meEnd > meStart, 'GET /api/me route is missing')
  const meRoute = indexSource.slice(meStart, meEnd)
  const implementation = `${meRoute}\n${cityCreditSource}`

  assert.match(meRoute, /privateResidentHeaders/iu)
  assert.match(meRoute, /before_credit_id/iu)
  assert.match(meRoute, /credit_limit/iu)
  assert.match(implementation, /city_credit_accounts/iu)
  assert.match(implementation, /city_credit_entries/iu)
  assert.match(meRoute, /city_fee_credit/iu)
  assert.match(meRoute, /balance_usdc/iu)
  assert.match(meRoute, /resident\.id/iu)

  for (const publicRoute of ["app.get('/api/residents'", "app.get('/api/events'", "app.get('/treasury'"]) {
    const routeStart = indexSource.indexOf(publicRoute)
    assert.ok(routeStart >= 0, `${publicRoute} is missing`)
    const routeEnd = indexSource.indexOf('\napp.', routeStart + 10)
    const publicImplementation = indexSource.slice(routeStart, routeEnd < 0 ? undefined : routeEnd)
    assert.doesNotMatch(publicImplementation, /city_credit|balance_usdc|credit_total/iu)
  }

  assert.doesNotMatch(
    publicSurfaceSources,
    /city_credit_accounts|city_credit_entries|city_fee_credit|balance_usdc|before_credit_id|credit_limit/iu,
  )
  assert.doesNotMatch(cityCreditSource, /\bconsole\.(?:debug|error|info|log|warn)\s*\(/iu)
})

test('MCP found advertises a non-secret credit request id and forwards it only as the fee header', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.post('/api/place', async c => c.json({
    path: c.req.path,
    credit: c.req.header(CREDIT_HEADER),
    authorization: c.req.header('authorization'),
    body: await c.req.json(),
  }))

  const listedResponse = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer resident-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const listed = await listedResponse.json() as ToolPayload
  const found = listed.result?.tools?.find(tool => tool.name === 'found')
  assert.ok(found)
  assert.ok('city_credit_request_id' in (found.inputSchema.properties ?? {}))
  assert.match(mcpSource, /city_credit_request_id/iu)

  const httpResponse = await callToolResponse(app, 'found', {
    parent_id: null,
    name: 'credit continent',
    city_credit_request_id: VALID_REQUEST_ID,
  })
  assert.equal(httpResponse.headers.get('cache-control'), 'no-store')
  const response = await httpResponse.json() as ToolPayload
  assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text)
  const forwarded = JSON.parse(response.result?.content?.[0]?.text ?? '{}') as {
    path: string
    credit: string
    authorization: string
    body: Record<string, unknown>
  }
  assert.equal(forwarded.path, '/api/place')
  assert.equal(forwarded.credit, VALID_REQUEST_ID)
  assert.equal(forwarded.authorization, 'Bearer resident-secret')
  assert.equal('city_credit_request_id' in forwarded.body, false)
})

test('MCP rejects a credential-like credit request id before calling the city', async () => {
  let cityCalls = 0
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.post('/api/place', c => {
    cityCalls += 1
    return c.json({ unexpected: true })
  })

  const response = await callTool(app, 'found', {
    parent_id: null,
    name: 'unsafe continent',
    city_credit_request_id: `1f3d9_sk_${'ab'.repeat(24)}`,
  })
  assert.equal(response.result?.isError, true)
  assert.equal(cityCalls, 0)
  assert.match(response.result?.content?.[0]?.text ?? '', /credential|secret|request id|safe/iu)
})

test('MCP preflight reads exact private fee facts without sending action fields', async () => {
  let forwarded: Readonly<Record<string, unknown>> | null = null
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.get('/api/city-credit/preflight', c => {
    forwarded = Object.freeze({
      path: c.req.path,
      query: { ...c.req.query() },
      authorization: c.req.header('authorization'),
    })
    return c.json({
      fee_cost: '1.000000',
      balance_before: '3.000000',
      balance_after: '2.000000',
      can_confirm: true,
    })
  })

  const response = await callTool(app, 'credit_preflight', {})
  assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text)
  assert.deepEqual(forwarded, {
    path: '/api/city-credit/preflight',
    query: {},
    authorization: 'Bearer resident-secret',
  })
  assert.match(response.result?.content?.[0]?.text ?? '', /1\.000000[\s\S]*3\.000000[\s\S]*2\.000000/u)
})

test('MCP me independently forwards private receipt and pending-gift pages', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.get('/api/me', c => c.json({
    path: c.req.path,
    query: c.req.query(),
    authorization: c.req.header('authorization'),
    city_fee_credit: {
      balance_usdc: '1.000000',
      history: [],
    },
  }))

  const response = await callTool(app, 'me', {
    before_credit_id: 77,
    credit_limit: 25,
    before_gift_id: 31,
    gift_limit: 10,
  })
  assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text)
  const forwarded = JSON.parse(response.result?.content?.[0]?.text ?? '{}') as {
    path: string
    query: Record<string, string>
    authorization: string
    city_fee_credit: { balance_usdc: string }
  }
  assert.equal(forwarded.path, '/api/me')
  assert.deepEqual(forwarded.query, {
    before_credit_id: '77',
    credit_limit: '25',
    before_gift_id: '31',
    gift_limit: '10',
  })
  assert.equal(forwarded.authorization, 'Bearer resident-secret')
  assert.equal(forwarded.city_fee_credit.balance_usdc, '1.000000')
})

test('MCP recipients can accept or refuse a pending credit gift without exposing buyer secrets', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.post('/api/city-credit/gifts/:giftId/:action', async c => c.json({
    gift_id: c.req.param('giftId'),
    action: c.req.param('action'),
    authorization: c.req.header('authorization'),
    content_length: c.req.header('content-length'),
    body: await c.req.json(),
  }))

  const listedResponse = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer resident-secret',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const listed = await listedResponse.json() as ToolPayload
  const tool = listed.result?.tools?.find(candidate => candidate.name === 'credit_gift')
  assert.ok(tool)
  assert.match(String(tool.description), /pending[\s\S]{0,220}accept[\s\S]{0,120}refus/iu)
  assert.doesNotMatch(JSON.stringify(tool.inputSchema), /token|buyer|payer/iu)

  for (const action of ['accept', 'refuse'] as const) {
    const validGiftId = `city_gift_${(action === 'accept' ? 'ab' : 'cd').repeat(16)}`
    const response = await callTool(app, 'credit_gift', { action, gift_id: validGiftId })
    assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text)
    assert.deepEqual(JSON.parse(response.result?.content?.[0]?.text ?? '{}'), {
      gift_id: validGiftId,
      action,
      authorization: 'Bearer resident-secret',
      content_length: '2',
      body: {},
    })
  }
})
