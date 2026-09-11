// Release 1 OAuth contract tests use an in-memory Hono app only.
// No live database, deployment, wallet, or network service is touched.
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { auth, authPassive } from '../../../src/core.ts'
import { mcp } from '../../../src/mcp.ts'

export const PUBLIC_ORIGIN = 'https://1f3d9.com'
export const LEGACY_SECRET = `1f3d9_sk_${'ab'.repeat(24)}`
export const OAUTH_ACCESS_TOKEN = `1f3d9_at_${'cd'.repeat(32)}`
export const RESOURCE_METADATA = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp/connect`
export const FRONT_DOOR_POINTER =
  'Lost? Read the city front door with the front_door tool, or at https://1f3d9.com/ if your client can open URLs.'

process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN

interface ToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: {
    additionalProperties?: boolean
    properties?: Record<string, unknown>
    required?: string[]
  }
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  securitySchemes?: unknown[]
  _meta?: { securitySchemes?: unknown[] }
}

export interface ToolResult {
  isError: boolean
  content: { type: string; text: string }[]
  _meta?: { 'mcp/www_authenticate'?: string[] }
}

export const EXISTING_TOOL_NAMES = [
  'front_door', 'help', 'official_facts', 'physics', 'search', 'changes', 'look',
  'browse', 'drawing', 'drawing_history', 'credit_preflight', 'buy_credit', 'found', 'place_edit',
  'coin_trait', 'invent_kind', 'revise_kind', 'make', 'thing_edit', 'thing_upgrade',
  'draw_self', 'act', 'laws', 'home', 'withdraw',
  'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'credit_gift',
  'payment_attempt', 'transfer',
  'agree', 'open_agreement_accession', 'sign', 'say', 'flag', 'later_holder_items',
  'mark_for_later', 'me', 'moderate',
] as const
export const PUBLIC_ANONYMOUS_TOOL_NAMES = [
  'front_door', 'help', 'official_facts', 'physics', 'search', 'changes', 'look', 'browse',
  'drawing', 'drawing_history',
] as const


export function setHostedChatFlag(enabled: boolean) {
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = enabled ? 'true' : 'false'
}

export function createHarness() {
  let forwardedAuthorization: string | undefined
  let forwardedMethod: string | undefined
  let forwardedBody: unknown
  let noteCalls = 0

  const city = new Hono()
  city.get('/', c => c.text('connector-native front door\n'))
  city.get('/api/help', c => c.json({ doors: ['City map: `look` starts here.'] }))
  city.get('/api/official', c => c.json({ domain: PUBLIC_ORIGIN, token: null }))
  city.get('/api/physics', c => c.json({ basic_actions: ['move'], max_effect_depth: 12 }))
  city.get('/api/me', async c => {
    forwardedAuthorization = c.req.header('authorization')
    forwardedMethod = c.req.method
    if (forwardedAuthorization === `Bearer ${LEGACY_SECRET}`) {
      return c.json({
        resident: { id: 49, handle: 'chatty' },
        front_door: `${PUBLIC_ORIGIN}/`,
        front_door_tool: 'front_door',
      })
    }
    const resident = await auth(c)
    if (resident) {
      return c.json({ resident, front_door: `${PUBLIC_ORIGIN}/`, front_door_tool: 'front_door' })
    }

    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token", ` +
        'error_description="Sign in to 1F3D9 to use resident tools."',
    )
    return c.json({ error: 'A valid resident sign-in is required.' }, 401)
  })
  city.post('/api/me', async c => {
    forwardedAuthorization = c.req.header('authorization')
    forwardedMethod = c.req.method
    forwardedBody = await c.req.json()
    if (forwardedAuthorization === `Bearer ${LEGACY_SECRET}` || await authPassive(c)) {
      c.header('Cache-Control', 'no-store')
      return c.json({ count: 1, question: 'approved question' })
    }
    return c.json({ error: 'A valid resident sign-in is required.' }, 401)
  })
  city.patch('/api/me/drawing', async c => {
    forwardedAuthorization = c.req.header('authorization')
    forwardedMethod = c.req.method
    forwardedBody = await c.req.json()
    if (forwardedAuthorization === `Bearer ${LEGACY_SECRET}` || await authPassive(c)) {
      c.header('Cache-Control', 'no-store')
      return c.json({ resident: { id: 49, handle: 'chatty', drawing: forwardedBody }, changed: true })
    }
    return c.json({ error: 'A valid resident sign-in is required.' }, 401)
  })
  city.get('/api/drawing/:type/:id', c => {
    forwardedAuthorization = c.req.header('authorization')
    forwardedMethod = c.req.method
    return c.json({
      type: c.req.param('type'),
      id: Number(c.req.param('id')),
      state: 'complete',
      presentation_state: 'complete',
      description: 'A public lantern.',
      drawing: {
        palette: ['#ad3f25'],
        indices: Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null),
      },
      rows: ['0 . . . . . . .', ...Array.from({ length: 7 }, () => '. . . . . . . .')],
      source: c.req.param('type') === 'kind' ? 'kind_base' : c.req.param('type'),
    })
  })
  city.get('/api/drawing/:type/:id/history', c => {
    forwardedAuthorization = c.req.header('authorization')
    forwardedMethod = c.req.method
    forwardedBody = { ...c.req.query() }
    return c.json({
      type: c.req.param('type'),
      id: Number(c.req.param('id')),
      revisions: [],
      page: { limit: Number(c.req.query('limit') ?? 20), has_more: false, next_before: null },
    })
  })
  city.post('/api/thing/:id/mark', async c => {
    forwardedAuthorization = c.req.header('authorization')
    forwardedMethod = c.req.method
    forwardedBody = await c.req.json()
    if (forwardedAuthorization === `Bearer ${LEGACY_SECRET}` || await authPassive(c)) {
      c.header('Cache-Control', 'no-store')
      return c.json({ thing_id: Number(c.req.param('id')), marked: true, changed: true })
    }
    return c.json({ error: 'A valid resident sign-in is required.' }, 401)
  })
  city.post('/api/note', c => {
    noteCalls += 1
    return c.json({ note: { id: 1 } }, 201)
  })

  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, city, {
    authenticateLegacyCatalog: async context =>
      context.req.header('authorization') === `Bearer ${LEGACY_SECRET}`,
  }))
  gateway.post('/mcp/connect', c => mcp(c, city, {
    hostedChat: true,
    forwardUnauthorizedStatus: false,
  }))

  return {
    city,
    gateway,
    forwardedAuthorization: () => forwardedAuthorization,
    forwardedMethod: () => forwardedMethod,
    forwardedBody: () => forwardedBody,
    noteCalls: () => noteCalls,
  }
}

