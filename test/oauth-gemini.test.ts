import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import { mountOAuthRoutes, residentByOAuthAccessToken, type OAuthDiagnosticRecord } from '../src/oauth.ts'
import { OAUTH_LIMITS } from '../src/oauth-limits.ts'
import { registerGeminiClient, resolveGeminiClient } from '../src/oauth-gemini.ts'
import { EXISTING_KEY, MemoryOAuthStore, rateLimitResult } from './oauth-flow-tests/memory-oauth-store.ts'
import { assertSecretsAbsent, authorizationUrl, browserPost, environment, exchangeCode, readTokenPair, RESOURCE } from './oauth-flow-tests/fixture.ts'

const REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123456-1f3d9_com'
const SECOND_REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-654321-1f3d9_com'
const signingKey = randomBytes(32).toString('hex')

type Sink = (record: Readonly<OAuthDiagnosticRecord>) => void

function fixture(patch: Record<string, string> = {}, memory = new MemoryOAuthStore(), pairingEnabled = false, diagnostics: Sink = () => undefined) {
  const env = { ...environment, GEMINI_DCR_SIGNING_KEY: signingKey, ...patch }
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: env, store: memory.api, diagnostics,
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

async function consent(app: Hono, clientId: string, redirect = REDIRECT) {
  const location = authorizationUrl({ client_id: clientId, redirect_uri: redirect })
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
  const callback = await assertGeminiReturnPage(approval, redirect, 'client-state-that-must-survive')
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
    response.headers.get('content-security-policy')?.replace(/nonce-[^']+/u, 'nonce-redacted'),
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-redacted'; form-action 'self' https://oauth-redirect.googleusercontent.com; base-uri 'none'; frame-ancestors 'none'",
  )
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/iu)

  const body = await response.text()
  assert.match(body, /<h1>Your resident is ready<\/h1>/u)
  const main = body.match(/<main>([\s\S]*?)<\/main>/u)?.[1]
  const footer = body.match(/<footer class="identity-footer">([\s\S]*?)<\/footer>/u)?.[1]
  assert.ok(main)
  assert.ok(footer)
  assert.equal([...main.matchAll(/<a\b/giu)].length, 1)
  assert.match(main, /<a href="[^"]+">Return to Gemini<\/a>/u)
  assert.deepEqual([...footer.matchAll(/<a href="([^"]+)"/gu)].map(match => match[1]), [
    '/setup', '/terms', '/privacy', '/delete', '/support', 'mailto:adam@twamd.com', '/about',
  ])
  assert.equal([...body.matchAll(/<a\b/giu)].length, 8)
  assert.doesNotMatch(body, /<script\b|http-equiv\s*=\s*["']?refresh/iu)
  assert.doesNotMatch(body, /\*\.googleusercontent\.com/u)

  const escapedHref = main.match(/<a href="([^"]+)">Return to Gemini<\/a>/u)?.[1]
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

// In October 2026 Gemini's backend sent these six variants; its UI copied only the third.
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

// Since November 2026 Google sends an opaque user-bound segment with no server name.
// Every segment below is invented; none comes from a real Google account.
const OPAQUE_PREFIX = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-'
const OPAQUE_SEGMENT = '4815162342c0ffee15deadbe'
const OPAQUE = `${OPAQUE_PREFIX}${OPAQUE_SEGMENT}`
const opaqueAt = (segment: string) => `${OPAQUE_PREFIX}${segment}`

function revoke(app: Hono, clientId: string, token: string) {
  return app.request('/oauth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: clientId }),
  })
}

async function assertRefused(app: Hono, redirect: string): Promise<void> {
  const response = await register(app, { redirect_uris: [redirect] })
  assert.equal(response.status, 400, JSON.stringify(redirect))
  assert.equal((await response.json()).error, 'invalid_redirect_uri')
  const mixed = await register(app, { redirect_uris: [redirect, OPAQUE] })
  assert.equal(mixed.status, 201, JSON.stringify(redirect))
  assert.deepEqual((await mixed.json()).redirect_uris, [OPAQUE])
}

for (const host of ['1f3d9.com', '1f3d9-git-feat-gemini-google-ae6fcd-onetapstudiogames-projects.vercel.app']) {
  test(`Gemini selects only the supported callback from its opaque six-address registration for ${host}`, async () => {
    const { app } = fixture({ PUBLIC_ORIGIN: `https://${host}` })
    const redirects = ['r', 'a'].flatMap(path => ['oauth-redirect-sandbox', 'oauth-redirect-test', 'oauth-redirect']
      .map(domain => `https://${domain}.googleusercontent.com/${path}/user_bound_custom-mcp-${OPAQUE_SEGMENT}`))
    const response = await register(app, {
      redirect_uris: redirects, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_name: 'Google',
    }, { 'user-agent': 'OpenAuth' })
    assert.equal(response.status, 201)
    const registered = await response.json()
    assert.deepEqual(registered.redirect_uris, [redirects[2]])
    assert.equal(registered.client_name, 'Gemini')
    for (const redirect of redirects) {
      const authorization = await app.request(authorizationUrl({ client_id: registered.client_id,
        redirect_uri: redirect, resource: `https://${host}/mcp/connect` }))
      assert.equal(authorization.status, redirect === redirects[2] ? 200 : 400, redirect)
      assert.equal(authorization.headers.get('location'), null)
    }
    assert.equal((await register(app, { redirect_uris: redirects.filter(uri => uri !== redirects[2]) })).status, 400)
  })
}

test('Gemini accepts opaque segments of 16 to 64 letters or digits and refuses 15 or 65', async () => {
  const { app } = fixture()
  for (const segment of ['a1'.repeat(8), 'f0'.repeat(32), '1234567890123456', 'AbCdEf0123456789XyZ', 'ABCDEF0123456789']) {
    const response = await register(app, { redirect_uris: [opaqueAt(segment)] })
    assert.equal(response.status, 201, segment)
    assert.deepEqual((await response.json()).redirect_uris, [opaqueAt(segment)])
  }
  for (const segment of ['a1'.repeat(7) + 'a', 'f0'.repeat(32) + 'f', '']) await assertRefused(app, opaqueAt(segment))
})

test('Gemini refuses every opaque near-match on another host, path or spelling', async () => {
  const { app } = fixture()
  const bad = [
    OPAQUE.replace('oauth-redirect.', 'oauth-redirect-test.'), OPAQUE.replace('oauth-redirect.', 'oauth-redirect-sandbox.'),
    OPAQUE.replace('/r/', '/a/'), OPAQUE.replace('https:', 'http:'), OPAQUE.replace('googleusercontent', 'GOOGLEUSERCONTENT'),
    ...['.', '/', '%2e', '-', '_', '~', '+', '='].map(mark => opaqueAt(`4815162342${mark}c0ffee15deadbe`)),
    OPAQUE + '\n', OPAQUE + ' ', OPAQUE + '\t', OPAQUE + '?', OPAQUE + '?x=1', OPAQUE + '#', OPAQUE + '#x',
    OPAQUE.replace('.com/r', '.com:443/r'), OPAQUE.replace('https://', 'https://user@'), OPAQUE.replace('https://', 'https://@'),
    OPAQUE + '/more', OPAQUE.replace('/r/', '/%72/'), OPAQUE.replace('/r/', '/other/../r/'),
  ]
  for (const redirect of bad) await assertRefused(app, redirect)
})

test('Gemini keeps both address forms anchored to the one Google host and path', async () => {
  const { app } = fixture()
  for (const redirect of [
    `https://evil.example/r/user_bound_custom-mcp-${OPAQUE_SEGMENT}`,
    OPAQUE.replace('googleusercontent.com', 'googleusercontent.com.evil.test'),
    `https://x.example/?${OPAQUE}`,
    `https://x.example/r/user_bound_custom-mcp-1-1f3d9_com${OPAQUE_SEGMENT}`,
    `${REDIRECT}${OPAQUE_SEGMENT}`, `${REDIRECT}abcdef0123456789`,
  ]) await assertRefused(app, redirect)
})

test('Gemini still binds October-form addresses to this city host', async () => {
  const { app } = fixture()
  for (const redirect of [
    REDIRECT.replace('1f3d9_com', 'other_com'), REDIRECT.replace('1f3d9_com', 'evil_example'),
    REDIRECT.replace('-123456-', '-abc-'), REDIRECT.replace('-123456-', '--'), REDIRECT.replace('-123456-', '-'),
  ]) await assertRefused(app, redirect)
  const preview = fixture({ PUBLIC_ORIGIN: 'https://city-preview.example' }).app
  assert.equal((await register(preview)).status, 400)
})

test('Gemini never signs a foreign callback beside an opaque one', async () => {
  const { app, env } = fixture()
  const foreign = OPAQUE.replace('oauth-redirect.googleusercontent.com', 'evil.example')
  const response = await register(app, { redirect_uris: [foreign, OPAQUE, OPAQUE] })
  assert.equal(response.status, 201)
  const registered = await response.json()
  assert.deepEqual(registered.redirect_uris, [OPAQUE])
  assert.equal((await app.request(authorizationUrl({ client_id: registered.client_id, redirect_uri: foreign }))).status, 400)
  assert.equal(resolveGeminiClient(registerGeminiClient([OPAQUE, foreign], env)!, env), null)
})

test('Gemini opaque client IDs are tied to the exact ID, origin and key', async () => {
  const { app, env, memory } = fixture()
  const id = await client(app, [OPAQUE])
  assert.deepEqual(resolveGeminiClient(id, env)?.redirectUris, [OPAQUE])
  for (const changed of [id.slice(0, -1) + (id.endsWith('A') ? 'B' : 'A'), id + 'x']) {
    assert.equal((await app.request(authorizationUrl({ client_id: changed, redirect_uri: OPAQUE }))).status, 400)
  }
  const otherOrigin = fixture({ PUBLIC_ORIGIN: 'https://city-preview.example' }).app
  assert.equal((await otherOrigin.request(authorizationUrl({ client_id: id, redirect_uri: OPAQUE, resource: 'https://city-preview.example/mcp/connect' }))).status, 400)
  const otherKey = fixture({ GEMINI_DCR_SIGNING_KEY: randomBytes(32).toString('hex') }).app
  assert.equal((await otherKey.request(authorizationUrl({ client_id: id, redirect_uri: OPAQUE }))).status, 400)
  const code = await consent(app, id, OPAQUE)
  const unconfigured = fixture({ GEMINI_DCR_SIGNING_KEY: '' }, memory).app
  assert.equal((await register(unconfigured, { redirect_uris: [OPAQUE] })).status, 503)
  assert.equal((await exchangeCode(unconfigured, code, { client_id: id, redirect_uri: OPAQUE })).status, 400)
  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: id, redirect_uri: OPAQUE }))
  assert.equal((await refresh(unconfigured, id, pair.refresh_token)).status, 400)
})

