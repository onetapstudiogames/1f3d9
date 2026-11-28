import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { mountOAuthRoutes, residentByOAuthAccessToken, type OAuthDiagnosticRecord } from '../src/oauth.ts'
import { REGISTRATION_REFUSAL_CHECKS } from '../src/oauth-diagnostics.ts'
import { OAUTH_LIMITS } from '../src/oauth-limits.ts'
import { EXISTING_KEY, MemoryOAuthStore, rateLimitResult } from './oauth-flow-tests/memory-oauth-store.ts'
import {
  authorizationUrl, browserPost, CALLBACK, CLIENT_ID, environment, ORIGIN, readTokenPair, RESOURCE, STATE, VERIFIER,
} from './oauth-flow-tests/fixture.ts'

// Decision 206: Grok registers itself at POST /oauth/register with its one return page,
// as Gemini does with its own (decisions 143 and 186). Proven on 2026-11-28: Grok uses
// dynamic client registration, and before this change the city refused it.

const RETURN = 'https://grok.com/connectors-oauth-exchange-code/'
const APP = `${ORIGIN}/mcp/app`
const GEMINI = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-4815162342c0ffee15deadbe'
const signingKey = randomBytes(32).toString('hex')
// The body sent on 2026-11-28 to show the refusal. Grok's own body is sent server to
// server and is not known, so the variants below cover what a registering client may send.
const GROK_BODY = {
  client_name: 'Grok', redirect_uris: [RETURN], grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'], token_endpoint_auth_method: 'none',
}
// The exact refusal main gave every registration but Gemini's before decision 206.
const TODAY_REFUSAL = '{"error":"invalid_redirect_uri","error_description":"Include a Google Gemini user-bound return address, with no port, query, fragment or user information; send 1 to 10 addresses, each at most 1024 characters. Only supported addresses are registered and must fit a 2048-character client ID."}'

function gateway(patch: Record<string, string> = {}, memory = new MemoryOAuthStore()) {
  const records: OAuthDiagnosticRecord[] = []
  const env = { ...environment, GEMINI_DCR_SIGNING_KEY: signingKey, ...patch }
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: env, store: memory.api, diagnostics: record => records.push(record),
    fetcher: (async () => { throw new Error('registration must not fetch client metadata') }) as typeof fetch,
  })
  return { app, memory, records, env }
}

function register(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function grokClient(app: Hono, body: unknown = GROK_BODY): Promise<string> {
  const response = await register(app, body)
  assert.equal(response.status, 201)
  return (await response.json()).client_id
}

const grokRequest = (clientId: string) => ({ client_id: clientId, redirect_uri: RETURN, resource: APP })

async function approvedCode(app: Hono, clientId: string): Promise<string> {
  const location = authorizationUrl(grokRequest(clientId))
  const started = await app.request(location)
  assert.equal(started.status, 200)
  const html = await started.text()
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)![1]!
  const finished = await browserPost(app, { cookie, csrf, html, location, rawSession: '' }, {
    action: 'link', csrf, resident_key: EXISTING_KEY,
  })
  assert.equal(finished.status, 303)
  const callback = new URL(finished.headers.get('location')!)
  assert.equal(callback.origin + callback.pathname, RETURN)
  assert.equal(callback.searchParams.get('state'), STATE)
  return callback.searchParams.get('code')!
}

