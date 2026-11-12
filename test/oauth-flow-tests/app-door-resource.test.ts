import assert from 'node:assert/strict'
import test from 'node:test'
import { residentByOAuthAccessToken } from '../../src/oauth.ts'
import { EXISTING_KEY } from './memory-oauth-store.ts'
import {
  CLIENT_ID,
  ORIGIN,
  RESOURCE,
  authorizationCode,
  authorizationUrl,
  begin,
  browserPost,
  environment,
  exchangeCode,
  fixture,
  initialPair,
  readTokenPair,
} from './fixture.ts'

const APP_RESOURCE = `${ORIGIN}/mcp/app`
// Decision 195: both hosted doors show this one sentence, word for word.
const SIGNIN_LINE = "<p><strong>Hosted Chat Flow Test</strong> wants to act as your resident. It cannot change the resident key. It can use the resident's fee credit.</p>"
const SIGNIN_SENTENCE = /<p><strong>[^<]*<\/strong> wants to act as your resident\.[^<]*<\/p>/u
// The owner asked that this sentence use none of these words or their forms (decision 195).
const AVOIDED_WORDS = /spend|spent|money|pay|wallet|buy|bought|purchas|cost|price|pricing|charg|cash|dollar|fund/iu

// Decision 142: /mcp/app is its own protected resource with the same sign-in and clients.
export function registerAppDoorResourceTests(): void {
  test('each hosted door publishes its own protected-resource metadata', async () => {
    const { app } = fixture()
    for (const [path, resource] of [
      ['/.well-known/oauth-protected-resource', RESOURCE],
      ['/.well-known/oauth-protected-resource/mcp/connect', RESOURCE],
      ['/.well-known/oauth-protected-resource/mcp/app', APP_RESOURCE],
    ] as const) {
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      const metadata = await response.json() as { resource: string; authorization_servers: string[] }
      assert.equal(metadata.resource, resource, path)
      assert.deepEqual(metadata.authorization_servers, [ORIGIN])
    }
  })

  test('both sign-in pages say the same true sentence about what a pass can use (decision 195)', async () => {
    const { app } = fixture()
    const appPage = (await begin(app, authorizationUrl({ resource: APP_RESOURCE }))).html
    assert.ok(appPage.includes(SIGNIN_LINE), 'the app door sentence')
    assert.doesNotMatch(appPage, /wallet|payment|USDC|\/buy/iu)
    assert.doesNotMatch(appPage, /rotate the permanent resident key|Paid actions spend/u)
    const { app: connectApp } = fixture()
    const connectPage = (await begin(connectApp, authorizationUrl({ resource: RESOURCE }))).html
    assert.ok(connectPage.includes(SIGNIN_LINE), 'the chat door sentence')
    assert.doesNotMatch(connectPage, /separate wallet approval|bypass payment rules/u)
  })

  test('neither sign-in sentence uses a word that can set off chat app filters (decision 195)', async () => {
    for (const resource of [RESOURCE, APP_RESOURCE]) {
      const { app } = fixture()
      const page = (await begin(app, authorizationUrl({ resource }))).html
      const sentence = page.match(SIGNIN_SENTENCE)?.[0]
      assert.ok(sentence, `${resource} has its sign-in sentence`)
      assert.doesNotMatch(sentence, AVOIDED_WORDS, resource)
    }
  })

  test('an existing resident signs in for /mcp/app, and that token works only at the app door', async () => {
    const { app, memory } = fixture()
    const session = await begin(app, authorizationUrl({ resource: APP_RESOURCE }))
    const linked = await browserPost(app, session, { action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY })
    const code = authorizationCode(linked)

    const wrongResource = await exchangeCode(app, code, { resource: RESOURCE })
    assert.equal(wrongResource.status, 400, 'a code for /mcp/app cannot be spent on /mcp/connect')

    const { app: freshApp, memory: freshMemory } = fixture()
    const freshSession = await begin(freshApp, authorizationUrl({ resource: APP_RESOURCE }))
    const freshCode = authorizationCode(await browserPost(freshApp, freshSession, {
      action: 'link', csrf: freshSession.csrf, resident_key: EXISTING_KEY,
    }))
    const pair = await readTokenPair(await exchangeCode(freshApp, freshCode, { resource: APP_RESOURCE }))
    assert.equal((await residentByOAuthAccessToken(pair.access_token, environment, freshMemory.api, 'app'))?.id, 49)
    assert.equal(await residentByOAuthAccessToken(pair.access_token, environment, freshMemory.api, 'connect'), null)

    const refreshed = await readTokenPair(await freshApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: CLIENT_ID, resource: APP_RESOURCE, refresh_token: pair.refresh_token,
      }),
    }))
    assert.equal((await residentByOAuthAccessToken(refreshed.access_token, environment, freshMemory.api, 'app'))?.id, 49)

    const connectPair = await initialPair(app)
    assert.equal((await residentByOAuthAccessToken(connectPair.access_token, environment, memory.api, 'connect'))?.id, 49)
    assert.equal(await residentByOAuthAccessToken(connectPair.access_token, environment, memory.api, 'app'), null)
  })

  test('an unknown resource is still refused at sign-in and token exchange', async () => {
    const { app } = fixture()
    const refused = await app.request(authorizationUrl({ resource: `${ORIGIN}/mcp` }))
    assert.equal(refused.status, 400)
    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: CLIENT_ID, resource: `${ORIGIN}/mcp`, refresh_token: `1f3d9_rt_${'ab'.repeat(32)}`,
      }),
    })
    assert.equal(token.status, 400)
    assert.deepEqual(await token.json(), { error: 'invalid_client' })
  })
}
