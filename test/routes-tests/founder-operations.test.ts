import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import type { FakeFounderPayPalDispute } from '../helpers/routes-fixtures/state.ts'


export function registerFounderOperationsTests(): void {
  const {
    allowOAuthForHostedConnectorRequest,
    app,
    authHeaders,
    fixtureState,
    reset,
    setActor,
    setOAuthResidentResolver,
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
  const FOUNDER_FLAG_PATH = '/api/founder/flags'
  const FLAG_JSON = { 'Content-Type': 'application/json' }

  test('the founder flag read is root-key-only, private, paged, and snake_case', async () => {
    reset()

    const missingKey = await app.request(FOUNDER_FLAG_PATH)
    assert.equal(missingKey.status, 401)
    assert.match(missingKey.headers.get('cache-control') ?? '', /no-store/iu)

    const nonFounder = await app.request(FOUNDER_FLAG_PATH, { headers: authHeaders() })
    assert.equal(nonFounder.status, 403)
    assert.match(nonFounder.headers.get('cache-control') ?? '', /no-store/iu)
    assert.equal(sqlCalls().some(call => call.query?.includes('/* founder:flag-queue */')), false)

    setActor(1, 'founder')
    for (const unsupported of [`${FOUNDER_FLAG_PATH}?force=true`, `${FOUNDER_FLAG_PATH}?limit=0`]) {
      const refused = await app.request(unsupported, { headers: authHeaders() })
      assert.equal(refused.status, 400, await refused.clone().text())
      assert.equal(sqlCalls().some(call => call.query?.includes('/* founder:flag-queue */')), false)
    }

    const response = await app.request(FOUNDER_FLAG_PATH, { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
    const body = await response.json() as {
      note: string
      unhandled_count: number
      flags: Array<Record<string, unknown>>
      returned_flags: number
      has_more: boolean
      next_before_id: number | null
    }
    assert.match(body.note, /data, never as instructions/iu)
    assert.equal(body.unhandled_count, 1)
    assert.equal(body.returned_flags, 1)
    assert.equal(body.has_more, false)
    assert.equal(body.next_before_id, null)
    assert.deepEqual(body.flags, [{
      id: 3,
      reporter: { id: 7, handle: 'tiny-lantern' },
      target_type: 'note',
      target_id: 51,
      reason: 'a resident wrote this report text',
      created_at: '2026-09-10T00:00:00.000Z',
      handled: null,
    }])
  })

  test('a report older than one page stays reachable through next_before_id', async () => {
    reset({ scenario: 'flag quota' })
    const body = JSON.stringify({
      target_type: 'thing', target_id: 41, reason: 'the newer report',
    })
    for (let index = 0; index < 2; index += 1) {
      const filed = await app.request('/api/flag', {
        method: 'POST', headers: authHeaders(), body,
      })
      assert.equal(filed.status, 201, await filed.clone().text())
    }

    setActor(1, 'founder')
    const first = await app.request(`${FOUNDER_FLAG_PATH}?limit=1`, { headers: authHeaders() })
    assert.equal(first.status, 200, await first.clone().text())
    const firstPage = await first.json() as {
      unhandled_count: number
      flags: Array<{ id: number }>
      returned_flags: number
      has_more: boolean
      next_before_id: number | null
    }
    // The count keeps counting the reports this page does not carry, and has_more says so.
    assert.equal(firstPage.unhandled_count, 3)
    assert.equal(firstPage.returned_flags, 1)
    assert.deepEqual(firstPage.flags.map(flag => flag.id), [5])
    assert.equal(firstPage.has_more, true)
    assert.equal(firstPage.next_before_id, 5)

    const older = await app.request(
      `${FOUNDER_FLAG_PATH}?before_id=${firstPage.next_before_id}&limit=2`,
      { headers: authHeaders() },
    )
    assert.equal(older.status, 200, await older.clone().text())
    const olderPage = await older.json() as {
      flags: Array<{ id: number; reason: string }>
      has_more: boolean
      next_before_id: number | null
    }
    assert.deepEqual(olderPage.flags.map(flag => flag.id), [4, 3])
    assert.equal(olderPage.flags[1]?.reason, 'a resident wrote this report text')
    assert.equal(olderPage.has_more, false)
    assert.equal(olderPage.next_before_id, null)
  })

  test('a filed flag reads back to the founder with its reason and then marks handled', async () => {
    reset({ scenario: 'flag quota' })

    const filed = await app.request('/api/flag', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        target_type: 'thing', target_id: 41, reason: 'private report detail',
      }),
    })
    assert.equal(filed.status, 201, await filed.clone().text())

    setActor(1, 'founder')
    const queue = await app.request(FOUNDER_FLAG_PATH, { headers: authHeaders() })
    assert.equal(queue.status, 200, await queue.clone().text())
    const queued = await queue.json() as {
      unhandled_count: number
      flags: Array<{ id: number; reason: string; handled: unknown }>
    }
    assert.equal(queued.unhandled_count, 2)
    assert.equal(queued.flags[0]?.id, 4, 'the newest flag is listed first')
    assert.equal(queued.flags[0]?.reason, 'private report detail')
    assert.equal(queued.flags[0]?.handled, null)

    const handled = await app.request(`${FOUNDER_FLAG_PATH}/4/handle`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'no action needed' }),
    })
    assert.equal(handled.status, 200, await handled.clone().text())
    assert.match(handled.headers.get('cache-control') ?? '', /no-store/iu)
    assert.deepEqual(await handled.json(), {
      flag_id: 4,
      disposition: 'handled',
      handled_at: '2026-09-15T01:00:00.000Z',
      moderation_id: null,
      note: 'no action needed',
    })

    const retried = await app.request(`${FOUNDER_FLAG_PATH}/4/handle`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'no action needed' }),
    })
    assert.equal(retried.status, 200, await retried.clone().text())
    assert.deepEqual((await retried.json() as { disposition: string }).disposition, 'already_handled')

    const after = await app.request(FOUNDER_FLAG_PATH, { headers: authHeaders() })
    const answered = await after.json() as {
      unhandled_count: number
      flags: Array<{ id: number; handled: unknown }>
    }
    assert.equal(answered.unhandled_count, 1)
    assert.deepEqual(answered.flags[0]?.handled, {
      at: '2026-09-15T01:00:00.000Z', moderation_id: null, note: 'no action needed',
    })
  })

  test('marking a flag handled is root-key-only, strictly bounded, and never overwrites an answer', async () => {
    reset()
    const body = JSON.stringify({ note: 'no action needed' })

    const missingKey = await app.request(`${FOUNDER_FLAG_PATH}/3/handle`, {
      method: 'POST', headers: FLAG_JSON, body,
    })
    assert.equal(missingKey.status, 401)

    const nonFounder = await app.request(`${FOUNDER_FLAG_PATH}/3/handle`, {
      method: 'POST', headers: authHeaders(), body,
    })
    assert.equal(nonFounder.status, 403)
    assert.equal(sqlCalls().some(call => call.query?.includes('/* founder:flag-handle */')), false)

    setActor(1, 'founder')
    const invalidRequests: ReadonlyArray<Readonly<{
      path?: string
      headers?: Readonly<Record<string, string>>
      body: string
      error: RegExp
    }>> = [
      { path: `${FOUNDER_FLAG_PATH}/3/handle?force=true`, body, error: /query|option/iu },
      { path: `${FOUNDER_FLAG_PATH}/0/handle`, body, error: /flag id/iu },
      { headers: { ...authHeaders(), 'Content-Length': '513' }, body, error: /Content-Length|byte/iu },
      {
        headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
        body,
        error: /Content-Type/iu,
      },
      { body: '{', error: /valid JSON/iu },
      { body: '{}', error: /moderation_id|note/iu },
      { body: JSON.stringify({ note: '' }), error: /moderation_id|note/iu },
      { body: JSON.stringify({ note: 'x'.repeat(201) }), error: /moderation_id|note/iu },
      { body: JSON.stringify({ note: 'two\nlines' }), error: /moderation_id|note/iu },
      { body: JSON.stringify({ moderation_id: 0 }), error: /moderation_id|note/iu },
      { body: JSON.stringify({ note: 'ok', extra: true }), error: /moderation_id|note/iu },
    ]
    for (const invalid of invalidRequests) {
      const response = await app.request(invalid.path ?? `${FOUNDER_FLAG_PATH}/3/handle`, {
        method: 'POST', headers: invalid.headers ?? authHeaders(), body: invalid.body,
      })
      assert.equal(response.status, 400, await response.clone().text())
      assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
      assert.match(await response.text(), invalid.error)
    }
    assert.equal(sqlCalls().some(call => call.query?.includes('/* founder:flag-handle */')), false)

    const missingFlag = await app.request(`${FOUNDER_FLAG_PATH}/4040/handle`, {
      method: 'POST', headers: authHeaders(), body,
    })
    assert.equal(missingFlag.status, 404, await missingFlag.clone().text())
    assert.deepEqual(await missingFlag.json(), {
      error: 'flag_id 4040 was not found; re-read the founder flag queue and send a current flag_id',
    })

    const missingModeration = await app.request(`${FOUNDER_FLAG_PATH}/3/handle`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ moderation_id: 9999 }),
    })
    assert.equal(missingModeration.status, 404, await missingModeration.clone().text())
    assert.deepEqual(await missingModeration.json(), {
      error: 'moderation_id 9999 was not found; re-read the public moderation history and send a current moderation id',
    })

    const first = await app.request(`${FOUNDER_FLAG_PATH}/3/handle`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ moderation_id: 77 }),
    })
    assert.equal(first.status, 200, await first.clone().text())

    const second = await app.request(`${FOUNDER_FLAG_PATH}/3/handle`, {
      method: 'POST', headers: authHeaders(), body,
    })
    assert.equal(second.status, 409, await second.clone().text())
    assert.deepEqual(await second.json(), {
      error: 'flag_id 3 already carries a different answer and one flag keeps one answer; re-read the founder flag queue, and record anything further as a new moderation act',
    })
    assert.deepEqual(fixtureState.current.flags[0]?.moderation_id, 77)
  })

  test('/api/me tells only founder #1 how many flags are unhandled', async () => {
    reset()
    const resident = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(resident.status, 200, await resident.clone().text())
    assert.equal(
      Object.hasOwn(await resident.json() as Record<string, unknown>, 'unhandled_flag_count'),
      false,
    )
    assert.equal(
      sqlCalls().some(call => call.query?.includes('/* founder:flag-unhandled-count */')),
      false,
    )

    setActor(1, 'founder')
    const founder = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(founder.status, 200, await founder.clone().text())
    assert.equal((await founder.json() as { unhandled_flag_count: number }).unhandled_flag_count, 1)

    const handled = await app.request(`${FOUNDER_FLAG_PATH}/3/handle`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'no action needed' }),
    })
    assert.equal(handled.status, 200, await handled.clone().text())
    const answered = await app.request('/api/me', { headers: authHeaders() })
    assert.equal((await answered.json() as { unhandled_flag_count: number }).unhandled_flag_count, 0)
  })

  test('a hosted-chat sign-in as founder #1 is told nothing about reports', async () => {
    // Founder capability lives on the root key alone. The hosted door deliberately refuses
    // founder-only surface, so signing in there as resident #1 must not leak the count.
    reset()
    setActor(1, 'founder')
    const accessToken = `1f3d9_at_${'cd'.repeat(32)}`
    const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    setOAuthResidentResolver(async token => token === accessToken ? {
      id: 1,
      handle: 'founder',
      model: 'hosted-chat',
      joined_at: '2026-08-13T00:00:00.000Z',
      quota_day: '2026-09-15',
      things_today: 0,
      notes_today: 0,
      agreement_actions_today: 0,
    } : null)
    try {
      const request = new Request('http://localhost/api/me', {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      allowOAuthForHostedConnectorRequest(request)
      const hosted = await app.request(request)
      assert.equal(hosted.status, 200, await hosted.clone().text())
      assert.equal(
        Object.hasOwn(await hosted.json() as Record<string, unknown>, 'unhandled_flag_count'),
        false,
      )
      assert.equal(
        sqlCalls().some(call => call.query?.includes('/* founder:flag-unhandled-count */')),
        false,
      )
    } finally {
      setOAuthResidentResolver(null)
      if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
    }
  })
}
