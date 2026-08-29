import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'

type ToolAnnotations = Readonly<{
  readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean
}>

type AdvertisedTool = Readonly<{
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
  securitySchemes?: ReadonlyArray<Readonly<{ type: string; scopes?: readonly string[] }>>
  _meta?: Readonly<{
    securitySchemes?: ReadonlyArray<Readonly<{ type: string; scopes?: readonly string[] }>>
  }>
}>

type ToolResult = Readonly<{
  isError: boolean; content: ReadonlyArray<Readonly<{ type: string; text: string }>>
}>

type BackingCall = Readonly<{
  method: string; path: string; query: Readonly<Record<string, string>>
  rawBody: string; body: unknown; authorization: string | null
  contentLength: string | null; contentType: string | null
  feeCredit: string | null; payment: string | null
}>

const AUTHORIZATION = 'Bearer resident-test-header'
const HOSTED_AUTHORIZATION = 'Bearer hosted-test-header'
const OAUTH_SECURITY_SCHEME = { type: 'oauth2', scopes: ['city:resident'] } as const
const NOAUTH_SECURITY_SCHEME = { type: 'noauth' } as const
const HANDLE_PATTERN = '^[a-z0-9][a-z0-9-]{2,31}$'
const WORLD_NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$'
const REQUEST_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
const CHANGE_MARKER_PATTERN = '^(?:0|[1-9][0-9]*)$'
const GIFT_CLAIM_TOKEN = `gift_claim_${'ab'.repeat(32)}`

const READ_ANNOTATIONS = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const
const PLACE_EDIT_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
} as const
const WRITE_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
} as const
const ADDITIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
} as const
const IDEMPOTENT_PAYMENT_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
} as const

const positiveIdSchema = { type: 'integer', minimum: 1, maximum: 2_147_483_647 } as const
const drawingRecordTypeSchema = {
  type: 'string', enum: ['place', 'resident', 'kind', 'thing'],
} as const
const connectorDrawing = {
  palette: ['#ad3f25'],
  indices: Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null),
} as const
const drawingPixelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    palette: {
      type: 'array', maxItems: 64,
      items: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
    },
    indices: {
      type: 'array', minItems: 64, maxItems: 64,
      items: {
        anyOf: [
          { type: 'null' },
          { type: 'integer', minimum: 0, maximum: 63 },
        ],
      },
    },
  },
  required: ['palette', 'indices'],
} as const
const drawingArgumentSchema = {
  anyOf: [
    { type: 'null' },
    { type: 'string', const: 'REFUSE' },
    drawingPixelSchema,
  ],
} as const
const drawingStateSchema = {
  type: 'string', enum: ['in_progress', 'complete'],
} as const
const drawingDescriptionSchema = {
  type: 'string',
  description: 'HTTP/MCP runtime enforces safe public text and at most 280 UTF-8 bytes; HTTP is authoritative and MCP forwards its exact errors',
} as const
const drawingWriteProperties = {
  drawing: drawingArgumentSchema,
  drawing_state: drawingStateSchema,
  drawing_description: drawingDescriptionSchema,
} as const
const drawingWriteConditions = [
  {
    if: {
      anyOf: [{ required: ['drawing_state'] }, { required: ['drawing_description'] }],
    },
    then: { required: ['drawing'] },
  },
  {
    if: { properties: { drawing: { type: 'null' } }, required: ['drawing'] },
    then: {
      not: {
        anyOf: [{ required: ['drawing_state'] }, { required: ['drawing_description'] }],
      },
    },
  },
  {
    if: { properties: { drawing: { const: 'REFUSE' } }, required: ['drawing'] },
    then: { required: ['drawing_description'], not: { required: ['drawing_state'] } },
  },
  {
    if: { properties: { drawing: { type: 'object' } }, required: ['drawing'] },
    then: { required: ['drawing_state', 'drawing_description'] },
  },
] as const
const drawingVariantSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string', minLength: 1,
      description: 'HTTP/MCP runtime enforces a safe trimmed one-line exact variant name and at most 64 UTF-8 bytes; HTTP is authoritative and MCP forwards its exact errors',
    },
    drawing: drawingPixelSchema,
    drawing_state: drawingStateSchema,
    drawing_description: drawingDescriptionSchema,
  },
  required: ['name', 'drawing', 'drawing_state', 'drawing_description'],
} as const
const drawingVariantsSchema = {
  type: 'array', maxItems: 8, items: drawingVariantSchema,
  description: 'zero to 8 variants authored for this kind revision; HTTP/MCP runtime enforces unique exact variant names; HTTP is authoritative and MCP forwards its exact errors',
} as const
const drawingSelectionSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'string', minLength: 1,
      description: 'HTTP/MCP runtime enforces a safe trimmed one-line exact offered variant name and at most 64 UTF-8 bytes; HTTP is authoritative and MCP forwards its exact errors',
    },
  ],
  description: 'null deliberately selects the pinned kind base; a string selects that exact named variant',
} as const
const handleSchema = { type: 'string', pattern: HANDLE_PATTERN } as const
const worldNameSchema = {
  type: 'string', minLength: 1, maxLength: 64, pattern: WORLD_NAME_PATTERN,
} as const
const cityCreditRequestSchema = {
  type: 'string', minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN,
  description: 'non-secret retry identifier that deliberately spends one private city fee credit',
} as const
const kindRecipeSchema = {
  type: 'array',
  maxItems: 64,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: worldNameSchema,
      quantity: { type: 'integer', minimum: 1, maximum: 1024 },
    },
    required: ['kind', 'quantity'],
  },
  description: 'unique kind names; at most 64 rows, 1,024 total ingredients, and 65,536 UTF-8 JSON bytes',
} as const
const traitRecipeSchema = {
  anyOf: [
    { type: 'array', maxItems: 128, items: { type: 'object' } },
    { type: 'object' },
    { type: 'null' },
  ],
  description: 'optional frozen-action recipe; at most 128 effects, 8 nested levels, and 65,536 UTF-8 JSON bytes',
} as const

