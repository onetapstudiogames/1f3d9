// This fake makes an accidental database or network call fail the test. The
// discovery and rejected-request paths below must finish before touching Neon.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
process.env.HOSTED_CHAT_OAUTH_CLIENTS = JSON.stringify([{
  client_id: 'hosted-chat-test',
  client_name: 'Hosted Chat Test',
  redirect_uris: ['https://chat.example.test/oauth/callback'],
}])
process.env.HOSTED_CHAT_CIMD_ORIGINS = JSON.stringify(['https://chatgpt.com', 'https://claude.ai'])

globalThis.fetch = (async input => {
  throw new Error(`unexpected network or database call: ${String(input)}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')

const authorizeUrl = (patch: Record<string, string> = {}) => {
  const values = {
    response_type: 'code',
    client_id: 'hosted-chat-test',
    redirect_uri: 'https://chat.example.test/oauth/callback',
    resource: 'https://1f3d9.com/mcp/connect',
    scope: 'city:resident',
    state: 'opaque-client-state',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...patch,
  }
  return `/oauth/authorize?${new URLSearchParams(values)}`
}

function assertPrivateBrowserResponse(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors\s+'none'/i)
}

test('RFC 9728 metadata names only the MCP resource and the city authorization server', async () => {
  const response = await app.request('/.well-known/oauth-protected-resource/mcp/connect')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await response.json(), {
    resource: 'https://1f3d9.com/mcp/connect',
    authorization_servers: ['https://1f3d9.com'],
    bearer_methods_supported: ['header'],
    scopes_supported: ['city:resident'],
  })
})

test('RFC 8414 metadata advertises code plus refresh, PKCE S256, and no registration door', async () => {
  const response = await app.request('/.well-known/oauth-authorization-server')

  assert.equal(response.status, 200)
  const metadata = await response.json() as Record<string, unknown>
  assert.equal(metadata.issuer, 'https://1f3d9.com')
  assert.equal(metadata.authorization_endpoint, 'https://1f3d9.com/oauth/authorize')
  assert.equal(metadata.token_endpoint, 'https://1f3d9.com/oauth/token')
  assert.equal(metadata.revocation_endpoint, 'https://1f3d9.com/oauth/revoke')
  assert.deepEqual(metadata.response_types_supported, ['code'])
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token'])
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(metadata.scopes_supported, ['city:resident'])
  assert.equal(metadata.registration_endpoint, undefined)
  assert.equal(
    metadata.authorization_response_iss_parameter_supported,
    undefined,
    'issuer protection must stay unadvertised until every callback includes matching iss',
  )
})

test('OAuth browser and token preflights never inherit the public wildcard CORS policy', async () => {
  for (const path of ['/oauth/authorize', '/oauth/token', '/oauth/revoke']) {
    const response = await app.request(path, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://untrusted.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })

    assert.equal(response.status, 204, path)
    assert.equal(response.headers.get('access-control-allow-origin'), null, path)
    assert.equal(response.headers.get('access-control-allow-credentials'), null, path)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i, path)
  }
})

test('authorization rejects near-match return addresses and resources before touching storage', async () => {
  for (const url of [
    authorizeUrl({ redirect_uri: 'https://chat.example.test/oauth/callback/near-match' }),
    authorizeUrl({ resource: 'https://1f3d9.com' }),
    authorizeUrl({ code_challenge_method: 'plain' }),
  ]) {
    const response = await app.request(url)
    assert.equal(response.status, 400)
    assertPrivateBrowserResponse(response)
    assert.doesNotMatch(await response.text(), /opaque-client-state|E9Melhoa|1f3d9_(?:sk|at|rt|ac)_/i)
  }
})

test('browser approval POST needs its private cookie, CSRF value, and same-site origin', async () => {
  const body = new URLSearchParams({
    action: 'link',
    resident_key: `1f3d9_sk_${'ab'.repeat(24)}`,
    csrf: 'missing-server-side-session',
  })
  const missingSession = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://1f3d9.com',
    },
    body,
  })
  assert.equal(missingSession.status, 403)
  assertPrivateBrowserResponse(missingSession)
  assert.doesNotMatch(await missingSession.text(), /1f3d9_sk_/i)

  const hostileOrigin = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://evil.example',
      cookie: '1f3d9_oauth_session=opaque',
    },
    body,
  })
  assert.equal(hostileOrigin.status, 403)
  assertPrivateBrowserResponse(hostileOrigin)
})

test('dynamic client registration is absent in Release 1', async () => {
  const response = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
  })
  assert.equal(response.status, 404)
})

test('an unauthenticated protected MCP call returns the OAuth discovery challenge', async () => {
  const response = await app.request('/mcp/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'me', arguments: {} },
    }),
  })

  assert.equal(response.status, 401)
  const challenge = response.headers.get('www-authenticate') ?? ''
  assert.match(challenge, /^Bearer\b/i)
  assert.match(challenge, /resource_metadata="https:\/\/1f3d9\.com\/\.well-known\/oauth-protected-resource\/mcp\/connect"/i)
  assert.match(challenge, /scope="city:resident"/i)
  assert.doesNotMatch(await response.text(), /1f3d9_(?:sk|at|rt|ac)_/i)
})

test('MCP rejects credentials anywhere in tool arguments without echoing them', async () => {
  const credentials = [
    `1f3d9_sk_${'ab'.repeat(24)}`,
    `1f3d9_at_${'bc'.repeat(24)}`,
    `1f3d9_rt_${'cd'.repeat(24)}`,
    `1f3d9_ac_${'de'.repeat(24)}`,
  ]

  for (const [index, credential] of credentials.entries()) {
    const response = await app.request('/mcp/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: index + 10,
        method: 'tools/call',
        params: { name: 'say', arguments: { place_id: 1, body: `remember ${credential}` } },
      }),
    })
    const text = await response.text()
    assert.match(text, /do not put (?:secrets|credentials)/i)
    assert.doesNotMatch(text, /1f3d9_(?:sk|at|rt|ac)_/i)
  }

  const refreshKey = await app.request('/mcp/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'me', arguments: { refresh_token: 'hidden' } },
    }),
  })
  assert.match(await refreshKey.text(), /do not put (?:secrets|credentials)/i)
})
