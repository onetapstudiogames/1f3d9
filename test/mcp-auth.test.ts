// Release 1 OAuth contract tests use an in-memory Hono app only.
// No live database, deployment, wallet, or network service is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { auth, setOAuthResidentResolver } from '../src/core.ts'
import { mcp } from '../src/mcp.ts'

const PUBLIC_ORIGIN = 'https://1f3d9.com'
const LEGACY_SECRET = `1f3d9_sk_${'ab'.repeat(24)}`
const OAUTH_ACCESS_TOKEN = `1f3d9_at_${'cd'.repeat(32)}`
const RESOURCE_METADATA = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp/connect`
const OAUTH_SCHEME = { type: 'oauth2', scopes: ['city:resident'] } as const
const NOAUTH_SCHEME = { type: 'noauth' } as const

process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN

interface ToolDefinition {
  name: string
  description: string
  inputSchema: { properties?: Record<string, unknown> }
  securitySchemes?: unknown[]
  _meta?: { securitySchemes?: unknown[] }
}

interface ToolResult {
  isError: boolean
  content: { type: string; text: string }[]
  _meta?: { 'mcp/www_authenticate'?: string[] }
}

const EXISTING_TOOL_NAMES = [
  'register', 'look', 'found', 'make', 'act', 'laws', 'home', 'withdraw',
  'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'transfer',
  'agree', 'sign', 'say', 'me', 'moderate',
] as const

const PROTECTED_TOOL_NAMES = [
  'found', 'make', 'act', 'laws', 'home', 'withdraw', 'list_world',
  'claim_world', 'cancel_world', 'reconcile_world', 'transfer', 'agree',
  'sign', 'say', 'me',
] as const

function setHostedChatFlag(enabled: boolean) {
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = enabled ? 'true' : 'false'
}

function createHarness() {
  let forwardedAuthorization: string | undefined
  let noteCalls = 0

  const city = new Hono()
  city.get('/api/me', async c => {
    forwardedAuthorization = c.req.header('authorization')
    if (forwardedAuthorization === `Bearer ${LEGACY_SECRET}`) {
      return c.json({ resident: { id: 49, handle: 'chatty' } })
    }
    const resident = await auth(c)
    if (resident) return c.json({ resident })

    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token", ` +
        'error_description="Sign in to 1F3D9 to use resident tools."',
    )
    return c.json({ error: 'A valid resident sign-in is required.' }, 401)
  })
  city.post('/api/note', c => {
    noteCalls += 1
    return c.json({ note: { id: 1 } }, 201)
  })

  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, city))
  gateway.post('/mcp/connect', c => mcp(c, city, {
    hostedChat: true,
    forwardUnauthorizedStatus: false,
  }))

  return {
    city,
    gateway,
    forwardedAuthorization: () => forwardedAuthorization,
    noteCalls: () => noteCalls,
  }
}

async function rpc(
  app: Hono,
  method: string,
  params?: Record<string, unknown>,
  authorization?: string,
  path = '/mcp/connect',
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authorization) headers.Authorization = authorization
  const response = await app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  assert.equal(response.status, 200)
  return response.json() as Promise<Record<string, unknown>>
}

async function listTools(app: Hono, path = '/mcp/connect'): Promise<ToolDefinition[]> {
  const response = await rpc(app, 'tools/list', undefined, undefined, path) as {
    result: { tools: ToolDefinition[] }
  }
  return response.result.tools
}

function toolByName(tools: ToolDefinition[], name: string) {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool, `tools/list should include ${name}`)
  return tool
}

test('initialize defaults to the current MCP version and echoes an explicit current version', async () => {
  setHostedChatFlag(true)
  const { gateway } = createHarness()
  const fallback = await rpc(gateway, 'initialize', {}) as {
    result: { protocolVersion: string }
  }
  assert.equal(fallback.result.protocolVersion, '2025-11-25')

  const current = await rpc(gateway, 'initialize', {
    protocolVersion: '2025-11-25',
  }) as { result: { protocolVersion: string } }
  assert.equal(current.result.protocolVersion, '2025-11-25')
})

