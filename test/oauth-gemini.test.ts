import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import { mountOAuthRoutes, residentByOAuthAccessToken } from '../src/oauth.ts'
import { OAUTH_LIMITS } from '../src/oauth-limits.ts'
import { registerGeminiClient, resolveGeminiClient } from '../src/oauth-gemini.ts'
import { EXISTING_KEY, MemoryOAuthStore, rateLimitResult } from './oauth-flow-tests/memory-oauth-store.ts'
import { assertSecretsAbsent, authorizationUrl, browserPost, environment, exchangeCode, readTokenPair, RESOURCE } from './oauth-flow-tests/fixture.ts'

const REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123456-1f3d9_com'
const SECOND_REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-654321-1f3d9_com'
const signingKey = randomBytes(32).toString('hex')

function fixture(patch: Record<string, string> = {}, memory = new MemoryOAuthStore(), pairingEnabled = false) {
  const env = { ...environment, GEMINI_DCR_SIGNING_KEY: signingKey, ...patch }
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: env, store: memory.api, diagnostics: () => undefined,
    pairingEnabled,
    fetcher: (async () => { throw new Error('Gemini registration must not fetch metadata') }) as typeof fetch,
  })
  return { app, memory, env }
}

function register(app: Hono, body: unknown = { redirect_uris: [REDIRECT] }, headers: Record<string, string> = {}) {
  return app.request('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
}

async function client(app: Hono, redirects = [REDIRECT]): Promise<string> {
  const response = await register(app, { redirect_uris: redirects })
  assert.equal(response.status, 201)
  return (await response.json()).client_id
}

async function consent(app: Hono, clientId: string) {
  const location = authorizationUrl({ client_id: clientId, redirect_uri: REDIRECT })
  const started = await app.request(location)
  assert.equal(started.status, 200)
  const html = await started.text()
  assert.match(html, /Gemini/)
  assert.match(started.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/oauth-redirect\.googleusercontent\.com;/)
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!
  const approval = await browserPost(app, { cookie, csrf, html, location, rawSession: '' }, {
    action: 'link', csrf, resident_key: EXISTING_KEY,
  })
  const callback = await assertGeminiReturnPage(approval, REDIRECT, 'client-state-that-must-survive')
  return callback.searchParams.get('code')!
}

async function geminiSession(app: Hono, clientId: string, state: string) {
  const location = authorizationUrl({ client_id: clientId, redirect_uri: SECOND_REDIRECT, state })
  const started = await app.request(location)
  assert.equal(started.status, 200)
  const html = await started.text()
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!
  return { cookie, csrf, html, location, rawSession: '' }
}

async function assertGeminiReturnPage(response: Response, redirectUri: string, state: string): Promise<URL> {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/iu)
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://oauth-redirect.googleusercontent.com; base-uri 'none'; frame-ancestors 'none'",
  )
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/iu)

  const body = await response.text()
  assert.match(body, /<h1>Your resident is ready<\/h1>/u)
  assert.equal([...body.matchAll(/<a\b/giu)].length, 1)
  assert.match(body, /<a href="[^"]+">Return to Gemini<\/a>/u)
  assert.doesNotMatch(body, /<script\b|http-equiv\s*=\s*["']?refresh/iu)
  assert.doesNotMatch(body, /\*\.googleusercontent\.com/u)

  const escapedHref = body.match(/<a href="([^"]+)">Return to Gemini<\/a>/u)?.[1]
  assert.ok(escapedHref)
  const callback = new URL(escapedHref!.replaceAll('&amp;', '&'))
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUri)
  assert.match(callback.searchParams.get('code') ?? '', /^1f3d9_ac_[0-9a-f]{64}$/u)
  assert.equal(callback.searchParams.get('state'), state)
  assert.deepEqual([...callback.searchParams.keys()].sort(), ['code', 'state'])
  return callback
}

function refresh(app: Hono, clientId: string, token: string) {
  return app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, resource: RESOURCE, refresh_token: token }),
  })
}