test('Gemini opaque registrations of ten longest addresses fit the client ID, eleven do not', async () => {
  const { app } = fixture()
  const ten = Array.from({ length: 10 }, (_, i) => opaqueAt(String(i).repeat(64)))
  const response = await register(app, { redirect_uris: ten })
  assert.equal(response.status, 201)
  const registered = await response.json()
  assert.deepEqual(registered.redirect_uris, ten)
  assert.ok(registered.client_id.length <= 2048)
  assert.equal((await register(app, { redirect_uris: [...ten, OPAQUE] })).status, 400)
})

test('Gemini completes consent, exchange, refresh and revocation with an opaque address', async () => {
  const { app, env, memory } = fixture()
  const id = await client(app, [OPAQUE])
  const code = await consent(app, id, OPAQUE)
  assert.equal((await exchangeCode(app, code, { client_id: id, redirect_uri: OPAQUE, code_verifier: 'wrong' })).status, 400)
  assert.equal((await exchangeCode(app, code, { client_id: id, redirect_uri: REDIRECT })).status, 400)
  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: id, redirect_uri: OPAQUE }))
  assert.equal((await residentByOAuthAccessToken(pair.access_token, env, memory.api))?.handle, 'chatty')
  const second = await readTokenPair(await refresh(app, id, pair.refresh_token))
  assert.notEqual(second.refresh_token, pair.refresh_token)
  assert.equal((await refresh(app, id, pair.refresh_token)).status, 400)
  assert.equal(await residentByOAuthAccessToken(second.access_token, env, memory.api), null)

  const again = await readTokenPair(await exchangeCode(app, await consent(app, id, OPAQUE), { client_id: id, redirect_uri: OPAQUE }))
  assert.equal((await revoke(app, id, again.refresh_token)).status, 200)
  assert.equal((await refresh(app, id, again.refresh_token)).status, 400)
})

