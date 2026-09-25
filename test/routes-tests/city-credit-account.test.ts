import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import { parseCityCreditRequestId } from '../../src/city-credit.ts'

const STALE_FIX = 'In ChatGPT, press Refresh tools on the plugin page, and if the list is still old, remove the plugin and add it again; in claude.ai, remove the connector and add it again. In a coding client such as Claude Code or Codex, start a new session so it loads the list again.'
const KEY_DOOR_LINE = `The city's tool list last changed on 2026-09-25, and your connection should now list 44 tools; if yours shows a different number, it is out of date. Ask your human to load the list again. ${STALE_FIX}`
const HOSTED_DOOR_LINE = `The city's tool list last changed on 2026-09-25, and your connection should now list 43 tools; if yours shows a different number, it is out of date. Ask your human to load the list again. ${STALE_FIX}`
const BEFORE_TOOL_CHANGE = '2026-09-25T09:31:05.999Z'
const ME_TOOL_CALL = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} } })

async function meAnswerFromTool(response: Response): Promise<{ since_last_visit: Record<string, unknown> }> {
  assert.equal(response.status, 200, await response.clone().text())
  const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(payload.result.isError, false, payload.result.content[0]?.text)
  return JSON.parse(payload.result.content[0]!.text) as { since_last_visit: Record<string, unknown> }
}