function basic(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`
}

function token(app: Hono, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  })
}

const exchangeFields = (clientId: string, code: string) => ({
  grant_type: 'authorization_code', client_id: clientId, redirect_uri: RETURN, resource: APP, code, code_verifier: VERIFIER,
})

test('Grok registers itself with its one return page and gets the same public client shape as Gemini', async () => {
  const { app, records } = gateway()
  const response = await register(app, GROK_BODY)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const registered = await response.json()
  assert.match(registered.client_id, /^grok\.v1\.[A-Za-z0-9_-]{43}$/u)
  assert.deepEqual(registered, {
    client_id: registered.client_id, client_name: 'Grok', redirect_uris: [RETURN],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], scope: 'city:resident',
  })
  const gemini = await (await register(app, { redirect_uris: [GEMINI] })).json()
  assert.deepEqual(Object.keys(registered), Object.keys(gemini), 'the Grok answer has the Gemini answer\'s fields in order')
  assert.deepEqual(records, [], 'a successful registration writes no record')
})

test('every reasonable Grok registration body gets one public client with no secret', async () => {
  const { app } = gateway()
  const expected = await grokClient(app)
  const variants: Record<string, unknown>[] = [
    { redirect_uris: [RETURN] },
    ...['none', 'client_secret_post', 'client_secret_basic'].map(method => ({ ...GROK_BODY, token_endpoint_auth_method: method })),
    { ...GROK_BODY, client_name: 'grok-connectors-manager' }, { ...GROK_BODY, client_name: '<b>not Grok</b>' },
    { redirect_uris: [RETURN], grant_types: ['authorization_code'], response_types: ['code'] },
    { ...GROK_BODY, scope: 'city:resident', logo_uri: 'https://grok.com/logo.png', client_uri: 'https://grok.com',
      contacts: ['someone@example.test'], software_id: 'grok', software_version: '1', unknown_field: { nested: [1, 2] } },
  ]
  for (const body of variants) {
    const response = await register(app, body)
    assert.equal(response.status, 201, JSON.stringify(body))
    const registered = await response.json()
    assert.equal(registered.client_id, expected)
    assert.equal(registered.client_name, 'Grok')
    assert.equal(registered.token_endpoint_auth_method, 'none')
    assert.equal('client_secret' in registered, false)
  }
})

test('Grok consent names Grok, and the client works only with its return page, the app door and PKCE S256', async () => {
  const { app, memory, records, env } = gateway()
  const clientId = await grokClient(app)
  const started = await app.request(authorizationUrl(grokRequest(clientId)))
  assert.equal(started.status, 200)
  assert.match(started.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/grok\.com;/u)
  assert.match(await started.text(), /<strong>Grok<\/strong> wants to act as your resident/u)
  assert.equal((await app.request(authorizationUrl({ ...grokRequest(clientId), resource: `${APP}?2` }))).status, 200)

  for (const patch of [
    { resource: RESOURCE }, { resource: `${RESOURCE}?2` }, { resource: `${ORIGIN}/mcp` },
    { redirect_uri: RETURN.slice(0, -1) }, { redirect_uri: `${RETURN}?x=1` }, { redirect_uri: CALLBACK },
    { scope: 'default' }, { code_challenge_method: 'plain' },
  ]) {
    const response = await app.request(authorizationUrl({ ...grokRequest(clientId), ...patch }))
    assert.equal(response.status, 400, JSON.stringify(patch))
    assert.equal(response.headers.get('x-1f3d9-reason'), 'invalid_request')
    assert.equal(response.headers.get('location'), null)
    assert.partialDeepStrictEqual(records.at(-1), { error_class: 'invalid_request', client_family: 'grok' })
  }

  const code = await approvedCode(app, clientId)
  for (const mismatch of [{ resource: RESOURCE }, { redirect_uri: CALLBACK }, { code_verifier: 'x'.repeat(43) }]) {
    assert.equal((await token(app, { ...exchangeFields(clientId, code), ...mismatch })).status, 400)
  }
  const pair = await readTokenPair(await token(app, exchangeFields(clientId, code)))
  assert.equal(await residentByOAuthAccessToken(pair.access_token, env, memory.api, 'connect'), null)
  assert.equal((await residentByOAuthAccessToken(pair.access_token, env, memory.api, 'app'))?.handle, 'chatty')
  const refreshConnect = await token(app, { grant_type: 'refresh_token', client_id: clientId, resource: RESOURCE, refresh_token: pair.refresh_token })
  assert.equal(refreshConnect.status, 400)
  assert.deepEqual(await refreshConnect.json(), { error: 'invalid_grant' })
  await readTokenPair(await token(app, {
    grant_type: 'refresh_token', client_id: clientId, resource: APP, refresh_token: pair.refresh_token,
  }))
})

test('the Grok client may send a stray secret at the token endpoint; it is ignored and PKCE stays the proof', async () => {
  const { app } = gateway()
  const clientId = await grokClient(app, { ...GROK_BODY, token_endpoint_auth_method: 'client_secret_basic' })
  const accepted: [string, Record<string, string>, Record<string, string>][] = [
    ['a made-up posted secret', { client_secret: 'made-up' }, {}],
    ['an empty posted secret', { client_secret: '' }, {}],
    ['HTTP Basic with an empty secret', {}, { authorization: basic(clientId, '') }],
    ['HTTP Basic with a made-up secret', {}, { authorization: basic(clientId, 'made-up') }],
  ]
  for (const [label, extra, headers] of accepted) {
    const code = await approvedCode(app, clientId)
    await readTokenPair(await token(app, { ...exchangeFields(clientId, code), ...extra }, headers)).catch(error => {
      throw new Error(`${label}: ${error}`)
    })
  }
  // HTTP Basic alone may name the client, as RFC 6749 allows.
  const basicOnly = await approvedCode(app, clientId)
  const { client_id: _, ...withoutClient } = exchangeFields(clientId, basicOnly)
  const pair = await readTokenPair(await token(app, withoutClient, { authorization: basic(clientId, 'made-up') }))
  await readTokenPair(await token(app, {
    grant_type: 'refresh_token', resource: APP, refresh_token: pair.refresh_token,
  }, { authorization: basic(clientId, '') }))

  const refusedCode = await approvedCode(app, clientId)
  const refused: [string, Record<string, string>, Record<string, string>, string][] = [
    ['a wrong PKCE verifier with a secret', { client_secret: 'made-up', code_verifier: 'y'.repeat(43) }, {}, 'invalid_grant'],
    ['HTTP Basic naming another client', {}, { authorization: basic(CLIENT_ID, '') }, 'invalid_request'],
    ['a Bearer header', {}, { authorization: 'Bearer made-up' }, 'invalid_request'],
    ['a Basic header that is not base64', {}, { authorization: 'Basic %%%' }, 'invalid_request'],
    ['a Basic header with no colon', {}, { authorization: `Basic ${Buffer.from(clientId).toString('base64')}` }, 'invalid_request'],
  ]
  for (const [label, extra, headers, error] of refused) {
    const response = await token(app, { ...exchangeFields(clientId, refusedCode), ...extra }, headers)
    assert.equal(response.status, 400, label)
    assert.deepEqual(await response.json(), { error }, label)
  }
  const twice = new URLSearchParams(exchangeFields(clientId, refusedCode))
  twice.append('client_secret', 'a')
  twice.append('client_secret', 'b')
  const doubled = await app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: twice,
  })
  assert.deepEqual([doubled.status, await doubled.json()], [400, { error: 'invalid_request' }])
  await readTokenPair(await token(app, exchangeFields(clientId, refusedCode)))
})

test('revocation follows the same rule: the Grok client may name itself by HTTP Basic, no other client may', async () => {
  const { app } = gateway()
  const clientId = await grokClient(app)
  const revoke = (fields: Record<string, string>, headers: Record<string, string> = {}) => app.request('/oauth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields),
  })
  const refresh = (pair: { refresh_token: string }) => token(app, {
    grant_type: 'refresh_token', client_id: clientId, resource: APP, refresh_token: pair.refresh_token,
  })
  const kept = await readTokenPair(await token(app, exchangeFields(clientId, await approvedCode(app, clientId))))
  assert.equal((await revoke({ token: kept.refresh_token, client_id: clientId }, { authorization: 'Bearer made-up' })).status, 200)
  assert.equal((await revoke({ token: kept.refresh_token }, { authorization: basic(CLIENT_ID, '') })).status, 200)
  const stillLive = await readTokenPair(await refresh(kept))
  assert.equal((await revoke({ token: stillLive.refresh_token, client_secret: 'made-up' }, { authorization: basic(clientId, 'x') })).status, 200)
  assert.equal((await refresh(stillLive)).status, 400, 'Basic naming the Grok client revoked its sign-in')
})

test('every other client still may not send a client secret or an Authorization header', async () => {
  const { app } = gateway()
  const gemini = (await (await register(app, { redirect_uris: [GEMINI] })).json()).client_id
  const forged = `grok.v1.${'A'.repeat(43)}`
  for (const clientId of [CLIENT_ID, gemini, forged]) {
    for (const [extra, headers] of [
      [{ client_secret: '' }, {}], [{ client_secret: 'made-up' }, {}],
      [{}, { authorization: basic(clientId, '') }], [{}, { authorization: basic(clientId, 'made-up') }],
    ] as const) {
      const response = await token(app, {
        grant_type: 'authorization_code', client_id: clientId, redirect_uri: CALLBACK, resource: RESOURCE,
        code: `1f3d9_ac_${'ab'.repeat(32)}`, code_verifier: VERIFIER, ...extra,
      }, headers)
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: 'invalid_request' }, `${clientId} ${JSON.stringify(extra)} ${JSON.stringify(headers)}`)
    }
  }
})

test('near misses of the Grok return page and every other registration are refused exactly as before', async () => {
  const { app } = gateway()
  const nearMisses = [
    RETURN.replace('https:', 'http:'), RETURN.slice(0, -1), `${RETURN}/`, RETURN.replace('/connectors-', '//connectors-'),
    `${RETURN}?x=1`, `${RETURN}?`, `${RETURN}#x`, `${RETURN}#`, RETURN.replace('grok.com', 'grok.com:443'),
    RETURN.replace('grok.com', 'grok.com:8443'), RETURN.replace('grok.com', 'user@grok.com'),
    RETURN.replace('grok.com', 'user:pass@grok.com'), RETURN.replace('grok.com', 'GROK.COM'),
    RETURN.replace('connectors', 'Connectors'), RETURN.toUpperCase(), RETURN.replace('grok.com', 'www.grok.com'),
    RETURN.replace('grok.com', 'grok.com.evil.test'), 'https://grok.com/connectors-oauth-exchange-code/x',
    'https://grok.com/other/', `${RETURN} `, ` ${RETURN}`, `${RETURN}\n`, RETURN.replace('code/', 'code%2F'),
  ]
  const lists: unknown[] = [
    ...nearMisses.map(uri => [uri]), [RETURN, RETURN], [RETURN, 'https://example.test/callback'],
    ['https://example.test/callback', RETURN], [RETURN, RETURN.slice(0, -1)], [], RETURN, [null], [RETURN, 7],
    Array(11).fill(RETURN), ['x'.repeat(1_025)],
  ]
  for (const redirect_uris of lists) {
    const response = await register(app, { ...GROK_BODY, redirect_uris })
    assert.equal(response.status, 400, JSON.stringify(redirect_uris))
    assert.equal(await response.text(), TODAY_REFUSAL, JSON.stringify(redirect_uris))
  }
  const statement = await register(app, { ...GROK_BODY, software_statement: 'eyJ.x.y' })
  assert.equal(statement.status, 400)
  assert.equal(await statement.text(), '{"error":"unapproved_software_statement","error_description":"Send the return addresses directly, without a software statement."}')

  // Gemini shapes keep their result: only the supported Gemini address is registered.
  for (const redirect_uris of [[GEMINI], [GEMINI, RETURN], [RETURN, GEMINI]]) {
    const response = await register(app, { redirect_uris })
    assert.equal(response.status, 201)
    const registered = await response.json()
    assert.equal(registered.client_name, 'Gemini')
    assert.deepEqual(registered.redirect_uris, [GEMINI])
    assert.match(registered.client_id, /^gemini\.v1\./u)
  }
})

