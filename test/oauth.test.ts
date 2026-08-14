import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_AUTHORIZATION_CODE_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_RESOURCE,
  OAUTH_SCOPE,
  oauthEnabled,
  parseCimdOrigins,
  parseOAuthClients,
  tokenLooksSensitive,
  validateAuthorizationRequest,
  verifyPkceS256,
} from '../src/oauth.ts'

const REDIRECT_URI = 'https://chat.example.test/oauth/callback'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

const clientJson = JSON.stringify([{
  client_id: 'hosted-chat-test',
  client_name: 'Hosted Chat Test',
  redirect_uris: [REDIRECT_URI],
}])

const validRequest = () => ({
  response_type: 'code',
  client_id: 'hosted-chat-test',
  redirect_uri: REDIRECT_URI,
  resource: 'https://1f3d9.com/mcp/connect',
  scope: 'city:resident',
  state: 'opaque-client-state',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
})

test('hosted-chat sign-in is off unless explicitly enabled', () => {
  assert.equal(oauthEnabled({}), false)
  assert.equal(oauthEnabled({ HOSTED_CHAT_SIGNIN_ENABLED: '' }), false)
  assert.equal(oauthEnabled({ HOSTED_CHAT_SIGNIN_ENABLED: 'false' }), false)
  assert.equal(oauthEnabled({ HOSTED_CHAT_SIGNIN_ENABLED: 'true' }), true)
  assert.equal(oauthEnabled({ HOSTED_CHAT_SIGNIN_ENABLED: 'TRUE' }), false)
})

test('the one Release 1 audience and scope stay narrow', () => {
  assert.equal(OAUTH_RESOURCE, 'https://1f3d9.com/mcp/connect')
  assert.equal(OAUTH_SCOPE, 'city:resident')
})

test('static clients have exact HTTPS return addresses and no shared secret', () => {
  const clients = parseOAuthClients(clientJson)

  assert.equal(clients.length, 1)
  assert.deepEqual(clients[0], {
    clientId: 'hosted-chat-test',
    clientName: 'Hosted Chat Test',
    redirectUris: [REDIRECT_URI],
  })

  for (const unsafe of [
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['http://chat.example.test/callback'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['https://*.example.test/callback'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['https://chat.example.test/callback#fragment'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: [REDIRECT_URI], client_secret: 'do-not-store-this' }],
  ]) {
    assert.throws(() => parseOAuthClients(JSON.stringify(unsafe)))
  }
})

test('CIMD fetching is possible only from exact allowlisted HTTPS origins', () => {
  assert.deepEqual(
    parseCimdOrigins(JSON.stringify(['https://chatgpt.com', 'https://claude.ai'])),
    ['https://chatgpt.com', 'https://claude.ai'],
  )

  for (const unsafe of [
    ['http://chatgpt.com'],
    ['https://*.example.com'],
    ['https://example.com/a/path'],
    ['https://user@example.com'],
  ]) {
    assert.throws(() => parseCimdOrigins(JSON.stringify(unsafe)))
  }
})

test('authorization accepts only code flow, exact client details, exact resource, one scope, and PKCE S256', () => {
  const clients = parseOAuthClients(clientJson)

  assert.deepEqual(validateAuthorizationRequest(validRequest(), clients), {
    clientId: 'hosted-chat-test',
    clientName: 'Hosted Chat Test',
    redirectUri: REDIRECT_URI,
    resource: OAUTH_RESOURCE,
    scope: OAUTH_SCOPE,
    state: 'opaque-client-state',
    codeChallenge: CHALLENGE,
  })

  const rejected: Record<string, unknown>[] = [
    { ...validRequest(), response_type: 'token' },
    { ...validRequest(), client_id: 'unknown-client' },
    { ...validRequest(), redirect_uri: `${REDIRECT_URI}/almost` },
    { ...validRequest(), resource: 'https://1f3d9.com' },
    { ...validRequest(), scope: 'city:resident city:admin' },
    { ...validRequest(), code_challenge_method: 'plain' },
    { ...validRequest(), code_challenge: 'too-short' },
    { ...validRequest(), state: '' },
    { ...validRequest(), state: `return-${`1f3d9_sk_${'ab'.repeat(24)}`}` },
  ]
  for (const request of rejected) {
    assert.throws(() => validateAuthorizationRequest(request, clients))
  }
})

test('client configuration cannot smuggle resident credentials into private pages or redirects', () => {
  const rootKey = `1f3d9_sk_${'ab'.repeat(24)}`
  assert.throws(() => parseOAuthClients(JSON.stringify([{
    client_id: 'unsafe-client',
    client_name: `Chat ${rootKey}`,
    redirect_uris: [REDIRECT_URI],
  }])))
  assert.throws(() => parseOAuthClients(JSON.stringify([{
    client_id: 'unsafe-client',
    client_name: 'Unsafe Chat',
    redirect_uris: [`https://chat.example.test/oauth/callback?state=${rootKey}`],
  }])))
})

test('PKCE S256 uses the RFC 7636 verifier calculation and constant-time comparison behavior', () => {
  assert.equal(verifyPkceS256(VERIFIER, CHALLENGE), true)
  assert.equal(verifyPkceS256(`${VERIFIER}x`, CHALLENGE), false)
  assert.equal(verifyPkceS256('short', CHALLENGE), false)
})

test('every credential form is recognized before it can reach chat, public text, or logs', () => {
  assert.match(OAUTH_AUTHORIZATION_CODE_PREFIX, /^1f3d9_/)
  assert.match(OAUTH_ACCESS_TOKEN_PREFIX, /^1f3d9_/)
  assert.match(OAUTH_REFRESH_TOKEN_PREFIX, /^1f3d9_/)

  for (const credential of [
    `1f3d9_sk_${'ab'.repeat(24)}`,
    `${OAUTH_AUTHORIZATION_CODE_PREFIX}${'a'.repeat(48)}`,
    `${OAUTH_ACCESS_TOKEN_PREFIX}${'b'.repeat(48)}`,
    `${OAUTH_REFRESH_TOKEN_PREFIX}${'c'.repeat(48)}`,
  ]) {
    assert.equal(tokenLooksSensitive(credential), true)
    assert.equal(tokenLooksSensitive(`accidental public note: ${credential}`), true)
  }
  assert.equal(tokenLooksSensitive('a resident remembers a lantern'), false)
})
