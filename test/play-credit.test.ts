import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { PLAY_CREDIT_PACKS, PlayCreditFailure, playConfiguration, playCredits, verifyPlayWebhook, verifyPlayPurchase } from '../src/play-credit.ts'
import { mountPlayCreditRoutes } from '../src/play-credit-routes.ts'
import { redactLogSecrets } from '../src/log-redaction.ts'

test('Play packs have fixed counts and refuse unknown products', () => {
  assert.deepEqual(PLAY_CREDIT_PACKS, { fee_credit_1_v1: 1, fee_credit_5_v1: 5, fee_credit_10_v1: 10 })
  assert.equal(playCredits('fee_credit_5_v1'), 5)
  assert.throws(() => playCredits('unknown'))
  assert.throws(() => playCredits('toString'))
})

test('webhook authorization and optional HMAC check exact bytes and fresh delivery time', () => {
  const secret = 'test-signing-value'
  const body = '{"event":{}}'
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  assert.equal(verifyPlayWebhook('test-auth', 'test-auth', body), true)
  assert.equal(verifyPlayWebhook(undefined, 'test-auth', body), false)
  assert.equal(verifyPlayWebhook('wrong', 'test-auth', body), false)
  assert.equal(verifyPlayWebhook('test-auth', 'test-auth', body, secret, `t=${timestamp},v1=${signature}`), true)
  assert.equal(verifyPlayWebhook('test-auth', 'test-auth', body + ' ', secret, `t=${timestamp},v1=${signature}`), false)
  assert.equal(verifyPlayWebhook('test-auth', 'test-auth', body, secret, `t=${timestamp},v1=${signature}`, timestamp + 301), false)
})

test('REST verification uses the documented v2 purchase and product shapes, never price or quantity', async () => {
  const requests: string[] = []
  const fetcher = (async (url: string | URL | Request) => {
    requests.push(String(url))
    return Response.json(String(url).includes('/products/')
      ? { id: 'prod_test', store_identifier: 'fee_credit_5_v1', type: 'one_time', one_time: { is_consumable: true } }
      : { items: [{ product_id: 'prod_test', store_purchase_identifier: 'GPA.test-transaction', store: 'play_store', environment: 'production', status: 'owned', purchased_at: 1000, quantity: 99, revenue_in_usd: { gross: -1 } }], next_page: null })
  }) as typeof fetch
  const verified = await verifyPlayPurchase({ secretKey: 'test-key', projectId: 'proj_test' }, 'test-app-user', 'GPA.test-transaction', fetcher)
  assert.equal(verified.productId, 'fee_credit_5_v1')
  assert.equal(playCredits(verified.productId), 5)
  assert.equal(verified.refunded, false)
  assert.equal(requests.length, 2)
})

test('all Play routes fail closed with missing configuration and no database work', async () => {
  const app = new Hono()
  mountPlayCreditRoutes(app, { environment: {}, database: { async query() { throw new Error('database must not be called') } } })
  for (const [method, path] of [['GET', '/residents/by-handle/test'], ['POST', '/orders'], ['GET', '/orders/test'], ['POST', '/orders/test/claim'], ['POST', '/webhook']] as const) {
    const response = await app.request(`/api/city-credit/play${path}`, { method })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('RevenueCat key shapes and configured webhook values are redacted', () => {
  assert.doesNotMatch(redactLogSecrets('provider sk_' + 'x'.repeat(32)), /sk_x/)
  const previous = process.env.REVENUECAT_WEBHOOK_AUTH
  process.env.REVENUECAT_WEBHOOK_AUTH = 'test-webhook-configured-value'
  try { assert.doesNotMatch(redactLogSecrets('oops test-webhook-configured-value'), /test-webhook-configured-value/) }
  finally { if (previous === undefined) delete process.env.REVENUECAT_WEBHOOK_AUTH; else process.env.REVENUECAT_WEBHOOK_AUTH = previous }
})

const configured = { REVENUECAT_SECRET_KEY: 'test-key', REVENUECAT_PROJECT_ID: 'proj_test', REVENUECAT_WEBHOOK_AUTH: 'test-auth',
  PLAY_CREDIT_CALLER_HASH_SECRET: 'test-caller', PLAY_CREDIT_ENVIRONMENT: 'production' }

test('provider network and malformed response failures are retryable 503, and production refuses sandbox configuration', async () => {
  const outage = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  const malformed = (async () => new Response('not-json')) as typeof fetch
  for (const fetcher of [outage, malformed]) {
    await assert.rejects(verifyPlayPurchase({ secretKey: 'test', projectId: 'proj_test' }, 'test-user', 'GPA.test', fetcher),
      error => error instanceof PlayCreditFailure && error.status === 503)
  }
  assert.equal(playConfiguration({ ...configured, VERCEL_ENV: 'production', PLAY_CREDIT_ENVIRONMENT: 'sandbox' }), null)
})

test('Play routes refuse extra amount fields, missing residents, and exhausted limits; forwarded caller cannot be spoofed', async () => {
  const hashes: unknown[] = []
  const database = { async query(sql: string, params: readonly unknown[] = []) {
    if (sql.includes('paypal-credit:rate-limit')) { hashes.push(params[0]); return [{ used: 1 }] }
    return []
  } }
  const app = new Hono()
  mountPlayCreditRoutes(app, { database, environment: { ...configured, VERCEL: '1' } })
  for (const attacker of ['attacker-one', 'attacker-two']) {
    const result = await app.request('/api/city-credit/play/residents/by-handle/nobody', { headers: {
      'x-forwarded-for': attacker, 'x-vercel-forwarded-for': `${attacker}, trusted-address`,
    } })
    assert.equal(result.status, 404)
  }
  assert.equal(hashes[0], hashes[1])
  const invalid = await app.request('/api/city-credit/play/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: 'test-order', resident_number: 2, resident_handle: 'nobody', product_id: 'fee_credit_5_v1', rc_app_user_id: 'test-user', amount: 500 }) })
  assert.equal(invalid.status, 400)
  assert.equal(hashes.length, 2)
  const limited = new Hono()
  mountPlayCreditRoutes(limited, { environment: configured, database: { async query() { return [] } } })
  assert.equal((await limited.request('/api/city-credit/play/residents/by-handle/nobody')).status, 429)
})
