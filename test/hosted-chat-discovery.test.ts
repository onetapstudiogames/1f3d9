import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'
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
    assert.match(output, /do not (?:add|create|repair) (?:a |the )?connector/iu, name)
    assert.match(
      output,
      /Hosted chat without Developer Mode[\s\S]{0,240}cannot add[\s\S]{0,180}watch \/window[\s\S]{0,180}\/join/iu,
      name,
    )
  }
})

test('recovery-off discovery does not advertise an unavailable browser route', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', false, true)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', false, true)],
  ] as const) {
    assert.equal(output.includes('/recovery'), false, name)
    assert.equal(output.includes('/join'), true, name)
    assert.equal(output.includes('/rotate'), true, name)
    assert.match(
      output,
      /Recovery stays browser-only and is never an MCP tool; no recovery page is enabled on this deployment/iu,
      name,
    )
    assert.match(output, /permanent (?:resident )?keys? never/iu, name)
    assert.match(output, /Every enabled first-party identity or sign-in (?:door|GET)/iu, name)
  }
})

test('rotation-off discovery strips only unavailable replacement guidance', () => {
  for (const [name, output] of [
    ['front door', hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', true, false)],
    ['llms.txt', hostedChatDiscovery(LLMS, { ready: false }, 'llms', true, false)],
  ] as const) {
    assert.equal(output.includes('/rotate'), false, name)
    assert.equal(output.includes('/join'), true, name)
    assert.equal(output.includes('/recovery'), true, name)
    assert.match(
      output,
      /Rotation stays browser-only and is never an MCP tool; no rotation page is enabled on this deployment/iu,
      name,
    )
    assert.match(output, /Every enabled first-party identity or sign-in (?:door|GET)/iu, name)
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
    assert.equal(output.includes('/rotate'), false, name)
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
    assert.equal(output.includes('/recovery'), false, name)
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
    assert.equal(neither.includes('/recovery'), false, document)
    assert.equal(neither.includes('/rotate'), false, document)

    const rotationOnly = hostedChatDiscovery(source, { ready: false }, document, false, true)
    assert.equal(rotationOnly.includes('/recovery'), false, document)
    assert.equal(rotationOnly.includes('/rotate'), true, document)

    const recoveryOnly = hostedChatDiscovery(source, { ready: false }, document, true, false)
    assert.equal(recoveryOnly.includes('/recovery'), true, document)
    assert.equal(recoveryOnly.includes('/rotate'), false, document)
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
    assert.match(output, /compatible hosted chats/iu, name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/mcp/connect`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/mcp`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/join`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/recovery`), name)
    assert.ok(output.includes(`${PREVIEW_ORIGIN}/rotate`), name)
    assert.match(
      output,
      /read (?:the|this) (?:live |plain-text )?front door[\s\S]{0,180}\bfront_door\b[\s\S]{0,100}(?:connector|tool)[\s\S]{0,180}https:\/\/signin-preview\.example\.test\/[\s\S]{0,120}(?:if|when)[^\n.]{0,100}(?:client|host)[^\n.]{0,100}open URLs?/iu,
      `${name}: connector-first front door read`,
    )
    assert.match(
      output,
      /(?:\bofficial_facts\b[\s\S]{0,180}\/api\/official|\/api\/official[\s\S]{0,180}\bofficial_facts\b)/iu,
      `${name}: connector-native official facts`,
    )
    assert.match(
      output,
      /(?:\bphysics\b[\s\S]{0,180}\/api\/physics|\/api\/physics[\s\S]{0,180}\bphysics\b)/iu,
      `${name}: connector-native physics`,
    )
    assert.match(output, /browser sign-in/iu, name)
    assert.match(output, /never paste (?:a |your )?resident key into chat/iu, name)
    assert.match(output, /(?:local|key-capable) clients/iu, name)
    assert.match(output, /nothing (?:needs to be|is) downloaded/iu, name)
    assert.match(output, /guide (?:the )?human/iu, name)
    assert.match(output, /chatgpt/iu, name)
    assert.ok(
      output.includes('https://developers.openai.com/plugins/deploy/connect-chatgpt'),
      `${name}: official OpenAI connect guide leads`,
    )
    assert.match(output, /official connect guide/iu, name)
    assert.match(output, /security and login/iu, name)
    assert.match(output, /developer mode/iu, name)
    assert.match(output, /chatgpt plugins/iu, name)
    assert.doesNotMatch(output, /advanced settings|scan tools/iu, name)
    assert.match(output, /claude/iu, name)
    assert.match(output, /add custom connector/iu, name)
    assert.match(output, /organization settings\s*->\s*connectors\s*->\s*add\s*->\s*custom\s*->\s*web/iu, name)
    assert.match(output, /members?[^\n]*customize\s*->\s*connectors[^\n]*connect/iu, name)
    assert.match(output, /menu names can change/iu, name)
    assert.match(output, /official (?:custom-)?connector (?:instructions|documentation)/iu, name)
    assert.match(output, /review (?:each )?tool permission/iu, name)
    assert.doesNotMatch(
      output,
      /It may read https:\/\/signin-preview\.example\.test\/ and watch https:\/\/signin-preview\.example\.test\/window\. A human/iu,
      `${name}: no unconditional URL-only fallback`,
    )
    assert.match(
      output,
      /cannot add (?:the (?:city )?)?connector[\s\S]{0,180}read (?:https:\/\/signin-preview\.example\.test\/|the front door)[\s\S]{0,180}only if (?:its|the) host can open (?:those )?URLs/iu,
      `${name}: unavailable host names the URL capability gate`,
    )
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
    const [front, llms, legacy, connector, metadata, join, setup, official] = await Promise.all([
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
  assert.equal(probe.metadata, 200)
  assert.equal(probe.join, 200)
  assert.equal(probe.setup, 200)
  assert.ok(probe.frontText.includes(`${PREVIEW_ORIGIN}/mcp/connect`))
  assert.ok(probe.llmsText.includes(`${PREVIEW_ORIGIN}/mcp/connect`))
  assert.ok(probe.joinText.includes('https://1f3d9.com/mcp/connect'))
  assert.ok(probe.setupText.includes('https://1f3d9.com/mcp/connect'))
  assert.ok(probe.frontText.includes(`${PREVIEW_ORIGIN}/recovery`))
  assert.ok(probe.llmsText.includes(`${PREVIEW_ORIGIN}/recovery`))
  assert.ok(probe.frontText.includes(`${PREVIEW_ORIGIN}/rotate`))
  assert.ok(probe.llmsText.includes(`${PREVIEW_ORIGIN}/rotate`))
})
