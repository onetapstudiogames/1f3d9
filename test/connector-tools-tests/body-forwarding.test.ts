import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTHORIZATION,
  callTool,
  connectorHarness,
} from '../helpers/connector-tools-fixtures/transport-harness.ts'

export function registerBodyForwardingTests(): void {
  test('backing writes receive valid multibyte JSON bytes and no synthesized Content-Length', async () => {
    const { app, calls } = connectorHarness()
    await callTool(app, '/mcp', 'make', {
      place_id: 3,
      name: 'paper lantern',
      body: '灯り 🏮',
      open_to_use: true,
    }, { authorization: AUTHORIZATION })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.path, '/api/thing')
    assert.equal(calls[0]?.contentLength, null)
    assert.deepEqual(calls[0]?.body, {
      place_id: 3,
      name: 'paper lantern',
      body: '灯り 🏮',
      open_to_use: true,
    })
    assert.ok(Buffer.byteLength(calls[0]?.rawBody ?? '', 'utf8') > (calls[0]?.rawBody.length ?? 0))
  })
}