// Minted before November 2026 with the October rule, a fixed test key and https://1f3d9.com.
// It stands for the live connection that carries an October-form address in its ID.
const FROZEN_KEY = '5e'.repeat(32)
const FROZEN_REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123456789012345678901-1f3d9_com'
const FROZEN_ID = 'gemini.v1.WyJodHRwczovL29hdXRoLXJlZGlyZWN0Lmdvb2dsZXVzZXJjb250ZW50LmNvbS9yL3VzZXJfYm91bmRfY3VzdG9tLW1jcC0xMjM0NTY3ODkwMTIzNDU2Nzg5MDEtMWYzZDlfY29tIl0.qBQ1tiKJ840-Vc-UyJ1VbtTs9JsbRxVOhTyRTs05k8s'

test('a frozen October-form Gemini client ID still resolves at authorize, exchange, refresh and revoke', async () => {
  const { app, env } = fixture({ GEMINI_DCR_SIGNING_KEY: FROZEN_KEY })
  assert.deepEqual(resolveGeminiClient(FROZEN_ID, env)?.redirectUris, [FROZEN_REDIRECT])
  assert.equal(registerGeminiClient([FROZEN_REDIRECT], env), FROZEN_ID)
  const code = await consent(app, FROZEN_ID, FROZEN_REDIRECT)
  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: FROZEN_ID, redirect_uri: FROZEN_REDIRECT }))
  const second = await readTokenPair(await refresh(app, FROZEN_ID, pair.refresh_token))
  assert.equal((await revoke(app, FROZEN_ID, second.refresh_token)).status, 200)
  assert.equal((await refresh(app, FROZEN_ID, second.refresh_token)).status, 400)
})

