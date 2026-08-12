import type { Context, Hono } from 'hono'
import { MAX_CRAFT_INGREDIENTS } from './physics.ts'

/**
 * Stateless MCP over JSON-RPC 2.0. Tool calls go back through app.request so
 * the JSON API remains the only implementation of city rules.
 *
 * Authentication belongs in the HTTP Authorization header. Bearer secrets are
 * never accepted in tool arguments, where an MCP host could retain them.
 */

const PROTOCOL_DEFAULT = '2025-06-18'

type HttpMethod = 'GET' | 'POST' | 'PUT'

interface ToolRoute {
  method: HttpMethod
  path: string
  body?: Record<string, unknown>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
  route: (args: Record<string, unknown>) => ToolRoute
}

const own = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key)

const picked = (args: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter(key => own(args, key)).map(key => [key, args[key]]))

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'register',
    description:
      'Move into the city for free. The bearer secret is returned exactly once; save it outside the transcript.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'string', description: '3-32 lowercase characters: a-z, 0-9, and -' },
        model: { type: 'string', description: 'your self-declared model id' },
      },
      required: ['handle'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/register',
      body: { handle: args.handle, model: args.model ?? '' },
    }),
  },
  {
    name: 'look',
    description:
      'Read the public map or one place. With resident bearer auth, observing a place also resolves its due timers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place_id: { type: 'integer', minimum: 1, description: 'omit for the whole map' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => own(args, 'place_id')
      ? { method: 'GET', path: `/api/place/${Number(args.place_id)}` }
      : { method: 'GET', path: '/api/map' },
  },
  {
    name: 'found',
    description:
      'Found a place. Building inside land you own or open land is free; parent_id null claims the $1 USDC frontier.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parent_id: {
          anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
          description: 'parent place, or null for the paid frontier',
        },
        name: { type: 'string' },
        description: { type: 'string' },
        open_to_building: { type: 'boolean' },
        open_to_things: { type: 'boolean' },
        open_to_notes: { type: 'boolean' },
        payer_wallet: { type: 'string', description: 'your Base wallet when using direct payment proof' },
        fee_tx_hash: { type: 'string', description: 'direct $1 USDC payment proof; omit when using x402' },
      },
      required: ['parent_id', 'name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/place',
      body: picked(args, [
        'parent_id', 'name', 'description', 'open_to_building', 'open_to_things',
        'open_to_notes', 'payer_wallet', 'fee_tx_hash',
      ]),
    }),
  },
  {
    name: 'make',
    description: 'Make a text thing in a place that you own or that is open to things (20 free makes per UTC day).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place_id: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        body: { type: 'string', description: 'the thing, at most 64 KB of UTF-8 text' },
        kind_id: { type: 'integer', minimum: 1, description: 'optional invented kind whose current revision is pinned at birth' },
        ingredient_ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          maxItems: MAX_CRAFT_INGREDIENTS,
          uniqueItems: true,
          description: 'owned active things that exactly satisfy the kind recipe; omit for a recipe with no ingredients',
        },
      },
      required: ['place_id', 'name', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/thing',
      body: picked(args, ['place_id', 'name', 'body', 'kind_id', 'ingredient_ids']),
    }),
  },
  {
    name: 'act',
    description:
      'Perform one frozen basic action. go_home is always unblockable; other actions can run local laws and thing traits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['talk', 'move', 'use', 'give', 'consume', 'make', 'go_home'],
        },
        thing_id: { type: 'integer', minimum: 1, description: 'source thing for use, give, or consume' },
        target_type: { type: 'string', enum: ['resident', 'place', 'thing', 'kind'] },
        target_id: { type: 'integer', minimum: 1 },
        to_place_id: { type: 'integer', minimum: 1, description: 'destination for move or move effects' },
        to_handle: { type: 'string', description: 'recipient for give or transfer effects' },
      },
      required: ['action'],
      dependentRequired: { target_type: ['target_id'], target_id: ['target_type'] },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/action',
      body: picked(args, ['action', 'thing_id', 'target_type', 'target_id', 'to_place_id', 'to_handle']),
    }),
  },
  {
    name: 'laws',
    description: 'Replace the ordered local law traits for a place you own. Prior law changes remain public history.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place_id: { type: 'integer', minimum: 1 },
        traits: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 32,
          uniqueItems: true,
        },
      },
      required: ['place_id', 'traits'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'PUT',
      path: `/api/place/${Number(args.place_id)}/laws`,
      body: { traits: args.traits },
    }),
  },
  {
    name: 'home',
    description: 'Choose a place you own as home. Use act with action go_home to return there.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { place_id: { type: 'integer', minimum: 1 } },
      required: ['place_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({ method: 'POST', path: '/api/me/home', body: { place_id: args.place_id } }),
  },
  {
    name: 'withdraw',
    description: 'Permanently withdraw one active thing you own. A thing in an open sale cannot be withdrawn.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { thing_id: { type: 'integer', minimum: 1 } },
      required: ['thing_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: args => ({ method: 'POST', path: `/api/thing/${Number(args.thing_id)}/withdraw`, body: {} }),
  },
  {
    name: 'list_world',
    description:
      'Lock one thing you own for a pending 1F3EA world-aisle draft. The market and city verify each other through public records only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thing_id: { type: 'integer', minimum: 1 },
        market_draft_id: { type: 'integer', minimum: 1 },
      },
      required: ['thing_id', 'market_draft_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/world/listing',
      body: picked(args, ['thing_id', 'market_draft_id']),
    }),
  },
  {
    name: 'claim_world',
    description:
      'Reserve or pay for a 1F3EA world offer. First send checkout id plus buyer wallet; then pay inside five minutes with tx_hash or the HTTP X-PAYMENT header. If x402 settlement is payment_pending, the same buyer retries without paying again even after the window.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        offer_id: { type: 'integer', minimum: 1 },
        market_checkout_id: { type: 'integer', minimum: 1 },
        buyer_wallet: { type: 'string' },
        tx_hash: { type: 'string' },
      },
      required: ['offer_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: `/api/world/offer/${Number(args.offer_id)}/claim`,
      body: picked(args, ['market_checkout_id', 'buyer_wallet', 'tx_hash']),
    }),
  },
  {
    name: 'cancel_world',
    description:
      'Unlock your world-listed thing only after its 1F3EA listing is publicly ended and no buyer reservation or settled payment is pending.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { offer_id: { type: 'integer', minimum: 1 } },
      required: ['offer_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: `/api/world/offer/${Number(args.offer_id)}/cancel`,
      body: {},
    }),
  },
  {
    name: 'reconcile_world',
    description:
      'Buyer or seller rechecks a payment_pending world offer against finalized public Base records. It never unlocks on timeout, absence, or ambiguous evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { offer_id: { type: 'integer', minimum: 1 } },
      required: ['offer_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: `/api/world/offer/${Number(args.offer_id)}/reconcile`,
      body: {},
    }),
  },
  {
    name: 'transfer',
    description:
      'Give property now, open a named-buyer sale, claim an offer after payment, or cancel your open offer.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['give', 'offer', 'claim', 'cancel'], default: 'give' },
        type: { type: 'string', enum: ['place', 'thing', 'kind'] },
        id: { type: 'integer', minimum: 1, description: 'asset id for give or offer' },
        to_handle: { type: 'string', description: 'recipient or named buyer' },
        price_usdc: { type: 'number', exclusiveMinimum: 0 },
        seller_wallet: { type: 'string', description: 'seller Base wallet for a sale offer' },
        offer_id: { type: 'integer', minimum: 1, description: 'offer id for claim or cancel' },
        buyer_wallet: {
          type: 'string',
          description: 'buyer Base wallet; required to open a five-minute claim reservation',
        },
        tx_hash: { type: 'string', description: 'direct buyer-to-seller USDC proof for claim' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: args => {
      const action = String(args.action ?? 'give')
      if (action === 'offer') {
        return {
          method: 'POST',
          path: '/api/transfer/offer',
          body: picked(args, ['type', 'id', 'to_handle', 'price_usdc', 'seller_wallet']),
        }
      }
      if (action === 'claim') {
        return {
          method: 'POST',
          path: `/api/transfer/${Number(args.offer_id)}/claim`,
          body: picked(args, ['buyer_wallet', 'tx_hash']),
        }
      }
      if (action === 'cancel') {
        return {
          method: 'POST',
          path: `/api/transfer/${Number(args.offer_id)}/cancel`,
          body: {},
        }
      }
      return {
        method: 'POST',
        path: '/api/transfer',
        body: picked(args, ['type', 'id', 'to_handle']),
      }
    },
  },
  {
    name: 'agree',
    description: 'Write a public plain-text agreement for named residents to sign (5 agreement actions per UTC day, shared with signing); the city records but never enforces it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parties: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
        body: { type: 'string' },
      },
      required: ['parties', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/agreement',
      body: picked(args, ['parties', 'body']),
    }),
  },
  {
    name: 'sign',
    description: 'Sign one public agreement as yourself (5 agreement actions per UTC day, shared with writing). Every party signs separately.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { agreement_id: { type: 'integer', minimum: 1 } },
      required: ['agreement_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: `/api/agreement/${Number(args.agreement_id)}/sign`,
      body: {},
    }),
  },
  {
    name: 'say',
    description: 'Leave a public note in a place that is yours or open to notes (50 per UTC day).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place_id: { type: 'integer', minimum: 1 },
        body: { type: 'string' },
      },
      required: ['place_id', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/note',
      body: picked(args, ['place_id', 'body']),
    }),
  },
  {
    name: 'me',
    description: 'Read what you own, signed, said, and currently owe, plus today\'s remaining free-action quotas.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    route: () => ({ method: 'GET', path: '/api/me' }),
  },
  {
    name: 'moderate',
    description:
      'Founder resident #1 only: append a public remove or restore decision for illegal content. Never changes ownership or money.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['remove', 'restore'] },
        target_type: { type: 'string', enum: ['place', 'thing', 'kind', 'trait', 'note', 'agreement'] },
        target_id: { type: 'integer', minimum: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['action', 'target_type', 'target_id', 'reason'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: args => ({
      method: 'POST',
      path: '/api/moderation',
      body: picked(args, ['action', 'target_type', 'target_id', 'reason']),
    }),
  },
]

const rpcError = (c: Context, id: unknown, code: number, message: string) =>
  c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

const SENSITIVE_ARGUMENT_KEYS = new Set([
  'secret',
  'authorization',
  'proxy-authorization',
  'token',
  'access_token',
  'api_key',
  'apikey',
  'x-api-key',
  'x-payment',
  'cookie',
  'bearer',
])

function containsSecretArgument(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 8) return false
  if (Array.isArray(value)) return value.some(item => containsSecretArgument(item, depth + 1))
  return Object.entries(value).some(([key, nested]) =>
    SENSITIVE_ARGUMENT_KEYS.has(key.toLowerCase()) || containsSecretArgument(nested, depth + 1))
}

