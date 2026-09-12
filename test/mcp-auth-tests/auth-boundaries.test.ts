import test from 'node:test'
import assert from 'node:assert/strict'
import { setOAuthResidentResolver } from '../../src/core.ts'
import {
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  RESOURCE_METADATA,
  EXISTING_TOOL_NAMES,
  PUBLIC_ANONYMOUS_TOOL_NAMES,
  setHostedChatFlag,
  createHarness,
  rpc,
  listTools,
  toolByName,
} from '../helpers/mcp-auth-fixtures/fixture.ts'
import type {
  ToolResult,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

export function registerAuthBoundaryTests(): void {
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
      const legacyText = legacy.result.content[0]?.text ?? ''
      assert.match(legacyText, /wrong 1F3D9 connector address/i)
      assert.match(legacyText, /remove|delete/i)
      assert.match(legacyText, /create|add/i)
      assert.match(legacyText, /https:\/\/1f3d9\.com\/mcp\/connect\b/i)
      assert.doesNotMatch(legacyText, new RegExp(OAUTH_ACCESS_TOKEN, 'i'))
      assert.equal(legacy.result._meta?.['mcp/www_authenticate'], undefined)

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

  test('legacy initialize plainly distinguishes the key door from ChatGPT browser sign-in', async () => {
    setHostedChatFlag(true)
    const { gateway } = createHarness()
    const initialized = await rpc(gateway, 'initialize', {}, undefined, '/mcp') as {
      result: { instructions: string }
    }

    assert.match(initialized.result.instructions, /key-capable|local client/i)
    assert.match(initialized.result.instructions, /https:\/\/1f3d9\.com\/mcp\b/i)
    assert.match(initialized.result.instructions, /resident key only in the HTTP Authorization header/i)
    assert.match(initialized.result.instructions, /reference\.txt/i)
  })

  test('legacy and hosted instructions never call registration browser-only in the same breath as offering the JSON door', async () => {
    process.env.CODING_IDENTITY_DOORS_ENABLED = 'true'
    process.env.IDENTITY_ROTATION_ENABLED = 'true'
    process.env.IDENTITY_RECOVERY_ENABLED = 'true'
    try {
      for (const [hostedChatFlag, path] of [[false, '/mcp'], [true, '/mcp']] as const) {
        setHostedChatFlag(hostedChatFlag)
        const { gateway } = createHarness()
        const initialized = await rpc(gateway, 'initialize', {}, undefined, path) as {
          result: { instructions: string }
        }
        const text = initialized.result.instructions
        // The opening sentence must not flatly claim "browser-only" (the sole
        // option) once it goes on, moments later, to offer the coding-client
        // JSON identity doors as an alternative -- see hosted-chat-discovery.ts's
        // sibling fix for the same self-contradiction in the front-door mirrors.
        assert.match(text, /Browser clients use \/join/iu, `hostedChat=${hostedChatFlag}`)
        assert.match(text, /coding clients use the enabled JSON identity doors/iu, `hostedChat=${hostedChatFlag}`)
        assert.doesNotMatch(
          text,
          /Registration, rotation, and recovery remain browser-only and are never MCP tools/i,
          `hostedChat=${hostedChatFlag}`,
        )
        assert.match(text, /reference skill/i, `hostedChat=${hostedChatFlag}`)
      }
    } finally {
      delete process.env.CODING_IDENTITY_DOORS_ENABLED
      delete process.env.IDENTITY_ROTATION_ENABLED
      delete process.env.IDENTITY_RECOVERY_ENABLED
      setHostedChatFlag(false)
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
}
