import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { newBrowserSessionCookie } from '../src/browser-session-cookie.ts'
import { sha256 } from '../src/core.ts'
import { mountOAuthRoutes, residentByOAuthAccessToken } from '../src/oauth.ts'
import { authorizationUrl, browserPost, CHALLENGE, environment, exchangeCode, ORIGIN, readTokenPair, RESOURCE, STATE } from './oauth-flow-tests/fixture.ts'
import { EXISTING_KEY, MemoryOAuthStore } from './oauth-flow-tests/memory-oauth-store.ts'

const CLIENT = 'https://cursor.com/oauth/mcp-client.json'
const GROK = 'https://grok.com/connectors-oauth-exchange-code/'
const CURSOR = 'https://www.cursor.com/agents/mcp/oauth/callback'
const APP = ORIGIN + '/mcp/app'
const config = {
  ...environment,
  HOSTED_CHAT_CIMD_ORIGINS: '["https://cursor.com"]',
  HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{ client_id: CLIENT, client_name: 'Cursor', redirect_uris: [CURSOR, GROK] }]),
}

// Model the records left by the earlier static client at each upgrade boundary.
const listed: typeof fetch = async () => Response.json({
  client_id: CLIENT, client_name: 'Cursor', redirect_uris: [CURSOR, GROK], token_endpoint_auth_method: 'none',
})

async function pending(redirectUri: string, resource: string, fetcher: typeof fetch = listed) {
  const memory = new MemoryOAuthStore()
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: config, store: memory.api, diagnostics: () => {},
    fetcher,
  })
  const cookie = newBrowserSessionCookie()
  const hashes = { sessionHash: sha256(cookie.session), csrfHash: sha256(cookie.csrf) }
  await memory.api.createAuthorizationRequest({
    ...hashes, clientId: CLIENT, clientName: 'Cursor', redirectUri, resource,
    scope: 'city:resident', state: STATE, codeChallenge: CHALLENGE,
  })
  const session = {
    cookie: '__Host-1f3d9_oauth=' + cookie.raw, csrf: cookie.csrf, rawSession: cookie.session, html: '',
    location: authorizationUrl({ client_id: CLIENT, redirect_uri: redirectUri, resource }),
  }
  return { app, memory, session, hashes }
}

async function storedCode(redirectUri: string, resource: string, fetcher: typeof fetch = listed) {
  const fixture = await pending(redirectUri, resource, fetcher)
  const code = '1f3d9_ac_' + 'ab'.repeat(32)
  const approval = await fixture.memory.api.approveExistingResidentAndIssueAuthorizationCode({
    ...fixture.hashes, residentSecretHash: sha256(EXISTING_KEY), authorizationCodeHash: sha256(code),
  })
  assert.equal(approval.status, 'approved')
  return { ...fixture, code }
}

function refresh(app: Hono, token: string, resource: string) {
  return app.request('/oauth/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: token, resource }),
  })
}

function revoke(app: Hono, token: string) {
  return app.request('/oauth/revoke', { method: 'POST', body: new URLSearchParams({ client_id: CLIENT, token }) })
}

for (const [name, redirect, resource] of [
  ['old Cursor callback and connect door', CURSOR, RESOURCE],
  ['old Cursor callback on the app door', CURSOR, APP],
  ['Grok callback on the connect door', GROK, RESOURCE],
] as const) {
  test('pending static consent refuses ' + name, async () => {
    const { app, session, memory } = await pending(redirect, resource)
    const response = await browserPost(app, session, { action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY })
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'invalid_request')
    assert.equal(response.headers.get('location'), null)
    assert.equal(JSON.parse(memory.safeState()).codes.length, 0)
  })

  test('stored authorization code refuses ' + name, async () => {
    const { app, memory, code } = await storedCode(redirect, resource)
    const response = await exchangeCode(app, code, { client_id: CLIENT, redirect_uri: redirect, resource: resource + '?=2' })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_grant' })
    assert.equal(JSON.parse(memory.safeState()).families.length, 0)
  })
}

test('a fresh authorization cannot resume an old static consent pointing to Cursor', async () => {
  const { app, session } = await pending(CURSOR, RESOURCE)
  const url = authorizationUrl({ client_id: CLIENT, redirect_uri: GROK, resource: APP })
  const refused = await app.request(url, { headers: { cookie: session.cookie } })
  assert.equal(refused.status, 400)
  assert.equal(refused.headers.get('x-1f3d9-reason'), 'invalid_request')
  assert.match(refused.headers.get('set-cookie') ?? '', /Max-Age=0/u)
  assert.equal((await app.request(url)).status, 200)
})

