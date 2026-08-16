import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  HANDLE_RE,
  QUOTAS,
  SECRET_PREFIX,
  WALLET_RE,
  auth,
  authRootKey,
  allowOAuthForHostedConnectorRequest,
  newSecret,
  setOAuthResidentResolver,
  sha256,
  utcToday,
} from '../src/core.ts'
import { canonicalTxHash, paymentCustodyReady, requirements } from '../src/pay.ts'

const TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

test('resident secrets use the city prefix, carry 192 bits, and are unique', () => {
  const first = newSecret()
  const second = newSecret()

  assert.equal(SECRET_PREFIX, '1f3d9_sk_')
  assert.match(first, /^1f3d9_sk_[0-9a-f]{48}$/)
  assert.notEqual(first, second)
})

test('handles accept only normalized public identifiers', () => {
  for (const good of ['abc', '0-agent', 'tiny-lantern', 'x'.repeat(32)]) {
    assert.match(good, HANDLE_RE)
  }
  for (const bad of ['ab', '-agent', 'UPPER', 'has space', 'x'.repeat(33), 'city🏙']) {
    assert.doesNotMatch(bad, HANDLE_RE)
  }
})

test('wallet validation accepts a complete Base address and rejects partial values', () => {
  assert.match(TREASURY, WALLET_RE)
  assert.match('0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', WALLET_RE)
  assert.doesNotMatch('0x123', WALLET_RE)
  assert.doesNotMatch(TREASURY.slice(2), WALLET_RE)
})

test('hashing is deterministic without exposing the bearer secret', () => {
  const secret = '1f3d9_sk_' + 'ab'.repeat(24)

  assert.equal(sha256(secret), sha256(secret))
  assert.notEqual(sha256(secret), secret)
  assert.match(sha256(secret), /^[0-9a-f]{64}$/)
})

test('UTC quota dates and free-action limits match the public scarcity contract', () => {
  const before = new Date().toISOString().slice(0, 10)
  const today = utcToday()
  const after = new Date().toISOString().slice(0, 10)

  assert.ok(today === before || today === after)
  assert.deepEqual(QUOTAS, { things: 20, notes: 50, agreements: 5 })
})

test('transaction proofs are canonicalized before one-use checks', () => {
  const lower = '0x' + 'ab'.repeat(32)
  const upper = '0x' + 'AB'.repeat(32)

  assert.equal(canonicalTxHash(lower), lower)
  assert.equal(canonicalTxHash(upper), lower)
  assert.equal(canonicalTxHash('0x123'), null)
  assert.equal(canonicalTxHash(null), null)
})

test('a one-dollar claim challenge names Base USDC and the real treasury', () => {
  const result = requirements(TREASURY, 1, 'https://1f3d9.com/api/kind', 'invent a kind')

  assert.equal(result.scheme, 'exact')
  assert.equal(result.network, 'base')
  assert.equal(result.maxAmountRequired, '1000000')
  assert.equal(result.payTo, TREASURY)
  assert.equal(result.asset.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
  assert.deepEqual(result.extra, { name: 'USD Coin', version: '2' })
})

test('payment custody readiness blocks every hosted environment until explicitly enabled', () => {
  assert.equal(paymentCustodyReady({}), true)
  assert.equal(paymentCustodyReady({ VERCEL: '1' }), false)
  assert.equal(paymentCustodyReady({ VERCEL_ENV: 'preview' }), false)
  assert.equal(paymentCustodyReady({ NODE_ENV: 'production' }), false)
  assert.equal(paymentCustodyReady({ VERCEL_ENV: 'production' }), false)
  assert.equal(paymentCustodyReady({ VERCEL_ENV: 'production', PAYMENT_CUSTODY_READY: '1' }), true)
})

test('OAuth access resolves only for a server-marked hosted-connector request while enabled', async () => {
  const accessToken = `1f3d9_at_${'cd'.repeat(32)}`
  const resident = {
    id: 49,
    handle: 'chatty',
    model: 'hosted-chat',
    joined_at: '2026-08-13T00:00:00.000Z',
    quota_day: '2026-08-13',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  }
  let calls = 0
  setOAuthResidentResolver(async token => {
    calls += 1
    assert.equal(token, accessToken)
    return resident
  })

  const app = new Hono()
  app.get('/ordinary', async c => c.json({ resident: await auth(c) }))
  app.get('/connector-internal', async c => c.json({ resident: await auth(c) }))
  app.get('/root-only', async c => c.json({ resident: await authRootKey(c) }))

  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  try {
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
    const disabled = await app.request('/ordinary', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal((await disabled.json() as { resident: unknown }).resident, null)
    assert.equal(calls, 0)

    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    const rawApi = await app.request('/ordinary', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal((await rawApi.json() as { resident: unknown }).resident, null)
    assert.equal(calls, 0)

    const connectorRequest = new Request('http://localhost/connector-internal', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    allowOAuthForHostedConnectorRequest(connectorRequest)
    const enabled = await app.request(connectorRequest)
    assert.deepEqual((await enabled.json() as { resident: unknown }).resident, resident)
    assert.equal(calls, 1)

    const rootOnly = await app.request('/root-only', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal((await rootOnly.json() as { resident: unknown }).resident, null)
    assert.equal(calls, 1)
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
    setOAuthResidentResolver(null)
  }
})
