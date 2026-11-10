import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Hono, type Context } from 'hono'
import { emptyActionBodyFailure, mountPrepaidCreditGiftRoutes } from '../src/prepaid-credit-routes.ts'

const GIFT_ID = `city_gift_${'ab'.repeat(16)}`
const CLAIM_TOKEN = `gift_claim_${'cd'.repeat(32)}`

function postJson(value: unknown): RequestInit {
  const body = JSON.stringify(value)
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
    body,
  }
}

function appFor(input: {
  authenticated?: boolean
  targetMatches?: boolean
  redirectRateLimited?: boolean
  vercel?: boolean
  giftStatus?: 'pending' | 'accepted' | 'refused' | 'frozen' | 'revoked'
  disputeBlocked?: boolean
  missingGiftAction?: boolean
  missingRedirect?: boolean
} = {}) {
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const app = new Hono()
  mountPrepaidCreditGiftRoutes(app, {
    authenticate: async (_c: Context) => input.authenticated
      ? { id: 7, handle: 'resident-seven' }
      : null,
    database: {
      query: async (text: string, params: readonly unknown[] = []) => {
        calls.push({ text, params })
        if (text.includes('paypal-credit:rate-limit')) {
          return input.redirectRateLimited ? [] : [{ used: 1 }]
        }
        if (text.includes('paypal-credit:recipient')) {
          return input.targetMatches === false ? [] : [{ id: 8, handle: params[0] === '431' ? '431' : 'resident-eight' }]
        }
        if (text.includes('prepaid-credit:gift-status')) {
          return input.missingGiftAction ? [] : [{
            amount_units: '3000000', recipient_handle: 'resident-eight',
            status: input.giftStatus ?? 'pending',
            frozen_at: input.disputeBlocked ? new Date().toISOString() : null,
            buyer_email: 'must-not-be-returned@example.invalid',
          }]
        }
        if (text.includes('prepaid-credit-routes:resident-confirmation')) {
          return input.targetMatches === false ? [] : [{ id: 8, handle: 'resident-eight' }]
        }
        if (text.includes('prepaid-credit:gift-accept')) {
          if (input.missingGiftAction) return []
          return [{
            gift_id: GIFT_ID,
            status: input.giftStatus ?? 'accepted',
            amount_units: '3000000',
            frozen_at: input.disputeBlocked ? '2026-08-27T18:00:00.000Z' : null,
          }]
        }
        if (text.includes('prepaid-credit:gift-refuse')) {
          if (input.missingGiftAction) return []
          return [{
            gift_id: GIFT_ID,
            status: input.giftStatus === 'frozen' ? 'refused' : input.giftStatus ?? 'refused',
            amount_units: '3000000',
            frozen_at: input.disputeBlocked || input.giftStatus === 'frozen'
              ? '2026-08-27T18:00:00.000Z'
              : null,
          }]
        }
        if (text.includes('prepaid-credit:gift-redirect')) {
          if (input.missingRedirect) return []
          return [{
            gift_id: GIFT_ID,
            status: input.giftStatus ?? 'pending',
            amount_units: '3000000',
            frozen_at: input.disputeBlocked ? '2026-08-27T18:00:00.000Z' : null,
          }]
        }
        return []
      },
    },
    environment: { VERCEL: input.vercel ? '1' : '0' },
  })
  return { app, calls }
}

test('gift destination lookup stays available without PayPal configuration', async () => {
  const found = appFor()
  const response = await found.app.request('/api/city-credit/gifts/residents/8')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    resident_number: 8,
    resident_handle: 'resident-eight',
  })
  assert.deepEqual(found.calls.at(-1)?.params, [8])

  const missing = appFor({ targetMatches: false })
  assert.equal((await missing.app.request('/api/city-credit/gifts/residents/8')).status, 404)
  assert.equal((await found.app.request('/api/city-credit/gifts/residents/!')).status, 400)
})

