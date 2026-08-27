import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Hono, type Context } from 'hono'
import { mountPrepaidCreditGiftRoutes } from '../src/prepaid-credit-routes.ts'

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
        if (text.includes('prepaid-credit-routes:resident-lookup')) {
          return input.targetMatches === false ? [] : [{ id: 8, handle: 'resident-eight' }]
        }
        if (text.includes('prepaid-credit-routes:resident-confirmation')) {
          return input.targetMatches === false ? [] : [{ id: 8, handle: 'resident-eight' }]
        }
        if (text.includes('prepaid-credit:gift-accept')) {
          return [{
            gift_id: GIFT_ID,
            status: input.giftStatus ?? 'accepted',
            amount_units: '3000000',
            frozen_at: input.disputeBlocked ? '2026-08-27T18:00:00.000Z' : null,
          }]
        }
        if (text.includes('prepaid-credit:gift-refuse')) {
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
  assert.equal((await found.app.request('/api/city-credit/gifts/residents/not-a-number')).status, 400)
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
    error: 'resident number and handle did not identify the same resident; no gift was redirected',
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
          : /resolved against.*permanently revoked.*never add credit/iu)
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
      : /resolved against.*permanently revoked.*never add credit/iu)
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
