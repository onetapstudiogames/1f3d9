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
  inputSchema: { properties?: Record<string, unknown>; required?: string[] }
  annotations?: { idempotentHint?: boolean }
  securitySchemes?: unknown[]
  _meta?: { securitySchemes?: unknown[] }
}

interface ToolResult {
  isError: boolean
  content: { type: string; text: string }[]
  _meta?: { 'mcp/www_authenticate'?: string[] }
}

const EXISTING_TOOL_NAMES = [
  'look', 'found', 'make', 'act', 'laws', 'home', 'withdraw',
  'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'transfer',
  'agree', 'open_agreement_accession', 'sign', 'say', 'me', 'moderate',
] as const
const PUBLIC_ANONYMOUS_TOOL_NAMES = ['look'] as const

const PROTECTED_TOOL_NAMES = [
  'found', 'make', 'act', 'laws', 'home', 'withdraw', 'list_world',
  'claim_world', 'cancel_world', 'reconcile_world', 'transfer', 'agree',
  'open_agreement_accession', 'sign', 'say', 'me',
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

function createAuthenticatedLookHarness(payload: Record<string, unknown>) {
  const city = new Hono()
  city.get('/api/place/:id', c => {
    if (![OAUTH_ACCESS_TOKEN, LEGACY_SECRET]
      .some(secret => c.req.header('authorization') === `Bearer ${secret}`)) {
      return c.json({ error: 'A valid resident sign-in is required.' }, 401)
    }
    return c.json(payload)
  })

  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, city))
  gateway.post('/mcp/connect', c => mcp(c, city, {
    hostedChat: true,
    forwardUnauthorizedStatus: false,
  }))
  return gateway
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

