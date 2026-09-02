// Decision row 74: POST /api/pair mints a coding client's pairing code.
// test/oauth-flow.test.ts covers the redemption side at /oauth/authorize.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import { mountPairRoutes, PAIRING_CODE_RE } from '../src/pair.ts'
import type { OAuthRateLimitResult } from '../src/oauth-store.ts'

function fakeStore(admitted: OAuthRateLimitResult = { admitted: true, retryAfterSeconds: 17 }) {
  const minted: { residentId: number; codeHash: string }[] = []
  const rateLimitCalls: { bucketHash: string; attemptKind: string; maximum: number }[] = []
  return {
    minted,
    rateLimitCalls,
    async mintPairingCode(input: { residentId: number; codeHash: string }) {
      minted.push(input)
      return { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
    },
    async approveExistingResidentByPairingCodeAndIssueAuthorizationCode() {
      throw new Error('not part of this test')
    },
    async consumeOAuthRateLimit(input: { bucketHash: string; attemptKind: string; maximum: number }) {
      rateLimitCalls.push(input)
      return admitted
    },
  }
}

function appFor(options: {
  authenticated?: { id: number } | null
  store?: ReturnType<typeof fakeStore>
} = {}) {
  const app = new Hono()
  mountPairRoutes(app, {
    authenticate: async () => options.authenticated ?? null,
    store: options.store ?? fakeStore(),
  })
  return app
}

test('minting requires a resident bearer key', async () => {
  const app = appFor({ authenticated: null })
  const response = await app.request('/api/pair', { method: 'POST' })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>',
  })
})

test('minting accepts no query options', async () => {
  const app = appFor({ authenticated: { id: 7 } })
  const response = await app.request('/api/pair?x=1', { method: 'POST' })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'pairing-code minting accepts no query options' })
})

test('minting rejects a nonempty non-object body', async () => {
  const app = appFor({ authenticated: { id: 7 } })
  for (const body of ['not json', '[]', '{"unexpected":true}']) {
    const response = await app.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'POST /api/pair takes an empty body, or {}' })
  }
})

test('an empty body and an empty-object body both mint a code', async () => {
  for (const body of [undefined, '{}']) {
    const store = fakeStore()
    const app = appFor({ authenticated: { id: 7 }, store })
    const response = await app.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })
    assert.equal(response.status, 200)
    const parsed = await response.json() as { status: string; pairing_code: string; expires_at: string; next_step: string }
    assert.equal(parsed.status, 'minted')
    assert.match(parsed.pairing_code, PAIRING_CODE_RE)
    assert.ok(!Number.isNaN(Date.parse(parsed.expires_at)))
    assert.match(parsed.next_step, /shown once/iu)
    assert.match(parsed.next_step, /expires in ten minutes/iu)
    assert.match(parsed.next_step, /works once/iu)
    assert.match(parsed.next_step, /never reveals the key/iu)
    assert.equal(store.minted.length, 1)
    assert.equal(store.minted[0]?.residentId, 7)
    assert.equal(store.minted[0]?.codeHash, sha256(parsed.pairing_code))
  }
})

test('too many mints in one hour are refused with Retry-After', async () => {
  const store = fakeStore({ admitted: false, retryAfterSeconds: 900 })
  const app = appFor({ authenticated: { id: 7 }, store })
  const response = await app.request('/api/pair', { method: 'POST' })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '900')
  const body = await response.json() as { error: string; next_step: string }
  assert.match(body.error, /too many pairing codes minted; you may mint 20 per resident per UTC hour/iu)
  assert.match(body.next_step, /900 seconds/iu)
  assert.equal(store.rateLimitCalls[0]?.attemptKind, 'pair_mint')
  assert.equal(store.rateLimitCalls[0]?.maximum, 20)
})

test('the response never leaks the pairing code anywhere but the pairing_code field', async () => {
  const store = fakeStore()
  const app = appFor({ authenticated: { id: 7 }, store })
  const response = await app.request('/api/pair', { method: 'POST' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('vary') ?? '', /Authorization/u)
})
