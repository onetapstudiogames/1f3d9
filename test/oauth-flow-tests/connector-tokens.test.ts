import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import {
  mountOAuthRoutes,
  residentByOAuthAccessToken,
  type OAuthDiagnosticRecord,
} from '../../src/oauth.ts'
import { EXISTING_KEY, MemoryOAuthStore, rateLimitResult } from './memory-oauth-store.ts'
import {
  CALLBACK,
  CLIENT_ID,
  ORIGIN,
  RESOURCE,
  STATE,
  VERIFIER,
  appFor,
  assertPrivate,
  authorizationUrl,
  browserPost,
  environment,
  fixture,
  initialPair,
  readTokenPair,
} from './fixture.ts'

export function registerConnectorTokenTests(): void {
  test('current ChatGPT callback-specific CIMD completes PKCE exchange and refresh', async () => {
    const memory = new MemoryOAuthStore()
    const clientId = 'https://chatgpt.com/oauth/wave11/client.json'
    const redirectUri = 'https://chatgpt.com/connector/oauth/wave11'
    const cimdEnvironment = {
      ...environment,
      HOSTED_CHAT_OAUTH_CLIENTS: '',
      HOSTED_CHAT_CIMD_ORIGINS: JSON.stringify(['https://chatgpt.com']),
    }
    const app = new Hono()
    mountOAuthRoutes(app, {
      environment: cimdEnvironment,
      store: memory.api,
      fetcher: (async (input, init) => {
        assert.equal(String(input), clientId)
        assert.equal(init?.redirect, 'manual')
        assert.ok(init?.signal instanceof AbortSignal)
        return new Response(JSON.stringify({
          client_id: clientId,
          client_name: 'ChatGPT',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'private_key_jwt',
          token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        }), { headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      diagnostics: () => undefined,
    })

    const location = authorizationUrl({
      client_id: clientId,
      redirect_uri: redirectUri,
    })
    const started = await app.request(location)
    assert.equal(started.status, 200)
    assertPrivate(started, true)
    assert.equal(started.headers.get('location'), null)
    const cookie = (started.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    assert.match(cookie, /^__Host-1f3d9_oauth=/u)
    assert.match(
      started.headers.get('content-security-policy') ?? '',
      /form-action 'self' https:\/\/chatgpt\.com;/u,
    )
    const html = await started.text()
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
    assert.ok(csrf)
    const session = {
      cookie,
      rawSession: cookie.split('=', 2)[1]!.split('.', 2)[0]!,
      csrf,
      html,
      location,
    }
    const approval = await browserPost(app, session, {
      action: 'link',
      csrf,
      resident_key: EXISTING_KEY,
    })
    assert.equal(approval.status, 303)
    const callback = new URL(approval.headers.get('location') ?? '')
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri)
    assert.equal(callback.searchParams.get('state'), STATE)
    const code = callback.searchParams.get('code') ?? ''
    assert.match(code, /^1f3d9_ac_[0-9a-f]{64}$/)

    const exchanged = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: RESOURCE,
        code,
        code_verifier: VERIFIER,
      }),
    })
    const firstPair = await readTokenPair(exchanged)
    const refreshed = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        resource: RESOURCE,
        refresh_token: firstPair.refresh_token,
      }),
    })
    const secondPair = await readTokenPair(refreshed)
    assert.notEqual(secondPair.refresh_token, firstPair.refresh_token)
    assert.equal(
      (await residentByOAuthAccessToken(secondPair.access_token, cimdEnvironment, memory.api))?.handle,
      'chatty',
    )
  })

  test('refresh allowances belong to each connector connection instead of the shared client', async () => {
    const { app, memory } = fixture()
    const first = await initialPair(app)
    const second = await initialPair(app)
    const usedByBucket = new Map<string, number>()
    memory.api.consumeOAuthRateLimit = async input => {
      if (input.attemptKind !== 'refresh') return rateLimitResult(true)
      const used = usedByBucket.get(input.bucketHash) ?? 0
      if (used >= 1) return rateLimitResult(false)
      usedByBucket.set(input.bucketHash, used + 1)
      return rateLimitResult(true)
    }

    for (const pair of [first, second]) {
      const response = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          resource: RESOURCE,
          refresh_token: pair.refresh_token,
        }),
      })
      await readTokenPair(response)
    }
  })

  test('junk refresh requests cannot spend a real connector connection allowance', async () => {
    const { app, memory } = fixture()
    const pair = await initialPair(app)
    const usedByBucket = new Map<string, number>()
    const rotateRefreshToken = memory.api.rotateRefreshToken
    let rotationCalls = 0
    memory.api.rotateRefreshToken = async input => {
      rotationCalls += 1
      return rotateRefreshToken(input)
    }
    memory.api.consumeOAuthRateLimit = async input => {
      if (input.attemptKind !== 'refresh') return rateLimitResult(true)
      const used = usedByBucket.get(input.bucketHash) ?? 0
      if (used >= 2) return rateLimitResult(false)
      usedByBucket.set(input.bucketHash, used + 1)
      return rateLimitResult(true)
    }

    for (const refreshToken of [
      'not-a-city-refresh-token',
      `1f3d9_rt_${'cd'.repeat(32)}`,
    ]) {
      const junk = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          resource: RESOURCE,
          refresh_token: refreshToken,
        }),
      })
      assert.equal(junk.status, 400)
      assert.deepEqual(await junk.json(), { error: 'invalid_grant' })
    }
    const throttledJunk = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: `1f3d9_rt_${'ef'.repeat(32)}`,
      }),
    })
    assert.equal(throttledJunk.status, 429)
    assert.equal(throttledJunk.headers.get('retry-after'), '17')
    assert.equal(rotationCalls, 0, 'junk must stop before refresh rotation work')

    const real = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: pair.refresh_token,
      }),
    })
    await readTokenPair(real)
    assert.equal(rotationCalls, 1)
  })

  test('a throttled refresh says to wait and retry instead of calling the grant invalid', async () => {
    const { app, memory } = fixture()
    const pair = await initialPair(app)
    memory.api.consumeOAuthRateLimit = async input => rateLimitResult(input.attemptKind !== 'refresh')

    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: pair.refresh_token,
      }),
    })

    assert.equal(response.status, 429)
    assertPrivate(response)
    assert.equal(response.headers.get('retry-after'), '17')
    const expected = {
      error: 'temporarily_unavailable',
      error_description: 'Too many refresh attempts. Wait 17 seconds and retry.',
    }
    assert.deepEqual(await response.json(), expected)

    const junk = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: 'not-a-city-refresh-token',
      }),
    })
    assert.equal(junk.status, 429)
    assertPrivate(junk)
    assert.equal(junk.headers.get('retry-after'), '17')
    assert.deepEqual(await junk.json(), expected)
  })

  test('two overlapping refreshes leave the successful connector grant alive', async () => {
    const memory = new MemoryOAuthStore()
    const diagnostics: OAuthDiagnosticRecord[] = []
    const app = appFor(memory, record => diagnostics.push(record))
    const first = await initialPair(app)
    const resolveRefreshRateLimitSubject = memory.api.resolveRefreshRateLimitSubject
    let subjectChecks = 0
    let releaseSubjectChecks!: () => void
    const bothSubjectsChecked = new Promise<void>(resolve => {
      releaseSubjectChecks = resolve
    })
    memory.api.resolveRefreshRateLimitSubject = async input => {
      const subject = await resolveRefreshRateLimitSubject(input)
      subjectChecks += 1
      if (subjectChecks === 2) releaseSubjectChecks()
      if (subjectChecks <= 2) await bothSubjectsChecked
      return subject
    }

    const request = (refreshToken: string) => app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: refreshToken,
      }),
    })
    const responses = await Promise.all([
      request(first.refresh_token),
      request(first.refresh_token),
    ])
    const successful = responses.filter(response => response.status === 200)
    const overlapping = responses.filter(response => response.status === 400)
    assert.equal(successful.length, 1)
    assert.equal(overlapping.length, 1)
    assert.deepEqual(await overlapping[0]!.json(), { error: 'invalid_grant' })
    assert.deepEqual(diagnostics.map(record => record.error_class), ['overlapping_refresh'])

    const winner = await readTokenPair(successful[0]!)
    assert.equal(
      (await residentByOAuthAccessToken(winner.access_token, environment, memory.api))?.id,
      49,
      'the losing overlap must not revoke the winner',
    )
    const next = await readTokenPair(await request(winner.refresh_token))
    assert.equal(
      (await residentByOAuthAccessToken(next.access_token, environment, memory.api))?.id,
      49,
      'the refresh token returned to the winner must remain usable',
    )
  })

  test('first refresh-token reuse still revokes once; later replay stops before rotation', async () => {
    const { app, memory } = fixture()
    const first = await initialPair(app)
    const request = () => app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: first.refresh_token,
      }),
    })
    const second = await readTokenPair(await request())
    const rotateRefreshToken = memory.api.rotateRefreshToken
    let rotationCalls = 0
    memory.api.rotateRefreshToken = async input => {
      rotationCalls += 1
      return rotateRefreshToken(input)
    }
    memory.api.consumeOAuthRateLimit = async input => rateLimitResult(input.attemptKind !== 'refresh')

    const firstReplay = await request()
    assert.equal(firstReplay.status, 400)
    assert.deepEqual(await firstReplay.json(), { error: 'invalid_grant' })
    assert.equal(await residentByOAuthAccessToken(first.access_token, environment, memory.api), null)
    assert.equal(await residentByOAuthAccessToken(second.access_token, environment, memory.api), null)
    assert.equal(rotationCalls, 1, 'the first replay must reach family revocation')

    const laterReplay = await request()
    assert.equal(laterReplay.status, 429)
    assert.equal(laterReplay.headers.get('retry-after'), '17')
    assert.deepEqual(await laterReplay.json(), {
      error: 'temporarily_unavailable',
      error_description: 'Too many refresh attempts. Wait 17 seconds and retry.',
    })
    assert.equal(rotationCalls, 1, 'post-revocation replay must stop before rotation')
  })

}