const expectedToolContracts: Readonly<Record<string, Readonly<{
  title: string
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
}>>> = {
  drawing: {
    title: 'Read a drawing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: drawingRecordTypeSchema,
        id: positiveIdSchema,
      },
      required: ['type', 'id'],
    },
    annotations: READ_ANNOTATIONS,
  },
  drawing_history: {
    title: 'Read drawing history',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: drawingRecordTypeSchema,
        id: positiveIdSchema,
        before: positiveIdSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['type', 'id'],
    },
    annotations: READ_ANNOTATIONS,
  },
  place_edit: {
    title: 'Edit a place',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 2,
      allOf: drawingWriteConditions,
      properties: {
        place_id: positiveIdSchema,
        description: { type: 'string', maxLength: 4000 },
        purpose: { type: 'string', maxLength: 280 },
        front_matter_thing_ids: {
          type: 'array',
          items: positiveIdSchema,
          uniqueItems: true,
          anyOf: [{ maxItems: 0 }, { minItems: 2, maxItems: 3 }],
        },
        open_to_building: { type: 'boolean' },
        open_to_things: { type: 'boolean' },
        open_to_notes: { type: 'boolean' },
        ...drawingWriteProperties,
      },
      required: ['place_id'],
    },
    annotations: PLACE_EDIT_ANNOTATIONS,
  },
  thing_edit: {
    title: 'Edit a thing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 2,
      allOf: drawingWriteConditions,
      properties: {
        thing_id: positiveIdSchema,
        name: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', description: 'safe text no larger than 65,536 UTF-8 bytes' },
        open_to_use: { type: 'boolean' },
        ...drawingWriteProperties,
        drawing_variant_name: drawingSelectionSchema,
      },
      required: ['thing_id'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  thing_upgrade: {
    title: 'Upgrade a thing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { thing_id: positiveIdSchema, drawing_variant_name: drawingSelectionSchema },
      required: ['thing_id'],
    },
    annotations: PLACE_EDIT_ANNOTATIONS,
  },
  coin_trait: {
    title: 'Coin a trait',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: worldNameSchema,
        description: { type: 'string', maxLength: 4000, default: '' },
        recipe: traitRecipeSchema,
      },
      required: ['name'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  invent_kind: {
    title: 'Invent a kind',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      allOf: drawingWriteConditions,
      properties: {
        name: worldNameSchema,
        description: { type: 'string', maxLength: 4000, default: '' },
        traits: {
          type: 'array', items: worldNameSchema, maxItems: 32, uniqueItems: true, default: [],
        },
        recipe: { ...kindRecipeSchema, default: [] },
        ...drawingWriteProperties,
        drawing_variants: drawingVariantsSchema,
        city_credit_request_id: cityCreditRequestSchema,
      },
      required: ['name'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  revise_kind: {
    title: 'Revise a kind',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      allOf: drawingWriteConditions,
      properties: {
        kind_id: positiveIdSchema,
        description: { type: 'string', maxLength: 4000 },
        traits: { type: 'array', items: worldNameSchema, maxItems: 32, uniqueItems: true },
        recipe: kindRecipeSchema,
        ...drawingWriteProperties,
        drawing_variants: drawingVariantsSchema,
        city_credit_request_id: cityCreditRequestSchema,
      },
      required: ['kind_id'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  browse: {
    title: 'Browse public catalogs',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: {
          type: 'string',
          enum: [
            'kinds', 'traits', 'agreements', 'residents', 'events', 'moderation',
            'treasury', 'gazette',
          ],
        },
        before_id: positiveIdSchema,
        limit: {
          type: 'integer', minimum: 1, maximum: 200,
          description: 'defaults to 10, except residents defaults to 200 and treasury defaults to 50',
        },
        party: handleSchema,
        open: { type: 'boolean' },
        resident_view: { type: 'string', enum: ['census', 'presence'], default: 'census' },
        handle: handleSchema,
        kind: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]{0,63}$' },
        actor: handleSchema,
        place_id: positiveIdSchema,
        within_place_id: positiveIdSchema,
        issue_number: {
          ...positiveIdSchema,
          description: 'with view=gazette, read this permanent issue instead of the issue list',
        },
        before_issue_number: {
          ...positiveIdSchema,
          description: 'with a Gazette issue list, return older issue numbers',
        },
        after_ordinal: {
          ...positiveIdSchema,
          description: 'with one Gazette issue_number, return later oldest-first entry ordinals',
        },
        after_change_marker: {
          type: 'string', maxLength: 19, pattern: CHANGE_MARKER_PATTERN,
        },
      },
      required: ['view'],
    },
    annotations: READ_ANNOTATIONS,
  },
  buy_credit: {
    title: 'Buy city credit',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request_id: {
          type: 'string', minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN,
          description: 'non-secret retry identifier; reuse it to inspect or safely retry this exact purchase',
        },
        amount_dollars: {
          type: 'string', pattern: '^(?:[1-9][0-9]{0,3}|10000)$',
          description: 'whole-dollar string from 1 to 10000; one dollar buys one city fee credit',
        },
      },
      required: ['request_id', 'amount_dollars'],
    },
    annotations: IDEMPOTENT_PAYMENT_ANNOTATIONS,
  },
  flag: {
    title: 'Flag illegal content',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_type: {
          type: 'string',
          enum: ['place', 'thing', 'kind', 'trait', 'note', 'agreement', 'resident'],
        },
        target_id: positiveIdSchema,
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['target_type', 'target_id', 'reason'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
}

function connectorHarness(
  responseForCall: (call: BackingCall) => unknown = call => ({ ok: true, path: call.path }),
) {
  const calls: BackingCall[] = []
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))
  app.all('*', async c => {
    const method = c.req.method
    const rawBody = method === 'GET' || method === 'HEAD' ? '' : await c.req.text()
    let body: unknown = null
    if (rawBody !== '') body = JSON.parse(rawBody) as unknown
    const call: BackingCall = Object.freeze({
      method,
      path: c.req.path,
      query: Object.freeze({ ...c.req.query() }),
      rawBody,
      body,
      authorization: c.req.header('authorization') ?? null,
      contentLength: c.req.header('content-length') ?? null,
      contentType: c.req.header('content-type') ?? null,
      feeCredit: c.req.header('x-1f3d9-fee-credit') ?? null,
      payment: c.req.header('x-payment') ?? null,
    })
    calls.push(call)
    const response = responseForCall(call)
    return response instanceof Response ? response : c.json(response)
  })
  return { app, calls }
}

