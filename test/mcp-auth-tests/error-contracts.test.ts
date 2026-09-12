import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mcp } from '../../src/mcp.ts'
import {
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  setHostedChatFlag,
  createHarness,
  createAuthenticatedLookHarness,
  rpc,
} from '../helpers/mcp-auth-fixtures/fixture.ts'
import type {
  ToolResult,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

export function registerErrorContractTests(): void {
  test('failed tool calls carry a stable machine-readable error class on both doors', async () => {
    const statuses = [
      [400, 'bad_input'],
      [404, 'not_found'],
      [401, 'auth_required'],
      [402, 'payment_required'],
      [403, 'forbidden'],
      [409, 'conflict'],
      [429, 'rate_limited'],
      [500, 'city_fault'],
    ] as const
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      for (const [status, expected] of statuses) {
        const city = new Hono()
        city.all('*', c => c.json({ error: 'downstream detail' }, status))
        const gateway = new Hono()
        gateway.post('/mcp', c => mcp(c, city))
        gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))
        const response = await rpc(gateway, 'tools/call', {
          name: 'say', arguments: { place_id: 2, body: 'hello square' },
        }, authorization, path) as { result: ToolResult }
        assert.equal(response.result.isError, true, `${path} ${status}`)
        const parsed = JSON.parse(response.result.content[0]?.text ?? '{}') as {
          error_class?: string
          http_status?: number
          error?: string
          request_id?: string
        }
        assert.equal(parsed.error_class, expected, `${path} ${status}`)
        assert.equal(parsed.http_status, status, `${path} ${status}`)
        assert.equal(parsed.error, 'downstream detail', `${path} ${status}: body fields preserved`)
        assert.match(parsed.request_id ?? '', /^[0-9a-f-]{36}$/iu, `${path} ${status}`)
      }
    }
  })

  test('a failed city action keeps its caller-facing cause through both MCP doors', async () => {
    const cityFailure = {
      error: 'thing_id is not yours; use a thing you own, or use an open_to_use thing without destructive effects',
      action: {
        id: 45555,
        action: 'use',
        status: 'failed',
        place_id: 303,
        effects_applied: 0,
        error: 'thing_id is not yours; use a thing you own, or use an open_to_use thing without destructive effects',
      },
    }

    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const city = new Hono()
      city.all('*', c => c.json(cityFailure, 403))
      const gateway = new Hono()
      gateway.post('/mcp', c => mcp(c, city))
      gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))

      const response = await rpc(gateway, 'tools/call', {
        name: 'act', arguments: { action: 'use', thing_id: 1183 },
      }, authorization, path) as { result: ToolResult }

      assert.equal(response.result.isError, true, path)
      const parsed = JSON.parse(response.result.content[0]?.text ?? '{}') as {
        error?: string
        error_class?: string
        http_status?: number
        action?: { status?: string; effects_applied?: number; error?: string }
      }
      assert.equal(parsed.error, cityFailure.error, path)
      assert.equal(parsed.error_class, 'forbidden', path)
      assert.equal(parsed.http_status, 403, path)
      assert.equal(parsed.action?.status, 'failed', path)
      assert.equal(parsed.action?.effects_applied, 0, path)
      assert.equal(parsed.action?.error, cityFailure.error, path)
    }
  })

  test('successes stay unwrapped, transport failure is unreachable, pre-flight rejections carry their class', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const city = new Hono()
      city.all('*', c => c.json({ note: { id: 7 } }, 201))
      const gateway = new Hono()
      gateway.post('/mcp', c => mcp(c, city))
      gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))
      const ok = await rpc(gateway, 'tools/call', {
        name: 'say', arguments: { place_id: 2, body: 'plain success' },
      }, authorization, path) as { result: ToolResult }
      assert.equal(ok.result.isError, false, path)
      assert.equal(
        (JSON.parse(ok.result.content[0]?.text ?? '{}') as { error_class?: string }).error_class,
        undefined,
        `${path}: successful results keep their exact downstream shape`,
      )

      const downCity = { request: () => Promise.reject(new Error('down')) } as unknown as Hono
      const downGateway = new Hono()
      downGateway.post('/mcp', c => mcp(c, downCity))
      downGateway.post('/mcp/connect', c => mcp(c, downCity, { hostedChat: true }))
      const failed = await rpc(downGateway, 'tools/call', {
        name: 'say', arguments: { place_id: 2, body: 'x' },
      }, authorization, path) as { result: ToolResult }
      assert.equal(failed.result.isError, true, path)
      assert.equal(
        (JSON.parse(failed.result.content[0]?.text ?? '{}') as { error_class?: string }).error_class,
        'unreachable',
        path,
      )
      assert.equal(
        (JSON.parse(failed.result.content[0]?.text ?? '{}') as { error?: string }).error,
        'the city API could not answer this tool call because its response was unreachable; retry this same tool call later',
        path,
      )

      const harness = createHarness()
      const secret = await rpc(harness.gateway, 'tools/call', {
        name: 'say', arguments: { place_id: 2, body: `keep this out: ${LEGACY_SECRET}` },
      }, authorization, path) as { result: ToolResult }
      assert.equal(
        (JSON.parse(secret.result.content[0]?.text ?? '{}') as { error_class?: string }).error_class,
        'bad_input',
        path,
      )
      assert.doesNotMatch(JSON.stringify(secret), new RegExp(LEGACY_SECRET, 'i'), path)

      for (const call of [
        { name: 'say', arguments: { place_id: 2, body: 'hello', invented: true } },
        { name: 'act', arguments: { action: 'invented', thing_id: 2 } },
        { name: 'drawing', arguments: { type: 'invented', id: 2 } },
      ]) {
        const rejected = await rpc(harness.gateway, 'tools/call', call, authorization, path) as { result: ToolResult }
        const payload = JSON.parse(rejected.result.content[0]?.text ?? '{}') as {
          error_class?: string
          http_status?: number
          request_id?: string
        }
        assert.equal(payload.error_class, 'bad_input', `${path}: ${call.name}`)
        assert.equal(payload.http_status, 400, `${path}: ${call.name}`)
        assert.match(payload.request_id ?? '', /^[0-9a-f-]{36}$/iu, `${path}: ${call.name}`)
      }
    }

    // The public legacy door's unauthenticated pointer is its own auth_required.
    setHostedChatFlag(false)
    const harness = createHarness()
    const anonymous = await rpc(harness.gateway, 'tools/call', {
      name: 'me', arguments: {},
    }, undefined, '/mcp') as { result: ToolResult }
    assert.equal(
      (JSON.parse(anonymous.result.content[0]?.text ?? '{}') as { error_class?: string }).error_class,
      'auth_required',
    )
  })

  test('hosted and legacy MCP reads redact every resident credential family', async () => {
    const credentials = [
      `1f3d9_sk_${'a1'.repeat(24)}`,
      `1f3d9_at_${'b2'.repeat(32)}`,
      `1f3d9_rt_${'c3'.repeat(32)}`,
      `1f3d9_ac_${'d4'.repeat(32)}`,
      `1f3d9_rc_${'e5'.repeat(32)}`,
    ]

    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      for (const credential of credentials) {
        const gateway = createAuthenticatedLookHarness({
          place: { id: 2, name: 'the square', description: `historical ${credential}` },
          subplaces: [],
          things: [],
          notes: [],
        })
        const response = await rpc(
          gateway,
          'tools/call',
          { name: 'look', arguments: { place_id: 2 } },
          authorization,
          path,
        ) as { result: ToolResult }
        const text = response.result.content[0]?.text ?? '{}'
        assert.equal(response.result.isError, false)
        assert.match(JSON.parse(text).place?.description ?? '', /redacted.*resident credential/i)
        assert.doesNotMatch(text, new RegExp(credential, 'i'))
      }
    }
  })

  test('connector-local validation puts one request id in the body and response header', async () => {
    for (const path of ['/mcp', '/mcp/connect'] as const) {
      setHostedChatFlag(path === '/mcp/connect')
      const harness = createHarness()
      const response = await harness.gateway.request(path, {
        method: 'POST',
        headers: {
          authorization: path === '/mcp/connect'
            ? `Bearer ${OAUTH_ACCESS_TOKEN}`
            : `Bearer ${LEGACY_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 91, method: 'tools/call',
          params: { name: 'drawing', arguments: { type: 'unsupported', id: 2 } },
        }),
      })
      const rpcBody = await response.json() as { result: ToolResult }
      const error = JSON.parse(rpcBody.result.content[0]?.text ?? '{}') as {
        request_id?: string
        error_class?: string
      }
      assert.match(error.request_id ?? '', /^[0-9a-f-]{36}$/iu, path)
      assert.equal(response.headers.get('x-request-id'), error.request_id, path)
      assert.equal(response.headers.get('x-1f3d9-error-class'), error.error_class, path)
    }
  })

  test('the hosted door never invites a resident key into chat', async () => {
    setHostedChatFlag(true)
    const { gateway } = createHarness()
    const response = await gateway.request('/mcp/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'me', arguments: {} } }),
    })
    const text = JSON.stringify(await response.json())
    assert.match(text, /Never paste a resident key into chat/)
    assert.doesNotMatch(text, /send it in the HTTP Authorization header/)
  })
}
