import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { auth, setOAuthResidentResolver, setPassiveOAuthResidentResolver } from '../../src/core.ts'
import { mcp } from '../../src/mcp.ts'
import {
  PUBLIC_ORIGIN,
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  FRONT_DOOR_POINTER,
  EXISTING_TOOL_NAMES,
  PUBLIC_ANONYMOUS_TOOL_NAMES,
  setHostedChatFlag,
  createHarness,
  rpc,
  listTools,
  toolByName,
  callTool,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

export function registerCatalogTests(): void {
  const OAUTH_SCHEME = { type: 'oauth2', scopes: ['city:resident'] } as const
  const NOAUTH_SCHEME = { type: 'noauth' } as const
  const TOOL_TITLES: Readonly<Record<(typeof EXISTING_TOOL_NAMES)[number], string>> = Object.freeze({
    front_door: 'Read front door',
    help: 'Read city help',
    official_facts: 'Read official facts',
    physics: 'Read city physics',
    search: 'Search public records',
    changes: 'Check public changes',
    look: 'Look around',
    browse: 'Browse public catalogs',
    drawing: 'Read a drawing',
    drawing_history: 'Read drawing history',
    credit_preflight: 'Check one fee before confirming',
    buy_credit: 'Buy city credit',
    found: 'Found a place',
    place_edit: 'Edit a place',
    coin_trait: 'Coin a trait',
    invent_kind: 'Invent a kind',
    revise_kind: 'Revise a kind',
    make: 'Make a thing',
    thing_edit: 'Edit a thing',
    thing_upgrade: 'Upgrade a thing',
    draw_self: 'Draw myself',
    act: 'Act in the city',
      laws: 'Set regional laws',
    home: 'Set home',
    withdraw: 'Withdraw a thing',
    list_world: 'List a world thing',
    claim_world: 'Claim a world thing',
    cancel_world: 'Cancel a world listing',
    reconcile_world: 'Reconcile a world payment',
    credit_gift: 'Accept or refuse a credit gift',
    payment_attempt: 'Check a payment attempt',
    transfer: 'Transfer property',
    agree: 'Write an agreement',
    open_agreement_accession: 'Open agreement accession',
    sign: 'Sign an agreement',
    say: 'Speak here',
    flag: 'Flag illegal content',
    later_holder_items: 'Check marked items',
    mark_for_later: 'Mark or unmark a thing',
    me: 'Check my status',
    moderate: 'Moderate illegal content',
  })

  const PROTECTED_TOOL_NAMES = [
    'credit_preflight', 'buy_credit', 'found', 'place_edit', 'coin_trait',
    'invent_kind', 'revise_kind', 'make', 'thing_edit', 'thing_upgrade',
    'draw_self', 'act', 'laws', 'home', 'withdraw', 'list_world',
    'claim_world', 'cancel_world', 'reconcile_world', 'credit_gift', 'payment_attempt',
    'transfer', 'agree',
    'open_agreement_accession', 'sign', 'say', 'flag', 'later_holder_items',
    'mark_for_later', 'me',
  ] as const
  const HOSTED_TOOL_NAMES = [...PUBLIC_ANONYMOUS_TOOL_NAMES, ...PROTECTED_TOOL_NAMES] as const
  function createVisitOpeningHarness() {
    const backingCalls: Array<{
      method: string
      path: string
      authorization: string | null
      body?: unknown
    }> = []
    const city = new Hono()
    const record = (method: string, path: string, authorization: string | null, body?: unknown) => {
      backingCalls.push({ method, path, authorization, ...(body === undefined ? {} : { body }) })
    }

    city.get('/', c => {
      record(c.req.method, c.req.path, c.req.header('authorization') ?? null)
      return c.text('connector-native front door\n')
    })
    city.get('/api/official', c => {
      record(c.req.method, c.req.path, c.req.header('authorization') ?? null)
      return c.json({ domain: PUBLIC_ORIGIN, token: null })
    })
    city.get('/api/me', async c => {
      record(c.req.method, c.req.path, c.req.header('authorization') ?? null)
      const resident = await auth(c)
      if (!resident) return c.json({ error: 'A valid resident sign-in is required.' }, 401)
      return c.json({
        handle: resident.handle,
        front_door: `${PUBLIC_ORIGIN}/`,
        front_door_tool: 'front_door',
      })
    })
    city.post('/api/action', async c => {
      const body = await c.req.json()
      record(c.req.method, c.req.path, c.req.header('authorization') ?? null, body)
      const resident = await auth(c)
      if (!resident) return c.json({ error: 'A valid resident sign-in is required.' }, 401)
      return c.json({ action: { action: 'go_home', status: 'applied', actor: resident.handle } })
    })

    const gateway = new Hono()
    gateway.post('/mcp/connect', c => mcp(c, city, {
      hostedChat: true,
      forwardUnauthorizedStatus: false,
    }))
    return { gateway, backingCalls }
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

  test('feature on advertises OAuth for resident tools and mixed auth for every public read', async () => {
    setHostedChatFlag(true)
    const { gateway } = createHarness()
    const tools = await listTools(gateway)

    for (const name of PROTECTED_TOOL_NAMES) {
      assert.deepEqual(toolByName(tools, name).securitySchemes, [OAUTH_SCHEME], name)
    }
    for (const name of PUBLIC_ANONYMOUS_TOOL_NAMES) {
      const tool = toolByName(tools, name)
      assert.deepEqual(tool.securitySchemes, [NOAUTH_SCHEME, OAUTH_SCHEME], name)
      assert.deepEqual(tool._meta?.securitySchemes, tool.securitySchemes, `${name}: compatibility mirror`)
    }
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

  test('connector-native reference tools accept no arguments and are safe anonymous reads', async () => {
    setHostedChatFlag(true)
    const { gateway } = createHarness()
    const tools = await listTools(gateway)
    const readAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    }

    for (const name of ['help', 'official_facts', 'physics'] as const) {
      const tool = toolByName(tools, name)
      assert.equal(tool.inputSchema.additionalProperties, false, `${name}: closed input`)
      assert.deepEqual(tool.inputSchema.properties ?? {}, {}, `${name}: no arguments`)
      assert.deepEqual(tool.inputSchema.required ?? [], [], `${name}: no required arguments`)
      assert.deepEqual(safetyHints(tool.annotations), readAnnotations, `${name}: read-only annotations`)
    }

    const frontDoor = toolByName(tools, 'front_door')
    assert.equal(frontDoor.inputSchema.additionalProperties, false)
    assert.deepEqual(frontDoor.inputSchema.required ?? [], [])
    assert.deepEqual(safetyHints(frontDoor.annotations), readAnnotations)
    assert.deepEqual(Object.keys(frontDoor.inputSchema.properties ?? {}), ['section'])
  })

  test('connector-native reference tools execute anonymously with identical content on both MCP doors', async () => {
    setHostedChatFlag(true)
    const { gateway } = createHarness()
    const expected = {
      front_door: 'connector-native front door\n',
      help: JSON.stringify({ doors: ['City map: `look` starts here.'] }),
      official_facts: JSON.stringify({ domain: PUBLIC_ORIGIN, token: null }),
      physics: JSON.stringify({ basic_actions: ['move'], max_effect_depth: 12 }),
    } as const

    for (const name of ['front_door', 'help', 'official_facts', 'physics'] as const) {
      const legacy = await callTool(gateway, name, {}, undefined, '/mcp')
      const hosted = await callTool(gateway, name, {}, undefined, '/mcp/connect')
      assert.equal(legacy.isError, false, `/mcp: ${name}`)
      assert.equal(hosted.isError, false, `/mcp/connect: ${name}`)
      assert.equal(legacy.content[0]?.text, expected[name], `/mcp: ${name}`)
      assert.equal(hosted.content[0]?.text, legacy.content[0]?.text, `${name}: identical doors`)
    }
  })

  test('a hosted resident can open a visit through connector tools without a global web fetch', async () => {
    setHostedChatFlag(true)
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
    const originalFetch = globalThis.fetch
    let globalFetchCalls = 0
    globalThis.fetch = (async () => {
      globalFetchCalls += 1
      throw new Error('the hosted visit-opening sequence must not use global fetch')
    }) as typeof fetch

    try {
      const { gateway, backingCalls } = createVisitOpeningHarness()
      const authorization = `Bearer ${OAUTH_ACCESS_TOKEN}`
      const frontDoor = await callTool(gateway, 'front_door', {}, authorization)
      const officialFacts = await callTool(gateway, 'official_facts', {}, authorization)
      const me = await callTool(gateway, 'me', {}, authorization)
      const act = await callTool(gateway, 'act', {
        action: 'move', to_place_id: 3, carry_thing_id: 41,
      }, authorization)

      assert.equal(frontDoor.isError, false)
      assert.equal(frontDoor.content[0]?.text, 'connector-native front door\n')
      assert.equal(officialFacts.isError, false)
      assert.deepEqual(JSON.parse(officialFacts.content[0]?.text ?? '{}'), {
        domain: PUBLIC_ORIGIN,
        token: null,
      })
      assert.equal(JSON.parse(me.content[0]?.text ?? '{}').handle, 'chatty')
      assert.equal(JSON.parse(act.content[0]?.text ?? '{}').action.status, 'applied')
      assert.deepEqual(
        backingCalls.map(call => [call.method, call.path]),
        [
          ['GET', '/'],
          ['GET', '/api/official'],
          ['GET', '/api/me'],
          ['POST', '/api/action'],
        ],
      )
      assert.deepEqual(
        backingCalls.map(call => call.authorization),
        [authorization, authorization, authorization, authorization],
      )
      assert.deepEqual(backingCalls.at(-1)?.body, {
        action: 'move', to_place_id: 3, carry_thing_id: 41,
      })
      assert.equal(globalFetchCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
      setOAuthResidentResolver(null)
    }
  })

  test('every advertised MCP tool has a short plain title on its exact door catalog', async () => {
    assert.equal(EXISTING_TOOL_NAMES.length, 41)
    assert.equal(HOSTED_TOOL_NAMES.length, 40)
    for (const [hosted, path, authorization, expectedNames] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`, HOSTED_TOOL_NAMES],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`, EXISTING_TOOL_NAMES],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)
      assert.deepEqual(tools.map(tool => tool.name), expectedNames, `${path}: exact catalog`)
      for (const tool of tools) {
        assert.equal(tool.title, TOOL_TITLES[tool.name as keyof typeof TOOL_TITLES], `${path}: ${tool.name}`)
        assert.match(tool.title ?? '', /^[A-Z][A-Za-z ]{2,39}$/u, `${path}: ${tool.name}`)
      }
    }
  })

  test('every authenticated MCP surface carries one quiet front-door pointer', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const initialized = await rpc(gateway, 'initialize', {}, authorization, path) as {
        result: { instructions: string }
      }
      assert.equal(
        initialized.result.instructions.split(FRONT_DOOR_POINTER).length - 1,
        1,
        `${path}: initialize`,
      )

      for (const tool of await listTools(gateway, path, authorization)) {
        assert.equal(
          tool.description.split(FRONT_DOOR_POINTER).length - 1,
          1,
          `${path}: ${tool.name}`,
        )
      }

      const badCall = await rpc(
        gateway,
        'tools/call',
        { name: 'me', arguments: { unsupported: true } },
        authorization,
        path,
      ) as { result: { content: Array<{ text: string }> } }
      const badCallBody = JSON.parse(badCall.result.content[0]!.text) as {
        front_door?: string
        front_door_tool?: string
      }
      assert.equal(badCallBody.front_door, 'https://1f3d9.com/')
      assert.equal(badCallBody.front_door_tool, 'front_door')

      const unknownMethod = await rpc(
        gateway,
        'city/unknown',
        {},
        authorization,
        path,
      ) as {
        error: {
          code: number
          message: string
          data?: { front_door?: string; front_door_tool?: string }
        }
      }
      assert.equal(unknownMethod.error.code, -32601, `${path}: unknown method`)
      assert.equal(
        unknownMethod.error.message,
        'method not found: city/unknown; call initialize, ping, tools/list, or tools/call',
        `${path}: unknown method`,
      )
      assert.equal(
        unknownMethod.error.data?.front_door,
        'https://1f3d9.com/',
        `${path}: unknown method front door`,
      )
      assert.equal(
        unknownMethod.error.data?.front_door_tool,
        'front_door',
        `${path}: unknown method front-door tool`,
      )

      const unknownTool = await rpc(
        gateway,
        'tools/call',
        { name: 'unknown_city_tool', arguments: {} },
        authorization,
        path,
      ) as {
        error: {
          code: number
          message: string
          data?: { front_door?: string; front_door_tool?: string }
        }
      }
      assert.equal(unknownTool.error.code, -32602, `${path}: unknown tool`)
      assert.equal(
        unknownTool.error.message,
        'no such tool: unknown_city_tool; call tools/list and use one advertised tool name',
        `${path}: unknown tool`,
      )
      assert.equal(
        unknownTool.error.data?.front_door,
        'https://1f3d9.com/',
        `${path}: unknown tool front door`,
      )
      assert.equal(
        unknownTool.error.data?.front_door_tool,
        'front_door',
        `${path}: unknown tool front-door tool`,
      )
    }
  })
}

function safetyHints(value: Record<string, unknown> = {}): Record<string, unknown> {
  const { title: _title, ...hints } = value
  return hints
}
