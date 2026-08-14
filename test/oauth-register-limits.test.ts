import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountOAuthRoutes } from '../src/oauth.ts'

const CLIENT_ID = 'hosted-chat-test'
const REDIRECT_URI = 'https://chat.example.test/oauth/callback'

const AUTHORIZE_QUERY = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  resource: 'https://1f3d9.com/mcp/connect',
  scope: 'city:resident',
  state: 'opaque-client-state',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
})

function fakeStore() {
  const rateLimitCalls: { bucketHash: string; attemptKind: string; maximum: number }[] = []
  return {
    rateLimitCalls,
    async createAuthorizationRequest() {},
    async getAuthorizationRequest() {
      return {
        id: 1,
        client_id: CLIENT_ID,
        client_display_name: 'Hosted Chat Test',
        redirect_uri: REDIRECT_URI,
        resource: 'https://1f3d9.com/mcp/connect',
        scope: 'city:resident',
        state: 'opaque-client-state',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        intent: null,
        resident_id: null,
        new_handle: null,
        new_model: null,
        root_key_confirmed_at: null,
      }
    },
    async approveExistingResidentAndIssueAuthorizationCode() {
      throw new Error('existing-resident link is not part of this test')
    },
    async stageNewResidentRegistration(input: { handle: string }) {
      return { status: 'staged' as const, handle: input.handle }
    },
    async cancelAuthorizationRequest() {
      throw new Error('cancel is not part of this test')
    },
    async confirmNewResidentAndIssueAuthorizationCode() {
      throw new Error('authorization-code issue is not part of this test')
    },
    async getAuthorizationCode() {
      throw new Error('code exchange is not part of this test')
    },
    async exchangeAuthorizationCode() {
      throw new Error('code exchange is not part of this test')
    },
    async rotateRefreshToken() {
      throw new Error('refresh rotation is not part of this test')
    },
    async revokeTokenFamilyByToken() {},
    async resolveOAuthAccessToken() {
      throw new Error('token auth is not part of this test')
    },
    async consumeOAuthRateLimit(input: { bucketHash: string; attemptKind: string; maximum: number }) {
      rateLimitCalls.push(input)
      return true
    },
  }
}

test('new hosted-chat residents use dedicated signup throttles instead of sharing the page-open bucket', async () => {
  const store = fakeStore()
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      VERCEL: '1',
      PUBLIC_ORIGIN: 'https://1f3d9.com',
      HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
        client_id: CLIENT_ID,
        client_name: 'Hosted Chat Test',
        redirect_uris: [REDIRECT_URI],
      }]),
    },
    store,
  })

  const openPage = await app.request(`/oauth/authorize?${AUTHORIZE_QUERY}`, {
    headers: { 'x-vercel-forwarded-for': '203.0.113.10' },
  })
  assert.equal(openPage.status, 200)
  const csrf = /name="csrf" value="([^"]+)"/.exec(await openPage.text())?.[1]
  assert.ok(csrf, 'authorization page should render a CSRF token')
  const cookie = openPage.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie, 'authorization page should set a private session cookie')

  const register = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://1f3d9.com',
      cookie,
      'x-vercel-forwarded-for': '203.0.113.10',
    },
    body: new URLSearchParams({
      action: 'register',
      csrf,
      handle: 'chatty',
      model: 'hosted-chat',
    }),
  })
  assert.equal(register.status, 200)

  assert.deepEqual(store.rateLimitCalls.map(call => call.maximum), [60, 60, 3, 300, 300])
  assert.equal(store.rateLimitCalls[0]?.attemptKind, 'authorize')
  assert.equal(store.rateLimitCalls[2]?.attemptKind, 'authorize')
  assert.notEqual(
    store.rateLimitCalls[0]?.bucketHash,
    store.rateLimitCalls[2]?.bucketHash,
    'opening the page and creating a resident must not share one IP bucket',
  )
  assert.notEqual(
    store.rateLimitCalls[1]?.bucketHash,
    store.rateLimitCalls[4]?.bucketHash,
    'opening the page and creating a resident must not share one client bucket',
  )
})

test('OAuth throttles trust only Vercel\'s final client address, not caller forwarding hops', async () => {
  const store = fakeStore()
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: {
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      VERCEL: '1',
      PUBLIC_ORIGIN: 'https://1f3d9.com',
      HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
        client_id: CLIENT_ID,
        client_name: 'Hosted Chat Test',
        redirect_uris: [REDIRECT_URI],
      }]),
    },
    store,
  })

  for (const spoofed of ['198.51.100.1', '198.51.100.2']) {
    const response = await app.request(`/oauth/authorize?${AUTHORIZE_QUERY}`, {
      headers: {
        'x-forwarded-for': spoofed,
        'x-vercel-forwarded-for': `${spoofed}, 203.0.113.10`,
      },
    })
    assert.equal(response.status, 200)
  }

  assert.equal(store.rateLimitCalls[0]?.bucketHash, store.rateLimitCalls[2]?.bucketHash)
})
