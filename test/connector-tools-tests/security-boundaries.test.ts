import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTHORIZATION,
  callToolResult,
  connectorHarness,
  listedTools,
  withHostedConnector,
} from '../helpers/connector-tools-fixtures/transport-harness.ts'

export function registerSecurityBoundaryTests(): void {
  const GIFT_CLAIM_TOKEN = `gift_claim_${'ab'.repeat(32)}`

  test('hosted connector redacts credentials returned by a new public browse tool', async () => {
    const leaked = `1f3d9_sk_${'cd'.repeat(24)}`
    const { app } = connectorHarness(() => ({
      kinds: [{ id: 7, description: `old record ${leaked}` }],
    }))
    const result = await withHostedConnector(() => callToolResult(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_browse',
      { view: 'kinds' },
    ))
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, false)
    assert.doesNotMatch(text, new RegExp(leaked, 'iu'))
    assert.match(text, /redacted.*resident credential/iu)
  })

  test('anonymous MCP cannot call the authenticated flag lane', async () => {
    const { app, calls } = connectorHarness()
    const anonymousTools = await listedTools(app, '/mcp')
    assert.equal(anonymousTools.some(tool => tool.name === 'flag'), false)

    const result = await callToolResult(app, '/mcp', 'flag', {
      target_type: 'thing', target_id: 41, reason: 'Illegal public content',
    })
    assert.equal(result.isError, true)
    const error = JSON.parse(result.content[0]?.text ?? '{}') as {
      error_class?: string
      error?: string
    }
    assert.equal(error.error_class, 'auth_required')
    assert.equal(calls.length, 0)

    const hostedResult = await withHostedConnector(() => callToolResult(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_flag',
      { target_type: 'thing', target_id: 41, reason: 'Illegal public content' },
    ))
    assert.equal(hostedResult.isError, true)
    const hostedError = JSON.parse(hostedResult.content[0]?.text ?? '{}') as {
      error_class?: string
    }
    assert.equal(hostedError.error_class, 'auth_required')
    assert.equal(calls.length, 0)
  })

  test('gift claim tokens are rejected inside allowed strings without reflection', async () => {
    const { app, calls } = connectorHarness()
    const result = await callToolResult(app, '/mcp', 'say', {
      place_id: 3,
      body: `Never forward ${GIFT_CLAIM_TOKEN} through a tool.`,
    }, { authorization: AUTHORIZATION })
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, true)
    assert.equal((JSON.parse(text) as { error_class?: string }).error_class, 'bad_input')
    assert.match(text, /gift redirect/iu)
    assert.match(text, /never.*MCP arguments/iu)
    assert.match(text, /never.*Authorization header/iu)
    assert.doesNotMatch(text, new RegExp(GIFT_CLAIM_TOKEN, 'iu'))
    assert.equal(calls.length, 0)
  })

  test('gift claim tokens nested below recipe structure stay out of backing routes', async () => {
    const { app, calls } = connectorHarness()
    const deeplyNested = Array.from({ length: 12 }).reduce<unknown>(
      nested => ({ nested }),
      GIFT_CLAIM_TOKEN,
    )
    const result = await callToolResult(app, '/mcp', 'coin_trait', {
      name: 'nested-token-test',
      recipe: deeplyNested,
    }, { authorization: AUTHORIZATION })
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, true)
    assert.match(text, /gift redirect/iu)
    assert.doesNotMatch(text, new RegExp(GIFT_CLAIM_TOKEN, 'iu'))
    assert.equal(calls.length, 0)
  })

  test('credential-shaped nested property names stay out of backing routes', async () => {
    const { app, calls } = connectorHarness()
    const residentKey = `1f3d9_sk_${'cd'.repeat(24)}`
    const result = await callToolResult(app, '/mcp', 'coin_trait', {
      name: 'nested-key-test',
      recipe: { [residentKey]: 'ordinary value' },
    }, { authorization: AUTHORIZATION })
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, true)
    assert.match(text, /secrets.*tool arguments/iu)
    assert.doesNotMatch(text, new RegExp(residentKey, 'iu'))
    assert.equal(calls.length, 0)
  })

  test('claim_token is a sensitive argument key, not an ordinary unknown field', async () => {
    const { app, calls } = connectorHarness()
    const result = await callToolResult(app, '/mcp', 'say', {
      place_id: 3,
      body: 'ordinary note',
      claim_token: 'private-browser-value',
    }, { authorization: AUTHORIZATION })
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, true)
    assert.match(text, /gift redirect/iu)
    assert.match(text, /never.*Authorization header/iu)
    assert.doesNotMatch(text, /private-browser-value/iu)
    assert.doesNotMatch(text, /Unsupported tool argument/iu)
    assert.equal(calls.length, 0)
  })

  test('place_edit refuses a laws argument by name and points at the laws tool', async () => {
    for (const args of [
      { place_id: 12, laws: [247] },
      { place_id: 12, law_trait_ids: [247] },
      { place_id: 12, traits: ['quiet-hours'] },
    ] as const) {
      const { app, calls } = connectorHarness()
      const result = await callToolResult(app, '/mcp', 'place_edit', args, { authorization: AUTHORIZATION })
      const text = result.content[0]?.text ?? ''
      assert.equal(result.isError, true, JSON.stringify(args))
      assert.equal((JSON.parse(text) as { error_class?: string }).error_class, 'bad_input')
      assert.match(text, /Unsupported tool argument/iu, JSON.stringify(args))
      const rejectedKey = Object.keys(args).find(key => key !== 'place_id')!
      assert.match(text, new RegExp(rejectedKey), JSON.stringify(args))
      assert.match(text, /laws tool/iu, JSON.stringify(args))
      assert.equal(calls.length, 0)
    }

    // An unknown argument unrelated to laws still refuses and names itself,
    // but does not claim the laws tool is the fix.
    const { app: appOther, calls: callsOther } = connectorHarness()
    const otherResult = await callToolResult(
      appOther, '/mcp', 'place_edit', { place_id: 12, mood: 'cozy' }, { authorization: AUTHORIZATION },
    )
    const otherText = otherResult.content[0]?.text ?? ''
    assert.equal(otherResult.isError, true)
    assert.match(otherText, /mood/u)
    assert.doesNotMatch(otherText, /laws tool/iu)
    assert.equal(callsOther.length, 0)
  })

  test('hosted output never exposes a browser-only gift claim token', async () => {
    const { app } = connectorHarness(() => ({
      message: `historical redirect ${GIFT_CLAIM_TOKEN}`,
    }))
    const result = await withHostedConnector(() => callToolResult(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_front_door',
      {},
    ))
    const text = result.content[0]?.text ?? ''
    assert.doesNotMatch(text, new RegExp(GIFT_CLAIM_TOKEN, 'iu'))
    assert.match(text, /redacted|withheld|credential/iu)
  })

  test('hosted output detects JSON-escaped gift claim tokens after parsing', async () => {
    const escapedToken = `gift_clai\\u006d_${'ab'.repeat(32)}`
    const { app } = connectorHarness(() => new Response(
      `{"message":"${escapedToken}"}`,
      { headers: { 'content-type': 'application/json' } },
    ))
    const result = await withHostedConnector(() => callToolResult(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_front_door',
      {},
    ))
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, true)
    assert.match(text, /withheld.*private gift claim token/iu)
    assert.doesNotMatch(text, /gift_claim_/iu)
  })

  test('hosted output redacts JSON-escaped resident credentials after parsing', async () => {
    const credential = `1f3d9_sk_${'cd'.repeat(24)}`
    const escapedCredential = `1f3d9_s\\u006b_${'cd'.repeat(24)}`
    const { app } = connectorHarness(() => new Response(
      `{"description":"${escapedCredential}"}`,
      { headers: { 'content-type': 'application/json' } },
    ))
    const result = await withHostedConnector(() => callToolResult(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_browse',
      { view: 'kinds' },
    ))
    const text = result.content[0]?.text ?? ''
    assert.equal(result.isError, false)
    assert.match(text, /redacted.*resident credential/iu)
    assert.doesNotMatch(text, new RegExp(credential, 'iu'))
  })

  test('hosted output accepts a secret-free maximum kind catalog page', async () => {
    const recipe = Object.freeze(Array.from({ length: 64 }, (_, index) => Object.freeze({
      kind: `ingredient-${index}`,
      quantity: 1,
    })))
    const kinds = Object.freeze(Array.from({ length: 200 }, (_, index) => Object.freeze({
      id: index + 1,
      name: `kind-${index}`,
      description: 'ordinary public kind',
      recipe,
    })))
    const { app } = connectorHarness(() => ({ kinds }))
    const result = await withHostedConnector(() => callToolResult(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_browse',
      { view: 'kinds', limit: 200 },
    ))
    assert.equal(result.isError, false, result.content[0]?.text)
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { kinds?: unknown[] }
    assert.equal(payload.kinds?.length, 200)
  })

}
