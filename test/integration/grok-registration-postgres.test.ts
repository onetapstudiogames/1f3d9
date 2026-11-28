// Grok registers itself, signs in and uses the app door (decision #206), against real
// PostgreSQL: the real schema, the real routes through src/index.ts and the real OAuth
// store. Grok's own registration body is sent server to server and is not known, so the
// body asks for a secret-based method, and two exchanges still send a stray secret.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { FOUNDER, type CityApp } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, resetCity, standIn, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'

const ORIGIN = 'https://1f3d9.com'
const APP = `${ORIGIN}/mcp/app`
const CONNECT = `${ORIGIN}/mcp/connect`
const RETURN = 'https://grok.com/connectors-oauth-exchange-code/'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const STATE = 'grok-state-that-must-survive'
const GROK_AGENT = 'grok-connectors-manager/0.1.0'

type TokenPair = Readonly<{ access_token: string; refresh_token: string }>
type ToolResult = Readonly<{ isError: boolean; content: Array<{ text: string }> }>

function url(path: string): string {
  return `http://city.test${path}`
}

function authorizeUrl(clientId: string, resource = APP): string {
  return url(`/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: RETURN, resource, scope: 'city:resident',
    state: STATE, code_challenge: CHALLENGE, code_challenge_method: 'S256',
  })}`)
}

async function register(app: CityApp): Promise<string> {
  const response = await app.request(url('/oauth/register'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': GROK_AGENT },
    body: JSON.stringify({
      client_name: 'Grok', redirect_uris: [RETURN], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic',
    }),
  })
  assert.equal(response.status, 201)
  const registered = await response.json() as Record<string, unknown>
  assert.equal(registered.client_name, 'Grok')
  assert.equal(registered.token_endpoint_auth_method, 'none')
  assert.equal('client_secret' in registered, false)
  assert.deepEqual(registered.redirect_uris, [RETURN])
  return String(registered.client_id)
}

async function signIn(app: CityApp, clientId: string): Promise<string> {
  const started = await app.request(authorizeUrl(clientId))
  assert.equal(started.status, 200)
  const html = await started.text()
  assert.match(html, /<strong>Grok<\/strong> wants to act as your resident/u)
  const cookie = started.headers.get('set-cookie')!.split(';', 1)[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)![1]!
  const approved = await app.request(url('/oauth/authorize'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: ORIGIN },
    body: new URLSearchParams({ action: 'link', csrf, resident_key: FOUNDER.secret }),
  })
  assert.equal(approved.status, 303)
  const callback = new URL(approved.headers.get('location')!)
  assert.equal(callback.origin + callback.pathname, RETURN)
  assert.equal(callback.searchParams.get('state'), STATE)
  return callback.searchParams.get('code')!
}

function token(app: CityApp, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return app.request(url('/oauth/token'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  })
}

async function pair(response: Response): Promise<TokenPair> {
  assert.equal(response.status, 200)
  const body = await response.json() as TokenPair
  assert.match(body.access_token, /^1f3d9_at_[0-9a-f]{64}$/u)
  assert.match(body.refresh_token, /^1f3d9_rt_[0-9a-f]{64}$/u)
  return body
}

const exchange = (clientId: string, code: string) => ({
  grant_type: 'authorization_code', client_id: clientId, redirect_uri: RETURN, resource: APP, code, code_verifier: VERIFIER,
})

async function meOn(app: CityApp, path: '/mcp/app' | '/mcp/connect', accessToken: string) {
  return app.request(url(path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'user-agent': GROK_AGENT, authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} } }),
  })
}

