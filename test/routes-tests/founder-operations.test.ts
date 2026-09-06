import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import type { FakeFounderPayPalDispute } from '../helpers/routes-fixtures/state.ts'


export function registerFounderOperationsTests(): void {
  const {
    app,
    authHeaders,
    fixtureState,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  const COMMUNITY_TOOL_QUEUE_PATH = '/api/founder/community-tool-submissions'
  const COMMUNITY_TOOL_REVIEW_PATH = `${COMMUNITY_TOOL_QUEUE_PATH}/9/review`
  const COMMUNITY_TOOL_LIST_BODY = JSON.stringify({ outcome: 'listed' })

  test('community tool founder queue is private, queryless, no-store, and snake_case', async () => {
    reset()

    const missingKey = await app.request(COMMUNITY_TOOL_QUEUE_PATH)
    assert.equal(missingKey.status, 401)
    assert.match(missingKey.headers.get('cache-control') ?? '', /no-store/iu)

    const nonFounder = await app.request(COMMUNITY_TOOL_QUEUE_PATH, { headers: authHeaders() })
    assert.equal(nonFounder.status, 403)
    assert.match(nonFounder.headers.get('cache-control') ?? '', /no-store/iu)
    assert.equal(sqlCalls().some(call => call.query?.includes('/* community-tools:operator-queue */')), false)

    setActor(1, 'founder')
    const withQuery = await app.request(`${COMMUNITY_TOOL_QUEUE_PATH}?limit=1`, {
      headers: authHeaders(),
    })
    assert.equal(withQuery.status, 400, await withQuery.clone().text())
    assert.match(withQuery.headers.get('cache-control') ?? '', /no-store/iu)
    assert.equal(sqlCalls().some(call => call.query?.includes('/* community-tools:operator-queue */')), false)

    const response = await app.request(COMMUNITY_TOOL_QUEUE_PATH, { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
    const body = await response.json()
    assert.deepEqual(body, {
      waiting_count: 1,
      submissions: [{
        id: 9,
        title: 'Pocket city atlas',
        url: 'https://tools.example/atlas',
        operator: 'Lantern Workshop',
        description: 'Finds public places by their street names.',
        resident: { id: 7, handle: 'tiny-lantern' },
        category: 'Browse',
        tags: ['maps', 'streets'],
        submitted_at: '2026-09-01T20:00:00.000Z',
      }],
    })
    assert.doesNotMatch(JSON.stringify(body), /submittedAt|submitter_ip_hash|[0-9a-f]{64}/u)
  })

  test('community tool founder review enforces its HTTP boundary and is retry-safe', async () => {
    reset()

    const missingKey = await app.request(COMMUNITY_TOOL_REVIEW_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: COMMUNITY_TOOL_LIST_BODY,
    })
    assert.equal(missingKey.status, 401)
    assert.match(missingKey.headers.get('cache-control') ?? '', /no-store/iu)

    const nonFounder = await app.request(COMMUNITY_TOOL_REVIEW_PATH, {
      method: 'POST', headers: authHeaders(), body: COMMUNITY_TOOL_LIST_BODY,
    })
    assert.equal(nonFounder.status, 403)
    assert.match(nonFounder.headers.get('cache-control') ?? '', /no-store/iu)
    assert.equal(sqlCalls().some(call => call.query?.includes('/* community-tools:review */')), false)

    setActor(1, 'founder')
    const invalidRequests: ReadonlyArray<Readonly<{
      path?: string
      headers?: Readonly<Record<string, string>>
      body: string
      error: RegExp
    }>> = [
      {
        path: `${COMMUNITY_TOOL_REVIEW_PATH}?force=true`,
        body: COMMUNITY_TOOL_LIST_BODY,
        error: /query|option/iu,
      },
      { body: '{', error: /valid JSON/iu },
      {
        headers: { ...authHeaders(), 'Content-Length': '257' },
        body: COMMUNITY_TOOL_LIST_BODY,
        error: /Content-Length|byte/iu,
      },
      {
        body: JSON.stringify({ outcome: 'listed', padding: 'x'.repeat(256) }),
        error: /1 to 256 bytes/iu,
      },
    ]
    for (const invalid of invalidRequests) {
      const response = await app.request(invalid.path ?? COMMUNITY_TOOL_REVIEW_PATH, {
        method: 'POST',
        headers: invalid.headers ?? authHeaders(),
        body: invalid.body,
      })
      assert.equal(response.status, 400, await response.clone().text())
      assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
      assert.match(await response.text(), invalid.error)
    }
    assert.equal(sqlCalls().some(call => call.query?.includes('/* community-tools:review */')), false)

    const reviewed = await app.request(COMMUNITY_TOOL_REVIEW_PATH, {
      method: 'POST', headers: authHeaders(), body: COMMUNITY_TOOL_LIST_BODY,
    })
    assert.equal(reviewed.status, 200, await reviewed.clone().text())
    assert.match(reviewed.headers.get('cache-control') ?? '', /no-store/iu)
    assert.deepEqual(await reviewed.json(), {
      submission_id: 9,
      outcome: 'listed',
      disposition: 'reviewed',
    })

    const retried = await app.request(COMMUNITY_TOOL_REVIEW_PATH, {
      method: 'POST', headers: authHeaders(), body: COMMUNITY_TOOL_LIST_BODY,
    })
    assert.equal(retried.status, 200, await retried.clone().text())
    assert.deepEqual(await retried.json(), {
      submission_id: 9,
      outcome: 'listed',
      disposition: 'already_reviewed',
    })

    const missing = await app.request(`${COMMUNITY_TOOL_QUEUE_PATH}/404/review`, {
      method: 'POST', headers: authHeaders(), body: COMMUNITY_TOOL_LIST_BODY,
    })
    assert.equal(missing.status, 404, await missing.clone().text())
    assert.match(missing.headers.get('cache-control') ?? '', /no-store/iu)
  })

  const FOUNDER_DISPUTE_PATH =
    '/api/founder/city-credit/disputes/PP-D-FOUNDER-REVIEW/resolve'
  const SELLER_FAVOUR_BODY = JSON.stringify({ decision: 'seller_favour' })

  function founderReviewDispute(
    disputeId: string,
    state: FakeFounderPayPalDispute['state'] = 'resolution_review',
  ): FakeFounderPayPalDispute {
    return { dispute_id: disputeId, state, decision: null }
  }

  test('founder PayPal dispute resolution is root-key-only, private, queryless, and strictly bounded', async () => {
    reset({
      founderPayPalDisputes: new Map([[
        'PP-D-FOUNDER-REVIEW',
        founderReviewDispute('PP-D-FOUNDER-REVIEW'),
      ]]),
    })

    const missingKey = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: SELLER_FAVOUR_BODY,
    })
    assert.equal(missingKey.status, 401)
    assert.match(missingKey.headers.get('cache-control') ?? '', /no-store/iu)

    const nonFounder = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST', headers: authHeaders(), body: SELLER_FAVOUR_BODY,
    })
    assert.equal(nonFounder.status, 403)
    assert.match(nonFounder.headers.get('cache-control') ?? '', /no-store/iu)

    setActor(1, 'founder')
    const invalidRequests: Array<Readonly<{
      path: string
      body: string
      error: RegExp
    }>> = [
      {
        path: `${FOUNDER_DISPUTE_PATH}?force=true`,
        body: SELLER_FAVOUR_BODY,
        error: /query|option|parameter/iu,
      },
      {
        path: '/api/founder/city-credit/disputes/not%20a%20dispute/resolve',
        body: SELLER_FAVOUR_BODY,
        error: /dispute id/iu,
      },
      { path: FOUNDER_DISPUTE_PATH, body: '{', error: /json|body/iu },
      {
        path: FOUNDER_DISPUTE_PATH,
        body: JSON.stringify({ decision: 'seller_favour', reason: 'not accepted' }),
        error: /unsupported|exactly|body/iu,
      },
      {
        path: FOUNDER_DISPUTE_PATH,
        body: JSON.stringify({ decision: 'approve' }),
        error: /seller_favour|buyer_favour/iu,
      },
      {
        path: FOUNDER_DISPUTE_PATH,
        body: JSON.stringify({ decision: 'seller_favour', padding: 'x'.repeat(1_024) }),
        error: /1,?024|bytes|large|limit/iu,
      },
    ]
    for (const invalid of invalidRequests) {
      const response = await app.request(invalid.path, {
        method: 'POST', headers: authHeaders(), body: invalid.body,
      })
      assert.equal(response.status, 400, `${invalid.path}: ${await response.clone().text()}`)
      assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
      assert.match(await response.text(), invalid.error)
    }
    for (const declaration of ['10, 20', '513']) {
      const rateCallsBefore = sqlCalls().filter(call =>
        call.query?.includes('/* paypal-credit:rate-limit */')).length
      const resolutionCallsBefore = sqlCalls().filter(call =>
        call.query?.includes('/* paypal-credit:founder-dispute-resolution */')).length
      const response = await app.request(FOUNDER_DISPUTE_PATH, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Length': declaration,
        },
        body: SELLER_FAVOUR_BODY,
      })
      assert.equal(response.status, 400, `${declaration}: ${await response.clone().text()}`)
      assert.match(await response.text(), /Content-Length|byte|declar/iu)
      assert.equal(sqlCalls().filter(call =>
        call.query?.includes('/* paypal-credit:rate-limit */')).length, rateCallsBefore)
      assert.equal(sqlCalls().filter(call =>
        call.query?.includes('/* paypal-credit:founder-dispute-resolution */')).length,
      resolutionCallsBefore)
    }
    assert.equal(sqlCalls().filter(call =>
      call.query?.includes('/* paypal-credit:founder-dispute-resolution */')).length, 0)
    assert.deepEqual(fixtureState.current.founderPayPalDisputeEvents, [])
  })

  test('founder PayPal dispute resolution creates once, replays exactly, and publicly logs no private identifier', async () => {
    reset({
      actorId: 1,
      actorHandle: 'founder',
      founderPayPalDisputes: new Map([[
        'PP-D-FOUNDER-REVIEW',
        founderReviewDispute('PP-D-FOUNDER-REVIEW'),
      ]]),
    })

    // No Content-Length is supplied. The route must enforce the actual body
    // bytes and accept the edge-shaped headerless request.
    const created = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST', headers: authHeaders(), body: SELLER_FAVOUR_BODY,
    })
    assert.equal(created.status, 201, await created.clone().text())
    assert.match(created.headers.get('cache-control') ?? '', /no-store/iu)
    assert.deepEqual(await created.json(), {
      paypal_dispute_resolution: {
        dispute_id: 'PP-D-FOUNDER-REVIEW',
        decision: 'seller_favour',
        state: 'resolved_seller',
        disposition: 'created',
        application_outcome: 'founder_review_seller_favour_applied',
        local_purchase_count: 1,
        receipts_created: 1,
      },
    })

    const replay = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST', headers: authHeaders(), body: SELLER_FAVOUR_BODY,
    })
    assert.equal(replay.status, 200, await replay.clone().text())
    assert.deepEqual(await replay.json(), {
      paypal_dispute_resolution: {
        dispute_id: 'PP-D-FOUNDER-REVIEW',
        decision: 'seller_favour',
        state: 'resolved_seller',
        disposition: 'existing',
        application_outcome: 'founder_review_seller_favour_applied',
        local_purchase_count: 1,
        receipts_created: 0,
      },
    })

    const opposite = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ decision: 'buyer_favour' }),
    })
    assert.equal(opposite.status, 409, await opposite.clone().text())
    assert.match(opposite.headers.get('cache-control') ?? '', /no-store/iu)
    assert.match(await opposite.text(), /already|seller.favour|cannot|nothing changed/iu)
    assert.deepEqual(fixtureState.current.founderPayPalDisputeEvents, [{
      kind: 'payment_repair',
      actor: 'founder',
      detail: { action: 'credit_dispute_seller_favour' },
    }])
    assert.deepEqual(Object.keys(fixtureState.current.founderPayPalDisputeEvents[0]!.detail), ['action'])
    assert.doesNotMatch(
      JSON.stringify(fixtureState.current.founderPayPalDisputeEvents[0]!.detail),
      /PP-D-FOUNDER-REVIEW|CAPTURE|city_gift|purchase|resident_id|buyer_id/iu,
    )

    reset({
      actorId: 1,
      actorHandle: 'founder',
      founderPayPalDisputes: new Map([[
        'PP-D-FOUNDER-REVIEW',
        founderReviewDispute('PP-D-FOUNDER-REVIEW'),
      ]]),
    })
    const buyerFavour = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ decision: 'buyer_favour' }),
    })
    assert.equal(buyerFavour.status, 201, await buyerFavour.clone().text())
    assert.match(buyerFavour.headers.get('cache-control') ?? '', /no-store/iu)
    const buyerBody = await buyerFavour.json() as {
      paypal_dispute_resolution: Record<string, unknown>
    }
    assert.deepEqual(buyerBody.paypal_dispute_resolution, {
      dispute_id: 'PP-D-FOUNDER-REVIEW',
      decision: 'buyer_favour',
      state: 'resolved_against_seller',
      disposition: 'created',
      application_outcome: 'founder_review_buyer_favour_applied',
      local_purchase_count: 1,
      receipts_created: 1,
    })
    assert.deepEqual(fixtureState.current.founderPayPalDisputeEvents, [{
      kind: 'payment_repair',
      actor: 'founder',
      detail: { action: 'credit_dispute_buyer_favour' },
    }])
  })

  test('founder PayPal dispute resolution refuses missing and non-review cases without a public event', async () => {
    reset({ actorId: 1, actorHandle: 'founder' })
    const missing = await app.request(
      '/api/founder/city-credit/disputes/PP-D-MISSING/resolve',
      { method: 'POST', headers: authHeaders(), body: SELLER_FAVOUR_BODY },
    )
    assert.equal(missing.status, 404, await missing.clone().text())
    assert.match(missing.headers.get('cache-control') ?? '', /no-store/iu)
    assert.match(await missing.text(), /not found|nothing changed/iu)

    for (const wrongState of [
      'open', 'resolved_seller', 'resolved_against_seller',
    ] as const) {
      reset({
        actorId: 1,
        actorHandle: 'founder',
        founderPayPalDisputes: new Map([[
          'PP-D-FOUNDER-REVIEW',
          founderReviewDispute('PP-D-FOUNDER-REVIEW', wrongState),
        ]]),
      })
      const response = await app.request(FOUNDER_DISPUTE_PATH, {
        method: 'POST', headers: authHeaders(), body: SELLER_FAVOUR_BODY,
      })
      assert.equal(response.status, 409, `${wrongState}: ${await response.clone().text()}`)
      assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
      assert.match(await response.text(), /open|already resolved|founder review|nothing changed/iu)
      assert.deepEqual(fixtureState.current.founderPayPalDisputeEvents, [])
    }
  })

  test('founder PayPal dispute resolution uses a durable rate bucket before changing custody', async () => {
    reset({
      actorId: 1,
      actorHandle: 'founder',
      paypalCreditRateSlotsUsed: 300,
      founderPayPalDisputes: new Map([[
        'PP-D-FOUNDER-REVIEW',
        founderReviewDispute('PP-D-FOUNDER-REVIEW'),
      ]]),
    })
    const limited = await app.request(FOUNDER_DISPUTE_PATH, {
      method: 'POST', headers: authHeaders(), body: SELLER_FAVOUR_BODY,
    })
    assert.equal(limited.status, 429, await limited.clone().text())
    assert.equal(limited.headers.get('retry-after'), '3600')
    assert.match(limited.headers.get('cache-control') ?? '', /no-store/iu)
    assert.match(await limited.text(), /too many|one hour|retry/iu)
    assert.ok(sqlCalls().some(call => call.query?.includes('/* paypal-credit:rate-limit */')))
    assert.equal(sqlCalls().some(call =>
      call.query?.includes('/* paypal-credit:founder-dispute-resolution */')), false)
    assert.deepEqual(fixtureState.current.founderPayPalDisputeEvents, [])
  })
}
