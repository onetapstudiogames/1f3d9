import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mountOAuthRoutes } from '../../src/oauth.ts'
import { MemoryOAuthStore } from './memory-oauth-store.ts'
import { CALLBACK, CLIENT_ID, ORIGIN, RESOURCE, STATE, CHALLENGE, environment } from './fixture.ts'

const CLAUDE_CODE_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata'
const CLAUDE_CODE_CALLBACKS = ['http://localhost/callback', 'http://127.0.0.1/callback']

function claudeCodeMetadata(): Response {
  return new Response(JSON.stringify({
    client_id: CLAUDE_CODE_CLIENT_ID,
    client_name: 'Claude Code',
    redirect_uris: CLAUDE_CODE_CALLBACKS,
    token_endpoint_auth_method: 'none',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function loopbackApp(): Hono {
  const app = new Hono()
  // A thrown error must surface as a 500 here rather than as a rejected test
  // promise, so a regression that throws while building the page is visible
  // as the status a real browser would receive.
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  mountOAuthRoutes(app, {
    environment: { ...environment, HOSTED_CHAT_CIMD_ORIGINS: JSON.stringify(['https://claude.ai']) },
    store: new MemoryOAuthStore().api,
    fetcher: (async input => {
      if (String(input) === CLAUDE_CODE_CLIENT_ID) return claudeCodeMetadata()
      throw new Error(`unexpected network call: ${String(input)}`)
    }) as typeof fetch,
  })
  return app
}

function authorizeUrl(patch: Record<string, string> = {}): string {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CODE_CLIENT_ID,
    redirect_uri: 'http://127.0.0.1:54123/callback',
    resource: RESOURCE,
    scope: 'city:resident',
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...patch,
  })}`
}

async function assertRefused(app: Hono, url: string): Promise<void> {
  const response = await app.request(url)
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('location'), null)
  assert.ok(response.headers.get('x-request-id'))
  const body = await response.text()
  assert.match(body, /Request ID: <code>[0-9a-f-]{36}<\/code>/u)
  assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /http:/u)
}

export function registerClaudeCodeLoopbackTests(): void {
  test('the verified Claude Code client reaches the consent page on a loopback callback', async () => {
    const app = loopbackApp()

    for (const redirect_uri of ['http://127.0.0.1:54123/callback', 'http://localhost:1/callback']) {
      const response = await app.request(authorizeUrl({ redirect_uri }))

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('location'), null)
      const origin = new URL(redirect_uri).origin
      assert.equal(
        response.headers.get('content-security-policy'),
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; ` +
          "base-uri 'none'; frame-ancestors 'none'",
      )
      const body = await response.text()
      assert.match(body, /name="csrf" value="[^"]+"/u)
      assert.match(body, /Claude Code/u)
    }
  })

  test('a loopback exception never widens past the verified client and its own hosts', async () => {
    const app = loopbackApp()

    for (const redirect_uri of [
      'http://evil.example/callback',
      'http://localhost.evil.example/callback',
      'http://localhost.evil.example:54123/callback',
      'http://127.0.0.1:54123/callback?next=http://evil.example',
      'http://127.0.0.1:0/callback',
      'http://[::1]:54123/callback',
    ]) await assertRefused(app, authorizeUrl({ redirect_uri }))

    // A lookalike client on the same approved metadata origin is not the
    // verified Claude Code client and gets no loopback callback.
    await assertRefused(app, authorizeUrl({ client_id: 'https://claude.ai/oauth/other-client' }))

    // Neither does an approved HTTPS client that asked for one.
    await assertRefused(app, authorizeUrl({
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:54123/callback',
    }))
  })

  test('an ordinary HTTPS client still signs in and still names only its HTTPS callback', async () => {
    const app = loopbackApp()

    const response = await app.request(authorizeUrl({ client_id: CLIENT_ID, redirect_uri: CALLBACK }))

    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-security-policy') ?? '',
      new RegExp(`form-action 'self' ${new URL(CALLBACK).origin};`, 'u'),
    )
    assert.equal(new URL(CALLBACK).origin.startsWith(ORIGIN), false)
  })
}