const REFUSAL_KEYS = ['address_count', 'addresses', 'elapsed_ms', 'error_class', 'event', 'request_id', 'stage', 'status', 'ua_class']
const SHAPE_KEYS = ['has_port_query_fragment_userinfo_whitespace', 'host_class', 'non_string', 'path_class',
  'prefix_match', 'scheme_ok', 'segment_class', 'segment_length']

function refusal(record: Readonly<OAuthDiagnosticRecord> | undefined) {
  assert.ok(record?.stage === 'client_registration')
  return record
}

function recording(patch: Record<string, string> = {}) {
  const records: Readonly<OAuthDiagnosticRecord>[] = []
  return { ...fixture(patch, undefined, false, record => { records.push(record) }), records }
}

test('a refused Gemini registration writes one shapes-only record', async () => {
  const { app, records } = recording()
  const refused = await register(app, { redirect_uris: [
    OPAQUE.replace('/r/', '/a/'), OPAQUE.replace('oauth-redirect.', 'oauth-redirect-test.'),
    REDIRECT.replace('1f3d9_com', 'other_com'), `${OPAQUE}?x=1`, 4,
  ] }, { 'user-agent': 'OpenAuth' })
  assert.equal(refused.status, 400)
  assert.equal(records.length, 1)
  const record = refusal(records[0])
  assert.equal(refused.headers.get('x-request-id'), record.request_id)
  assert.deepEqual(Object.keys(record).sort(), REFUSAL_KEYS)
  assert.equal(record.event, 'oauth_failure')
  assert.equal(record.error_class, 'invalid_redirect_uri')
  assert.equal(record.status, 400)
  assert.equal(record.ua_class, 'OpenAuth')
  assert.equal(record.address_count, 5)
  for (const shape of record.addresses) assert.deepEqual(Object.keys(shape).sort(), SHAPE_KEYS)
  assert.deepEqual(record.addresses.map(shape => [shape.host_class, shape.path_class, shape.prefix_match, shape.segment_length,
    shape.segment_class, shape.has_port_query_fragment_userinfo_whitespace, shape.scheme_ok, shape.non_string]), [
    ['main', 'a', true, 24, 'hex_lower', false, true, false],
    ['test', 'r', true, 24, 'hex_lower', false, true, false],
    ['main', 'r', true, 16, 'old_other_host', false, true, false],
    ['main', 'r', true, 24, 'hex_lower', true, true, false],
    ['other', 'other', false, 0, 'empty', false, false, true],
  ])
})