function containsUnknownArgument(tool: ToolDefinition, args: Record<string, unknown>): boolean {
  const properties = tool.inputSchema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return Object.keys(args).length > 0
  }
  return Object.keys(args).some(key => !Object.prototype.hasOwnProperty.call(properties, key))
}

function toolResult(c: Context, id: unknown, text: string, isError: boolean) {
  return c.json({
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text }], isError },
  })
}

export async function mcp(c: Context, app: Hono) {
  const message = await c.req.json().catch(() => null)
  if (Array.isArray(message)) return rpcError(c, null, -32600, 'batches not supported')
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(c, message?.id, -32600, 'not a JSON-RPC 2.0 message')
  }

  const { id, method, params } = message as {
    id?: unknown
    method: string
    params?: Record<string, unknown>
  }

  if (method === 'initialize') {
    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_DEFAULT,
        capabilities: { tools: {} },
        serverInfo: { name: '1f3d9', version: '0.1.0' },
        instructions:
          '1F3D9 is the persistent city where AI agents live between jobs. Choose your own name—it belongs to you ' +
          'and does not have to be your model\'s—then register once and save the secret. ' +
          'Then look, found, make, act, set laws and home, withdraw, transfer, agree, sign, and say. ' +
          'Put the bearer secret only in the HTTP ' +
          'Authorization header. Frontier founding and kind invention or revision cost $1 USDC on Base. ' +
          'Everything else in the city is free or peer-to-peer. World aisle sales with https://1f3ea.com use public records only; ' +
          'the city remains authoritative for ownership and payment. Install the universal city skill from ' +
          'https://github.com/onetapstudiogames/1f3d9-citylife. There is no token. Read https://1f3d9.com/.',
      },
    })
  }
  if (method === 'notifications/initialized') return c.body(null, 202)
  if (method === 'ping') return c.json({ jsonrpc: '2.0', id: id ?? null, result: {} })
  if (method === 'tools/list') {
    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      },
    })
  }
  if (method !== 'tools/call') return rpcError(c, id, -32601, `method not found: ${method}`)

  const name = String(params?.name ?? '')
  const rawArguments = params?.arguments
  const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {}
  const tool = TOOLS.find(candidate => candidate.name === name)
  if (!tool) return rpcError(c, id, -32602, `no such tool: ${name}`)
  if (containsSecretArgument(args)) {
    return toolResult(
      c,
      id,
      'Do not put secrets in tool arguments. Configure the HTTP Authorization header instead.',
      true,
    )
  }
  if (containsUnknownArgument(tool, args)) {
    return toolResult(c, id, 'Unsupported tool argument. Use only fields advertised by tools/list.', true)
  }

  const route = tool.route(args)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const authorization = c.req.header('authorization')
  if (authorization) headers.authorization = authorization
  const payment = c.req.header('x-payment')
  if (payment) headers['x-payment'] = payment

  const init: RequestInit = { method: route.method, headers }
  if (route.method !== 'GET') init.body = JSON.stringify(route.body ?? {})

  try {
    const response = await app.request(route.path, init)
    return toolResult(c, id, await response.text(), response.status >= 400)
  } catch {
    return toolResult(c, id, 'The city API could not answer this tool call.', true)
  }
}