test('Gemini registration advertises its endpoint and fixes public client metadata', async () => {
  const { app } = fixture()
  const metadata = await (await app.request('/.well-known/oauth-authorization-server')).json()
  assert.equal(metadata.registration_endpoint, 'https://1f3d9.com/oauth/register')
  const response = await register(app, {
    redirect_uris: [REDIRECT], client_name: '<script>impersonate</script>',
    token_endpoint_auth_method: 'client_secret_basic', scope: 'anything',
    grant_types: ['client_credentials'], response_types: ['token'],
  })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const registered = await response.json()
  assert.equal(registered.client_name, 'Gemini')
  assert.equal(registered.token_endpoint_auth_method, 'none')
  assert.equal(registered.scope, 'city:resident')
  assert.deepEqual(registered.redirect_uris, [REDIRECT])
  assert.deepEqual(registered.grant_types, ['authorization_code', 'refresh_token'])
  assert.deepEqual(registered.response_types, ['code'])
  assert.equal(registered.client_secret, undefined)
  assert.ok(registered.client_id.length <= 2048)
})

test('Gemini refuses every raw near-match and malformed registration', async () => {
  const { app } = fixture()
  const bad = [
    REDIRECT.replace('googleusercontent.com', 'googleusercontent.com.evil.test'),
    REDIRECT.replace('https:', 'http:'), REDIRECT.replace('-123456-', '-abc-'),
    REDIRECT.replace('-123456-', '--'), REDIRECT.replace('1f3d9_com', 'other_com'),
    REDIRECT + '/more', REDIRECT + '?', REDIRECT + '?x=1', REDIRECT + '#', REDIRECT + '#x',
    REDIRECT.replace('.com/r', '.com:443/r'), REDIRECT.replace('.com/r', '.com:8443/r'),
    REDIRECT.replace('https://', 'https://user@'), REDIRECT.replace('https://', 'https://@'),
    REDIRECT.replace('/r/', '/other/../r/'), REDIRECT.replace('/r/', '/%72/'),
    REDIRECT.replace('googleusercontent', 'GOOGLEUSERCONTENT'), REDIRECT + '\n',
  ]
  for (const redirect of bad) {
    for (const redirects of [[redirect]]) {
      const response = await register(app, { redirect_uris: redirects })
      assert.equal(response.status, 400, JSON.stringify(redirects))
      assert.equal((await response.json()).error, 'invalid_redirect_uri')
    }
  }
  for (const body of [null, [], {}, { redirect_uris: [] }, { redirect_uris: REDIRECT }, { redirect_uris: [4] },
    { redirect_uris: [REDIRECT, 4] }, { redirect_uris: [REDIRECT, 'x'.repeat(1025)] }]) {
    assert.equal((await register(app, body)).status, 400)
  }
  assert.equal((await register(app, { redirect_uris: [REDIRECT] }, { 'content-type': 'text/plain' })).status, 400)
  assert.equal((await register(app, { redirect_uris: [REDIRECT], ignored: 'x'.repeat(8192) })).status, 400)
  const statement = await register(app, { redirect_uris: [REDIRECT], software_statement: 'untrusted' })
  assert.equal((await statement.json()).error, 'unapproved_software_statement')
  assert.equal((await register(app, { redirect_uris: Array.from({ length: 11 }, () => REDIRECT) })).status, 400)
  const oversized = Array.from({ length: 10 }, (_, i) => REDIRECT.replace('123456', String(i).repeat(140)))
  assert.equal((await register(app, { redirect_uris: oversized })).status, 400)
})

// Gemini's real backend sends these six variants; its UI copies only the third.
// The numeric account component is synthetic; host and path shapes are recorded Preview evidence.
for (const host of ['1f3d9.com', '1f3d9-git-feat-gemini-google-ae6fcd-onetapstudiogames-projects.vercel.app']) {
  test(`Gemini selects only the supported callback from its six-address registration for ${host}`, async () => {
    const { app } = fixture({ PUBLIC_ORIGIN: `https://${host}` })
    const suffix = `user_bound_custom-mcp-123456789012345678901-${host.replaceAll('.', '_')}`
    const redirects = ['r', 'a'].flatMap(path => ['oauth-redirect-sandbox', 'oauth-redirect-test', 'oauth-redirect']
      .map(domain => `https://${domain}.googleusercontent.com/${path}/${suffix}`))
    const response = await register(app, {
      redirect_uris: redirects, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_name: 'Gemini', scope: 'city:resident',
      software_id: 'gemini', software_version: '1', unknown_metadata: { ignored: true },
    })
    assert.equal(response.status, 201)
    const registered = await response.json()
    assert.deepEqual(registered.redirect_uris, [redirects[2]])
    assert.equal(registered.token_endpoint_auth_method, 'none')
    assert.equal(registered.client_secret, undefined)
    for (const redirect of redirects) {
      const authorization = await app.request(authorizationUrl({ client_id: registered.client_id,
        redirect_uri: redirect, resource: `https://${host}/mcp/connect` }))
      assert.equal(authorization.status, redirect === redirects[2] ? 200 : 400, redirect)
      assert.equal(authorization.headers.get('location'), null)
    }
    assert.equal((await register(app, { redirect_uris: redirects.filter(uri => uri !== redirects[2]) })).status, 400)
  })
}

