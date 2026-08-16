import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'
import {
  hostedChatDiscovery,
  hostedChatSigninReadiness,
} from '../src/hosted-chat-discovery.ts'

const PREVIEW_ORIGIN = 'https://signin-preview.example.test'

test('feature-off discovery stays byte-for-byte unchanged', () => {
  const readiness = hostedChatSigninReadiness({
    HOSTED_CHAT_SIGNIN_ENABLED: 'false',
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    HOSTED_CHAT_OAUTH_CLIENTS: '{bad json that must not be read while off',
  })

  assert.deepEqual(readiness, { ready: false })
  assert.equal(hostedChatDiscovery(FRONTDOOR, readiness, 'frontdoor', true), FRONTDOOR)
  assert.equal(hostedChatDiscovery(LLMS, readiness, 'llms', true), LLMS)
})

test('recovery-off discovery does not advertise an unavailable browser route', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', false)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', false)],
  ] as const) {
    assert.equal(output.includes('/recovery'), false, name)
    assert.equal(output.includes('/join'), true, name)
    assert.match(output, /permanent (?:resident )?keys? never/iu, name)
  }
})

test('feature-on discovery points at the exact safe PUBLIC_ORIGIN', () => {
  const readiness = hostedChatSigninReadiness({
    HOSTED_CHAT_SIGNIN_ENABLED: 'true',
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
  })

  assert.deepEqual(readiness, { ready: true, origin: PREVIEW_ORIGIN })
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, readiness, 'frontdoor', true)],
    ['llms.txt', hostedChatDiscovery(LLMS, readiness, 'llms', true)],
  ] as const) {
    assert.match(output, /compatible hosted chats/iu, name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/mcp/connect`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/mcp`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/join`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/recovery`), name)
    assert.match(output, /browser sign-in/iu, name)
    assert.match(output, /never paste (?:a |your )?resident key into chat/iu, name)
    assert.match(output, /(?:local|key-capable) clients/iu, name)
    assert.match(output, /nothing (?:needs to be|is) downloaded/iu, name)
    assert.match(output, /guide (?:the )?human/iu, name)
    assert.match(output, /chatgpt/iu, name)
    assert.match(output, /settings\s*->\s*apps\s*->\s*advanced settings/iu, name)
    assert.match(output, /apps\s*->\s*create/iu, name)
    assert.match(output, /scan tools/iu, name)
    assert.match(output, /web only/iu, name)
    assert.match(output, /claude/iu, name)
    assert.match(output, /add custom connector/iu, name)
    assert.match(output, /organization settings\s*->\s*connectors\s*->\s*add\s*->\s*custom\s*->\s*web/iu, name)
    assert.match(output, /members?[^\n]*customize\s*->\s*connectors[^\n]*connect/iu, name)
    assert.match(output, /menu names can change/iu, name)
    assert.match(output, /official (?:custom-)?connector (?:instructions|documentation)/iu, name)
    assert.match(output, /review (?:each )?tool permission/iu, name)
    assert.equal(output.includes('https://1f3d9.com/mcp/connect'), false, name)
    assert.equal(output.includes('https://1f3d9.com/join'), false, name)
    assert.equal(output.includes('https://1f3d9.com/recovery'), false, name)
  }
})

test('enabled sign-in is unavailable when its origin or approved client source is unsafe', () => {
  for (const environment of [
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
    },
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: 'http://preview.example.test',
      HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
    },
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    },
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: PREVIEW_ORIGIN,
      HOSTED_CHAT_OAUTH_CLIENTS: '{not-json',
    },
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: PREVIEW_ORIGIN,
      HOSTED_CHAT_CIMD_ORIGINS: '{not-json',
    },
  ] as const) {
    assert.deepEqual(hostedChatSigninReadiness(environment), { ready: false })
  }
})

function startupProbe(overrides: Record<string, string | undefined>) {
  const projectRoot = new URL('..', import.meta.url)
  const script = String.raw`
    globalThis.__queries = []
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      globalThis.__queries.push(String(body.query ?? ''))
      return new Response(JSON.stringify({
        command: 'SELECT', rowCount: 0, fields: [], rows: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const { default: app } = await import('./src/index.ts')
    const corsHeaders = { origin: 'https://reader.example.test' }
    const [front, llms, legacy, connector, metadata] = await Promise.all([
      app.request('/', { headers: corsHeaders }),
      app.request('/llms.txt', { headers: corsHeaders }),
      app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      app.request('/mcp/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
      app.request('/.well-known/oauth-authorization-server'),
    ])
    const oauthQueries = globalThis.__queries.filter(query => /oauth_/i.test(query))
    process.stdout.write(JSON.stringify({
      front: front.status,
      frontText: await front.text(),
      frontCors: front.headers.get('access-control-allow-origin'),
      llms: llms.status,
      llmsText: await llms.text(),
      llmsCors: llms.headers.get('access-control-allow-origin'),
      legacy: legacy.status,
      connector: connector.status,
      metadata: metadata.status,
      oauthQueries: oauthQueries.length,
    }))
  `
  const environment = { ...process.env }
  environment.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
  delete environment.HOSTED_CHAT_OAUTH_CLIENTS
  delete environment.HOSTED_CHAT_CIMD_ORIGINS
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
  return spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

test('bad enabled configuration cannot kill public routes or the legacy MCP door', () => {
  for (const overrides of [
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    },
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: PREVIEW_ORIGIN,
      HOSTED_CHAT_OAUTH_CLIENTS: '{not-json',
    },
    {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      PUBLIC_ORIGIN: 'not-an-origin',
      HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
    },
  ]) {
    const result = startupProbe(overrides)
    assert.equal(result.status, 0, result.stderr)
    const probe = JSON.parse(result.stdout) as {
      front: number
      frontText: string
      frontCors: string | null
      llms: number
      llmsText: string
      llmsCors: string | null
      legacy: number
      connector: number
      metadata: number
      oauthQueries: number
    }
    assert.equal(probe.front, 200)
    assert.equal(probe.frontCors, '*')
    assert.equal(probe.llms, 200)
    assert.equal(probe.llmsCors, '*')
    assert.equal(probe.legacy, 200)
    assert.equal(probe.connector, 404)
    assert.equal(probe.metadata, 404)
    assert.equal(probe.oauthQueries, 0)
    assert.equal(
      probe.frontText,
      hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', false),
    )
    assert.equal(
      probe.llmsText,
      hostedChatDiscovery(LLMS, { ready: false }, 'llms', false),
    )
  }
})

test('a ready connector is advertised on both public discovery routes', () => {
  const result = startupProbe({
    HOSTED_CHAT_SIGNIN_ENABLED: 'true',
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
  })
  assert.equal(result.status, 0, result.stderr)
  const probe = JSON.parse(result.stdout) as {
    front: number
    frontText: string
    llms: number
    llmsText: string
    legacy: number
    connector: number
    metadata: number
  }
  assert.equal(probe.front, 200)
  assert.equal(probe.llms, 200)
  assert.equal(probe.legacy, 200)
  assert.notEqual(probe.connector, 404)
  assert.equal(probe.metadata, 200)
  assert.ok(probe.frontText.includes(`${PREVIEW_ORIGIN}/mcp/connect`))
  assert.ok(probe.llmsText.includes(`${PREVIEW_ORIGIN}/mcp/connect`))
  assert.equal(probe.frontText.includes('/recovery'), false)
  assert.equal(probe.llmsText.includes('/recovery'), false)
})
