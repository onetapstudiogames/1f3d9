import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerCityCreditAccountTests(): void {
  const {
    app,
    authHeaders,
    fixtureState,
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
      pages: {
        city_fee_credit: Record<string, unknown>
        pending_gifts: Record<string, unknown>
      }
    }
    assert.equal(body.help, '/api/help')
    assert.deepEqual(body.attention, [])
    assert.deepEqual(body.since_last_visit, {
      city_updates: { count: 0, href: '/changelog' },
      fee_credit_received: {
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
        pending_gifts: {
          count: 0,
          record_link: 'city_fee_credit.pending_gifts',
        },
      },
      last_visit_at: null,
    })
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
          pending_gifts: { count: number }
        }
        last_visit_at: string | null
      }
    }

    assert.deepEqual(body.attention, [
      'You have 2 pending 1F3D9 fee-credit gifts awaiting accept or refuse; see city_fee_credit.pending_gifts.',
    ])
    assert.equal(body.since_last_visit.fee_credit_received.pending_gifts.count, 2)
    assert.equal(body.since_last_visit.fee_credit_received.accepted_gifts.amount_units, '0')
    assert.equal(body.since_last_visit.fee_credit_received.settled_purchases.amount_units, '0')
    assert.equal(body.since_last_visit.last_visit_at, null)
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
    const body = await response.json() as Record<string, unknown>
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
