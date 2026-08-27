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
          return [{ gift_id: GIFT_ID, status: 'accepted', amount_units: '3000000' }]
        }
        if (text.includes('prepaid-credit:gift-refuse')) {
          return [{ gift_id: GIFT_ID, status: 'refused', amount_units: '3000000' }]
        }
        if (text.includes('prepaid-credit:gift-redirect')) {
          return [{ gift_id: GIFT_ID, status: 'pending', amount_units: '3000000' }]
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
