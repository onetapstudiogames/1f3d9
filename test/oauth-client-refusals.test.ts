import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mountOAuthRoutes, type OAuthDiagnosticRecord } from '../src/oauth.ts'
import { CLIENT_REFUSAL_CHECKS } from '../src/oauth-diagnostics.ts'
import { MemoryOAuthStore } from './oauth-flow-tests/memory-oauth-store.ts'
import { CHALLENGE, RESOURCE, STATE, environment } from './oauth-flow-tests/fixture.ts'

// Decision 189: a refused chat app is told the true kind of reason, and the host log
// names the one check that failed from a closed list, never caller text.

const CHATGPT_ID = 'https://chatgpt.com/oauth/caller-chosen-path-7c1f/client.json'
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector/oauth/caller-chosen-callback-9d2e'
const CLAUDE_ID = 'https://claude.ai/oauth/caller-chosen-claude-metadata'
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata'
const CALLER_TEXT = ['caller-chosen', 'chatgpt.com/oauth', 'chatgpt.com/connector', 'auth_callback',
  'claude-code-client-metadata', 'secret-state-value', 'Document Name Marker']

const TEMPORARY_SENTENCE = "The city could not check this chat app's sign-in details just now. The chat app's own site could not be reached, did not answer in time, or answered with an error. Nothing is wrong with your agent or your key."
const NOT_ACCEPTED_SENTENCE = 'The city does not accept sign-in from this chat app, or from this way of connecting it. Either the app is not one the city knows, or the details it sent do not meet the city&#39;s sign-in rules.'

type Fetcher = typeof fetch

function chatGptDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CHATGPT_ID,
    client_name: 'Document Name Marker',
    redirect_uris: [CHATGPT_CALLBACK],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'],
    ...overrides,
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  })
}

function signinApp(fetcher: Fetcher, records: OAuthDiagnosticRecord[]): Hono {
  const app = new Hono()
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  mountOAuthRoutes(app, {
    environment: {
      ...environment,
      HOSTED_CHAT_CIMD_ORIGINS: JSON.stringify(['https://chatgpt.com', 'https://claude.ai']),
    },
    store: new MemoryOAuthStore().api,
    fetcher,
    diagnostics: record => records.push(record),
  })
  return app
}