test('feature on advertises OAuth for resident tools and mixed auth for public look', async () => {
  setHostedChatFlag(true)
  const { gateway } = createHarness()
  const tools = await listTools(gateway)

  for (const name of PROTECTED_TOOL_NAMES) {
    assert.deepEqual(toolByName(tools, name).securitySchemes, [OAUTH_SCHEME], name)
  }
  assert.deepEqual(toolByName(tools, 'look').securitySchemes, [NOAUTH_SCHEME, OAUTH_SCHEME])
  assert.equal(tools.some(tool => tool.name === 'register'), false)
  assert.equal(tools.some(tool => tool.name === 'moderate'), false)

  const advertised = JSON.stringify(tools)
  assert.doesNotMatch(advertised, /1f3d9_(?:at|rt|ac)_/i)
  for (const forbiddenField of ['access_token', 'refresh_token', 'client_secret', 'code', 'session']) {
    assert.equal(
      tools.some(tool => forbiddenField in (tool.inputSchema.properties ?? {})),
      false,
      `${forbiddenField} must never be a tool argument`,
    )
  }
})

test('feature on turns a missing resident sign-in into an MCP OAuth challenge', async () => {
  setHostedChatFlag(true)
  const { gateway } = createHarness()
  const response = await rpc(gateway, 'tools/call', {
    name: 'me',
    arguments: {},
  }) as { result: ToolResult }

  assert.equal(response.result.isError, true)
  const advertised = response.result._meta?.['mcp/www_authenticate']
  assert.ok(Array.isArray(advertised))
  assert.equal(advertised.length, 1)
  const challenge = advertised[0]
  assert.match(challenge!, /^Bearer\s/i)
  assert.match(challenge!, new RegExp(`resource_metadata="${RESOURCE_METADATA}"`))
  assert.match(challenge!, /error="invalid_token"/)
  assert.match(challenge!, /error_description="[^"]+"/)
  assert.doesNotMatch(JSON.stringify(response), /1f3d9_(?:at|rt|ac)_/i)
})

test('feature off keeps the original tools and legacy bearer-header flow unchanged', async () => {
  setHostedChatFlag(false)
  const harness = createHarness()
  const tools = await listTools(harness.gateway, '/mcp')

  assert.deepEqual(tools.map(tool => tool.name), EXISTING_TOOL_NAMES)
  assert.equal(tools.every(tool => tool.securitySchemes === undefined), true)
  assert.equal(tools.every(tool => tool._meta?.securitySchemes === undefined), true)
  assert.equal(
    toolByName(tools, 'register').description,
    'Move into the city for free. The bearer secret is returned exactly once; save it outside the transcript.',
  )

  const response = await rpc(
    harness.gateway,
    'tools/call',
    { name: 'me', arguments: {} },
    `Bearer ${LEGACY_SECRET}`,
    '/mcp',
  ) as { result: ToolResult }
  assert.equal(response.result.isError, false)
  assert.equal(harness.forwardedAuthorization(), `Bearer ${LEGACY_SECRET}`)
})

test('feature on still lets a root key use the original MCP endpoint', async () => {
  setHostedChatFlag(true)
  const harness = createHarness()

  const response = await rpc(
    harness.gateway,
    'tools/call',
    { name: 'me', arguments: {} },
    `Bearer ${LEGACY_SECRET}`,
    '/mcp',
  ) as { result: ToolResult }

  assert.equal(response.result.isError, false)
  assert.equal(harness.forwardedAuthorization(), `Bearer ${LEGACY_SECRET}`)
})

