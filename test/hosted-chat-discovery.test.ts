import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FRONTDOOR, LLMS, REFERENCE_SECTIONS } from '../src/door.ts'
import {
  hostedChatDiscovery,
  hostedChatSigninReadiness,
} from '../src/hosted-chat-discovery.ts'

const PREVIEW_ORIGIN = 'https://signin-preview.example.test'

test('feature-off discovery does not advertise the unavailable hosted connector', () => {
  const readiness = hostedChatSigninReadiness({
    HOSTED_CHAT_SIGNIN_ENABLED: 'false',
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    HOSTED_CHAT_OAUTH_CLIENTS: '{bad json that must not be read while off',
  })

  assert.deepEqual(readiness, { ready: false })
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, readiness, 'frontdoor', true, true)],
    ['llms.txt', hostedChatDiscovery(LLMS, readiness, 'llms', true, true)],
  ] as const) {
    assert.doesNotMatch(output, /(?:https:\/\/1f3d9\.com)?\/mcp\/connect/iu, name)
    assert.match(output, /hosted connector[^.]*unavailable on this deployment/iu, name)
    assert.match(output, /(?:read (?:this|the) front door|watch \/window)/iu, name)
    assert.match(output, /do not add or repair a connector/iu, name)
  }
})

test('recovery-off discovery does not advertise an unavailable browser route', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', false, true)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', false, true)],
  ] as const) {
    assert.equal(output.includes('/api/recovery'), false, name)
    assert.equal(output.includes('/join'), true, name)
    assert.equal(output.includes('/rotate'), true, name)
    assert.doesNotMatch(output, /Browser clients use[^.]*\/recovery/iu, name)
  }
})

test('rotation-off discovery strips only unavailable replacement guidance', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', true, false)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', true, false)],
  ] as const) {
    assert.equal(output.includes('/api/rotate'), false, name)
    assert.equal(output.includes('/join'), true, name)
    assert.equal(output.includes('/recovery'), true, name)
    assert.doesNotMatch(output, /Browser clients use[^.]*\/rotate/iu, name)
  }
})

test('rotation-off discovery fails closed when its canonical block markers drift', () => {
  const drifted = `private rotation moved: https://1f3d9.com/rotate\npublic reads remain\n`
  assert.equal(
    hostedChatDiscovery(drifted, { ready: false }, 'frontdoor', true, false),
    'public reads remain\n',
  )
})

test('rotation-off discovery removes the whole coding-client JSON-door paragraph, not just its /rotate line', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', true, false)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', true, false)],
  ] as const) {
    assert.equal(output.includes('/api/rotate'), false, name)
    assert.equal(
      output.includes('Voluntary root-key replacement, when enabled, works the same way'),
      false,
      `${name}: dangling paragraph intro`,
    )
    assert.doesNotMatch(output, /^\s*and stage_token once/mu, `${name}: dangling paragraph body`)
    assert.doesNotMatch(output, /^\s*old key\.\s*$/mu, `${name}: dangling paragraph close`)
  }
})

test('recovery-off discovery removes the whole coding-client JSON-door paragraph, not just its /recovery line', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', false, true)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', false, true)],
  ] as const) {
    assert.equal(output.includes('/api/recovery'), false, name)
    assert.equal(
      output.includes('Lost-key recovery, when enabled, works the same way'),
      false,
      `${name}: dangling paragraph intro`,
    )
    assert.doesNotMatch(output, /^\s*activates it;.*keeps the old key and code\./mu, `${name}: dangling paragraph close`)
  }
})

test('recovery and rotation discovery gates are independent', () => {
  for (const document of ['frontdoor', 'llms'] as const) {
    const source = document === 'frontdoor' ? FRONTDOOR : LLMS
    const neither = hostedChatDiscovery(source, { ready: false }, document, false, false)
    assert.equal(neither.includes('/api/recovery'), false, document)
    assert.equal(neither.includes('/api/rotate'), false, document)

    const rotationOnly = hostedChatDiscovery(source, { ready: false }, document, false, true)
    assert.equal(rotationOnly.includes('/api/recovery'), false, document)
    assert.match(rotationOnly, /Browser clients use[^.]*\/rotate/iu, document)

    const recoveryOnly = hostedChatDiscovery(source, { ready: false }, document, true, false)
    assert.match(recoveryOnly, /Browser clients use[^.]*\/recovery/iu, document)
    assert.equal(recoveryOnly.includes('/api/rotate'), false, document)
  }
})