async function listTools(app: Hono, path = '/mcp/connect', authorization?: string): Promise<ToolDefinition[]> {
  const response = await rpc(app, 'tools/list', undefined, authorization, path) as {
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

test('feature off keeps resident tools on the legacy bearer-header flow without registration', async () => {
  setHostedChatFlag(false)
  const harness = createHarness()
  const anonymousTools = await listTools(harness.gateway, '/mcp')
  assert.deepEqual(anonymousTools.map(tool => tool.name), PUBLIC_ANONYMOUS_TOOL_NAMES)

  const tools = await listTools(harness.gateway, '/mcp', `Bearer ${LEGACY_SECRET}`)

  assert.deepEqual(tools.map(tool => tool.name), EXISTING_TOOL_NAMES)
  assert.equal(tools.every(tool => tool.securitySchemes === undefined), true)
  assert.equal(tools.every(tool => tool._meta?.securitySchemes === undefined), true)
  assert.ok(!tools.some(tool => tool.name === 'register'))

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

test('feature off public door says to use /mcp/connect for sign-in instead of pretending a protected tool worked', async () => {
  setHostedChatFlag(false)
  const { gateway } = createHarness()
  const response = await rpc(
    gateway,
    'tools/call',
    { name: 'me', arguments: {} },
    undefined,
    '/mcp',
  ) as { result: ToolResult }

  assert.equal(response.result.isError, true)
  const text = response.result.content[0]?.text ?? ''
  assert.match(text, /public 1F3D9 MCP door/i)
  assert.match(text, /https:\/\/1f3d9\.com\/mcp\b/)
  assert.match(text, /https:\/\/1f3d9\.com\/mcp\/connect\b/)
  assert.equal(response.result._meta?.['mcp/www_authenticate'], undefined)
})

test('agreement tools make later accession an explicit author opt-in', async () => {
  setHostedChatFlag(false)
  const { gateway } = createHarness()
  const tools = await listTools(gateway, '/mcp', `Bearer ${LEGACY_SECRET}`)

  const agree = toolByName(tools, 'agree')
  const accessionProperty = agree.inputSchema.properties?.accession_open as
    { type?: unknown; description?: unknown } | undefined
  assert.equal(accessionProperty?.type, 'boolean')
  assert.match(String(accessionProperty?.description), /closed by default|later signers/i)
  assert.equal(agree.inputSchema.required?.includes('accession_open') ?? false, false)
  assert.match(agree.description, /closed by default|explicit/i)

  const opener = toolByName(tools, 'open_agreement_accession')
  assert.deepEqual(opener.inputSchema.required, ['agreement_id'])
  assert.equal(opener.annotations?.idempotentHint, true)
  assert.match(opener.description, /original author/i)

  const sign = toolByName(tools, 'sign')
  assert.match(sign.description, /named party|later signer/i)
  assert.match(sign.description, /author.*open/i)
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

test('registration is absent from both MCP doors so no root key can enter a tool result', async () => {
  setHostedChatFlag(true)
  const { gateway } = createHarness()
  const hosted = await rpc(gateway, 'tools/call', {
    name: 'register',
    arguments: { handle: 'chatty-two', model: 'hosted-chat' },
  }) as { error: { message: string } }
  assert.match(hosted.error.message, /no such tool/i)

  const legacy = await rpc(gateway, 'tools/call', {
    name: 'register',
    arguments: { handle: 'chatty-two', model: 'hosted-chat' },
  }, undefined, '/mcp') as { error: { message: string } }
  assert.match(legacy.error.message, /no such tool/i)
  assert.ok(!(await listTools(gateway)).some(tool => tool.name === 'register'))
  assert.ok(!(await listTools(gateway, '/mcp')).some(tool => tool.name === 'register'))
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

test('a recovery code embedded in a known MCP field is rejected without reflection', async () => {
  setHostedChatFlag(true)
  const harness = createHarness()
  const recoveryCode = `1f3d9_rc_${'45'.repeat(32)}`
  const response = await rpc(harness.gateway, 'tools/call', {
    name: 'say',
    arguments: { place_id: 2, body: `do not publish ${recoveryCode}` },
  }) as { result: ToolResult }

  assert.equal(response.result.isError, true)
  assert.doesNotMatch(JSON.stringify(response), new RegExp(recoveryCode, 'i'))
  assert.equal(harness.noteCalls(), 0)
})

test('hosted look redacts only a credential-bearing note body and preserves the place response', async () => {
  setHostedChatFlag(true)
  const residentKey = `1f3d9_sk_${'ef'.repeat(24)}`
  const accessToken = `1f3d9_at_${'34'.repeat(32)}`
  const unsafeNote56 = {
    id: 56,
    place_id: 2,
    author: 'guard-test-owner',
    body: `pre-publish guard fixture ${residentKey}`,
    created_at: '2026-08-14T15:00:00.000Z',
  }
  const unsafeNote57 = {
    id: 57,
    place_id: 2,
    author: 'guard-test-owner',
    body: `second pre-publish guard fixture ${accessToken}`,
    created_at: '2026-08-14T15:01:00.000Z',
  }
  const unsafeNote58 = {
    id: 58,
    place_id: 2,
    author: 'guard-test-owner',
    body: `credential followed by lowercase hex ${residentKey}a`,
    created_at: '2026-08-14T15:01:30.000Z',
  }
  const unsafeNote59 = {
    id: 59,
    place_id: 2,
    author: 'guard-test-owner',
    body: `credential followed by uppercase hex ${accessToken}F`,
    created_at: '2026-08-14T15:01:45.000Z',
  }
  const formatNote = {
    id: 49,
    place_id: 2,
    author: 'documentarian',
    body: 'A resident key starts with 1f3d9_sk_...; this is not a credential.',
    created_at: '2026-08-14T14:59:00.000Z',
  }
  const safeNote = {
    id: 60,
    place_id: 2,
    author: 'neighbor',
    body: 'The square remains readable.',
    created_at: '2026-08-14T15:02:00.000Z',
  }
  const placePayload = {
    place: {
      id: 2,
      parent_id: 1,
      name: 'the square',
      description: `unsafe place description ${residentKey}`,
      owner_id: null,
      owner: null,
      labels: ['meeting-place'],
      laws: [],
    },
    subplaces: [{ id: 3, parent_id: 2, name: 'the waystation' }],
    things: [{
      id: 313,
      place_id: 2,
      name: 'credential safety guide',
      body: 'The format 1f3d9_at_... is safe to name when no token follows it.',
    }],
    notes: [formatNote, unsafeNote56, unsafeNote57, unsafeNote58, unsafeNote59, safeNote],
  }
  const gateway = createAuthenticatedLookHarness(placePayload)

  const response = await rpc(
    gateway,
    'tools/call',
    { name: 'look', arguments: { place_id: 2 } },
    `Bearer ${OAUTH_ACCESS_TOKEN}`,
  ) as { result: ToolResult }

  assert.equal(response.result.isError, false)
  const text = response.result.content[0]?.text ?? ''
  const parsed = JSON.parse(text) as typeof placePayload
  const redactedDescription = parsed.place.description
  const redactedBody56 = parsed.notes[1]?.body
  const redactedBody57 = parsed.notes[2]?.body
  const redactedBody58 = parsed.notes[3]?.body
  const redactedBody59 = parsed.notes[4]?.body
  assert.match(redactedDescription ?? '', /redacted.*resident credential/i)
  assert.match(redactedBody56 ?? '', /redacted.*resident credential/i)
  assert.match(redactedBody57 ?? '', /redacted.*resident credential/i)
  assert.match(redactedBody58 ?? '', /redacted.*resident credential/i)
  assert.match(redactedBody59 ?? '', /redacted.*resident credential/i)
  assert.deepEqual(parsed, {
    ...placePayload,
    place: { ...placePayload.place, description: redactedDescription },
    notes: [
      formatNote,
      { ...unsafeNote56, body: redactedBody56 },
      { ...unsafeNote57, body: redactedBody57 },
      { ...unsafeNote58, body: redactedBody58 },
      { ...unsafeNote59, body: redactedBody59 },
      safeNote,
    ],
  })
  assert.doesNotMatch(JSON.stringify(response), new RegExp(residentKey, 'i'))
  assert.doesNotMatch(JSON.stringify(response), new RegExp(accessToken, 'i'))
})

test('hosted look redacts credential-bearing fields outside note bodies instead of withholding the response', async () => {
  setHostedChatFlag(true)
  const residentKey = `1f3d9_sk_${'12'.repeat(24)}`
  const gateway = createAuthenticatedLookHarness({
    place: {
      id: 2,
      name: 'the square',
      description: `unsafe place description ${residentKey}`,
    },
    subplaces: [],
    things: [],
    notes: [{ id: 58, place_id: 2, author: 'neighbor', body: 'Safe public note.' }],
  })

  const response = await rpc(
    gateway,
    'tools/call',
    { name: 'look', arguments: { place_id: 2 } },
    `Bearer ${OAUTH_ACCESS_TOKEN}`,
  ) as { result: ToolResult }

  assert.equal(response.result.isError, false)
  const parsed = JSON.parse(response.result.content[0]?.text ?? '{}') as {
    place?: { description?: string }
    notes?: Array<{ body?: string }>
  }
  assert.match(parsed.place?.description ?? '', /redacted.*resident credential/i)
  assert.equal(parsed.notes?.[0]?.body, 'Safe public note.')
  assert.doesNotMatch(JSON.stringify(response), new RegExp(residentKey, 'i'))
})

test('legacy MCP reads use the same historical credential redaction rule', async () => {
  setHostedChatFlag(false)
  const leaked = `1f3d9_rt_${'56'.repeat(32)}`
  const gateway = createAuthenticatedLookHarness({
    place: { id: 2, name: 'the square', description: `historical ${leaked}` },
    subplaces: [],
    things: [],
    notes: [{ id: 61, place_id: 2, author: 'neighbor', body: 'Safe public note.' }],
  })

  const response = await rpc(
    gateway,
    'tools/call',
    { name: 'look', arguments: { place_id: 2 } },
    `Bearer ${LEGACY_SECRET}`,
    '/mcp',
  ) as { result: ToolResult }

  assert.equal(response.result.isError, false)
  const text = response.result.content[0]?.text ?? '{}'
  const parsed = JSON.parse(text) as { place?: { description?: string } }
  assert.match(parsed.place?.description ?? '', /redacted.*resident credential/i)
  assert.doesNotMatch(text, new RegExp(leaked, 'i'))
})

test('an invalid enum value rejects plainly and never routes to a different action', async () => {
  for (const [hosted, path, authorization] of [
    [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
    [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
  ] as const) {
    setHostedChatFlag(hosted)
    const calls: string[] = []
    const city = new Hono()
    city.all('*', c => {
      calls.push(`${c.req.method} ${new URL(c.req.url).pathname}`)
      return c.json({ ok: true })
    })
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, city))
    gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))

    // A near-miss transfer action must not fall through to an immediate give.
    const transfer = await rpc(gateway, 'tools/call', {
      name: 'transfer',
      arguments: { action: 'offerr', type: 'thing', id: 7, to_handle: 'neighbor' },
    }, authorization, path) as { result: ToolResult }
    assert.equal(transfer.result.isError, true, path)
    assert.match(transfer.result.content[0]?.text ?? '', /unsupported action value/i, path)
    assert.match(transfer.result.content[0]?.text ?? '', /give, offer, claim, cancel/, path)

    // talk and make are no longer act menu entries; the rejection lists the menu.
    const act = await rpc(gateway, 'tools/call', {
      name: 'act',
      arguments: { action: 'talk' },
    }, authorization, path) as { result: ToolResult }
    assert.equal(act.result.isError, true, path)
    assert.match(act.result.content[0]?.text ?? '', /move, use, give, consume, go_home/, path)

    assert.deepEqual(calls, [], `${path}: no city route may run for an invalid enum value`)
  }
})

test('hosted and legacy MCP reads redact every resident credential family', async () => {
  const credentials = [
    `1f3d9_sk_${'a1'.repeat(24)}`,
    `1f3d9_at_${'b2'.repeat(32)}`,
    `1f3d9_rt_${'c3'.repeat(32)}`,
    `1f3d9_ac_${'d4'.repeat(32)}`,
    `1f3d9_rc_${'e5'.repeat(32)}`,
  ]

  for (const [hosted, path, authorization] of [
    [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
    [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
  ] as const) {
    setHostedChatFlag(hosted)
    for (const credential of credentials) {
      const gateway = createAuthenticatedLookHarness({
        place: { id: 2, name: 'the square', description: `historical ${credential}` },
        subplaces: [],
        things: [],
        notes: [],
      })
      const response = await rpc(
        gateway,
        'tools/call',
        { name: 'look', arguments: { place_id: 2 } },
        authorization,
        path,
      ) as { result: ToolResult }
      const text = response.result.content[0]?.text ?? '{}'
      assert.equal(response.result.isError, false)
      assert.match(JSON.parse(text).place?.description ?? '', /redacted.*resident credential/i)
      assert.doesNotMatch(text, new RegExp(credential, 'i'))
    }
  }
})
