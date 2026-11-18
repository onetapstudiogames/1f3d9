import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { auth, setOAuthResidentResolver } from '../src/core.ts'
import { mcp } from '../src/mcp.ts'
import { mountOAuthRoutes, residentByOAuthAccessToken, type OAuthDiagnosticRecord } from '../src/oauth.ts'
import {
  authorizationUrl, browserPost, environment, exchangeCode, ORIGIN, readTokenPair, RESOURCE, STATE,
} from './oauth-flow-tests/fixture.ts'
import { EXISTING_KEY, MemoryOAuthStore } from './oauth-flow-tests/memory-oauth-store.ts'

const CURSOR = 'https://cursor.com'
const CLIENT_ID = `${CURSOR}/oauth/mcp-client.json`
const RETURN = 'https://grok.com/connectors-oauth-exchange-code/'
const APP = `${ORIGIN}/mcp/app`
const grokRequest = { client_id: CLIENT_ID, redirect_uri: RETURN, resource: APP }

// Fields used by the city from the public document fetched on 2026-11-18.
const cursorDocument = {
  client_id: CLIENT_ID,
  client_name: 'Cursor',
  redirect_uris: [
    'https://www.cursor.com/agents/mcp/oauth/callback',
    'https://www.cursor.com/bot/mcp/oauth/callback',
    RETURN,
    'http://localhost:8787/callback',
    'http://127.0.0.1:8787/callback',
  ],
  token_endpoint_auth_method: 'none',
}

function gateway(
  fetcher: typeof fetch = async () => Response.json(cursorDocument),
  env: Record<string, string> = {},
) {
  const app = new Hono()
  const memory = new MemoryOAuthStore()
  const records: OAuthDiagnosticRecord[] = []
  const config = { ...environment, HOSTED_CHAT_CIMD_ORIGINS: JSON.stringify([CURSOR]), ...env }
  mountOAuthRoutes(app, { environment: config, store: memory.api, fetcher, diagnostics: record => records.push(record) })
  return { app, memory, records, config }
}

test('Grok consent names Grok and returns a code for an app-door resident call', async t => {
  const { app, memory, config } = gateway()
  app.post('/mcp/app', c => mcp(c, app, { door: 'app', forwardUnauthorizedStatus: true }))
  app.get('/api/me', async c => {
    const resident = await auth(c)
    return resident ? c.json({ handle: resident.handle }) : c.json({ error: 'missing resident' }, 401)
  })
  const location = authorizationUrl(grokRequest)
  const started = await app.request(location)
  assert.equal(started.status, 200)
  assert.match(started.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/grok\.com;/u)
  const html = await started.text()
  assert.match(html, /<strong>Grok<\/strong> wants to act as your resident/u)
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)![1]!
  const finished = await browserPost(app, { cookie, csrf, html, location, rawSession: '' }, {
    action: 'link', csrf, resident_key: EXISTING_KEY,
  })
  assert.equal(finished.status, 303)
  const callback = new URL(finished.headers.get('location')!)
  assert.equal(callback.origin + callback.pathname, RETURN)
  assert.equal(callback.searchParams.get('state'), STATE)
  const code = callback.searchParams.get('code')!
  assert.match(code, /^1f3d9_ac_[a-f0-9]{64}$/u)
  for (const mismatch of [
    { resource: RESOURCE }, { redirect_uri: cursorDocument.redirect_uris[0]! }, { code_verifier: 'x'.repeat(43) },
  ]) {
    assert.equal((await exchangeCode(app, code, { ...grokRequest, ...mismatch })).status, 400)
  }
  const pair = await readTokenPair(await exchangeCode(app, code, grokRequest))
  assert.equal(await residentByOAuthAccessToken(pair.access_token, config, memory.api, 'connect'), null)

  const previousFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  setOAuthResidentResolver((token, door) => residentByOAuthAccessToken(token, config, memory.api, door))
  t.after(() => {
    setOAuthResidentResolver(null)
    if (previousFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousFlag
  })
  const headers = { 'content-type': 'application/json', 'user-agent': 'grok-connectors-manager/0.1.0',
    authorization: `Bearer ${pair.access_token}` }
  const list = await app.request('/mcp/app', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(list.status, 200)
  const listed = await list.json()
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === 'me'))
  const me = await app.request('/mcp/app', {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} } }),
  })
  assert.equal(me.status, 200)
  const { result } = await me.json()
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /chatty/u)
})