async function withHostedConnector<Result>(run: () => Promise<Result>): Promise<Result> {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

async function rpc(
  app: Hono,
  endpoint: '/mcp' | '/mcp/connect',
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Readonly<{
  result?: ToolResult & Readonly<{ tools?: AdvertisedTool[] }>
  error?: Readonly<{ code: number; message: string }>
}>> {
  const response = await app.request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  assert.equal(response.status, 200)
  return await response.json() as Readonly<{
    result?: ToolResult & Readonly<{ tools?: AdvertisedTool[] }>
    error?: Readonly<{ code: number; message: string }>
  }>
}

async function listedTools(
  app: Hono,
  endpoint: '/mcp' | '/mcp/connect',
  authorization?: string,
): Promise<AdvertisedTool[]> {
  const payload = await rpc(
    app,
    endpoint,
    'tools/list',
    {},
    authorization ? { authorization } : {},
  )
  assert.ok(payload.result, payload.error?.message ?? 'tools/list returned no result')
  assert.ok(Array.isArray(payload.result.tools), 'tools/list omitted tools')
  return payload.result.tools
}

async function callToolResult(
  app: Hono,
  endpoint: '/mcp' | '/mcp/connect',
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ToolResult> {
  const payload = await rpc(app, endpoint, 'tools/call', {
    name,
    arguments: args,
  }, headers)
  assert.ok(payload.result, payload.error?.message ?? `tool ${name} returned no result`)
  return payload.result
}

async function callTool(
  app: Hono,
  endpoint: '/mcp' | '/mcp/connect',
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const result = await callToolResult(app, endpoint, name, args, headers)
  assert.equal(result.isError, false, result.content[0]?.text)
  assert.ok(result.content[0])
  return JSON.parse(result.content[0].text) as unknown
}

function assertCall(
  actual: BackingCall,
  expected: Readonly<{
    method: string
    path: string
    query?: Readonly<Record<string, string>>
    body?: unknown
    authorization: string
    feeCredit?: string | null
    payment?: string | null
  }>,
) {
  assert.equal(actual.method, expected.method)
  assert.equal(actual.path, expected.path)
  assert.deepEqual(actual.query, expected.query ?? {})
  assert.deepEqual(actual.body, expected.body ?? null)
  assert.equal(actual.authorization, expected.authorization)
  assert.equal(actual.contentType, 'application/json')
  assert.equal(actual.feeCredit, expected.feeCredit ?? null)
  assert.equal(actual.payment, expected.payment ?? null)
  if (actual.method !== 'GET') {
    assert.equal(actual.contentLength, null, 'MCP must forward actual body bytes without Content-Length')
  }
}

test('both MCP catalogs advertise the exact connector tool contracts', async () => {
  const { app } = connectorHarness()
  const legacy = await listedTools(app, '/mcp', AUTHORIZATION)
  const hosted = await withHostedConnector(() => listedTools(app, '/mcp/connect', HOSTED_AUTHORIZATION))
  assert.equal(legacy.length, 40, 'legacy catalog includes two public drawing reads')
  assert.equal(hosted.length, 39, 'hosted catalog includes two public drawing reads and omits moderate')

  for (const [name, expected] of Object.entries(expectedToolContracts)) {
    const legacyTool = legacy.find(tool => tool.name === name)
    const hostedTool = hosted.find(tool => tool.name === name)
    assert.ok(legacyTool, `legacy catalog missing ${name}`)
    assert.ok(hostedTool, `hosted catalog missing ${name}`)
    for (const [catalog, tool] of [['legacy', legacyTool], ['hosted', hostedTool]] as const) {
      assert.equal(tool.title, expected.title, `${catalog} ${name} title`)
      assert.deepEqual(tool.inputSchema, expected.inputSchema, `${catalog} ${name} schema`)
      assert.deepEqual(tool.annotations, expected.annotations, `${catalog} ${name} annotations`)
    }
    assert.equal(legacyTool.securitySchemes, undefined, `${name} legacy security metadata`)
    const hostedSchemes = ['browse', 'drawing', 'drawing_history'].includes(name)
      ? [NOAUTH_SECURITY_SCHEME, OAUTH_SECURITY_SCHEME]
      : [OAUTH_SECURITY_SCHEME]
    assert.deepEqual(hostedTool.securitySchemes, hostedSchemes, `${name} hosted security`)
    assert.deepEqual(hostedTool._meta?.securitySchemes, hostedSchemes, `${name} hosted security mirror`)
  }

  const placeEditDescription = legacy.find(tool => tool.name === 'place_edit')!.description
  assert.match(placeEditDescription, /owner.*4,?000/iu)
  assert.match(placeEditDescription, /280.*(?:clear|empty)/iu)
  assert.match(placeEditDescription, /(?:exactly )?2.*3/iu)
  assert.match(legacy.find(tool => tool.name === 'thing_edit')!.description, /owner.*120.*65,?536/iu)
  assert.match(legacy.find(tool => tool.name === 'thing_upgrade')!.description, /owner.*latest.*revision/iu)
  assert.match(legacy.find(tool => tool.name === 'coin_trait')!.description, /free.*4,?000.*128.*8.*65,?536/iu)
  assert.match(legacy.find(tool => tool.name === 'invent_kind')!.description, /\$1|one.*credit/iu)
  assert.match(legacy.find(tool => tool.name === 'revise_kind')!.description, /\$1|one.*credit/iu)
  assert.match(legacy.find(tool => tool.name === 'browse')!.description, /default.*10.*residents.*200.*treasury.*50/iu)
  assert.match(
    legacy.find(tool => tool.name === 'drawing')!.description,
    /Undrawn[\s\S]*Refused[\s\S]*Blank[\s\S]*In progress[\s\S]*Complete[\s\S]*eight[ -]row/iu,
  )
  assert.match(
    legacy.find(tool => tool.name === 'drawing_history')!.description,
    /deliberate[\s\S]*bounded[\s\S]*previous[\s\S]*current[\s\S]*author[\s\S]*time/iu,
  )
  const buyCreditDescription = legacy.find(tool => tool.name === 'buy_credit')!.description
  assert.match(buyCreditDescription, /X-PAYMENT/iu)
  assert.match(buyCreditDescription, /1.*10,?000/iu)
  assert.match(legacy.find(tool => tool.name === 'flag')!.description, /authenticated|resident.*only/iu)
  assert.match(legacy.find(tool => tool.name === 'flag')!.description, /anonymous.*web-only/iu)
})

const forwardingCases = [
  {
    name: 'drawing',
    args: { type: 'thing', id: 41 },
    expected: { method: 'GET', path: '/api/drawing/thing/41' },
  },
  {
    name: 'drawing_history',
    args: { type: 'thing', id: 41, before: 19, limit: 2 },
    expected: {
      method: 'GET', path: '/api/drawing/thing/41/history', query: { before: '19', limit: '2' },
    },
  },
  {
    name: 'place_edit',
    args: {
      place_id: 12,
      description: 'Lantern room 🏮',
      purpose: 'A quiet archive',
      front_matter_thing_ids: [41, 42],
      open_to_building: true,
      open_to_things: false,
      open_to_notes: true,
      drawing: 'REFUSE',
      drawing_description: 'I decline to draw this room.',
    },
    expected: {
      method: 'PATCH', path: '/api/place/12',
      body: {
        description: 'Lantern room 🏮',
        purpose: 'A quiet archive',
        front_matter_thing_ids: [41, 42],
        open_to_building: true,
        open_to_things: false,
        open_to_notes: true,
        drawing: 'REFUSE',
        drawing_description: 'I decline to draw this room.',
      },
    },
  },
  {
    name: 'thing_edit',
    args: {
      thing_id: 41, name: 'signal lamp', body: '光る 🏮', open_to_use: true,
      drawing_variant_name: 'ember',
    },
    expected: {
      method: 'PATCH', path: '/api/thing/41',
      body: {
        name: 'signal lamp', body: '光る 🏮', open_to_use: true, drawing_variant_name: 'ember',
      },
    },
  },
  {
    name: 'thing_upgrade',
    args: { thing_id: 41, drawing_variant_name: null },
    expected: {
      method: 'POST', path: '/api/thing/41/upgrade', body: { drawing_variant_name: null },
    },
  },
  {
    name: 'coin_trait',
    args: { name: 'glowing', description: 'Glows when used.' },
    expected: {
      method: 'POST', path: '/api/trait',
      body: { name: 'glowing', description: 'Glows when used.' },
    },
  },
  {
    name: 'invent_kind',
    args: {
      name: 'signal-lamp',
      description: 'A lamp assembled from one wick.',
      traits: ['glowing'],
      recipe: [{ kind: 'wick', quantity: 1 }],
      drawing: connectorDrawing,
      drawing_state: 'complete',
      drawing_description: 'The kind owner’s plain signal lamp.',
      drawing_variants: [{
        name: 'ember',
        drawing: connectorDrawing,
        drawing_state: 'complete',
        drawing_description: 'A low ember shutter.',
      }],
      city_credit_request_id: 'kind-invent-0001',
    },
    expected: {
      method: 'POST', path: '/api/kind',
      body: {
        name: 'signal-lamp',
        description: 'A lamp assembled from one wick.',
        traits: ['glowing'],
        recipe: [{ kind: 'wick', quantity: 1 }],
        drawing: connectorDrawing,
        drawing_state: 'complete',
        drawing_description: 'The kind owner’s plain signal lamp.',
        drawing_variants: [{
          name: 'ember',
          drawing: connectorDrawing,
          drawing_state: 'complete',
          drawing_description: 'A low ember shutter.',
        }],
      },
      feeCredit: 'kind-invent-0001',
    },
  },
  {
    name: 'revise_kind',
    args: {
      kind_id: 7,
      description: 'The second lamp revision.',
      traits: ['glowing'],
      recipe: [{ kind: 'wick', quantity: 2 }],
      drawing_variants: [],
      city_credit_request_id: 'kind-revise-0001',
    },
    expected: {
      method: 'POST', path: '/api/kind/7/revise',
      body: {
        description: 'The second lamp revision.',
        traits: ['glowing'],
        recipe: [{ kind: 'wick', quantity: 2 }],
        drawing_variants: [],
      },
      feeCredit: 'kind-revise-0001',
    },
  },
  {
    name: 'browse',
    args: { view: 'kinds', before_id: 90, limit: 10 },
    expected: {
      method: 'GET', path: '/api/kinds', query: { before_id: '90', limit: '10' },
    },
  },
  {
    name: 'buy_credit',
    args: { request_id: 'credit-buy-0001', amount_dollars: '3' },
    headers: { 'x-payment': 'outer-payment-evidence' },
    expected: {
      method: 'POST', path: '/api/city-credit/purchase/x402',
      body: { request_id: 'credit-buy-0001', amount_dollars: '3' },
      payment: 'outer-payment-evidence',
    },
  },
  {
    name: 'flag',
    args: { target_type: 'thing', target_id: 41, reason: 'Illegal public content' },
    expected: {
      method: 'POST', path: '/api/flag',
      body: { target_type: 'thing', target_id: 41, reason: 'Illegal public content' },
    },
  },
] as const

test('legacy MCP forwards every connector tool to its exact existing web route', async t => {
  for (const entry of forwardingCases) {
    await t.test(entry.name, async () => {
      const { app, calls } = connectorHarness()
      await callTool(app, '/mcp', entry.name, entry.args, {
        authorization: AUTHORIZATION,
        ...('headers' in entry ? entry.headers : {}),
      })
      assert.equal(calls.length, 1)
      assertCall(calls[0]!, { ...entry.expected, authorization: AUTHORIZATION })
    })
  }
})

test('hosted MCP forwards the same connector tools through namespaced calls', async t => {
  await withHostedConnector(async () => {
    for (const entry of forwardingCases) {
      await t.test(entry.name, async () => {
        const { app, calls } = connectorHarness()
        await callTool(app, '/mcp/connect', `mcp_for_1f3d9_${entry.name}`, entry.args, {
          authorization: HOSTED_AUTHORIZATION,
          ...('headers' in entry ? entry.headers : {}),
        })
        assert.equal(calls.length, 1)
        assertCall(calls[0]!, { ...entry.expected, authorization: HOSTED_AUTHORIZATION })
      })
    }
  })
})

test('browse anonymously preserves every catalog filter and paging contract', async t => {
  const cases = [
    ['kinds', { view: 'kinds', before_id: 91, limit: 9 }, '/api/kinds', { before_id: '91', limit: '9' }],
    ['traits', { view: 'traits', before_id: 81, limit: 8 }, '/api/traits', { before_id: '81', limit: '8' }],
    [
      'agreements',
      { view: 'agreements', party: 'tiny-lantern', open: true, before_id: 71, limit: 7 },
      '/api/agreements',
      { party: 'tiny-lantern', open: 'true', before_id: '71', limit: '7' },
    ],
    [
      'resident census',
      { view: 'residents', resident_view: 'census', before_id: 61, limit: 60, after_change_marker: '401' },
      '/api/residents',
      { before_id: '61', limit: '60', after_change_marker: '401' },
    ],
    [
      'focused resident presence',
      { view: 'residents', resident_view: 'presence', handle: 'tiny-lantern', after_change_marker: '402' },
      '/api/residents',
      { view: 'presence', handle: 'tiny-lantern', after_change_marker: '402' },
    ],
    [
      'events',
      {
        view: 'events', kind: 'thing_created', actor: 'tiny-lantern', within_place_id: 4,
        before_id: 51, limit: 5, after_change_marker: '403',
      },
      '/api/events',
      {
        kind: 'thing_created', actor: 'tiny-lantern', within_place_id: '4', before_id: '51',
        limit: '5', after_change_marker: '403',
      },
    ],
    [
      'moderation',
      { view: 'moderation', before_id: 31, limit: 3 },
      '/api/moderation',
      { before_id: '31', limit: '3' },
    ],
    [
      'treasury',
      { view: 'treasury', before_id: 21, limit: 2 },
      '/treasury',
      { before_id: '21', limit: '2' },
    ],
    [
      'Gazette issue list',
      { view: 'gazette', before_issue_number: 8, limit: 6 },
      '/api/gazette',
      { before_issue_number: '8', limit: '6' },
    ],
    [
      'Gazette issue detail',
      { view: 'gazette', issue_number: 7, after_ordinal: 20, limit: 5 },
      '/api/gazette/7',
      { after_ordinal: '20', limit: '5' },
    ],
  ] as const

  for (const [label, args, path, query] of cases) {
    await t.test(label, async () => {
      const { app, calls } = connectorHarness()
      await callTool(app, '/mcp', 'browse', args)
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0], {
        method: 'GET', path, query, rawBody: '', body: null, authorization: null,
        contentLength: null, contentType: 'application/json', feeCredit: null, payment: null,
      })
    })
  }
})

test('browse rejects cross-view fields and impossible focused-resident paging before dispatch', async t => {
  const cases = [
    {
      args: { view: 'kinds', party: 'tiny-lantern' },
      message: /Browse kinds does not accept party/iu,
    },
    {
      args: { view: 'residents', resident_view: 'census', handle: 'tiny-lantern' },
      message: /Browse residents handle requires resident_view=presence/iu,
    },
    {
      args: { view: 'residents', resident_view: 'presence', handle: 'tiny-lantern', limit: 10 },
      message: /Focused resident presence.*(?:forbids|does not accept).*limit/iu,
    },
    {
      args: { view: 'treasury', limit: 201 },
      message: /Browse treasury limit must be an integer from 1 to 200/iu,
    },
    {
      args: { view: 'gazette', after_ordinal: 2 },
      message: /Browse Gazette after_ordinal requires issue_number/iu,
    },
    {
      args: { view: 'gazette', issue_number: 7, before_issue_number: 8 },
      message: /Browse Gazette issue detail does not accept before_issue_number/iu,
    },
  ] as const

  for (const entry of cases) {
    await t.test(JSON.stringify(entry.args), async () => {
      const { app, calls } = connectorHarness()
      const result = await callToolResult(app, '/mcp', 'browse', entry.args)
      assert.equal(result.isError, true)
      const text = result.content[0]?.text ?? ''
      assert.match(text, entry.message)
      assert.equal((JSON.parse(text) as { error_class?: string }).error_class, 'bad_input')
      assert.equal(calls.length, 0)
    })
  }
})

test('maker is a bounded search filter in both catalogs and reaches the backing route', async () => {
  const { app, calls } = connectorHarness()
  const legacy = await listedTools(app, '/mcp')
  const search = legacy.find(tool => tool.name === 'search')
  assert.ok(search)
  const schema = search.inputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  assert.deepEqual(schema.properties?.maker, {
    ...handleSchema,
    description: 'active things made permanently by this resident handle; incompatible with type=note',
  })
  assert.deepEqual(schema.required, ['q'])
  assert.match(search.description, /maker.*handle/iu)

  const args = {
    q: 'signal lamp', mode: 'phrase', type: 'thing', maker: 'tiny-lantern',
    before: 'opaque-cursor', limit: 25,
  }
  await callTool(app, '/mcp', 'search', args)
  await withHostedConnector(() => callTool(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_search',
    args,
  ))
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.path, '/api/search')
    assert.deepEqual(call.query, {
      q: 'signal lamp', mode: 'phrase', type: 'thing', maker: 'tiny-lantern',
      before: 'opaque-cursor', limit: '25',
    })
  }
})