test('gift destination lookup accepts names and @digits without confusing them with resident numbers', async () => {
  for (const [name, parameter, handle] of [['resident-eight', 'resident-eight', 'resident-eight'], ['@431', '431', '431']] as const) {
    const found = appFor()
    const response = await found.app.request(`/api/city-credit/gifts/residents/${encodeURIComponent(name)}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { resident_number: 8, resident_handle: handle })
    assert.deepEqual(found.calls.at(-1)?.params, [parameter])
    assert.match(found.calls.at(-1)!.text, /WHERE handle = \$1::text/u)
  }
})

test('claim-key status is POST-only, private, bounded, and reveals just amount, recipient and state', async () => {
  for (const state of ['pending', 'refused', 'accepted', 'frozen', 'revoked'] as const) {
    const found = appFor({ giftStatus: state })
    const response = await found.app.request('/api/city-credit/gifts/status', postJson({ claim_token: CLAIM_TOKEN }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { amount_usd: '3.00', recipient_handle: 'resident-eight', status: state })
    assert.deepEqual(found.calls.at(-1)?.params, [expectHash()])
  }
  const frozen = appFor({ giftStatus: 'refused', disputeBlocked: true })
  const response = await frozen.app.request('/api/city-credit/gifts/status', postJson({ claim_token: CLAIM_TOKEN }))
  assert.equal((await response.json() as {status: string}).status, 'frozen')
  const missing = appFor({ missingGiftAction: true })
  assert.equal((await missing.app.request('/api/city-credit/gifts/status', postJson({ claim_token: CLAIM_TOKEN }))).status, 404)
  assert.equal((await missing.app.request('/api/city-credit/gifts/status')).status, 404)
  assert.equal((await missing.app.request('/api/city-credit/gifts/status', postJson({ claim_token: CLAIM_TOKEN, extra: true }))).status, 400)
  assert.equal((await missing.app.request('/api/city-credit/gifts/status?claim_token=not-a-key', postJson({ claim_token: CLAIM_TOKEN }))).status, 400)
  assert.equal((await missing.app.request('/api/city-credit/gifts/status', { method: 'POST', body: ' '.repeat(1025) })).status, 400)
  for (const path of ['status', 'redirect']) {
    const rejected = await missing.app.request(`/api/city-credit/gifts/${path}?unexpected=true`, postJson({ claim_token: CLAIM_TOKEN }))
    assert.equal(rejected.status, 400)
    assert.equal(rejected.headers.get('cache-control'), 'no-store')
  }
})

test('key-only redirect reuses the atomic hash-bound redirect and shares status and legacy rate limits', async () => {
  const body = { claim_token: CLAIM_TOKEN, recipient_number: 8, recipient_handle: 'resident-eight', request_id: 'key-only-move-0001' }
  const found = appFor()
  const moved = await found.app.request('/api/city-credit/gifts/redirect', postJson(body))
  assert.equal(moved.status, 200)
  assert.equal(moved.headers.get('cache-control'), 'no-store')
  assert.deepEqual(found.calls.at(-1)?.params, [null, expectHash(), 8, 'key-only-move-0001'])
  const hashes = []
  for (const path of ['status', 'redirect', `${GIFT_ID}/redirect`]) {
    const limited = appFor({ redirectRateLimited: true })
    const response = await limited.app.request(`/api/city-credit/gifts/${path}`, postJson(path === 'status' ? { claim_token: CLAIM_TOKEN } : body))
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('retry-after'), '3600')
    assert.equal(limited.calls.length, 1)
    hashes.push(limited.calls[0]!.params[0])
  }
  assert.equal(new Set(hashes).size, 1)
})

test('gift accept and refuse require the recipient key and accept an empty action body', async () => {
  const unauthenticated = appFor()
  const denied = await unauthenticated.app.request(`/api/city-credit/gifts/${GIFT_ID}/accept`, {
    method: 'POST',
  })
  assert.equal(denied.status, 401)

  const acceptedApp = appFor({ authenticated: true })
  const accepted = await acceptedApp.app.request(`/api/city-credit/gifts/${GIFT_ID}/accept`, {
    method: 'POST',
    headers: { authorization: 'Bearer resident-key' },
  })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), {
    gift_id: GIFT_ID,
    status: 'accepted',
    amount_units: '3000000',
  })
  assert.deepEqual(acceptedApp.calls.at(-1)?.params, [GIFT_ID, 7, 'accepted', 'gift_accept'])

  const refusedApp = appFor({ authenticated: true })
  const refused = await refusedApp.app.request(`/api/city-credit/gifts/${GIFT_ID}/refuse`, {
    method: 'POST',
  })
  assert.equal(refused.status, 200)
  assert.equal((await refused.json() as { status: string }).status, 'refused')
})

test('gift action conflicts name the current pending-gift recovery', async () => {
  const missing = appFor({ authenticated: true, missingGiftAction: true })
  const response = await missing.app.request(`/api/city-credit/gifts/${GIFT_ID}/accept`, {
    method: 'POST',
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'gift is not pending for this recipient or was not found; call me, or use /api/me if your client can open URLs, and send one pending gift_id addressed to this resident',
    do_not_retry_with_changed_terms: true,
  })
})

test('the buyer claim token redirects only after number and handle confirm the same resident', async () => {
  const mismatch = appFor({ targetMatches: false })
  const mismatchResponse = await mismatch.app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, postJson({
      claim_token: CLAIM_TOKEN,
      recipient_number: 8,
      recipient_handle: 'resident-eight',
      request_id: 'gift-redirect-browser-0001',
    }))
  assert.equal(mismatchResponse.status, 404)
  assert.deepEqual(await mismatchResponse.json(), {
    error: 'resident number and handle did not identify the same resident; re-read the public resident list and resend one matching number and handle',
  })

  const redirectedApp = appFor({ targetMatches: true })
  const redirected = await redirectedApp.app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, postJson({
      claim_token: CLAIM_TOKEN,
      recipient_number: 8,
      recipient_handle: 'resident-eight',
      request_id: 'gift-redirect-browser-0001',
    }))
  assert.equal(redirected.status, 200)
  const redirectedBody = await redirected.json()
  assert.deepEqual(redirectedBody, {
    gift_id: GIFT_ID,
    status: 'pending',
    amount_units: '3000000',
    message: 'gift redirected; the new recipient must accept it',
  })
  assert.doesNotMatch(JSON.stringify(redirectedBody), /buyer|payer|email/iu)
  assert.deepEqual(redirectedApp.calls.at(-1)?.params, [
    GIFT_ID,
    expectHash(),
    8,
    'gift-redirect-browser-0001',
  ])
})

test('gift redirect conflicts name the eligible state and exact retry inputs', async () => {
  const missing = appFor({ targetMatches: true, missingRedirect: true })
  const response = await missing.app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, postJson({
    claim_token: CLAIM_TOKEN,
    recipient_number: 8,
    recipient_handle: 'resident-eight',
    request_id: 'gift-redirect-browser-0001',
  }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'gift redirect claim or recipient changed, or the gift is no longer redirectable; retry with the original claim_token and one current matching recipient while the gift is pending or refused',
    do_not_retry_with_changed_terms: true,
  })
})

test('gift redirect rate limits token guesses before resident lookup or redirect work', async () => {
  const limited = appFor({ redirectRateLimited: true, vercel: true })
  const request = postJson({
    claim_token: CLAIM_TOKEN,
    recipient_number: 8,
    recipient_handle: 'resident-eight',
    request_id: 'gift-redirect-browser-0001',
  })
  const response = await limited.app.request(
    `/api/city-credit/gifts/${GIFT_ID}/redirect`,
    {
      ...request,
      headers: {
        ...request.headers,
        'x-vercel-forwarded-for': '198.51.100.9, 203.0.113.17',
      },
    },
  )

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '3600')
  assert.deepEqual(await response.json(), {
    error: 'Too many gift redirect attempts were received. Wait one hour before trying a gift redirect again.',
  })
  assert.equal(limited.calls.length, 1)
  assert.match(limited.calls[0]!.text, /paypal-credit:rate-limit/u)
  assert.deepEqual(limited.calls[0]!.params, [
    createHash('sha256')
      .update('prepaid-credit:gift-redirect:anonymous:203.0.113.17', 'utf8')
      .digest('hex'),
    30,
  ])
  assert.equal(limited.calls.some(call => /resident-confirmation|gift-redirect/u.test(call.text)), false)
})

test('frozen gifts allow recipient refusal while revoked gifts refuse every action', async () => {
  const redirectBody = postJson({
    claim_token: CLAIM_TOKEN,
    recipient_number: 8,
    recipient_handle: 'resident-eight',
    request_id: 'gift-redirect-dispute-block-0001',
  })
  for (const status of ['frozen', 'revoked'] as const) {
    for (const action of ['accept', 'refuse'] as const) {
      const blocked = appFor({ authenticated: true, giftStatus: status })
      const response = await blocked.app.request(
        `/api/city-credit/gifts/${GIFT_ID}/${action}`,
        { method: 'POST' },
      )
      if (status === 'frozen' && action === 'refuse') {
        assert.equal(response.status, 200, await response.clone().text())
        assert.deepEqual(await response.json(), {
          gift_id: GIFT_ID,
          status: 'refused',
          amount_units: '3000000',
        })
      } else {
        assert.equal(response.status, 409, await response.clone().text())
        const message = String((await response.json() as { error: unknown }).error)
        assert.match(message, status === 'frozen'
          ? /payment dispute is open.*purchase that funded/iu
          : /funding payment was refunded or its dispute was resolved against the seller.*permanently revoked.*never add credit/iu)
      }
    }
    const blockedRedirect = appFor({ giftStatus: status })
    const redirect = await blockedRedirect.app.request(
      `/api/city-credit/gifts/${GIFT_ID}/redirect`,
      redirectBody,
    )
    assert.equal(redirect.status, 409, await redirect.clone().text())
    const redirectMessage = String((await redirect.json() as { error: unknown }).error)
    assert.match(redirectMessage, status === 'frozen'
      ? /payment dispute is open.*purchase that funded/iu
      : /funding payment was refunded or its dispute was resolved against the seller.*permanently revoked.*never add credit/iu)
  }
})

test('a refused gift keeps its status but an active dispute blocks accept and redirect', async () => {
  const blocked = appFor({ authenticated: true, giftStatus: 'refused', disputeBlocked: true })
  for (const action of ['accept', 'redirect'] as const) {
    const response = action === 'accept'
      ? await blocked.app.request(`/api/city-credit/gifts/${GIFT_ID}/accept`, { method: 'POST' })
      : await blocked.app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, postJson({
          claim_token: CLAIM_TOKEN,
          recipient_number: 8,
          recipient_handle: 'resident-eight',
          request_id: 'gift-redirect-refused-dispute-0001',
        }))
    assert.equal(response.status, 409, await response.clone().text())
    assert.match(
      String((await response.json() as { error: unknown }).error),
      /payment dispute is open.*purchase that funded/iu,
    )
  }
})

function expectHash(): string {
  // hashGiftClaimToken is separately covered; route storage receives only its 64-hex digest.
  return '571615e90423371acd80b4a6a5e323e336ba24c994c1e530eda2f7465ed1790d'
}

test('gift action routes reject query switches and unexpected redirect fields', async () => {
  const { app } = appFor({ authenticated: true })
  assert.equal((await app.request(`/api/city-credit/gifts/${GIFT_ID}/accept?force=1`, {
    method: 'POST',
  })).status, 400)
  assert.equal((await app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, postJson({
      claim_token: CLAIM_TOKEN,
      recipient_number: 8,
      recipient_handle: 'resident-eight',
      request_id: 'gift-redirect-browser-0001',
      buyer: 'must-never-exist',
    }))).status, 400)

  // The production edge forwards no usable Content-Length, so a valid
  // redirect without the header must still be read and accepted.
  const headerless = JSON.stringify({
    claim_token: CLAIM_TOKEN,
    recipient_number: 8,
    recipient_handle: 'resident-eight',
    request_id: 'gift-redirect-browser-0002',
  })
  assert.equal((await app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: headerless,
  })).status, 200)
})

test('gift body-bound refusals name their real causes, never a field rule', async () => {
  const { app } = appFor({ authenticated: true })

  // An unusable declaration on a genuinely empty accept body must name the
  // header problem, not claim the body was non-empty.
  const unusable = await app.request(`/api/city-credit/gifts/${GIFT_ID}/accept`, {
    method: 'POST',
    headers: { 'content-length': '10, 20' },
    body: '',
  })
  assert.equal(unusable.status, 400)
  assert.match(
    String((await unusable.json() as { error: string }).error),
    /Content-Length/iu,
  )

  // A redirect body padded past the bound must name the size rule the caller
  // actually broke, not the fields it already sent correctly.
  const oversized = await app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{${' '.repeat(1_024)}"claim_token": "${CLAIM_TOKEN}", "recipient_number": 8, "recipient_handle": "resident-eight", "request_id": "gift-redirect-browser-0003"}`,
  })
  assert.equal(oversized.status, 400)
  assert.match(
    String((await oversized.json() as { error: string }).error),
    /limited to 1024 bytes/u,
  )
})