test('only the exact Grok return address can be used from the Cursor document', async () => {
  const { app, records } = gateway()
  for (const redirect_uri of [
    ...cursorDocument.redirect_uris.filter(uri => uri !== RETURN),
    'cursor://anysphere.cursor-mcp/oauth/callback', RETURN.slice(0, -1), RETURN + '?x', RETURN + '#x',
    RETURN.replace('grok.com', 'grok.com:443'), RETURN.replace('grok.com', 'GROK.COM'),
  ]) {
    const response = await app.request(authorizationUrl({ ...grokRequest, redirect_uri }))
    assert.equal(response.status, 400, redirect_uri)
    assert.equal(response.headers.get('location'), null)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(records.at(-1)?.error_class, 'invalid_request')
    assert.equal(records.at(-1)?.client_origin, CURSOR)
    assert.partialDeepStrictEqual(records.at(-1), { client_family: 'grok' })
  }
})

test('the Grok client must use the app door, public exchange and PKCE S256', async () => {
  const { app } = gateway()
  for (const patch of [
    { resource: RESOURCE }, { resource: RESOURCE + '?2' }, { resource: ORIGIN + '/mcp' },
    { resource: 'https://other.example/mcp/app' }, { code_challenge_method: 'plain' },
  ]) {
    const response = await app.request(authorizationUrl({ ...grokRequest, ...patch }))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'invalid_request')
  }
  const suffixed = await app.request(authorizationUrl({ ...grokRequest, resource: APP + '?2' }))
  assert.equal(suffixed.status, 200, 'decision 190 also identifies the app door by its short suffix')
  const confidential = gateway(async () => Response.json({ ...cursorDocument, token_endpoint_auth_method: 'client_secret_basic' }))
  assert.equal((await confidential.app.request(authorizationUrl(grokRequest))).status, 400)
  assert.equal(confidential.records[0]?.failed_check, 'auth_method_unsupported')
})

test('an unlisted Grok callback is a permanent refusal, including with a static entry for the pinned ID', async () => {
  const env = { HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{ client_id: CLIENT_ID, client_name: 'Cursor', redirect_uris: [RETURN] }]) }
  for (const redirect_uris of [
    cursorDocument.redirect_uris.filter(uri => uri !== RETURN),
    [RETURN.replace('grok.com', 'grok.com:443')],
  ]) {
    const { app, records } = gateway(async () => Response.json({ ...cursorDocument, redirect_uris }), env)
    const response = await app.request(authorizationUrl(grokRequest))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'client_not_approved')
    assert.equal(response.headers.get('retry-after'), null)
    assert.equal(records[0]?.event, 'oauth_failure')
    assert.equal(records[0]?.client_origin, CURSOR)
    assert.equal(records[0]?.failed_check, 'grok_callback_missing')
  }
})

test('Grok metadata outages return the existing temporary refusal and identify the client in the log', async () => {
  const { app, records } = gateway(async () => { throw new TypeError('connection lost') })
  const response = await app.request(authorizationUrl(grokRequest))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.equal(response.headers.get('x-1f3d9-reason'), 'client_check_unavailable')
  assert.match(await response.text(), /Wait a minute, then return to the chat app and start sign-in again/u)
  assert.equal(records[0]?.event, 'oauth_failure')
  assert.equal(records[0]?.client_origin, CURSOR)
  assert.equal(records[0]?.failed_check, 'metadata_unreachable')
  assert.partialDeepStrictEqual(records[0], { client_family: 'grok' })
  assert.equal(records[0]?.request_id, response.headers.get('x-request-id'))
})

test('only the pinned raw client ID on an allowlisted Cursor origin can fetch a document', async () => {
  let fetches = 0
  const fetcher: typeof fetch = async input => {
    fetches++
    return Response.json({ ...cursorDocument, client_id: String(input), redirect_uris: [RETURN] })
  }
  const { app } = gateway(fetcher)
  for (const client_id of [
    CLIENT_ID + '?a', CLIENT_ID + '#a', CLIENT_ID.replace('/oauth/', '/other/'),
    CLIENT_ID.replace('cursor.com', 'CURSOR.COM'), CLIENT_ID.replace('cursor.com', 'cursor.com:443'),
    CLIENT_ID.replace('/oauth/', '/discard/../oauth/'),
  ]) {
    const response = await app.request(authorizationUrl({ ...grokRequest, client_id }))
    assert.equal(response.status, 400, client_id)
  }
  const disabled = gateway(fetcher, { HOSTED_CHAT_CIMD_ORIGINS: '' })
  assert.equal((await disabled.app.request(authorizationUrl(grokRequest))).status, 400)
  assert.equal(fetches, 0)
})