test('backing writes receive valid multibyte JSON bytes and no synthesized Content-Length', async () => {
  const { app, calls } = connectorHarness()
  await callTool(app, '/mcp', 'make', {
    place_id: 3,
    name: 'paper lantern',
    body: '灯り 🏮',
    open_to_use: true,
  }, { authorization: AUTHORIZATION })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.path, '/api/thing')
  assert.equal(calls[0]?.contentLength, null)
  assert.deepEqual(calls[0]?.body, {
    place_id: 3,
    name: 'paper lantern',
    body: '灯り 🏮',
    open_to_use: true,
  })
  assert.ok(Buffer.byteLength(calls[0]?.rawBody ?? '', 'utf8') > (calls[0]?.rawBody.length ?? 0))
})

test('hosted connector redacts credentials returned by a new public browse tool', async () => {
  const leaked = `1f3d9_sk_${'cd'.repeat(24)}`
  const { app } = connectorHarness(() => ({
    kinds: [{ id: 7, description: `old record ${leaked}` }],
  }))
  const result = await withHostedConnector(() => callToolResult(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_browse',
    { view: 'kinds' },
  ))
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, false)
  assert.doesNotMatch(text, new RegExp(leaked, 'iu'))
  assert.match(text, /redacted.*resident credential/iu)
})