test('a hostile refused Gemini address leaves none of its text in the record', async () => {
  const { app, records } = recording()
  const run = '987654321098765432109'
  const hostile = `https://quote"line\nbreak.example/r/user_bound_custom-mcp-${run}-zz"\n{"stage":"forged"}`
  const response = await register(app, { redirect_uris: [hostile, `${OPAQUE}\n`] }, { 'user-agent': 'OpenAuth-but-not-quite' })
  assert.equal(response.status, 400)
  assert.equal(records.length, 1)
  const serialized = JSON.stringify(records[0])
  for (const fragment of [run, '98765', 'quote', 'break', 'example', 'forged', 'zz', OPAQUE_SEGMENT, 'OpenAuth-but', '\\n', '\\"']) {
    assert.equal(serialized.includes(fragment), false, fragment)
  }
  const { request_id: requestId, addresses, ...rest } = refusal(records[0])
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  assert.equal(rest.ua_class, 'other')
  const allowed = new Set(['oauth_failure', 'client_registration', 'invalid_redirect_uri', 'other', 'main', 'test', 'sandbox',
    'r', 'a', 'digits', 'hex_lower', 'alnum', 'old_this_city', 'old_other_host', 'base64url', 'has_dot_slash_percent', 'empty'])
  for (const value of [...Object.values(rest), ...addresses.flatMap(shape => Object.values(shape))]) {
    if (typeof value === 'string') assert.ok(allowed.has(value), value)
    else if (typeof value === 'number') assert.ok(Number.isInteger(value) && value >= 0 && value <= 60_000)
    else assert.equal(typeof value, 'boolean')
  }
})

test('Gemini registration writes no record on success, a full allowance, missing setup or bad JSON', async () => {
  const ok = recording()
  assert.equal((await register(ok.app, { redirect_uris: [OPAQUE] })).status, 201)
  assert.equal((await register(ok.app, { redirect_uris: [REDIRECT] })).status, 201)
  const badJson = await ok.app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  assert.equal(badJson.status, 400)
  assert.deepEqual(ok.records, [])
  const limited = recording()
  limited.memory.api.consumeOAuthRateLimit = async () => rateLimitResult(false, 17)
  assert.equal((await register(limited.app, { redirect_uris: ['nope'] })).status, 429)
  assert.deepEqual(limited.records, [])
  const unready = recording({ GEMINI_DCR_SIGNING_KEY: '' })
  assert.equal((await register(unready.app, { redirect_uris: ['nope'] })).status, 503)
  assert.deepEqual(unready.records, [])
})

test('a failing diagnostics sink never changes the Gemini registration answer', async () => {
  const quiet = await register(fixture().app, { redirect_uris: ['nope'] })
  const loud = await register(fixture({}, undefined, false, () => { throw new Error('sink down') }).app, { redirect_uris: ['nope'] })
  assert.equal(loud.status, 400)
  assert.deepEqual(await loud.json(), await quiet.json())
})

test('the Gemini refusal text fits both address forms and names no city', async () => {
  const body = await (await register(fixture().app, { redirect_uris: ['nope'] })).json()
  assert.equal(body.error, 'invalid_redirect_uri')
  assert.doesNotMatch(body.error_description, /for this city/u)
  assert.match(body.error_description, /Google Gemini user-bound return address/u)
})