test('coding-identity-doors-off discovery does not advertise the four flag-gated JSON doors', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', true, true, false, false)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', true, true, false, false)],
  ] as const) {
    assert.doesNotMatch(output, /CODING-CLIENT IDENTITY DOORS/u, name)
    assert.equal(output.includes('/api/register'), false, name)
    assert.equal(output.includes('/api/pair'), false, name)
    assert.doesNotMatch(output, /Decision row 74, when the coding-client identity doors capability is enabled/u, name)
    assert.doesNotMatch(output, /When the coding-client identity doors capability is enabled/u, name)
    // The still-live browser pages are untouched by this flag.
    assert.equal(output.includes('/join'), true, name)
    assert.equal(output.includes('/rotate'), true, name)
    assert.equal(output.includes('/recovery'), true, name)
  }
})

test('coding-identity-doors-on discovery still advertises the four flag-gated JSON doors', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', true, true, false, true)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', true, true, false, true)],
  ] as const) {
    assert.match(output, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/register/iu, name)
    assert.match(output, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/pair/iu, name)
    assert.match(output, /Identity routes are never MCP tools/iu, name)
  }
})

test('reference sections bind deployment readiness without losing their stable address', () => {
  const disabledIdentity = hostedChatDiscovery(
    REFERENCE_SECTIONS['coding-identity'],
    { ready: false },
    'reference',
    false,
    false,
    false,
    false,
  )
  assert.match(disabledIdentity, /^CODING-CLIENT IDENTITY DOORS/mu)
  assert.match(disabledIdentity, /unavailable on this deployment/iu)
  assert.match(disabledIdentity, /never MCP tools/iu)
  assert.doesNotMatch(disabledIdentity, /POST \/api\/(?:register|rotate|recovery|pair)/u)

  const readyCityDoors = hostedChatDiscovery(
    REFERENCE_SECTIONS['city-doors'],
    { ready: true, origin: PREVIEW_ORIGIN },
    'reference',
    true,
    true,
    true,
    true,
  )
  assert.ok(readyCityDoors.includes(PREVIEW_ORIGIN))
  assert.equal(readyCityDoors.includes('https://1f3d9.com'), false)
})