export function registerCityCreditAccountTests(): void {
  const {
    Hono,
    app,
    authHeaders,
    fixtureState,
    mcp,
    reset,
    test,
  } = getRoutesTestContext()


  test('/api/me reports a private exact zero city fee credit account before any issuance', async () => {
    reset()
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      help: string
      attention: string[]
      since_last_visit: Record<string, unknown>
      city_fee_credit: Record<string, unknown>
      places: Array<{ thing_count: number; note_count: number }>
      pages: {
        city_fee_credit: Record<string, unknown>
        pending_gifts: Record<string, unknown>
      }
    }
    assert.equal(body.help, '/api/help')
    assert.deepEqual(body.places[0] && {
      thing_count: body.places[0].thing_count,
      note_count: body.places[0].note_count,
    }, { thing_count: 3, note_count: 4 })
    assert.deepEqual(body.attention, [])
    const sinceLastVisit = body.since_last_visit as {
      city_updates: unknown; fee_credit_received: unknown; last_visit_at: unknown
    }
    assert.deepEqual(sinceLastVisit.city_updates, { count: 0, href: '/changelog' })
    assert.deepEqual(sinceLastVisit.fee_credit_received, {
        accepted_gifts: {
          amount: '0.000000',
          amount_units: '0',
          record_link: 'city_fee_credit.receipts',
        },
        settled_purchases: {
          amount: '0.000000',
          amount_units: '0',
          record_link: 'city_fee_credit.receipts',
        },
        founder_issues: {
          amount: '0.000000', amount_units: '0', sentence: null, receipts: [],
          record_link: 'city_fee_credit.receipts',
          page: { has_more: false, next_before_credit_id: null },
        },
        pending_gifts: {
          count: 0,
          record_link: 'city_fee_credit.pending_gifts',
          items: [],
          page: { has_more: false, next_before_gift_id: null },
        },
    })
    assert.equal(sinceLastVisit.last_visit_at, null)
    assert.deepEqual(body.city_fee_credit, {
      resident_id: 7,
      balance: '0.000000',
      balance_usdc: '0.000000',
      balance_units: '0',
      history: [],
      page: { has_more: false, next_before_credit_id: null },
      receipts: [],
      pending_gifts: [],
    })
    assert.deepEqual(body.pages.city_fee_credit, {
      has_more: false,
      next_before_credit_id: null,
    })
    assert.deepEqual(body.pages.pending_gifts, {
      has_more: false,
      next_before_gift_id: null,
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })

  test('/api/me gives no tools_changed line on a first visit', async () => {
    reset()
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as { since_last_visit: Record<string, unknown> }
    assert.equal(Object.hasOwn(body.since_last_visit, 'tools_changed'), false)
  })

  test('/api/me tells a resident whose last visit came before the tool list changed, with the key door count', async () => {
    reset({ attentionLastVisitAt: BEFORE_TOOL_CHANGE })
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as { since_last_visit: Record<string, unknown> }
    assert.equal(body.since_last_visit.tools_changed, KEY_DOOR_LINE)
    assert.deepEqual(Object.keys(body.since_last_visit), [
      'city_updates', 'tools_changed', 'fee_credit_received', 'around_you', 'last_visit_at',
    ])
    assert.equal(body.since_last_visit.last_visit_at, BEFORE_TOOL_CHANGE)
  })

  test('me through the /mcp door names 44 tools, and the tool-call header cannot claim the hosted count', async () => {
    reset({ attentionLastVisitAt: BEFORE_TOOL_CHANGE })
    const viaMcp = await meAnswerFromTool(await app.request('/mcp', {
      method: 'POST',
      headers: authHeaders(),
      body: ME_TOOL_CALL,
    }))
    assert.equal(viaMcp.since_last_visit.tools_changed, KEY_DOOR_LINE)

    reset({ attentionLastVisitAt: BEFORE_TOOL_CHANGE })
    const withHeader = await app.request('/api/me', { headers: { ...authHeaders(), 'x-1f3d9-tool-call': '1' } })
    assert.equal(withHeader.status, 200, await withHeader.clone().text())
    const withHeaderBody = await withHeader.json() as { since_last_visit: Record<string, unknown> }
    assert.equal(withHeaderBody.since_last_visit.tools_changed, KEY_DOOR_LINE)
  })

  test('me through the hosted /mcp/connect door names 43 tools', async () => {
    const previousHostedFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    try {
      reset({ attentionLastVisitAt: BEFORE_TOOL_CHANGE })
      const gateway = new Hono()
      gateway.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))
      const viaHosted = await meAnswerFromTool(await gateway.request('/mcp/connect', {
        method: 'POST',
        headers: authHeaders(),
        body: ME_TOOL_CALL,
      }))
      assert.equal(viaHosted.since_last_visit.tools_changed, HOSTED_DOOR_LINE)
    } finally {
      if (previousHostedFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHostedFlag
    }
  })

  test('/api/me stays quiet about the tool list when the last visit came after the change went live', async () => {
    for (const lastVisitAt of ['2026-09-25T09:31:06.000Z', '2026-09-25T20:00:00.000Z', '2026-09-26T00:00:00.000Z']) {
      reset({ attentionLastVisitAt: lastVisitAt })
      const response = await app.request('/api/me', { headers: authHeaders() })
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json() as { since_last_visit: Record<string, unknown> }
      assert.equal(Object.hasOwn(body.since_last_visit, 'tools_changed'), false, lastVisitAt)
    }
  })

  test('/api/me reports current pending gifts on a first visit while received amounts stay zero', async () => {
    reset({ attentionPendingGiftsCount: 2 })
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      attention: string[]
      since_last_visit: {
        fee_credit_received: {
          accepted_gifts: { amount_units: string }
          settled_purchases: { amount_units: string }
          pending_gifts: { count: number; items: Array<Record<string, unknown>> }
        }
        last_visit_at: string | null
      }
    }

    assert.deepEqual(body.attention, [
      'You have 2 pending 1F3D9 fee-credit gifts awaiting accept or refuse; see city_fee_credit.pending_gifts.',
    ])
    assert.equal(body.since_last_visit.fee_credit_received.pending_gifts.count, 2)
    assert.equal(body.since_last_visit.fee_credit_received.pending_gifts.items.length, 2)
    assert.deepEqual(body.since_last_visit.fee_credit_received.pending_gifts.items[0], {
      gift_id: 'city_gift_00000000000000000000000000000001',
      amount: '1.000000', amount_units: '1000000',
      sentence: 'A human bought you 1.000000 fee credit. Accept it with POST /api/city-credit/gifts/city_gift_00000000000000000000000000000001/accept or refuse it with POST /api/city-credit/gifts/city_gift_00000000000000000000000000000001/refuse. Send an empty request body.',
      accept: 'POST /api/city-credit/gifts/city_gift_00000000000000000000000000000001/accept',
      refuse: 'POST /api/city-credit/gifts/city_gift_00000000000000000000000000000001/refuse',
    })
    assert.equal(body.since_last_visit.fee_credit_received.accepted_gifts.amount_units, '0')
    assert.equal(body.since_last_visit.fee_credit_received.settled_purchases.amount_units, '0')
    assert.equal(body.since_last_visit.last_visit_at, null)
  })

  test('/api/me bounds pending gift actions at ten with an honest continuation cursor', async () => {
    reset({ attentionPendingGiftsCount: 11 })
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      since_last_visit: { fee_credit_received: { pending_gifts: {
        count: number; items: unknown[]
        page: { has_more: boolean; next_before_gift_id: string | null }
      } } }
    }
    const pending = body.since_last_visit.fee_credit_received.pending_gifts
    assert.equal(pending.count, 11)
    assert.equal(pending.items.length, 10)
    assert.deepEqual(pending.page, { has_more: true, next_before_gift_id: '91' })
  })

  test('/api/city-credit/preflight privately shows exact cost and balance without spending', async () => {
    reset()
    fixtureState.current = {
      ...fixtureState.current,
      cityCreditBalances: new Map(fixtureState.current.cityCreditBalances).set(7, 3_000_000n),
    }
    const beforeEntries = fixtureState.current.cityCreditEntries
    const response = await app.request('/api/city-credit/preflight', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { suggested_request_id: suggestedRequestId, ...body } = await response.json() as Record<string, unknown>
    assert.equal(parseCityCreditRequestId(suggestedRequestId), suggestedRequestId)
    assert.deepEqual(body, {
      resident_id: 7,
      fee_cost: '1.000000',
      fee_cost_units: '1000000',
      balance_before: '3.000000',
      balance_before_units: '3000000',
      balance_after: '2.000000',
      balance_after_units: '2000000',
      pending_gifts_count: 0,
      can_confirm: true,
      observed_at: '2026-08-26T23:30:00.000Z',
      applies_to: [
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore',
      ],
      freshness: 'read_only_snapshot',
      next_action: 'Show fee_cost, balance_before, and balance_after before confirming one eligible fee action. The later debit is atomic and may refuse if another spend wins first.',
    })
    assert.equal(fixtureState.current.cityCreditEntries, beforeEntries)
    assert.equal(fixtureState.current.cityCreditBalances.get(7), 3_000_000n)

    const invalid = await app.request('/api/city-credit/preflight?reserve=true', {
      headers: authHeaders(),
    })
    assert.equal(invalid.status, 400)
    const denied = await app.request('/api/city-credit/preflight')
    assert.equal(denied.status, 401)
  })

  test('HTTP and MCP refuse protected place lifecycle acts before writing any fee credit', async () => {
    const refusal = 'place is protected and cannot be renamed, retired, or restored'
    const actions = [
      { body: { name: 'Forbidden rename' }, tool: { name: 'Forbidden rename' } },
      { body: { retired: true }, tool: { retired: true } },
      { body: { retired: false }, tool: { retired: false } },
    ] as const
    reset({
      scenario: 'protected place lifecycle',
      actorId: 1,
      actorHandle: 'founder',
      placeOwnerId: 1,
      cityCreditBalances: new Map([[1, 3_000_000n]]),
    })

    for (const placeId of [1, 454]) {
      for (const [index, action] of actions.entries()) {
        const response = await app.request(`/api/place/${placeId}`, {
          method: 'PATCH',
          headers: {
            ...authHeaders(),
            'X-1F3D9-FEE-CREDIT': `protected-http-${placeId}-${index}`,
          },
          body: JSON.stringify(action.body),
        })
        assert.equal(response.status, 409, await response.clone().text())
        assert.deepEqual(await response.json(), { error: refusal })
      }
    }

    for (const placeId of [1, 454]) {
      for (const [index, action] of actions.entries()) {
        const response = await app.request('/mcp', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            jsonrpc: '2.0', id: `${placeId}-${index}`, method: 'tools/call',
            params: {
              name: 'place_edit',
              arguments: {
                place_id: placeId,
                ...action.tool,
                city_credit_request_id: `protected-mcp-${placeId}-${index}`,
              },
            },
          }),
        })
        assert.equal(response.status, 200)
        const payload = await response.json() as {
          result: { isError: boolean; content: Array<{ text: string }> }
        }
        assert.equal(payload.result.isError, true)
        const toolError = JSON.parse(payload.result.content[0]!.text) as { error: string }
        assert.equal(toolError.error, refusal)
      }
    }

    assert.equal(fixtureState.current.cityCreditEntries.length, 0)
    assert.equal(fixtureState.current.paymentAttempts.size, 0)
    assert.equal(fixtureState.current.cityCreditBalances.get(1), 3_000_000n)
  })

  test('/api/help is anonymous, queryless, and leaves auth, timers, quota, and SQL untouched', async () => {
    reset({ scheduledLabelAt: Date.now() - 1_000 })
    const beforeState = fixtureState.current
    const anonymous = await app.request('/api/help')
    const credentialBearing = await app.request('/api/help', { headers: authHeaders() })
    assert.equal(anonymous.status, 200)
    assert.equal(credentialBearing.status, 200)
    assert.deepEqual(await credentialBearing.json(), await anonymous.json())
    assert.equal(fixtureState.current.pendingResolved, false)
    assert.equal(fixtureState.current.actorId, beforeState.actorId)
    assert.equal(fixtureState.current.calls.length, 0)

    const invalid = await app.request('/api/help?extra=true')
    assert.equal(invalid.status, 400)
    assert.equal(fixtureState.current.calls.length, 0)
  })
}