test('a refused registration naming the Grok return page logs one closed check and only field names', async () => {
  const { app, records } = gateway()
  const secretValue = 'secret-value-that-must-not-appear'
  const cases: [Record<string, unknown>, string, string][] = [
    [{ ...GROK_BODY, redirect_uris: [RETURN, 'https://example.test/callback'], client_secret: secretValue },
      'grok_registration_extra_address', 'invalid_redirect_uri'],
    [{ ...GROK_BODY, redirect_uris: [RETURN, RETURN] }, 'grok_registration_extra_address', 'invalid_redirect_uri'],
    [{ ...GROK_BODY, redirect_uris: [RETURN.slice(0, -1)] }, 'grok_registration_inexact_address', 'invalid_redirect_uri'],
    [{ ...GROK_BODY, redirect_uris: [RETURN.replace('https:', 'http:')] }, 'grok_registration_inexact_address', 'invalid_redirect_uri'],
    [{ ...GROK_BODY, software_statement: secretValue }, 'grok_registration_software_statement', 'unapproved_software_statement'],
  ]
  for (const [body, check, errorClass] of cases) {
    records.length = 0
    const response = await register(app, { ...body, [`${secretValue}-name`]: 1, 'x-unknown': secretValue })
    assert.equal(response.status, 400)
    assert.equal(records.length, 1, check)
    const record = records[0]!
    assert.partialDeepStrictEqual(record, {
      event: 'oauth_failure', stage: 'client_registration', error_class: errorClass, status: 400,
      client_family: 'grok', failed_check: check, other_field_count: 2,
      body_fields: Object.keys(body).filter(name => name !== 'x-unknown').sort(),
    })
    assert.equal(record.request_id, response.headers.get('x-request-id'))
    const serialized = JSON.stringify(record)
    for (const fragment of [secretValue, 'example', 'grok.com', 'connectors', 'Grok"', 'eyJ']) {
      assert.equal(serialized.includes(fragment), false, `${check} leaked ${fragment}`)
    }
  }
  assert.deepEqual([...new Set(cases.map(([, check]) => check))].sort(), [...REGISTRATION_REFUSAL_CHECKS].sort())
  // A refusal that names no Grok address keeps its existing record, and a Gemini software statement still writes none.
  records.length = 0
  assert.equal((await register(app, { redirect_uris: ['https://example.test/callback'], client_name: 'Other' })).status, 400)
  assert.equal(records.length, 1)
  for (const field of ['client_family', 'failed_check', 'body_fields', 'other_field_count']) {
    assert.equal(field in records[0]!, false, field)
  }
  records.length = 0
  assert.equal((await register(app, { redirect_uris: [GEMINI], software_statement: 'x' })).status, 400)
  assert.deepEqual(records, [])
})