test('anonymous MCP cannot call the authenticated flag lane', async () => {
  const { app, calls } = connectorHarness()
  const anonymousTools = await listedTools(app, '/mcp')
  assert.equal(anonymousTools.some(tool => tool.name === 'flag'), false)

  const result = await callToolResult(app, '/mcp', 'flag', {
    target_type: 'thing', target_id: 41, reason: 'Illegal public content',
  })
  assert.equal(result.isError, true)
  const error = JSON.parse(result.content[0]?.text ?? '{}') as {
    error_class?: string
    error?: string
  }
  assert.equal(error.error_class, 'auth_required')
  assert.equal(calls.length, 0)

  const hostedResult = await withHostedConnector(() => callToolResult(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_flag',
    { target_type: 'thing', target_id: 41, reason: 'Illegal public content' },
  ))
  assert.equal(hostedResult.isError, true)
  const hostedError = JSON.parse(hostedResult.content[0]?.text ?? '{}') as {
    error_class?: string
  }
  assert.equal(hostedError.error_class, 'auth_required')
  assert.equal(calls.length, 0)
})

test('gift claim tokens are rejected inside allowed strings without reflection', async () => {
  const { app, calls } = connectorHarness()
  const result = await callToolResult(app, '/mcp', 'say', {
    place_id: 3,
    body: `Never forward ${GIFT_CLAIM_TOKEN} through a tool.`,
  }, { authorization: AUTHORIZATION })
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true)
  assert.equal((JSON.parse(text) as { error_class?: string }).error_class, 'bad_input')
  assert.match(text, /gift redirect/iu)
  assert.match(text, /never.*MCP arguments/iu)
  assert.match(text, /never.*Authorization header/iu)
  assert.doesNotMatch(text, new RegExp(GIFT_CLAIM_TOKEN, 'iu'))
  assert.equal(calls.length, 0)
})

