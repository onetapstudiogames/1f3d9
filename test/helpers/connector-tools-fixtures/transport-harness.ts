import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mcp } from '../../../src/mcp.ts'
import type { ToolAnnotations } from './catalog-schemas.ts'

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

export const AUTHORIZATION = 'Bearer resident-test-header'
export const HOSTED_AUTHORIZATION = 'Bearer hosted-test-header'

export function connectorHarness(
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

export async function withHostedConnector<Result>(run: () => Promise<Result>): Promise<Result> {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

export async function rpc(
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

export async function listedTools(
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

export async function callToolResult(
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

export async function callTool(
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

export function assertCall(
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