test('Grok registration shares the Gemini allowance, size limit and setup check', async () => {
  const memory = new MemoryOAuthStore()
  const { app } = gateway({ VERCEL: '1' }, memory)
  const calls: Parameters<typeof memory.api.consumeOAuthRateLimit>[0][] = []
  memory.api.consumeOAuthRateLimit = async input => { calls.push(input); return rateLimitResult(calls.length < 3, 17) }
  const network = { 'x-vercel-forwarded-for': '192.0.2.1' }
  assert.equal((await register(app, GROK_BODY, network)).status, 201)
  assert.equal((await register(app, { redirect_uris: [GEMINI] }, network)).status, 201)
  const limited = await register(app, GROK_BODY, network)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '17')
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.attemptKind, 'authorize')
    assert.equal(call.maximum, OAUTH_LIMITS.clientRegistrationsPerNetworkHour)
    assert.equal(call.bucketHash, calls[0]!.bucketHash)
  }
  const { app: open } = gateway()
  const padded = { ...GROK_BODY, padding: 'p'.repeat(OAUTH_LIMITS.formBodyBytes) }
  const oversized = await register(open, padded)
  assert.equal(oversized.status, 400)
  assert.equal((await oversized.json()).error, 'invalid_client_metadata')
  assert.equal((await register(gateway({ GEMINI_DCR_SIGNING_KEY: '' }).app, GROK_BODY)).status, 503)
})