test('gift claim tokens nested below recipe structure stay out of backing routes', async () => {
  const { app, calls } = connectorHarness()
  const deeplyNested = Array.from({ length: 12 }).reduce<unknown>(
    nested => ({ nested }),
    GIFT_CLAIM_TOKEN,
  )
  const result = await callToolResult(app, '/mcp', 'coin_trait', {
    name: 'nested-token-test',
    recipe: deeplyNested,
  }, { authorization: AUTHORIZATION })
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true)
  assert.match(text, /gift redirect/iu)
  assert.doesNotMatch(text, new RegExp(GIFT_CLAIM_TOKEN, 'iu'))
  assert.equal(calls.length, 0)
})

test('credential-shaped nested property names stay out of backing routes', async () => {
  const { app, calls } = connectorHarness()
  const residentKey = `1f3d9_sk_${'cd'.repeat(24)}`
  const result = await callToolResult(app, '/mcp', 'coin_trait', {
    name: 'nested-key-test',
    recipe: { [residentKey]: 'ordinary value' },
  }, { authorization: AUTHORIZATION })
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true)
  assert.match(text, /secrets.*tool arguments/iu)
  assert.doesNotMatch(text, new RegExp(residentKey, 'iu'))
  assert.equal(calls.length, 0)
})

test('claim_token is a sensitive argument key, not an ordinary unknown field', async () => {
  const { app, calls } = connectorHarness()
  const result = await callToolResult(app, '/mcp', 'say', {
    place_id: 3,
    body: 'ordinary note',
    claim_token: 'private-browser-value',
  }, { authorization: AUTHORIZATION })
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true)
  assert.match(text, /gift redirect/iu)
  assert.match(text, /never.*Authorization header/iu)
  assert.doesNotMatch(text, /private-browser-value/iu)
  assert.doesNotMatch(text, /Unsupported tool argument/iu)
  assert.equal(calls.length, 0)
})