test('Gemini never registers a foreign callback when selecting supported redirects', async () => {
  const { app, env } = fixture()
  const foreign = REDIRECT.replace('oauth-redirect.googleusercontent.com', 'evil.example')
  const response = await register(app, { redirect_uris: [foreign, REDIRECT, REDIRECT] })
  assert.equal(response.status, 201)
  const registered = await response.json()
  assert.deepEqual(registered.redirect_uris, [REDIRECT])
  assert.equal((await app.request(authorizationUrl({ client_id: registered.client_id, redirect_uri: foreign }))).status, 400)
  const invalidId = registerGeminiClient([REDIRECT, foreign], env)!
  assert.equal(resolveGeminiClient(invalidId, env), null)
})

test('Gemini exact redirects survive stateless resolution and are tied to the configured origin and key', async () => {
  const { app } = fixture()
  const id = await client(app)
  const same = fixture().app
  const other = REDIRECT.replace('123456', '654321')
  const multiId = await client(app, [REDIRECT, other])
  assert.equal((await app.request(authorizationUrl({ client_id: multiId, redirect_uri: other }))).status, 200)
  assert.equal((await same.request(authorizationUrl({ client_id: id, redirect_uri: REDIRECT }))).status, 200)
  for (const changed of [id.slice(0, -1) + (id.endsWith('A') ? 'B' : 'A'), id + 'x']) {
    assert.equal((await app.request(authorizationUrl({ client_id: changed, redirect_uri: REDIRECT }))).status, 400)
  }
  const preview = fixture({ PUBLIC_ORIGIN: 'https://city-preview.example' }).app
  assert.equal((await register(preview)).status, 400)
  const previewRedirect = REDIRECT.replace('1f3d9_com', 'city-preview_example')
  const previewId = await client(preview, [previewRedirect])
  assert.equal((await preview.request(authorizationUrl({ client_id: previewId, redirect_uri: previewRedirect, resource: 'https://city-preview.example/mcp/connect' }))).status, 200)
  assert.equal((await preview.request(authorizationUrl({ client_id: id, redirect_uri: REDIRECT }))).status, 400)
  assert.equal((await fixture({ GEMINI_DCR_SIGNING_KEY: randomBytes(32).toString('hex') }).app.request(authorizationUrl({ client_id: id, redirect_uri: REDIRECT }))).status, 400)
})

test('Gemini refuses changed callbacks, missing or plain PKCE, and wrong scope or resource', async () => {
  const { app } = fixture()
  const id = await client(app)
  for (const patch of [
    { redirect_uri: REDIRECT.replace('123456', '654321') },
    { code_challenge_method: 'plain' }, { code_challenge_method: '' }, { code_challenge: '' },
    { scope: 'anything' }, { resource: 'https://other.example/mcp/connect' },
  ]) {
    const response = await app.request(authorizationUrl({ client_id: id, redirect_uri: REDIRECT, ...patch }))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('location'), null)
  }
})

test('Gemini completes consent, S256 exchange, refresh rotation, reuse revocation, and rejects secrets', async () => {
  const { app, env, memory } = fixture()
  const id = await client(app)
  const code = await consent(app, id)
  for (const secret of ['', 'not-a-secret']) {
    assert.equal((await exchangeCode(app, code, { client_id: id, redirect_uri: REDIRECT, client_secret: secret })).status, 400)
  }
  assert.equal((await exchangeCode(app, code, { client_id: id, redirect_uri: REDIRECT, code_verifier: 'wrong' })).status, 400)
  assert.equal((await exchangeCode(app, code, { client_id: id, redirect_uri: REDIRECT + '?x=1' })).status, 400)
  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: id, redirect_uri: REDIRECT }))
  for (const secret of ['', 'not-a-secret']) {
    const refused = await app.request('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: id, resource: RESOURCE, refresh_token: pair.refresh_token, client_secret: secret }),
    })
    assert.equal(refused.status, 400)
  }
  const basic = await app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic dGVzdDp0ZXN0' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: id, resource: RESOURCE, refresh_token: pair.refresh_token }),
  })
  assert.equal(basic.status, 400)
  assert.equal(pair.expires_in, 600)
  assert.equal((await residentByOAuthAccessToken(pair.access_token, env, memory.api))?.handle, 'chatty')
  const second = await readTokenPair(await refresh(app, id, pair.refresh_token))
  assert.notEqual(second.refresh_token, pair.refresh_token)
  assert.equal((await refresh(app, id, pair.refresh_token)).status, 400)
  assert.equal(await residentByOAuthAccessToken(second.access_token, env, memory.api), null)
})