// Regression guard for the production hang: on Vercel, @hono/node-server's
// fast path reads c.req.text()/json()/arrayBuffer() in well under 1ms, but
// touching c.req.raw.body even once (a `== null` presence check included)
// makes it build a real Request whose body is Readable.toWeb(incoming); every
// later body read then defers to that stream, which never delivers on
// Vercel's Node runtime (proven on the sibling market repo: 1f3ea issue #39,
// PR #40, same @hono/node-server 2.1.0, same Vercel Node 24 runtime). A
// fetch-backed test (`app.request(...)`, used above) cannot reproduce this —
// undici's Request has no such coupling — so this test models the coupling
// directly against a fake Context standing in for node-server's real one.
function nodeServerLikeContext(
  bodyText: string,
  headers: Readonly<Record<string, string>> = {},
): { context: Context; rawBodyWasTouched(): boolean } {
  let rawBodyTouched = false
  const raw = {
    get body(): unknown {
      rawBodyTouched = true
      // The real getter returns a live ReadableStream (or null for a
      // genuinely bodyless request); any truthy stand-in proves the touch.
      return bodyText.length > 0 ? {} : null
    },
  }
  // Mirrors node-server's actual behavior once raw.body has been read: the
  // fast-path text()/arrayBuffer() defer to the now-cached real Request's
  // stream reader, which on Vercel never settles.
  const settle = (): Promise<string> => rawBodyTouched
    ? new Promise<string>(() => { /* never settles — this is the hang */ })
    : Promise.resolve(bodyText)
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    text: () => settle(),
    raw,
  }
  const context = {
    req,
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  } as unknown as Context
  return { context, rawBodyWasTouched: () => rawBodyTouched }
}