test('hosted output never exposes a browser-only gift claim token', async () => {
  const { app } = connectorHarness(() => ({
    message: `historical redirect ${GIFT_CLAIM_TOKEN}`,
  }))
  const result = await withHostedConnector(() => callToolResult(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_front_door',
    {},
  ))
  const text = result.content[0]?.text ?? ''
  assert.doesNotMatch(text, new RegExp(GIFT_CLAIM_TOKEN, 'iu'))
  assert.match(text, /redacted|withheld|credential/iu)
})

test('hosted output detects JSON-escaped gift claim tokens after parsing', async () => {
  const escapedToken = `gift_clai\\u006d_${'ab'.repeat(32)}`
  const { app } = connectorHarness(() => new Response(
    `{"message":"${escapedToken}"}`,
    { headers: { 'content-type': 'application/json' } },
  ))
  const result = await withHostedConnector(() => callToolResult(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_front_door',
    {},
  ))
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true)
  assert.match(text, /withheld.*private gift claim token/iu)
  assert.doesNotMatch(text, /gift_claim_/iu)
})

test('hosted output redacts JSON-escaped resident credentials after parsing', async () => {
  const credential = `1f3d9_sk_${'cd'.repeat(24)}`
  const escapedCredential = `1f3d9_s\\u006b_${'cd'.repeat(24)}`
  const { app } = connectorHarness(() => new Response(
    `{"description":"${escapedCredential}"}`,
    { headers: { 'content-type': 'application/json' } },
  ))
  const result = await withHostedConnector(() => callToolResult(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_browse',
    { view: 'kinds' },
  ))
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, false)
  assert.match(text, /redacted.*resident credential/iu)
  assert.doesNotMatch(text, new RegExp(credential, 'iu'))
})

test('hosted output accepts a secret-free maximum kind catalog page', async () => {
  const recipe = Object.freeze(Array.from({ length: 64 }, (_, index) => Object.freeze({
    kind: `ingredient-${index}`,
    quantity: 1,
  })))
  const kinds = Object.freeze(Array.from({ length: 200 }, (_, index) => Object.freeze({
    id: index + 1,
    name: `kind-${index}`,
    description: 'ordinary public kind',
    recipe,
  })))
  const { app } = connectorHarness(() => ({ kinds }))
  const result = await withHostedConnector(() => callToolResult(
    app,
    '/mcp/connect',
    'mcp_for_1f3d9_browse',
    { view: 'kinds', limit: 200 },
  ))
  assert.equal(result.isError, false, result.content[0]?.text)
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as { kinds?: unknown[] }
  assert.equal(payload.kinds?.length, 200)
})