function basic(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`
}

test('Grok registers, signs in and uses the app door against real PostgreSQL', { timeout: 600_000 }, async t => {
  process.env.PUBLIC_ORIGIN = ORIGIN
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  process.env.HOSTED_CHAT_CIMD_ORIGINS = JSON.stringify(['https://chatgpt.com', 'https://claude.ai'])
  process.env.GEMINI_DCR_SIGNING_KEY = randomBytes(32).toString('hex')
  const postgres = await startNoteSuiteDatabase('grok-registration')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()
    const rooms = await resetCity([FOUNDER])
    await standIn(FOUNDER.id, rooms.eastRoomId)

    const discovery = await app.request(url('/mcp/app'), {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': GROK_AGENT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(discovery.status, 401, 'Grok is asked to sign in, as decision 202 set up')

    const clientId = await register(app)
    let passes: TokenPair

    await t.test('the code exchanges with no secret and the pass answers a tool call on the app door', async () => {
      passes = await pair(await token(app, exchange(clientId, await signIn(app, clientId))))
      const answer = await meOn(app, '/mcp/app', passes.access_token)
      assert.equal(answer.status, 200)
      const { result } = await answer.json() as { result: ToolResult }
      assert.equal(result.isError, false, result.content[0]?.text)
      assert.match(result.content[0]!.text, new RegExp(`"handle":\\s*"${FOUNDER.handle}"`, 'u'))
    })

    await t.test('the pass does not open /mcp/connect, and the client cannot sign in there', async () => {
      const answer = await meOn(app, '/mcp/connect', passes.access_token)
      assert.equal(answer.status, 401)
      assert.match(answer.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp\/connect".*error="invalid_token"/u)
      const { result } = await answer.json() as { result: ToolResult }
      assert.equal(result.isError, true)
      assert.equal(JSON.parse(result.content[0]!.text).error_class, 'auth_required')
      assert.doesNotMatch(result.content[0]!.text, new RegExp(FOUNDER.handle, 'u'))
      const refused = await app.request(authorizeUrl(clientId, CONNECT))
      assert.equal(refused.status, 400)
      assert.equal(refused.headers.get('location'), null)
    })

    await t.test('refresh works on the app door with a stray Basic secret and is refused for /mcp/connect', async () => {
      const wrongDoor = await token(app, {
        grant_type: 'refresh_token', client_id: clientId, resource: CONNECT, refresh_token: passes.refresh_token,
      })
      assert.equal(wrongDoor.status, 400)
      assert.deepEqual(await wrongDoor.json(), { error: 'invalid_grant' })
      passes = await pair(await token(app, {
        grant_type: 'refresh_token', resource: APP, refresh_token: passes.refresh_token,
      }, { authorization: basic(clientId, '') }))
      const answer = await meOn(app, '/mcp/app', passes.access_token)
      const { result } = await answer.json() as { result: ToolResult }
      assert.equal(result.isError, false)
    })

    await t.test('a stray posted secret or a made-up Basic secret is ignored; the verifier is still checked', async () => {
      const posted = await signIn(app, clientId)
      const wrongVerifier = await token(app, { ...exchange(clientId, posted), client_secret: 'made-up', code_verifier: 'z'.repeat(43) })
      assert.deepEqual([wrongVerifier.status, await wrongVerifier.json()], [400, { error: 'invalid_grant' }])
      await pair(await token(app, { ...exchange(clientId, await signIn(app, clientId)), client_secret: 'made-up' }))
      await pair(await token(app, exchange(clientId, await signIn(app, clientId)), { authorization: basic(clientId, 'made-up') }))
    })

    await t.test('every stored grant names the Grok client and the app door only', async () => {
      const families = (await db.query<{ client_id: string; resource: string }>(
        'SELECT DISTINCT client_id, resource FROM oauth_token_families',
      )).rows
      assert.deepEqual(families, [{ client_id: clientId, resource: APP }])
      const requests = (await db.query<{ client_display_name: string; redirect_uri: string }>(
        'SELECT DISTINCT client_display_name, redirect_uri FROM oauth_authorization_requests',
      )).rows
      assert.deepEqual(requests, [{ client_display_name: 'Grok', redirect_uri: RETURN }])
    })
  } finally {
    await postgres.stop()
  }
})
