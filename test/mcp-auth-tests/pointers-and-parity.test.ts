import test from 'node:test'
import assert from 'node:assert/strict'
import { setOAuthResidentResolver } from '../../src/core.ts'
import {
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  setHostedChatFlag,
  createHarness,
  rpc,
  listTools,
  toolByName,
} from '../helpers/mcp-auth-fixtures/fixture.ts'
import type {
  ToolResult,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

export function registerPointerAndParityTests(): void {
  test('JSON-RPC shape refusals say how to form the next request', async () => {
    const { gateway } = createHarness()
    const headers = { 'Content-Type': 'application/json' }

    const batchResponse = await gateway.request('/mcp/connect', {
      method: 'POST',
      headers,
      body: JSON.stringify([]),
    })
    assert.equal(batchResponse.status, 200)
    const batch = await batchResponse.json() as { error: { message: string } }
    assert.equal(
      batch.error.message,
      'JSON-RPC batches are not supported; send one JSON-RPC 2.0 request object at a time',
    )

    const malformedResponse = await gateway.request('/mcp/connect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 1, method: 'ping' }),
    })
    assert.equal(malformedResponse.status, 200)
    const malformed = await malformedResponse.json() as { error: { message: string } }
    assert.equal(
      malformed.error.message,
      'request is not a JSON-RPC 2.0 message; send one object with jsonrpc "2.0" and a supported method',
    )
  })

  test('successful me results preserve connector and URL front-door pointers on both MCP doors', async () => {
    setHostedChatFlag(true)
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
      const { gateway } = createHarness()
      for (const [path, authorization] of [
        ['/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
        ['/mcp', `Bearer ${LEGACY_SECRET}`],
      ] as const) {
        const response = await rpc(
          gateway,
          'tools/call',
          { name: 'me', arguments: {} },
          authorization,
          path,
        ) as { result: ToolResult }
        assert.equal(response.result.isError, false, path)
        const payload = JSON.parse(response.result.content[0]?.text ?? '{}') as {
          front_door?: string
          front_door_tool?: string
        }
        assert.equal(payload.front_door, 'https://1f3d9.com/', path)
        assert.equal(payload.front_door_tool, 'front_door', path)
      }
    } finally {
      setOAuthResidentResolver(null)
    }
  })

  test('world payment tools distinguish the five-minute reservation from bounded recovery on both doors', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)
      const claim = toolByName(tools, 'claim_world')
      const reconcile = toolByName(tools, 'reconcile_world')
      const cancel = toolByName(tools, 'cancel_world')

      assert.match(claim.description, /five-minute city reservation/iu, `${path}: reservation`)
      assert.match(claim.description, /payment_pending[\s\S]*two-hour recovery window/iu, `${path}: recovery`)
      assert.match(claim.description, /without paying again/iu, `${path}: no duplicate payment`)
      assert.doesNotMatch(claim.description, /even after the window/iu, `${path}: ambiguous window`)

      assert.match(reconcile.description, /two-hour recovery[\s\S]*terminal/iu, `${path}: terminal recovery`)
      assert.match(reconcile.description, /market-first cancellation[\s\S]*release/iu, `${path}: release order`)
      assert.doesNotMatch(reconcile.description, /never unlocks on timeout/iu, `${path}: stale timeout claim`)

      assert.match(cancel.description, /market listing is terminal/iu, `${path}: terminal market state`)
      assert.match(cancel.description, /no live reservation or payment_pending/iu, `${path}: live payment guard`)
    }
  })

  test('both MCP doors keep every shared tool label, input, and safety hint identical', async () => {
    setHostedChatFlag(true)
    const hostedHarness = createHarness()
    const hostedTools = await listTools(
      hostedHarness.gateway,
      '/mcp/connect',
      `Bearer ${OAUTH_ACCESS_TOKEN}`,
    )

    setHostedChatFlag(false)
    const keyHarness = createHarness()
    const keyTools = await listTools(keyHarness.gateway, '/mcp', `Bearer ${LEGACY_SECRET}`)

    for (const hostedTool of hostedTools) {
      const keyTool = toolByName(keyTools, hostedTool.name)
      assert.deepEqual({
        title: hostedTool.title,
        description: hostedTool.description,
        inputSchema: hostedTool.inputSchema,
        annotations: hostedTool.annotations,
      }, {
        title: keyTool.title,
        description: keyTool.description,
        inputSchema: keyTool.inputSchema,
        annotations: keyTool.annotations,
      }, hostedTool.name)
      assert.equal(hostedTool.inputSchema.additionalProperties, false, `${hostedTool.name}: closed input`)
      assert.deepEqual(Object.keys(hostedTool.annotations ?? {}).sort(), [
        'destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint',
      ], `${hostedTool.name}: complete safety labels`)
      assert.equal(
        Object.values(hostedTool.annotations ?? {}).every(value => typeof value === 'boolean'),
        true,
        `${hostedTool.name}: boolean safety labels`,
      )
    }
  })
}
