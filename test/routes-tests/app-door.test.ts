import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import {
  APP_BANNED_TEXT,
  APP_INSUFFICIENT_CREDIT_REFUSAL,
  APP_PAYMENT_REQUIRED_REFUSAL,
} from '../../src/door-profile.ts'

interface ToolReply {
  isError: boolean
  text: string
}

// Decision 141: the app door's own answers carry fee credit only, through the real routes.
export function registerAppDoorRoutesTests(): void {
  const {
    Hono,
    X_PAYMENT,
    app,
    authHeaders,
    mcp,
    networkCalled,
    reset,
    test,
  } = getRoutesTestContext()

  async function withHostedFlag<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    try {
      return await run()
    } finally {
      if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
    }
  }

  async function callAppTool(
    name: string,
    args: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<ToolReply> {
    return withHostedFlag(async () => {
      const gateway = new Hono()
      gateway.post('/mcp/app', c => mcp(c, app, { door: 'app' }))
      const response = await gateway.request('/mcp/app', {
        method: 'POST',
        headers: { ...authHeaders(), ...extraHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      assert.equal(response.status, 200, await response.clone().text())
      const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
      return { isError: payload.result.isError, text: payload.result.content[0]!.text }
    })
  }

  test('app door: a frontier with no fee credit gets the plain one-credit refusal, never a payment challenge', async () => {
    reset({ scenario: 'paid claims' })
    const withRequest = await callAppTool('found', {
      parent_id: null, name: 'No Credit Continent', city_credit_request_id: 'app-door-empty-00001',
    })
    assert.equal(withRequest.isError, true)
    const withRequestBody = JSON.parse(withRequest.text) as Record<string, unknown>
    assert.equal(withRequestBody.error, APP_INSUFFICIENT_CREDIT_REFUSAL)
    assert.equal(withRequestBody.http_status, 409)
    assert.doesNotMatch(withRequest.text, APP_BANNED_TEXT)
    assert.doesNotMatch(withRequest.text, /\b402\b|front_door":"https?:|\/api\/tools/u)

    reset({ scenario: 'paid claims' })
    const withoutRequest = await callAppTool(
      'found',
      { parent_id: null, name: 'No Credit Continent' },
      // A proof sent to the app door is never forwarded; the city never sees it.
      { 'X-PAYMENT': X_PAYMENT },
    )
    assert.equal(withoutRequest.isError, true)
    const withoutRequestBody = JSON.parse(withoutRequest.text) as Record<string, unknown>
    assert.equal(withoutRequestBody.error, APP_PAYMENT_REQUIRED_REFUSAL)
    assert.equal(withoutRequestBody.http_status, 409)
    assert.equal(withoutRequestBody.error_class, 'conflict')
    assert.doesNotMatch(withoutRequest.text, APP_BANNED_TEXT)
    assert.doesNotMatch(withoutRequest.text, /\b402\b|accepts|payTo/u)
    assert.equal(networkCalled('/verify'), false)
    assert.equal(networkCalled('/settle'), false)
  })

  test('app door: the same no-credit frontier through /mcp still names the full refusal', async () => {
    reset({ scenario: 'paid claims' })
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'found', arguments: { parent_id: null, name: 'No Credit Continent', city_credit_request_id: 'app-door-empty-00002' } },
      }),
    })
    const payload = await response.json() as { result: { content: Array<{ text: string }> } }
    assert.match(payload.result.content[0]!.text, /insufficient city fee credit; buy or receive one city fee credit/u)
  })

  test('app door: me keeps fee credit held and drops gifts, offers, web pointers, and app-block advice', async () => {
    reset({ attentionPendingGiftsCount: 2, cityCreditBalances: new Map([[7, 3_000_000n]]) })
    const reply = await callAppTool('me', {})
    assert.equal(reply.isError, false, reply.text)
    assert.doesNotMatch(reply.text, APP_BANNED_TEXT)
    const body = JSON.parse(reply.text) as Record<string, unknown> & {
      attention: string[]
      city_fee_credit: Record<string, unknown>
      since_last_visit: Record<string, unknown>
      pages: Record<string, unknown>
    }
    for (const key of ['offers', 'if_blocked', 'help', 'front_door']) {
      assert.equal(Object.hasOwn(body, key), false, key)
    }
    assert.equal(body.front_door_tool, 'front_door')
    assert.equal(body.city_fee_credit.balance, '3.000000')
    assert.equal(body.city_fee_credit.balance_units, '3000000')
    assert.ok(Array.isArray(body.city_fee_credit.receipts))
    assert.equal(Object.hasOwn(body.city_fee_credit, 'pending_gifts'), false)
    assert.equal(Object.hasOwn(body.pages, 'offers'), false)
    assert.equal(Object.hasOwn(body.pages, 'pending_gifts'), false)
    assert.deepEqual(body.attention, [])
    assert.ok(Object.hasOwn(body.since_last_visit, 'fee_credit_received'))
    assert.doesNotMatch(reply.text, /gift/iu)
  })

  test('app door: me refuses the offer and gift paging arguments it does not advertise', async () => {
    reset()
    const reply = await callAppTool('me', { offer_limit: 5 })
    assert.equal(reply.isError, true)
    assert.match(reply.text, /Unsupported tool argument: offer_limit/u)
  })

  test('app door: credit_preflight shows the one-fee result without a gift count', async () => {
    reset({ cityCreditBalances: new Map([[7, 1_000_000n]]) })
    const reply = await callAppTool('credit_preflight', {})
    assert.equal(reply.isError, false, reply.text)
    assert.doesNotMatch(reply.text, APP_BANNED_TEXT)
    const body = JSON.parse(reply.text) as Record<string, unknown>
    assert.equal(Object.hasOwn(body, 'pending_gifts_count'), false)
    assert.equal(body.can_confirm, true)
    assert.equal(body.balance_before, '1.000000')
  })
}
