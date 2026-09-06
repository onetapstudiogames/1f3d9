import assert from 'node:assert/strict'
import test from 'node:test'
import { auth, setOAuthResidentResolver } from '../../src/core.ts'
import { mcp } from '../../src/mcp.ts'
import { residentByOAuthAccessToken } from '../../src/oauth.ts'
import { EXISTING_KEY } from './memory-oauth-store.ts'
import {
  CLIENT_ID,
  assertPrivate,
  authorizationCode,
  authorizeExisting,
  begin,
  browserPost,
  environment,
  exchangeCode,
  fixture,
  initialPair,
  readTokenPair,
} from './fixture.ts'

export function registerResidentLinkingTests(): void {
  test('existing resident completes sign-in, PKCE exchange, resolver, replay rejection, and revocation', async () => {
    const { app, memory } = fixture()
    const recoveryCodesBefore = (JSON.parse(memory.safeState()) as { recoveryCodes: unknown[] }).recoveryCodes
    const { code } = await authorizeExisting(app)

    assert.doesNotMatch(memory.safeState(), new RegExp(EXISTING_KEY, 'i'))
    const pair = await readTokenPair(await exchangeCode(app, code))
    assert.doesNotMatch(JSON.stringify(pair), new RegExp(EXISTING_KEY, 'i'))

    const replay = await exchangeCode(app, code)
    assert.equal(replay.status, 400)
    assert.deepEqual(await replay.json(), { error: 'invalid_grant' })

    const resident = await residentByOAuthAccessToken(pair.access_token, environment, memory.api)
    assert.equal(resident?.id, 49)
    assert.equal(resident?.handle, 'chatty')
    assert.doesNotMatch(JSON.stringify(resident), /1f3d9_(?:sk|at|rt|ac)_/i)

    const revoked = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: pair.refresh_token, client_id: CLIENT_ID }),
    })
    assert.equal(revoked.status, 200)
    assertPrivate(revoked)
    assert.equal(await residentByOAuthAccessToken(pair.access_token, environment, memory.api), null)
    const recoveryCodesAfter = (JSON.parse(memory.safeState()) as { recoveryCodes: unknown[] }).recoveryCodes
    assert.deepEqual(recoveryCodesAfter, recoveryCodesBefore, 'linking must not generate or replace recovery codes')
  })

  test('unrecognized resident keys stay merged and can be corrected on the same sign-in request', async () => {
    const { app } = fixture()
    const session = await begin(app)
    const unrecognizedKeys = [
      `1f3d9_sk_${'cd'.repeat(24)}`,
      `1f3d9_sk_${'ef'.repeat(24)}`,
    ]

    for (const residentKey of unrecognizedKeys) {
      const rejected = await browserPost(app, session, {
        action: 'link', csrf: session.csrf, resident_key: residentKey,
      })
      assert.equal(rejected.status, 403)
      assert.equal(rejected.headers.get('x-1f3d9-reason'), 'resident_key_rejected')
      assert.match(
        rejected.headers.get('content-security-policy') ?? '',
        /form-action 'self' https:\/\/chat\.example\.test/u,
      )
      const body = await rejected.text()
      assert.match(body, /resident key could not be verified/iu)
      assert.match(body, /try again on this page/iu)
      assert.match(body, /name="action" value="link"/u)
      assert.match(body, /name="resident_key"[^>]*type="password"/iu)
      assert.match(body, new RegExp(`name="csrf" value="${session.csrf}"`, 'u'))
      assert.doesNotMatch(body, /Start again|close this page/iu)
      assert.doesNotMatch(body, new RegExp(residentKey, 'iu'))
    }

    const corrected = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    authorizationCode(corrected)
  })

  test('a redeemed access token reaches city actions only through the hosted connector', async () => {
    const { app, memory } = fixture()
    app.get('/api/me', async c => {
      const resident = await auth(c)
      return resident ? c.json({ handle: resident.handle }) : c.json({ error: 'sign in required' }, 401)
    })
    app.post('/mcp', c => mcp(c, app))
    app.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))

    const previousFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    setOAuthResidentResolver(token => residentByOAuthAccessToken(token, environment, memory.api))

    try {
      const pair = await initialPair(app)
      const headers = { authorization: `Bearer ${pair.access_token}` }

      const rawApi = await app.request('/api/me', {
        headers: { ...headers, 'x-1f3d9-internal-connector': 'true' },
      })
      assert.equal(rawApi.status, 401)

      const call = (path: '/mcp' | '/mcp/connect') => app.request(path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'me', arguments: {} },
        }),
      })

      const legacy = await call('/mcp')
      assert.equal(legacy.status, 200)
      const legacyPayload = await legacy.json() as { result: { isError: boolean } }
      assert.equal(legacyPayload.result.isError, true)

      const hosted = await call('/mcp/connect')
      assert.equal(hosted.status, 200)
      const hostedPayload = await hosted.json() as {
        result: { isError: boolean; content: Array<{ text: string }> }
      }
      assert.equal(hostedPayload.result.isError, false)
      assert.match(hostedPayload.result.content[0]?.text ?? '', /chatty/)
    } finally {
      setOAuthResidentResolver(null)
      if (previousFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousFlag
    }
  })

}
