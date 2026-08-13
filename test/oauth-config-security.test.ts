import test from 'node:test'
import assert from 'node:assert/strict'
import {
  oauthResource,
  publicOrigin,
  resolveOAuthClient,
  validateAuthorizationRequest,
  type OAuthClient,
} from '../src/oauth-config.ts'

const ALLOWED_ORIGIN = 'https://chat.example.test'
const CLIENT_ID = `${ALLOWED_ORIGIN}/oauth/client.json`
const REDIRECT_URI = `${ALLOWED_ORIGIN}/oauth/callback`

const staticClient: OAuthClient = {
  clientId: 'static-client',
  clientName: 'Static Client',
  redirectUris: [REDIRECT_URI],
}

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: CLIENT_ID,
    client_name: 'Hosted Chat',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    ...overrides,
  })
}

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

test('a configured static client is returned without any metadata fetch', async () => {
  let fetchCount = 0
  const fetcher = (async () => {
    fetchCount += 1
    throw new Error('static clients must never use the network')
  }) as typeof fetch

  const resolved = await resolveOAuthClient(
    staticClient.clientId,
    [staticClient],
    [ALLOWED_ORIGIN],
    fetcher,
  )

  assert.equal(resolved, staticClient)
  assert.equal(fetchCount, 0)
})

test('CIMD fetches only an allowlisted HTTPS origin with locked-down request options', async () => {
  let fetchedUrl = ''
  let fetchedInit: RequestInit | undefined
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchedUrl = String(input)
    fetchedInit = init
    return jsonResponse(metadata())
  }) as typeof fetch

  const resolved = await resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], fetcher)

  assert.deepEqual(resolved, {
    clientId: CLIENT_ID,
    clientName: 'Hosted Chat',
    redirectUris: [REDIRECT_URI],
  })
  assert.equal(fetchedUrl, CLIENT_ID)
  assert.equal(fetchedInit?.method, 'GET')
  assert.equal(fetchedInit?.redirect, 'manual')
  assert.equal(new Headers(fetchedInit?.headers).get('accept'), 'application/json')
  assert.ok(fetchedInit?.signal instanceof AbortSignal, 'CIMD fetch must have a timeout signal')
})

test('CIMD metadata fetch is aborted after four seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requestSignal: AbortSignal | null | undefined
  const fetcher = ((_: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }) as typeof fetch

  const pending = resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], fetcher)
  assert.equal(requestSignal?.aborted, false)
  t.mock.timers.tick(3_999)
  assert.equal(requestSignal?.aborted, false)
  t.mock.timers.tick(1)

  await assert.rejects(pending, /metadata could not be verified/i)
  assert.equal(requestSignal?.aborted, true)
})

test('unallowlisted, credential-bearing, and fragment-bearing client IDs never fetch', async () => {
  let fetchCount = 0
  const fetcher = (async () => {
    fetchCount += 1
    return jsonResponse(metadata())
  }) as typeof fetch

  const rejectedClientIds = [
    'https://outside.example/client.json',
    'http://chat.example.test/client.json',
    'https://chat.example.test/',
    'https://user@chat.example.test/client.json',
    'https://chat.example.test/client.json#fragment',
    `https://chat.example.test/oauth/${`1f3d9_sk_${'ab'.repeat(24)}`}/client.json`,
  ]
  for (const clientId of rejectedClientIds) {
    await assert.rejects(resolveOAuthClient(clientId, [], [ALLOWED_ORIGIN], fetcher))
  }
  assert.equal(fetchCount, 0)
})

test('CIMD rejects mismatched identity, missing or unsafe redirects, and private auth methods', async () => {
  const rejectedDocuments = [
    metadata({ client_id: undefined }),
    metadata({ client_name: undefined }),
    metadata({ client_id: `${ALLOWED_ORIGIN}/someone-else.json` }),
    metadata({ redirect_uris: undefined }),
    metadata({ redirect_uris: ['http://chat.example.test/callback'] }),
    metadata({ redirect_uris: ['https://user@chat.example.test/callback'] }),
    metadata({ redirect_uris: ['https://chat.example.test/callback#fragment'] }),
    metadata({ token_endpoint_auth_method: 'client_secret_basic' }),
    metadata({ token_endpoint_auth_method: undefined }),
    metadata({
      token_endpoint_auth_method: undefined,
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    }),
    metadata({
      token_endpoint_auth_method: 'none',
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
    }),
    metadata({
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    }),
    metadata({
      token_endpoint_auth_method: 'none',
      token_endpoint_auth_methods_supported: 'none',
    }),
  ]

  for (const document of rejectedDocuments) {
    const fetcher = (async () => jsonResponse(document)) as typeof fetch
    await assert.rejects(resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], fetcher))
  }
})

test('CIMD rejects declared and actual metadata bodies larger than 64 KiB', async () => {
  const declaredTooLarge = (async () => jsonResponse(metadata(), {
    'content-length': '65537',
  })) as typeof fetch
  await assert.rejects(
    resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], declaredTooLarge),
    /too large/i,
  )

  const oversizedBody = JSON.stringify({ padding: 'x'.repeat(65_536) })
  const actualTooLarge = (async () => jsonResponse(oversizedBody)) as typeof fetch
  await assert.rejects(
    resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], actualTooLarge),
    /too large/i,
  )
})

test('an allowlisted public client using no token-endpoint secret succeeds', async () => {
  const fetcher = (async () => jsonResponse(metadata())) as typeof fetch

  const client = await resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], fetcher)

  assert.equal(client.clientId, CLIENT_ID)
  assert.equal(client.clientName, 'Hosted Chat')
  assert.deepEqual(client.redirectUris, [REDIRECT_URI])
})

test('CIMD also accepts ChatGPT-style plural metadata when public exchange is offered', async () => {
  const fetcher = (async () => jsonResponse(metadata({
    token_endpoint_auth_method: undefined,
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  }))) as typeof fetch

  const client = await resolveOAuthClient(CLIENT_ID, [], [ALLOWED_ORIGIN], fetcher)
  assert.equal(client.clientId, CLIENT_ID)
})

test('PUBLIC_ORIGIN and the derived OAuth resource accept only an exact HTTPS origin', () => {
  assert.equal(publicOrigin({}), 'https://1f3d9.com')
  assert.equal(
    publicOrigin({ PUBLIC_ORIGIN: 'https://preview.example.test' }),
    'https://preview.example.test',
  )
  assert.equal(
    oauthResource({ PUBLIC_ORIGIN: 'https://preview.example.test' }),
    'https://preview.example.test/mcp/connect',
  )

  for (const unsafe of [
    'http://preview.example.test',
    'https://user@preview.example.test',
    'https://preview.example.test/path',
    'https://preview.example.test?query=yes',
    'https://preview.example.test/#fragment',
  ]) {
    assert.throws(() => publicOrigin({ PUBLIC_ORIGIN: unsafe }))
    assert.throws(() => oauthResource({ PUBLIC_ORIGIN: unsafe }))
  }

  const resource = oauthResource({ PUBLIC_ORIGIN: 'https://preview.example.test' })
  const request = {
    response_type: 'code',
    client_id: staticClient.clientId,
    redirect_uri: REDIRECT_URI,
    resource,
    scope: 'city:resident',
    state: 'opaque-state',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }
  assert.equal(validateAuthorizationRequest(request, [staticClient], resource).resource, resource)
  assert.throws(() => validateAuthorizationRequest(
    { ...request, resource: 'https://1f3d9.com/mcp/connect' },
    [staticClient],
    resource,
  ))
})