test('reopening the same canceled static Grok consent keeps its terminal result', async () => {
  const { app, memory, hashes, session } = await pending(GROK, APP)
  assert.ok(await memory.api.cancelAuthorizationRequest(hashes))
  const result = await app.request(session.location, { headers: { cookie: session.cookie } })
  assert.equal(result.status, 403)
  assert.equal(result.headers.get('x-1f3d9-reason'), 'request_unavailable')
  assert.match(await result.text(), /This signup was canceled/u)
  assert.equal(JSON.parse(memory.safeState()).requests.length, 1)
})

for (const [name, fetcher] of [
  ['the Grok return disappears', async () => Response.json({ client_id: CLIENT, client_name: 'Cursor', redirect_uris: [CURSOR], token_endpoint_auth_method: 'none' })],
  ['Cursor goes offline', async () => new Response(null, { status: 502 })],
] as const) {
  test('an old static approval and code keep the stored Grok binding if ' + name, async () => {
    const { app, session } = await pending(GROK, APP, fetcher)
    const approval = await browserPost(app, session, { action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY })
    assert.equal(approval.status, 303)
    const callback = new URL(approval.headers.get('location')!)
    assert.equal(callback.origin + callback.pathname, GROK)

    const saved = await storedCode(GROK, APP, fetcher)
    const exchange = await exchangeCode(saved.app, saved.code, { client_id: CLIENT, redirect_uri: GROK, resource: APP })
    const pair = await readTokenPair(exchange)
    assert.ok(await residentByOAuthAccessToken(pair.access_token, config, saved.memory.api, 'app'))
  })
}

test('Grok approval, code exchange and refresh use the stored binding with zero document reads', async t => {
  const fetcher = t.mock.fn(listed)
  const { app, session } = await pending(GROK, APP, fetcher)
  const approval = await browserPost(app, session, { action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY })
  assert.equal(approval.status, 303)
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!
  const afterApproval = fetcher.mock.callCount()

  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: CLIENT, redirect_uri: GROK, resource: APP + '?2' }))
  const afterExchange = fetcher.mock.callCount()
  await readTokenPair(await refresh(app, pair.refresh_token, APP + '?3'))
  assert.deepEqual({ afterApproval, afterExchange, afterRefresh: fetcher.mock.callCount() },
    { afterApproval: 0, afterExchange: 0, afterRefresh: 0 })
})

for (const resource of [APP, RESOURCE]) {
  test('a legacy refresh grant with no callback record cannot renew at ' + resource, async () => {
    const { app, memory, code } = await storedCode(CURSOR, resource)
    const token = '1f3d9_rt_' + 'ab'.repeat(32)
    const access = '1f3d9_at_' + 'ab'.repeat(32)
    assert.equal(await memory.api.exchangeAuthorizationCode({
      clientId: CLIENT, codeHash: sha256(code), redirectUri: CURSOR, resource,
      accessTokenHash: sha256(access), refreshTokenHash: sha256(token),
    }), true)
    const refused = await refresh(app, token, resource + '?=2')
    assert.equal(refused.status, 400)
    assert.deepEqual(await refused.json(), { error: 'invalid_grant' })
    assert.equal(JSON.parse(memory.safeState()).tokens.length, 2)
    const door = resource === APP ? 'app' : 'connect'
    assert.ok(await residentByOAuthAccessToken(access, config, memory.api, door))
    assert.equal((await revoke(app, token)).status, 200)
    assert.equal(await residentByOAuthAccessToken(access, config, memory.api, door), null)
  })
}

test('a checked Grok code can exchange, renew twice with app suffixes and revoke the whole family', async () => {
  const { app, memory, code } = await storedCode(GROK, APP)
  const pair = await readTokenPair(await exchangeCode(app, code, { client_id: CLIENT, redirect_uri: GROK, resource: APP + '?2' }))
  const wrongDoor = await refresh(app, pair.refresh_token, RESOURCE + '?=2')
  assert.equal(wrongDoor.status, 400)
  const second = await readTokenPair(await refresh(app, pair.refresh_token, APP + '?=3'))
  const third = await readTokenPair(await refresh(app, second.refresh_token, APP))
  assert.ok(await residentByOAuthAccessToken(third.access_token, config, memory.api, 'app'))
  assert.equal((await revoke(app, third.refresh_token)).status, 200)
  assert.equal(await residentByOAuthAccessToken(pair.access_token, config, memory.api, 'app'), null)
  assert.equal((await refresh(app, third.refresh_token, APP)).status, 400)
})
