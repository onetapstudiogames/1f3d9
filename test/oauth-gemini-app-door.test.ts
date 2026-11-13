import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'

// Decision 198: a new Gemini resident is sent to /mcp/app. Before any Gemini link moved,
// this proves in process that a Gemini self-registered client can sign in for that door.
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'

const { auth, setOAuthResidentResolver } = await import('../src/core.ts')
const { mcp } = await import('../src/mcp.ts')
const { mountOAuthRoutes, residentByOAuthAccessToken } = await import('../src/oauth.ts')
const { EXISTING_KEY, MemoryOAuthStore } = await import('./oauth-flow-tests/memory-oauth-store.ts')
const { authorizationUrl, browserPost, environment, exchangeCode, readTokenPair, ORIGIN } =
  await import('./oauth-flow-tests/fixture.ts')

const APP_RESOURCE = `${ORIGIN}/mcp/app`
const CONNECT_RESOURCE = `${ORIGIN}/mcp/connect`
// Decision 143's form (October 2026) and decision 186's opaque form (November 2026); both invented.
const RETURN_ADDRESSES = Object.freeze({
  october: 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123456-1f3d9_com',
  opaque: 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-4815162342c0ffee15deadbe',
})
const STATE = 'gemini-app-door-state'

function gateway() {
  const env = { ...environment, GEMINI_DCR_SIGNING_KEY: randomBytes(32).toString('hex') }
  const memory = new MemoryOAuthStore()
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: env, store: memory.api, diagnostics: () => undefined, pairingEnabled: false,
    fetcher: (async () => { throw new Error('Gemini sign-in must not fetch') }) as typeof fetch,
  })
  setOAuthResidentResolver((token, door) => residentByOAuthAccessToken(token, env, memory.api, door))
  const meRoute = async (c: import('hono').Context) => {
    const resident = await auth(c)
    if (!resident) return c.json({ error: 'bad or missing bearer secret' }, 401)
    return c.json({ resident_id: resident.id, handle: resident.handle })
  }
  app.get('/api/me', meRoute)
  app.post('/api/me', meRoute)
  app.post('/mcp/connect', c => mcp(c, app, { door: 'connect', forwardUnauthorizedStatus: true }))
  app.post('/mcp/app', c => mcp(c, app, { door: 'app', forwardUnauthorizedStatus: true }))
  return app
}

async function registerGemini(app: Hono, redirect: string): Promise<string> {
  const response = await app.request('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Google', token_endpoint_auth_method: 'none' }),
  })
  assert.equal(response.status, 201, 'registration')
  return (await response.json()).client_id as string
}

async function signInForAppDoor(app: Hono, clientId: string, redirect: string): Promise<string> {
  const location = authorizationUrl({ client_id: clientId, redirect_uri: redirect, resource: APP_RESOURCE, state: STATE })
  const started = await app.request(location)
  assert.equal(started.status, 200, 'the sign-in page opens for resource /mcp/app')
  const html = await started.text()
  assert.match(html, /Gemini/u)
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)![1]!
  const finished = await browserPost(app, { cookie, csrf, html, location, rawSession: '' }, {
    action: 'link', csrf, resident_key: EXISTING_KEY,
  })
  assert.equal(finished.status, 200, 'the sign-in page finishes')
  const href = (await finished.text()).match(/<a href="([^"]+)">Return to Gemini<\/a>/u)?.[1]
  assert.ok(href, 'the ready page links back to Gemini')
  const callback = new URL(href.replaceAll('&amp;', '&'))
  assert.equal(`${callback.origin}${callback.pathname}`, redirect)
  assert.equal(callback.searchParams.get('state'), STATE)
  return callback.searchParams.get('code')!
}

function callMe(app: Hono, path: '/mcp/app' | '/mcp/connect', accessToken: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} } }),
  })
}

for (const [shape, redirect] of Object.entries(RETURN_ADDRESSES)) {
  test(`a Gemini client with the ${shape} return address signs in for /mcp/app and calls me there`, async () => {
    const app = gateway()
    try {
      const clientId = await registerGemini(app, redirect)
      const code = await signInForAppDoor(app, clientId, redirect)
      const pair = await readTokenPair(await exchangeCode(app, code, {
        client_id: clientId, redirect_uri: redirect, resource: APP_RESOURCE,
      }))

      const onApp = await callMe(app, '/mcp/app', pair.access_token)
      assert.equal(onApp.status, 200)
      const appBody = await onApp.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
      assert.equal(appBody.result.isError, false, JSON.stringify(appBody))
      assert.match(appBody.result.content[0]!.text, /chatty/u)

      // The same pass is for /mcp/app only; /mcp/connect asks for its own sign-in.
      const onConnect = await callMe(app, '/mcp/connect', pair.access_token)
      assert.equal(onConnect.status, 401)
      const connectBody = await onConnect.json() as { result: { isError: boolean; _meta: Record<string, string[]> } }
      assert.equal(connectBody.result.isError, true)
      assert.match(connectBody.result._meta['mcp/www_authenticate']![0]!, /oauth-protected-resource\/mcp\/connect"/u)
    } finally {
      setOAuthResidentResolver(null)
    }
  })
}

test('a Gemini code made for /mcp/app is refused when exchanged for /mcp/connect', async () => {
  const app = gateway()
  try {
    const redirect = RETURN_ADDRESSES.opaque
    const clientId = await registerGemini(app, redirect)
    const code = await signInForAppDoor(app, clientId, redirect)
    const wrong = await exchangeCode(app, code, { client_id: clientId, redirect_uri: redirect, resource: CONNECT_RESOURCE })
    assert.equal(wrong.status, 400)
  } finally {
    setOAuthResidentResolver(null)
  }
})