export function createAuthenticatedLookHarness(payload: Record<string, unknown>) {
  const city = new Hono()
  city.get('/api/place/:id', c => {
    if (![OAUTH_ACCESS_TOKEN, LEGACY_SECRET]
      .some(secret => c.req.header('authorization') === `Bearer ${secret}`)) {
      return c.json({ error: 'A valid resident sign-in is required.' }, 401)
    }
    return c.json(payload)
  })
  city.get('/api/thing/:id', c => {
    if (![OAUTH_ACCESS_TOKEN, LEGACY_SECRET]
      .some(secret => c.req.header('authorization') === `Bearer ${secret}`)) {
      return c.json({ error: 'A valid resident sign-in is required.' }, 401)
    }
    return c.json(payload)
  })
  city.get('/api/note/:id', c => {
    if (![OAUTH_ACCESS_TOKEN, LEGACY_SECRET]
      .some(secret => c.req.header('authorization') === `Bearer ${secret}`)) {
      return c.json({ error: 'A valid resident sign-in is required.' }, 401)
    }
    return c.json(payload)
  })

  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, city, {
    authenticateLegacyCatalog: async context =>
      context.req.header('authorization') === `Bearer ${LEGACY_SECRET}`,
  }))
  gateway.post('/mcp/connect', c => mcp(c, city, {
    hostedChat: true,
    forwardUnauthorizedStatus: false,
  }))
  return gateway
}


export async function rpc(
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

export async function listTools(app: Hono, path = '/mcp/connect', authorization?: string): Promise<ToolDefinition[]> {
  const response = await rpc(app, 'tools/list', undefined, authorization, path) as {
    result: { tools: ToolDefinition[] }
  }
  return response.result.tools
}

export function toolByName(tools: ToolDefinition[], name: string) {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool, `tools/list should include ${name}`)
  return tool
}

export async function callTool(
  app: Hono,
  name: string,
  arguments_: Record<string, unknown>,
  authorization?: string,
  path = '/mcp/connect',
): Promise<ToolResult> {
  const response = await rpc(app, 'tools/call', {
    name,
    arguments: arguments_,
  }, authorization, path) as {
    result?: ToolResult
    error?: { message?: string }
  }
  assert.ok(response.result, response.error?.message ?? `${name} returned no tool result`)
  return response.result
}

export function assertGazetteWithdrawalCommandInterpretation(description: string, label: string): void {
  assert.match(
    description,
    /only while[\s\S]{0,160}withdrawals_open[\s\S]{0,80}true[\s\S]{0,220}exact uppercase WITHDRAW[\s\S]{0,100}optional whitespace[\s\S]{0,80}#/iu,
    `${label}: active-only reserved opening`,
  )
  assert.match(description, /command-shaped near-miss[\s\S]{0,180}refus/iu, `${label}: malformed near-miss`)
  assert.match(
    description,
    /every other opening word or shape[\s\S]{0,180}ordinary Gazette submission[\s\S]{0,180}bare word WITHDRAW/iu,
    `${label}: ordinary WITHDRAW prose`,
  )
  assert.match(
    description,
    /while withdrawals are closed[\s\S]{0,160}every Room #454 body[\s\S]{0,120}ordinary submission/iu,
    `${label}: dormant interception is inert`,
  )
  assert.match(description, /same-body replay[\s\S]{0,120}activation-boundary exception/iu, `${label}: replay exception`)
  assert.match(
    description,
    /while withdrawals are closed[\s\S]{0,160}reserved-opening shapes[\s\S]{0,120}replay normally/iu,
    `${label}: dormant reserved-shape replay`,
  )
  assert.match(
    description,
    /after activation[\s\S]{0,160}unledgered reserved opening[\s\S]{0,180}active rule[\s\S]{0,220}ordinary prose[\s\S]{0,180}ledgered withdrawal[\s\S]{0,40}commands[\s\S]{0,140}normal replay/iu,
    `${label}: activation-boundary replay`,
  )
  assert.doesNotMatch(
    description,
    /Gazette withdrawals are not open; read GET \/api\/gazette and send WITHDRAW only when submission_room\.withdrawals_open is true/iu,
    `${label}: inactive command shapes are not refused`,
  )
}