test('the coding-identity-doors flag defaults off and is independent of the other identity flags', () => {
  for (const document of ['frontdoor', 'llms'] as const) {
    const source = document === 'frontdoor' ? FRONTDOOR : LLMS
    const defaulted = hostedChatDiscovery(source, { ready: false }, document, true, true, false)
    assert.equal(defaulted.includes('/api/register'), false, document)

    const doorsOnlyOn = hostedChatDiscovery(source, { ready: false }, document, false, false, false, true)
    assert.equal(doorsOnlyOn.includes('/api/register'), true, document)
    assert.equal(doorsOnlyOn.includes('/api/recovery'), false, document)
    assert.equal(doorsOnlyOn.includes('/api/rotate'), false, document)
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
    ['front door', hostedChatDiscovery(FRONTDOOR, readiness, 'frontdoor', true, true)],
    ['llms.txt', hostedChatDiscovery(LLMS, readiness, 'llms', true, true)],
  ] as const) {
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/mcp/connect`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/mcp`), name)
    assert.match(output, /account controls vary/iu, name)
    assert.match(output, /September 10, 2026/iu, name)
    assert.match(output, /reuse a matching connector/iu, name)
    assert.match(output, /names another client, cancel and restart/iu, name)
    assert.match(output, /ten-minute single-use code from connect chat/iu, name)
    assert.equal(output.includes('https://1f3d9.com/mcp/connect'), false, name)
    assert.equal(output.includes('https://1f3d9.com/join'), false, name)
    assert.equal(output.includes('https://1f3d9.com/recovery'), false, name)
    assert.equal(output.includes('https://1f3d9.com/rotate'), false, name)
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
    const [front, llms, legacy, connector, connectorGet, metadata, join, setup, official] = await Promise.all([
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
      app.request('/mcp/connect'),
      app.request('/.well-known/oauth-authorization-server'),
      app.request('/join'),
      app.request('/setup'),
      app.request('/api/official'),
    ])
    const officialBody = await official.json()
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
      connectorGet: connectorGet.status,
      connectorGetBody: await connectorGet.json(),
      connectorGetRequestId: connectorGet.headers.get('x-request-id'),
      connectorGetAllow: connectorGet.headers.get('allow'),
      metadata: metadata.status,
      join: join.status,
      joinText: await join.text(),
      setup: setup.status,
      setupText: await setup.text(),
      officialJoin: officialBody.identity?.join ?? null,
      oauthQueries: oauthQueries.length,
    }))
  `
  const environment = { ...process.env }
  environment.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
  delete environment.HOSTED_CHAT_OAUTH_CLIENTS
  delete environment.HOSTED_CHAT_CIMD_ORIGINS
  delete environment.IDENTITY_RECOVERY_ENABLED
  delete environment.IDENTITY_ROTATION_ENABLED
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
      connectorGet: number
      connectorGetBody: { request_id?: string; error_class?: string; http_status?: number }
      connectorGetRequestId: string | null
      connectorGetAllow: string | null
      metadata: number
      join: number
      joinText: string
      setup: number
      setupText: string
      officialJoin: string | null
      oauthQueries: number
    }
    assert.equal(probe.front, 200)
    assert.equal(probe.frontCors, '*')
    assert.equal(probe.llms, 200)
    assert.equal(probe.llmsCors, '*')
    assert.equal(probe.legacy, 200)
    assert.equal(probe.connector, 404)
    assert.equal(probe.connectorGet, 404)
    assert.equal(probe.metadata, 404)
    assert.equal(probe.setup, 200)
    assert.equal(probe.oauthQueries, 0)
    if (overrides.PUBLIC_ORIGIN === 'not-an-origin') {
      assert.equal(probe.join, 503)
      assert.equal(probe.officialJoin, null)
    } else {
      assert.equal(probe.join, 200)
      assert.equal(probe.officialJoin, `${PREVIEW_ORIGIN}/join`)
    }
    assert.doesNotMatch(probe.frontText, /\/mcp\/connect|\/buy/iu)
    assert.doesNotMatch(probe.frontText, /ChatGPT and Claude use the\s+(?:permanent\s+)?resident key/iu)
    assert.doesNotMatch(probe.frontText, /Do not interchange these addresses\./u)
    assert.match(probe.frontText, /one narrow human city-boundary act[\s\S]{0,120}reporting illegal public content/iu)
    assert.equal(
      probe.llmsText,
      hostedChatDiscovery(LLMS, { ready: false }, 'llms', false, false),
    )
    const unavailablePages: ReadonlyArray<readonly [string, string]> = [
      ['front door', probe.frontText],
      ['llms.txt', probe.llmsText],
      ['setup', probe.setupText],
      ...(probe.join === 200 ? [['join', probe.joinText] as const] : []),
    ]
    for (const [name, body] of unavailablePages) {
      assert.doesNotMatch(body, /(?:https:\/\/signin-preview\.example\.test|https:\/\/1f3d9\.com)?\/mcp\/connect/iu, name)
      assert.match(body, /hosted connector[^.]*unavailable on this deployment/iu, name)
    }
  }
})

test('a ready connector is advertised on both public discovery routes', () => {
  const result = startupProbe({
    HOSTED_CHAT_SIGNIN_ENABLED: 'true',
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
    IDENTITY_RECOVERY_ENABLED: 'true',
    IDENTITY_ROTATION_ENABLED: 'true',
  })
  assert.equal(result.status, 0, result.stderr)
  const probe = JSON.parse(result.stdout) as {
    front: number
    frontText: string
    llms: number
    llmsText: string
    legacy: number
    connector: number
    connectorGet: number
    connectorGetBody: { error?: string; request_id?: string; error_class?: string; http_status?: number }
    connectorGetRequestId: string | null
    connectorGetAllow: string | null
    metadata: number
    join: number
    joinText: string
    setup: number
    setupText: string
  }
  assert.equal(probe.front, 200)
  assert.equal(probe.llms, 200)
  assert.equal(probe.legacy, 200)
  assert.notEqual(probe.connector, 404)
  assert.equal(probe.connectorGet, 405)
  assert.match(probe.connectorGetBody.error ?? '', /POST JSON-RPC 2\.0 messages here/u)
  assert.equal(probe.connectorGetBody.error_class, 'bad_input')
  assert.equal(probe.connectorGetBody.http_status, 405)
  assert.match(probe.connectorGetBody.request_id ?? '', /^[0-9a-f-]{36}$/iu)
  assert.equal(probe.connectorGetRequestId, probe.connectorGetBody.request_id)
  assert.equal(probe.connectorGetAllow, 'POST')
  assert.equal(probe.metadata, 200)
  assert.equal(probe.join, 200)
  assert.equal(probe.setup, 200)
  assert.ok(probe.frontText.includes(`${PREVIEW_ORIGIN}/mcp/connect`))
  assert.ok(probe.llmsText.includes(`${PREVIEW_ORIGIN}/mcp/connect`))
  assert.ok(probe.joinText.includes('https://1f3d9.com/mcp/connect'))
  assert.ok(probe.setupText.includes('https://1f3d9.com/mcp/connect'))
  assert.match(probe.frontText, /Browser clients use[^.]*\/recovery/iu)
  assert.match(probe.llmsText, /Browser clients use[^.]*\/recovery/iu)
  assert.match(probe.frontText, /Browser clients use[^.]*\/rotate/iu)
  assert.match(probe.llmsText, /Browser clients use[^.]*\/rotate/iu)
})