test('a Grok client ID the city did not sign is refused with its own closed log value', async () => {
  const { app } = gateway()
  const clientId = await grokClient(app)
  const otherKey = await grokClient(gateway({ GEMINI_DCR_SIGNING_KEY: randomBytes(32).toString('hex') }).app)
  const otherCity = await grokClient(gateway({ PUBLIC_ORIGIN: 'https://preview.example.test' }).app)
  const tampered = clientId.slice(0, -1) + (clientId.endsWith('A') ? 'B' : 'A')
  for (const unsigned of [otherKey, otherCity, tampered, `grok.v1.${'A'.repeat(43)}`, 'grok.v1.', `${clientId}x`]) {
    assert.notEqual(unsigned, clientId)
    const { app: city, records } = gateway({}, new MemoryOAuthStore())
    const response = await city.request(authorizationUrl(grokRequest(unsigned)))
    assert.equal(response.status, 400, unsigned)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'client_not_approved')
    assert.partialDeepStrictEqual(records[0], {
      failed_check: 'grok_client_unrecognized', error_class: 'client_not_approved', client_family: 'grok',
    })
    assert.doesNotMatch(JSON.stringify(records), /grok\.v1/u)
    const exchanged = await token(city, exchangeFields(unsigned, `1f3d9_ac_${'ab'.repeat(32)}`))
    assert.deepEqual([exchanged.status, await exchanged.json()], [400, { error: 'invalid_client' }])
  }
})
