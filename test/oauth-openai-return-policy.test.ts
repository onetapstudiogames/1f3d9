import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import { mountOAuthRoutes } from '../src/oauth.ts'
import { MemoryOAuthStore } from './oauth-flow-tests/memory-oauth-store.ts'
import { CLIENT_ID, authorizationUrl, environment } from './oauth-flow-tests/fixture.ts'

const CHATGPT_CALLBACK = 'https://chatgpt.com/connector/oauth/submission-test'
const OTHER_CALLBACK = 'https://chat.example.test/oauth/callback'
const PLATFORM_ORIGIN = 'https://platform.openai.com'

function appForCallbacks(callbacks: readonly string[], memory = new MemoryOAuthStore()): Hono {
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: {
      ...environment,
      HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
        client_id: CLIENT_ID,
        client_name: 'ChatGPT',
        redirect_uris: callbacks,
      }]),
    },
    store: memory.api,
    pairingEnabled: true,
    diagnostics: () => undefined,
  })
  return app
}

function formPolicy(response: Response): string {
  const policy = response.headers.get('content-security-policy') ?? ''
  assert.match(policy, /default-src 'none';/u)
  assert.match(policy, /base-uri 'none'; frame-ancestors 'none'/u)
  return policy.split(';').find(directive => directive.trim().startsWith('form-action'))!.trim()
}

test('ChatGPT sign-in permits the exact OpenAI Platform return origin', async () => {
  const app = appForCallbacks([CHATGPT_CALLBACK])
  const response = await app.request(authorizationUrl({ redirect_uri: CHATGPT_CALLBACK }))
  assert.equal(response.status, 200)
  assert.equal(formPolicy(response), `form-action 'self' https://chatgpt.com ${PLATFORM_ORIGIN}`)
  assert.equal(response.headers.get('location'), null)
  assert.doesNotMatch(await response.text(), /http-equiv="refresh"/iu)
})

test('other callback origins cannot acquire the OpenAI allowance through their name or state', async () => {
  for (const callback of [
    OTHER_CALLBACK,
    'https://claude.ai/oauth/callback',
    'https://chatgpt.com.example.test/oauth/callback',
    'https://subdomain.chatgpt.com/oauth/callback',
    'https://chatgpt.com:8443/oauth/callback',
  ]) {
    const app = appForCallbacks([callback])
    const response = await app.request(authorizationUrl({
      redirect_uri: callback,
      state: `openai_platform_oauth_relay_${PLATFORM_ORIGIN}`,
    }))
    assert.equal(response.status, 200, callback)
    assert.equal(formPolicy(response), `form-action 'self' ${new URL(callback).origin}`, callback)
  }
})

test('the OpenAI browser allowance does not register another OAuth callback', async () => {
  const app = appForCallbacks([CHATGPT_CALLBACK])
  for (const callback of [
    `${PLATFORM_ORIGIN}/apps-manage/oauth`,
    `${CHATGPT_CALLBACK}/unregistered`,
  ]) {
    const response = await app.request(authorizationUrl({ redirect_uri: callback }))
    assert.equal(response.status, 400)
    assert.equal(formPolicy(response), "form-action 'self'")
    assert.equal(response.headers.get('location'), null)
  }
})

test('resumed sign-in uses the stored callback origin for its browser allowance', async () => {
  for (const [original, later] of [
    [CHATGPT_CALLBACK, OTHER_CALLBACK],
    [OTHER_CALLBACK, CHATGPT_CALLBACK],
  ]) {
    const app = appForCallbacks([CHATGPT_CALLBACK, OTHER_CALLBACK])
    const started = await app.request(authorizationUrl({ redirect_uri: original! }))
    assert.equal(started.status, 200)
    const cookie = (started.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    assert.ok(cookie)
    const resumed = await app.request(authorizationUrl({ redirect_uri: later! }), {
      headers: { cookie },
    })
    assert.equal(resumed.status, 200)
    assert.equal(formPolicy(resumed), formPolicy(started))
  }
})

test('ChatGPT retry and pairing confirmation retain the Platform browser allowance', async () => {
  const memory = new MemoryOAuthStore()
  const app = appForCallbacks([CHATGPT_CALLBACK], memory)
  const pairingCode = `1f3d9_pc_${'11'.repeat(32)}`
  await memory.api.mintPairingCode({ residentId: 49, codeHash: sha256(pairingCode) })
  const started = await app.request(authorizationUrl({ redirect_uri: CHATGPT_CALLBACK }))
  const cookie = (started.headers.get('set-cookie') ?? '').split(';', 1)[0]!
  const csrf = (await started.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrf)
  const attempts = [
    { status: 403, fields: { action: 'link', csrf, resident_key: `1f3d9_sk_${'cd'.repeat(24)}` } },
    { status: 200, fields: { action: 'pair', csrf, pairing_code: pairingCode } },
  ]
  for (const { status, fields } of attempts) {
    const response = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: { cookie, origin: environment.PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    })
    assert.equal(response.status, status)
    assert.equal(formPolicy(response), `form-action 'self' https://chatgpt.com ${PLATFORM_ORIGIN}`)
    assert.equal(response.headers.get('location'), null)
  }
})