function authorizeUrl(clientId: string, redirectUri: string): string {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: RESOURCE,
    scope: 'city:resident',
    state: `${STATE}-secret-state-value`,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  })}`
}

interface Expected {
  check: typeof CLIENT_REFUSAL_CHECKS[number]
  temporary: boolean
  statusClass?: '2xx' | '3xx' | '4xx' | '5xx'
}

async function assertRefusal(
  label: string,
  fetcher: Fetcher,
  expected: Expected,
  clientId = CHATGPT_ID,
  redirectUri = CHATGPT_CALLBACK,
): Promise<void> {
  const records: OAuthDiagnosticRecord[] = []
  const response = await signinApp(fetcher, records).request(authorizeUrl(clientId, redirectUri))
  const body = await response.text()
  const reason = expected.temporary ? 'client_check_unavailable' : 'client_not_approved'
  const status = expected.temporary ? 503 : 400

  assert.equal(response.status, status, label)
  assert.equal(response.headers.get('x-1f3d9-reason'), reason, label)
  assert.equal(response.headers.get('location'), null, label)
  assert.equal(response.headers.get('set-cookie'), null, label)
  const requestId = response.headers.get('x-request-id') ?? ''
  assert.match(requestId, /^[0-9a-f-]{36}$/u, label)
  assert.ok(body.includes(`Request ID: <code>${requestId}</code>`), `${label}: request ID on the page`)
  if (expected.temporary) {
    assert.ok(body.includes(TEMPORARY_SENTENCE.replaceAll("'", '&#39;')), `${label}: temporary sentence`)
    assert.match(body, /Wait a minute, then return to the chat app and start sign-in again\./u, label)
    assert.equal(response.headers.get('retry-after'), '60', label)
    assert.doesNotMatch(body, /not approved|does not accept|href="\/join"/iu, `${label}: no refusal words, no join detour`)
  } else {
    assert.ok(body.includes(NOT_ACCEPTED_SENTENCE), `${label}: not-accepted sentence`)
    assert.match(body, /href="\/setup#oauth-refused"/u, label)
    assert.match(body, /href="\/join"/u, label)
    assert.equal(response.headers.get('retry-after'), null, label)
    assert.doesNotMatch(body, /try again in a minute|Wait a minute/iu, `${label}: a real refusal never invites a retry`)
  }
  for (const text of CALLER_TEXT) assert.equal(body.includes(text), false, `${label}: page leaks ${text}`)

  assert.equal(records.length, 1, label)
  const record = records[0]!
  const serialized = JSON.stringify(record)
  assert.deepEqual(
    Object.keys(record).sort(),
    ['client_origin', 'elapsed_ms', 'error_class', 'event', 'failed_check', 'request_id', 'stage', 'status',
      ...(expected.statusClass ? ['upstream_status_class'] : [])].sort(),
    label,
  )
  assert.equal(record.stage, 'client_metadata', label)
  assert.equal(record.error_class, reason, label)
  assert.equal(record.status, status, label)
  assert.equal(record.failed_check, expected.check, label)
  assert.equal((record as { upstream_status_class?: string }).upstream_status_class, expected.statusClass, label)
  assert.equal(record.request_id, requestId, label)
  for (const text of CALLER_TEXT) assert.equal(serialized.includes(text), false, `${label}: log leaks ${text}`)
}

const neverFetch = (async () => { throw new Error('the city must not fetch for this client') }) as Fetcher
const answer = (response: () => Response) => (async () => response()) as Fetcher

test('every client refusal cause has its own closed log value, status, class and page sentence', async () => {
  const cases: Array<[string, Fetcher, Expected, string?, string?]> = [
    ['not a known or allowlisted client', neverFetch, { check: 'client_unknown', temporary: false },
      'https://outside.example/caller-chosen-client.json', 'https://outside.example/caller-chosen-callback'],
    ['client address with a query', neverFetch, { check: 'client_address_query_or_fragment', temporary: false },
      `${CHATGPT_ID}?caller-chosen=1`],
    ['the chat app site could not be reached', (async () => { throw new TypeError('fetch failed caller-chosen') }) as Fetcher,
      { check: 'metadata_unreachable', temporary: true }],
    ['an abort the city did not cause is not a timeout', (async () => {
      throw Object.assign(new Error('caller-chosen abort'), { name: 'AbortError' })
    }) as Fetcher, { check: 'metadata_unreachable', temporary: true }],
    ['the chat app site answered 503', answer(() => new Response('caller-chosen', { status: 503 })),
      { check: 'metadata_error_status', temporary: true, statusClass: '5xx' }],
    ['the chat app site answered 403', answer(() => new Response('caller-chosen', { status: 403 })),
      { check: 'metadata_error_status', temporary: true, statusClass: '4xx' }],
    ['the chat app site sent a redirect', answer(() => new Response(null, {
      status: 302, headers: { location: 'https://chatgpt.com/caller-chosen' },
    })), { check: 'metadata_redirect', temporary: false, statusClass: '3xx' }],
    ['the document was not JSON', answer(() => new Response('<p>caller-chosen</p>', {
      headers: { 'content-type': 'text/html' },
    })), { check: 'metadata_not_json', temporary: false, statusClass: '2xx' }],
    ['the document was too large', answer(() => json(chatGptDocument(), { headers: { 'content-length': '65537' } })),
      { check: 'metadata_too_large', temporary: false, statusClass: '2xx' }],
    ['the document was invalid JSON', answer(() => json('{"client_id": caller-chosen')),
      { check: 'metadata_invalid_json', temporary: false, statusClass: '2xx' }],
    ['the document names a different client', answer(() => json(chatGptDocument({
      client_id: 'https://chatgpt.com/oauth/caller-chosen-other/client.json',
    }))), { check: 'metadata_identity_mismatch', temporary: false, statusClass: '2xx' }],
    ['no sign-in method stated', answer(() => json(chatGptDocument({
      token_endpoint_auth_method: undefined, token_endpoint_auth_methods_supported: undefined,
    }))), { check: 'auth_method_missing', temporary: false, statusClass: '2xx' }],
    ['an unsupported sign-in method', answer(() => json(chatGptDocument({
      token_endpoint_auth_method: 'client_secret_basic',
    }))), { check: 'auth_method_unsupported', temporary: false, statusClass: '2xx' }],
    ['no public PKCE exchange', answer(() => json(chatGptDocument({
      token_endpoint_auth_method: undefined, token_endpoint_auth_methods_supported: ['private_key_jwt'],
    }))), { check: 'public_pkce_missing', temporary: false, statusClass: '2xx' }],
    ['a missing name', answer(() => json(chatGptDocument({ client_name: undefined }))),
      { check: 'client_name_invalid', temporary: false, statusClass: '2xx' }],
    ['an over-long name', answer(() => json(chatGptDocument({ client_name: 'n'.repeat(241) }))),
      { check: 'client_name_invalid', temporary: false, statusClass: '2xx' }],
    ['a callback that is not exact https', answer(() => json(chatGptDocument({
      redirect_uris: ['http://chatgpt.com/caller-chosen-callback'],
    }))), { check: 'callback_invalid', temporary: false, statusClass: '2xx' }],
    ['the Claude Code loopback rule', answer(() => json({
      client_id: CLAUDE_CODE_ID, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
    })), { check: 'claude_code_callbacks_mismatch', temporary: false, statusClass: '2xx' },
    CLAUDE_CODE_ID, 'http://127.0.0.1:54123/callback'],
  ]
  const seen = new Set<string>(['metadata_timeout'])
  for (const [label, fetcher, expected, clientId, redirectUri] of cases) {
    await assertRefusal(label, fetcher, expected, clientId, redirectUri)
    seen.add(expected.check)
  }
  assert.deepEqual([...seen].sort(), CLIENT_REFUSAL_CHECKS.filter(check => check !== 'gemini_client_unrecognized').sort())
})

test('a chat app site that does not answer within four seconds is a temporary failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let started!: () => void
  const fetching = new Promise<void>(resolve => { started = resolve })
  const fetcher = ((_: string | URL | Request, init?: RequestInit) => {
    started()
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller-chosen abort')), { once: true })
    })
  }) as Fetcher
  const records: OAuthDiagnosticRecord[] = []
  const pending = signinApp(fetcher, records).request(authorizeUrl(CHATGPT_ID, CHATGPT_CALLBACK))
  await fetching
  t.mock.timers.tick(4_000)
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'client_check_unavailable')
  assert.ok((await response.text()).includes(TEMPORARY_SENTENCE.replaceAll("'", '&#39;')))
  assert.equal(records.length, 1)
  assert.equal(records[0]?.failed_check, 'metadata_timeout')
  assert.equal(records[0]?.error_class, 'client_check_unavailable')
  assert.equal('upstream_status_class' in records[0]!, false)
})

test('an unrecognised Gemini client is a real refusal with its own closed log value', async () => {
  const records: OAuthDiagnosticRecord[] = []
  const app = signinApp(neverFetch, records)
  const response = await app.request(authorizeUrl(`gemini.v1.${'A'.repeat(20)}.${'B'.repeat(43)}`, 'https://gemini.google.com/caller-chosen'))
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'client_not_approved')
  assert.ok((await response.text()).includes(NOT_ACCEPTED_SENTENCE))
  assert.equal(records.length, 1)
  assert.equal(records[0]?.failed_check, 'gemini_client_unrecognized')
  assert.equal(records[0]?.error_class, 'client_not_approved')
  assert.doesNotMatch(JSON.stringify(records), /caller-chosen|gemini\.v1/u)
})

test('a normal ChatGPT document and a normal claude.ai document are still accepted', async () => {
  for (const [clientId, redirectUri, document] of [
    [CHATGPT_ID, CHATGPT_CALLBACK, chatGptDocument()],
    [CLAUDE_ID, CLAUDE_CALLBACK, {
      client_id: CLAUDE_ID, client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none',
    }],
  ] as const) {
    const records: OAuthDiagnosticRecord[] = []
    const fetcher = (async (input: string | URL | Request) => {
      assert.equal(String(input), clientId)
      return json(document)
    }) as Fetcher
    const response = await signinApp(fetcher, records).request(authorizeUrl(clientId, redirectUri))
    assert.equal(response.status, 200, clientId)
    assert.match(await response.text(), /Let this chat enter 1F3D9\?/u)
    assert.deepEqual(records, [])
  }
})
