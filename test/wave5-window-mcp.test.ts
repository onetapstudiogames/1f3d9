import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

type AdvertisedTool = Readonly<{
  name: string
  description: string
  inputSchema: {
    additionalProperties?: boolean
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  securitySchemes?: Array<{ type: string, scopes?: string[] }>
  _meta?: { securitySchemes?: Array<{ type: string, scopes?: string[] }> }
}>

function toolApp() {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.all('/api/*', c => c.json({
    path: c.req.path,
    query: c.req.query(),
    authorization: c.req.header('authorization') ?? null,
  }))
  return app
}

async function listedTools(app: Hono): Promise<AdvertisedTool[]> {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert.equal(response.status, 200)
  return (await response.json() as { result: { tools: AdvertisedTool[] } }).result.tools
}

async function callAnonymousTool(
  app: Hono,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const result = await callAnonymousToolResult(app, name, args, headers)
  assert.equal(result.isError, false)
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

async function callAnonymousToolResult(
  app: Hono,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const payload = await response.json() as {
    result?: { isError: boolean; content: Array<{ text: string }> }
    error?: { code: number; message: string }
  }
  assert.ok(payload.result, payload.error?.message ?? 'MCP tool call returned no result')
  return payload.result
}

test('the human window has a bounded, accessible Archive search view', () => {
  assert.match(WINDOW_HTML, /data-view="archive"/u)
  assert.match(WINDOW_HTML, /id="archive-panel"[^>]*role="tabpanel"/u)
  for (const id of [
    'archive-query', 'archive-mode', 'archive-type', 'archive-search',
    'archive-results', 'archive-page',
  ]) assert.match(WINDOW_HTML, new RegExp(`id="${id}"`, 'u'), id)

  assert.match(WINDOW_HTML, /value="words"[^>]*>[^<]*Words/iu)
  assert.match(WINDOW_HTML, /value="phrase"[^>]*>[^<]*(?:Exact )?phrase/iu)
  for (const type of ['all', 'note', 'thing']) {
    assert.match(WINDOW_HTML, new RegExp(`value="${type}"`, 'u'), `archive type ${type}`)
  }
  assert.match(WINDOW_HTML, /aria-live="polite"/u)

  assert.match(WINDOW_JS, /VIEWS[^\n]*'archive'/u)
  assert.match(WINDOW_JS, /new URL\('\/api\/search', window\.location\.origin\)/u)
  for (const option of ['q', 'mode', 'type']) {
    assert.match(
      WINDOW_JS,
      new RegExp(`searchParams\\.set\\('${option}'`, 'u'),
      `search option ${option}`,
    )
  }
  assert.match(WINDOW_JS, /searchParams\.set\('limit', '25'\)/u)
  assert.match(WINDOW_JS, /searchParams\.set\('before'/u)

  for (const state of [
    /Searching the archive/u,
    /No public notes or things matched/iu,
    /Search could not be loaded/iu,
    /Retry search/iu,
    /Load older matches/iu,
  ]) assert.match(WINDOW_JS, state)
  assert.match(WINDOW_JS, /Open original/iu)
  assert.match(
    WINDOW_JS,
    /result\.href|'\/api\/'\s*\+\s*result\.type\s*\+\s*'\/'\s*\+\s*String\(result\.id\)/u,
  )
  assert.match(WINDOW_CSS, /\.archive-/u)
  assert.doesNotThrow(() => new Function(WINDOW_JS))
})

test('the window keeps its public change marker only in this page session', () => {
  assert.match(WINDOW_JS, /changeMarker:\s*null/u)
  assert.match(WINDOW_JS, /new URL\('\/api\/changes', window\.location\.origin\)/u)
  assert.match(WINDOW_JS, /searchParams\.set\('since',\s*state\.changeMarker\)/u)
  assert.match(WINDOW_JS, /\.unchanged\s*===\s*true/u)
  assert.match(WINDOW_JS, /change_marker|next_since/u)
  assert.match(WINDOW_JS, /async function refreshUnchangedPresence/u)
  assert.match(WINDOW_JS, /changeState\.status\s*===\s*'unchanged'[\s\S]{0,240}refreshUnchangedPresence/u)
  assert.match(WINDOW_JS, /searchParams\.set\('after_change_marker',\s*minimumMarker\)/u)
  assert.match(WINDOW_JS, /markerCovers\(freshSnapshot\.changeMarker,\s*requiredMarker\)/u)
  assert.match(WINDOW_JS, /freshSnapshotHistories\(snapshot\)/u)
  assert.match(WINDOW_JS, /let authoredRevision\s*=\s*0/u)
  assert.match(WINDOW_JS, /if \(replaceAuthored\) authoredRevision \+= 1/u)
  assert.match(WINDOW_JS, /authoredRevision !== requestAuthoredRevision/u)
  assert.match(WINDOW_JS, /historyRequestUrl\([\s\S]{0,180}requestMarker/u)
  assert.match(WINDOW_JS, /branchRequestUrl\([\s\S]{0,180}requestMarker/u)
  assert.doesNotMatch(WINDOW_JS, /next_since\s*\?\?\s*payload\.change_marker/u)
  assert.doesNotMatch(WINDOW_JS, /localStorage|sessionStorage/u)
  assert.doesNotMatch(WINDOW_JS, /read(?:ing)?_history|seen_by|reader_id/iu)
})

test('anonymous MCP advertises read-only search and change tools with bounded schemas', async () => {
  const app = toolApp()
  const tools = await listedTools(app)
  const search = tools.find(tool => tool.name === 'search')
  const changes = tools.find(tool => tool.name === 'changes')
  assert.ok(search, 'anonymous MCP should advertise search')
  assert.ok(changes, 'anonymous MCP should advertise changes')

  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }
  assert.deepEqual(search.annotations, readAnnotations)
  assert.deepEqual(changes.annotations, readAnnotations)
  assert.equal(search.inputSchema.additionalProperties, false)
  assert.deepEqual(search.inputSchema.required, ['q'])
  assert.deepEqual(search.inputSchema.properties?.mode?.enum, ['words', 'phrase'])
  assert.deepEqual(search.inputSchema.properties?.type?.enum, ['all', 'note', 'thing'])
  assert.equal(search.inputSchema.properties?.q?.maxLength, 256)
  assert.equal(search.inputSchema.properties?.limit?.maximum, 200)
  assert.equal(search.inputSchema.properties?.before?.type, 'string')
  assert.equal(search.inputSchema.properties?.before?.maxLength, 2048)
  assert.match(search.description, /date order|newest/iu)
  assert.match(search.description, /no relevance|not relevance-ranked/iu)
  assert.match(search.description, /exact total/iu)
  assert.match(search.description, /first[- ]page.*marker|retain.*marker/iu)

  assert.equal(changes.inputSchema.additionalProperties, false)
  assert.deepEqual(changes.inputSchema.required ?? [], [])
  assert.equal(changes.inputSchema.properties?.since?.type, 'string')
  assert.equal(changes.inputSchema.properties?.since?.maxLength, 19)
  assert.equal(changes.inputSchema.properties?.limit?.maximum, 200)
  assert.match(changes.description, /caller-held|keep the marker/iu)
  assert.match(changes.description, /since/iu)
  assert.match(changes.description, /next_since/iu)
})

test('hosted MCP marks search and changes no-auth while keeping the compatibility mirror', async () => {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const app = new Hono()
    app.post('/mcp', c => mcp(c, app, { hostedChat: true }))
    const tools = await listedTools(app)
    for (const name of ['search', 'changes']) {
      const tool = tools.find(candidate => candidate.name === name)
      assert.ok(tool, name)
      assert.equal(tool.securitySchemes?.some(scheme => scheme.type === 'noauth'), true, name)
      assert.deepEqual(tool._meta?.securitySchemes, tool.securitySchemes, name)
    }
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
})

test('anonymous MCP forwards only public search and change query fields', async () => {
  const app = toolApp()
  const searched = await callAnonymousTool(app, 'search', {
    q: 'old lantern', mode: 'phrase', type: 'thing', before: 'cursor-token', limit: 25,
  })
  assert.deepEqual(searched, {
    path: '/api/search',
    query: {
      q: 'old lantern', mode: 'phrase', type: 'thing', before: 'cursor-token', limit: '25',
    },
    authorization: null,
  })

  const changed = await callAnonymousTool(app, 'changes', { since: '41', limit: 9 })
  assert.deepEqual(changed, {
    path: '/api/changes',
    query: { since: '41', limit: '9' },
    authorization: null,
  })
})

test('anonymous MCP rejects oversized public cursors before a backing request', async () => {
  let backingCalls = 0
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.all('/api/*', c => {
    backingCalls += 1
    return c.json({ unexpected: c.req.path })
  })

  const cases = [
    ['search', { q: 'lantern', before: 'x'.repeat(2049) }],
    ['changes', { since: '1'.repeat(20) }],
  ] as const
  for (const [name, args] of cases) {
    const result = await callAnonymousToolResult(app, name, args)
    assert.equal(result.isError, true, name)
    assert.equal(JSON.parse(result.content[0]!.text).error_class, 'bad_input', name)
  }
  assert.equal(backingCalls, 0)
})

test('anonymous MCP preserves caller address headers for internal public reads', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.get('/api/search', c => c.json({
    vercel: c.req.header('x-vercel-forwarded-for') ?? null,
    forwarded: c.req.header('x-forwarded-for') ?? null,
  }))

  const result = await callAnonymousTool(app, 'search', { q: 'lantern' }, {
    'x-vercel-forwarded-for': '203.0.113.201, 10.0.0.8',
    'x-forwarded-for': '198.51.100.10, 10.0.0.9',
  })
  assert.deepEqual(result, {
    vercel: '203.0.113.201, 10.0.0.8',
    forwarded: '198.51.100.10, 10.0.0.9',
  })
})

test('anonymous MCP preserves a bounded Retry-After duration on rate-limit errors', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.get('/api/search', c => {
    c.header('Retry-After', '5')
    return c.json({ error: 'public search rate limit reached; retry' }, 429)
  })

  const result = await callAnonymousToolResult(app, 'search', { q: 'lantern' })
  assert.equal(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    error: 'public search rate limit reached; retry',
    error_class: 'rate_limited',
    http_status: 429,
    retry_after_seconds: 5,
  })
})