test('Gemini signup, existing-resident, and pairing success return one private exact callback link', async () => {
  const { app, memory } = fixture({}, undefined, true)
  const id = await client(app, [REDIRECT, SECOND_REDIRECT])
  const state = 'gemini-state-<img src=x onerror="bad"> & single-quote: \' '

  const linkSession = await geminiSession(app, id, state)
  const linked = await browserPost(app, linkSession, {
    action: 'link', csrf: linkSession.csrf, resident_key: EXISTING_KEY,
  })
  await assertGeminiReturnPage(linked, SECOND_REDIRECT, state)

  const signupSession = await geminiSession(app, id, state)
  const staged = await browserPost(app, signupSession, {
    action: 'register', csrf: signupSession.csrf, handle: 'gemini-ready', model: 'test client',
  })
  const stagedBody = await staged.text()
  const rootKey = stagedBody.match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
  const recoveryCodes = stagedBody.match(/1f3d9_rc_[0-9a-f]{64}/gu) ?? []
  assert.ok(rootKey)
  assert.equal(recoveryCodes.length, 8)
  const confirmed = await browserPost(app, signupSession, {
    action: 'confirm', csrf: signupSession.csrf, resident_key: rootKey!,
  })
  const confirmedBody = confirmed.clone().text()
  const signupReturn = await assertGeminiReturnPage(confirmed, SECOND_REDIRECT, state)
  assertSecretsAbsent(await confirmedBody, [rootKey!, ...recoveryCodes, EXISTING_KEY])
  assert.match(signupReturn.searchParams.get('code') ?? '', /^1f3d9_ac_[0-9a-f]{64}$/u)

  const pairingCode = `1f3d9_pc_${'cd'.repeat(32)}`
  await memory.api.mintPairingCode({ residentId: 49, codeHash: sha256(pairingCode) })
  const pairSession = await geminiSession(app, id, state)
  const pairPage = await browserPost(app, pairSession, {
    action: 'pair', csrf: pairSession.csrf, pairing_code: pairingCode,
  })
  assert.equal(pairPage.status, 200)
  const paired = await browserPost(app, pairSession, {
    action: 'pair_confirm', csrf: pairSession.csrf, pairing_code: pairingCode,
  })
  await assertGeminiReturnPage(paired, SECOND_REDIRECT, state)
})

test('Gemini signing key loss stops new registration and rechecks issued IDs at token exchange and refresh', async () => {
  const { app, memory } = fixture()
  const id = await client(app)
  const code = await consent(app, id)
  const unconfigured = fixture({ GEMINI_DCR_SIGNING_KEY: '' }, memory).app
  assert.equal((await register(unconfigured)).status, 503)
  assert.equal((await exchangeCode(unconfigured, code, { client_id: id, redirect_uri: REDIRECT })).status, 400)
  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: id, redirect_uri: REDIRECT }))
  assert.equal((await refresh(unconfigured, id, pair.refresh_token)).status, 400)
})

test('Gemini registration uses one isolated per-network OAuth allowance and fails closed on storage errors', async () => {
  const { app, memory } = fixture({ VERCEL: '1' })
  const initialState = memory.safeState()
  const calls: Parameters<typeof memory.api.consumeOAuthRateLimit>[0][] = []
  memory.api.consumeOAuthRateLimit = async input => { calls.push(input); return rateLimitResult(calls.length === 1, 17) }
  assert.equal((await register(app, undefined, { 'x-vercel-forwarded-for': '192.0.2.1' })).status, 201)
  const refused = await register(app, undefined, { 'x-vercel-forwarded-for': '192.0.2.1' })
  assert.equal(refused.status, 429)
  assert.equal(refused.headers.get('retry-after'), '17')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.attemptKind, 'authorize')
  assert.equal(calls[0]!.maximum, OAUTH_LIMITS.clientRegistrationsPerNetworkHour)
  assert.equal(calls[0]!.bucketHash, calls[1]!.bucketHash)
  assert.equal(memory.safeState(), initialState)
  memory.api.consumeOAuthRateLimit = async () => { throw new Error('database unavailable') }
  assert.equal((await register(app)).status, 503)
})
