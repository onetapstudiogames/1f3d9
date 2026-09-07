import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTHORIZATION,
  HOSTED_AUTHORIZATION,
  assertCall,
  callTool,
  connectorHarness,
  withHostedConnector,
} from '../helpers/connector-tools-fixtures/transport-harness.ts'

export function registerRouteForwardingTests(): void {
  const connectorDrawing = {
    palette: ['#ad3f25'],
    indices: Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null),
  } as const

  const forwardingCases = [
    {
      name: 'drawing',
      args: { type: 'thing', id: 41 },
      expected: { method: 'GET', path: '/api/drawing/thing/41' },
    },
    {
      name: 'drawing_history',
      args: { type: 'thing', id: 41, before: 19, limit: 2 },
      expected: {
        method: 'GET', path: '/api/drawing/thing/41/history', query: { before: '19', limit: '2' },
      },
    },
    {
      name: 'place_edit',
      args: {
        place_id: 12,
        description: 'Lantern room 🏮',
        purpose: 'A quiet archive',
        front_matter_thing_ids: [41, 42],
        open_to_building: true,
        open_to_things: false,
        open_to_notes: true,
        drawing: 'REFUSE',
        drawing_description: 'I decline to draw this room.',
      },
      expected: {
        method: 'PATCH', path: '/api/place/12',
        body: {
          description: 'Lantern room 🏮',
          purpose: 'A quiet archive',
          front_matter_thing_ids: [41, 42],
          open_to_building: true,
          open_to_things: false,
          open_to_notes: true,
          drawing: 'REFUSE',
          drawing_description: 'I decline to draw this room.',
        },
      },
    },
    {
      name: 'place_edit',
      args: {
        place_id: 12,
        name: 'lantern archive',
        city_credit_request_id: 'rename-lantern-12',
      },
      expected: {
        method: 'PATCH', path: '/api/place/12',
        body: { name: 'lantern archive' },
        feeCredit: 'rename-lantern-12',
      },
    },
    {
      name: 'thing_edit',
      args: {
        thing_id: 41, name: 'signal lamp', body: '光る 🏮', open_to_use: true,
        drawing_variant_name: 'ember',
      },
      expected: {
        method: 'PATCH', path: '/api/thing/41',
        body: {
          name: 'signal lamp', body: '光る 🏮', open_to_use: true, drawing_variant_name: 'ember',
        },
      },
    },
    {
      name: 'thing_upgrade',
      args: { thing_id: 41, drawing_variant_name: null },
      expected: {
        method: 'POST', path: '/api/thing/41/upgrade', body: { drawing_variant_name: null },
      },
    },
    {
      name: 'coin_trait',
      args: { name: 'glowing', description: 'Glows when used.' },
      expected: {
        method: 'POST', path: '/api/trait',
        body: { name: 'glowing', description: 'Glows when used.' },
      },
    },
    {
      name: 'invent_kind',
      args: {
        name: 'signal-lamp',
        description: 'A lamp assembled from one wick.',
        traits: ['glowing'],
        recipe: [{ kind: 'wick', quantity: 1 }],
        drawing: connectorDrawing,
        drawing_state: 'complete',
        drawing_description: 'The kind owner’s plain signal lamp.',
        drawing_variants: [{
          name: 'ember',
          drawing: connectorDrawing,
          drawing_state: 'complete',
          drawing_description: 'A low ember shutter.',
        }],
        city_credit_request_id: 'kind-invent-0001',
      },
      expected: {
        method: 'POST', path: '/api/kind',
        body: {
          name: 'signal-lamp',
          description: 'A lamp assembled from one wick.',
          traits: ['glowing'],
          recipe: [{ kind: 'wick', quantity: 1 }],
          drawing: connectorDrawing,
          drawing_state: 'complete',
          drawing_description: 'The kind owner’s plain signal lamp.',
          drawing_variants: [{
            name: 'ember',
            drawing: connectorDrawing,
            drawing_state: 'complete',
            drawing_description: 'A low ember shutter.',
          }],
        },
        feeCredit: 'kind-invent-0001',
      },
    },
    {
      name: 'revise_kind',
      args: {
        kind_id: 7,
        description: 'The second lamp revision.',
        traits: ['glowing'],
        recipe: [{ kind: 'wick', quantity: 2 }],
        drawing_variants: [],
        city_credit_request_id: 'kind-revise-0001',
      },
      expected: {
        method: 'POST', path: '/api/kind/7/revise',
        body: {
          description: 'The second lamp revision.',
          traits: ['glowing'],
          recipe: [{ kind: 'wick', quantity: 2 }],
          drawing_variants: [],
        },
        feeCredit: 'kind-revise-0001',
      },
    },
    {
      name: 'browse',
      args: { view: 'kinds', before_id: 90, limit: 10 },
      expected: {
        method: 'GET', path: '/api/kinds', query: { before_id: '90', limit: '10' },
      },
    },
    {
      name: 'buy_credit',
      args: { request_id: 'credit-buy-0001', amount_dollars: '3' },
      headers: { 'x-payment': 'outer-payment-evidence' },
      expected: {
        method: 'POST', path: '/api/city-credit/purchase/x402',
        body: { request_id: 'credit-buy-0001', amount_dollars: '3' },
        payment: 'outer-payment-evidence',
      },
    },
    {
      name: 'flag',
      args: { target_type: 'thing', target_id: 41, reason: 'Illegal public content' },
      expected: {
        method: 'POST', path: '/api/flag',
        body: { target_type: 'thing', target_id: 41, reason: 'Illegal public content' },
      },
    },
  ] as const

  test('legacy MCP forwards every connector tool to its exact existing web route', async t => {
    for (const entry of forwardingCases) {
      await t.test(entry.name, async () => {
        const { app, calls } = connectorHarness()
        await callTool(app, '/mcp', entry.name, entry.args, {
          authorization: AUTHORIZATION,
          ...('headers' in entry ? entry.headers : {}),
        })
        assert.equal(calls.length, 1)
        assertCall(calls[0]!, { ...entry.expected, authorization: AUTHORIZATION })
      })
    }
  })

  test('hosted MCP forwards the same connector tools through namespaced calls', async t => {
    await withHostedConnector(async () => {
      for (const entry of forwardingCases) {
        await t.test(entry.name, async () => {
          const { app, calls } = connectorHarness()
          await callTool(app, '/mcp/connect', `mcp_for_1f3d9_${entry.name}`, entry.args, {
            authorization: HOSTED_AUTHORIZATION,
            ...('headers' in entry ? entry.headers : {}),
          })
          assert.equal(calls.length, 1)
          assertCall(calls[0]!, { ...entry.expected, authorization: HOSTED_AUTHORIZATION })
        })
      }
    })
  })
}
