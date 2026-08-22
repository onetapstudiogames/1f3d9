import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { USDC } from '../src/chain.ts'
import { TERMS_TEXT } from '../src/legal.ts'
import { mcp } from '../src/mcp.ts'
import { challenge402, requirements, TREASURY } from '../src/pay.ts'

const SELLER = '0x1234567890abcdef1234567890abcdef12345678'

test('every 402 error names exact Base USDC units, full recipient, and wallet-history risk', async () => {
  for (const [recipient, amount] of [[TREASURY, 1], [SELLER, 2.5]] as const) {
    const app = new Hono()
    app.get('/pay', c => challenge402(
      c,
      requirements(recipient, amount, '/pay', 'test payment'),
      'payment required',
    ))
    const response = await app.request('/pay')
    assert.equal(response.status, 402)
    const body = await response.json() as Record<string, any>
    assert.deepEqual(body.payment_safety, {
      network: 'Base',
      usdc_contract: USDC,
      recipient,
      amount_usdc: amount.toFixed(6),
      amount_units: String(Math.round(amount * 1_000_000)),
      verify_with: 'this current 402 response or /api/official',
      warning: 'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.',
    })
    assert.match(body.error, new RegExp(recipient, 'iu'))
    assert.match(body.error, new RegExp(amount.toFixed(6).replace('.', '\\.'), 'u'))
    assert.match(body.error, /Base/iu)
    assert.match(body.error, new RegExp(USDC, 'iu'))
    assert.match(body.error, /wallet history|lookalike/iu)
  }
})

test('legal money terms state exact production facts and bounded recovery outcomes', () => {
  assert.match(TERMS_TEXT, /1\.000000 USDC on Base/u)
  assert.match(TERMS_TEXT, new RegExp(USDC, 'u'))
  assert.match(TERMS_TEXT, new RegExp(TREASURY, 'u'))
  assert.match(TERMS_TEXT, /current 402|\/api\/official/iu)
  assert.match(TERMS_TEXT, /wallet history/iu)
  assert.match(TERMS_TEXT, /zero-value lookalike/iu)
  assert.match(TERMS_TEXT, /two hours/iu)
  assert.match(TERMS_TEXT, /exact spent credit is returned/iu)
  assert.match(TERMS_TEXT, /late real payment[\s\S]{0,120}founder review/iu)
})

test('both MCP doors initialize with exact payment safety and recovery guidance', async () => {
  for (const hosted of [false, true]) {
    const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = hosted ? 'true' : 'false'
    try {
      const city = new Hono()
      const gateway = new Hono()
      gateway.post('/mcp', c => mcp(c, city, { hostedChat: hosted }))
      const response = await gateway.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
      const body = await response.json() as { result: { instructions: string } }
      const instructions = body.result.instructions
      assert.match(instructions, /1\.000000 USDC on Base/u)
      assert.match(instructions, new RegExp(USDC, 'u'))
      assert.match(instructions, new RegExp(TREASURY, 'u'))
      assert.match(instructions, /current 402|\/api\/official/iu)
      assert.match(instructions, /wallet history|lookalike/iu)
      assert.match(instructions, /two-hour|two hours/iu)
      assert.match(instructions, /do not pay again/iu)
    } finally {
      if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
    }
  }
})