test('OAuth access is blocked on raw API and legacy MCP but works through hosted MCP', async () => {
  setHostedChatFlag(true)
  const harness = createHarness()
  const resident = {
    id: 49,
    handle: 'chatty',
    model: 'hosted-chat',
    joined_at: '2026-08-13T00:00:00.000Z',
    quota_day: '2026-08-13',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  }
  setOAuthResidentResolver(async token => token === OAUTH_ACCESS_TOKEN ? resident : null)

  try {
    const rawApi = await harness.city.request('/api/me', {
      headers: { authorization: `Bearer ${OAUTH_ACCESS_TOKEN}` },
    })
    assert.equal(rawApi.status, 401)

    const legacy = await rpc(
      harness.gateway,
      'tools/call',
      { name: 'me', arguments: {} },
      `Bearer ${OAUTH_ACCESS_TOKEN}`,
      '/mcp',
    ) as { result: ToolResult }
    assert.equal(legacy.result.isError, true)

    const hosted = await rpc(
      harness.gateway,
      'tools/call',
      { name: 'me', arguments: {} },
      `Bearer ${OAUTH_ACCESS_TOKEN}`,
      '/mcp/connect',
    ) as { result: ToolResult }
    assert.equal(hosted.result.isError, false)
    assert.match(hosted.result.content[0]?.text ?? '', /chatty/)
  } finally {
    setOAuthResidentResolver(null)
  }
})

test('hosted MCP accepts the ChatGPT namespace alias without advertising or widening it', async () => {
  setHostedChatFlag(true)
  const harness = createHarness()
  const resident = {
    id: 49,
    handle: 'chatty',
    model: 'hosted-chat',
    joined_at: '2026-08-13T00:00:00.000Z',
    quota_day: '2026-08-13',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  }
  setOAuthResidentResolver(async token => token === OAUTH_ACCESS_TOKEN ? resident : null)

  try {
    const tools = await listTools(harness.gateway)
    assert.equal(tools.some(tool => tool.name.startsWith('mcp_for_1f3d9_')), false)

    const hosted = await rpc(
      harness.gateway,
      'tools/call',
      { name: 'mcp_for_1f3d9_me', arguments: {} },
      `Bearer ${OAUTH_ACCESS_TOKEN}`,
      '/mcp/connect',
    ) as { result: ToolResult }
    assert.equal(hosted.result.isError, false)
    assert.match(hosted.result.content[0]?.text ?? '', /chatty/)

    const legacy = await rpc(
      harness.gateway,
      'tools/call',
      { name: 'mcp_for_1f3d9_me', arguments: {} },
      `Bearer ${LEGACY_SECRET}`,
      '/mcp',
    ) as { error: { message: string } }
    assert.match(legacy.error.message, /no such tool/i)
  } finally {
    setOAuthResidentResolver(null)
  }
})

test('hosted endpoint refuses move-in through MCP while the legacy endpoint stays unchanged', async () => {
  setHostedChatFlag(true)
  const { gateway } = createHarness()
  const response = await rpc(gateway, 'tools/call', {
    name: 'register',
    arguments: { handle: 'chatty-two', model: 'hosted-chat' },
  }) as { result: ToolResult }
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0]?.text ?? '', /sign[ -]?in/i)
  assert.doesNotMatch(JSON.stringify(response), /1f3d9_sk_/i)

  const legacyRegister = toolByName(await listTools(gateway, '/mcp'), 'register')
  assert.match(legacyRegister.description, /returned exactly once/i)
})

test('OAuth credentials and browser-session fields are rejected without reflection', async () => {
  setHostedChatFlag(true)
  const harness = createHarness()
  const cases = {
    refresh_token: `1f3d9_rt_${'11'.repeat(32)}`,
    client_secret: 'oauth-client-secret-sentinel',
    code: `1f3d9_ac_${'22'.repeat(32)}`,
    session: 'browser-session-sentinel',
    access_token: OAUTH_ACCESS_TOKEN,
  }

  for (const [field, value] of Object.entries(cases)) {
    const response = await rpc(harness.gateway, 'tools/call', {
      name: 'say',
      arguments: { place_id: 2, body: 'safe public note', [field]: value },
    }) as { result: ToolResult }
    assert.equal(response.result.isError, true, field)
    assert.doesNotMatch(JSON.stringify(response), new RegExp(value, 'i'), field)
  }
  assert.equal(harness.noteCalls(), 0)
})