async function withPromptDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const DEADLINE_MS = 200
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label} did not settle within ${DEADLINE_MS}ms — something touched c.req.raw.body`,
    )), DEADLINE_MS)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer!)
  }
}

test('gift action empty-body check never touches c.req.raw.body and always answers promptly', async () => {
  const contentLengthFor = (text: string) => String(Buffer.byteLength(text, 'utf8'))

  const empty = nodeServerLikeContext('')
  const emptyResult = await withPromptDeadline(
    emptyActionBodyFailure(empty.context, 'accept'),
    'an empty body',
  )
  assert.equal(emptyResult, null)
  assert.equal(empty.rawBodyWasTouched(), false)

  const emptyObject = nodeServerLikeContext('{}', { 'content-length': contentLengthFor('{}') })
  const emptyObjectResult = await withPromptDeadline(
    emptyActionBodyFailure(emptyObject.context, 'accept'),
    'a {} body',
  )
  assert.equal(emptyObjectResult, null)
  assert.equal(emptyObject.rawBodyWasTouched(), false)

  const nonEmptyText = '{"note":"hi"}'
  const nonEmpty = nodeServerLikeContext(nonEmptyText, { 'content-length': contentLengthFor(nonEmptyText) })
  const nonEmptyResult = await withPromptDeadline(
    emptyActionBodyFailure(nonEmpty.context, 'refuse'),
    'a non-empty body',
  )
  assert.ok(nonEmptyResult)
  assert.equal(nonEmptyResult?.status, 400)
  assert.match(
    String((await nonEmptyResult?.json() as { error: string }).error),
    /gift refuse accepts an empty body only/u,
  )
  assert.equal(nonEmpty.rawBodyWasTouched(), false)
})

test('a number-shaped redirect request id is refused in redirect words before any gift work', async () => {
  const numberShaped = appFor({ targetMatches: true })
  for (const requestId of ['12345678', '1.000000']) {
    const response = await numberShaped.app.request(`/api/city-credit/gifts/${GIFT_ID}/redirect`, postJson({
      claim_token: CLAIM_TOKEN,
      recipient_number: 8,
      recipient_handle: 'resident-eight',
      request_id: requestId,
    }))
    assert.equal(response.status, 400, requestId)
    assert.equal(
      String((await response.json() as { error: string }).error),
      'gift redirect request id must be an identifier you make up for this one redirect, not a number or an amount',
      requestId,
    )
  }
  assert.equal(
    numberShaped.calls.some(call => call.text.includes('prepaid-credit:gift-redirect')),
    false,
    'a refused redirect id must not reach the redirect statement',
  )
})
