import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import {
  auth,
  setOAuthResidentResolver,
  sha256,
  type Resident,
} from '../src/core.ts'
import { mcp } from '../src/mcp.ts'
import {
  mountOAuthRoutes,
  oauthChallenge,
  residentByOAuthAccessToken,
  type OAuthRouteOptions,
} from '../src/oauth.ts'
import type {
  AuthorizationCodeRecord,
  AuthorizationRequestInput,
  AuthorizationRequestRecord,
} from '../src/oauth-store.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

const port = Number(process.env.E2E_PORT ?? 41_739)
const origin = `https://127.0.0.1:${port}`
const callbackUri = `https://localhost:${port}/oauth/callback`
const existingResidentKey = `1f3d9_sk_${'ab'.repeat(24)}`
const placeDescription = 'A quiet test square with a brass observatory window.'
const noteExcerpt = 'The public note begins here'
const noteFull = `${noteExcerpt}, then continues beyond the snapshot excerpt.`
const thingExcerpt = 'A lantern with an abbreviated inscription'
const thingFull = `${thingExcerpt}; the complete inscription is readable without signing in.`

const publicWindowFixture = Object.freeze({
  places: [{
    id: 11,
    parent_id: null,
    name: 'test_square',
    description: placeDescription,
    owner: 'browser-resident',
    places: 0,
    things: 1,
    notes: 1,
    moderated: false,
    children: [],
  }, {
    id: 12,
    parent_id: null,
    name: 'side_room',
    description: 'A second room used to prove global conversation order.',
    owner: 'oldwalker',
    places: 0,
    things: 0,
    notes: 1,
    moderated: false,
    children: [],
  }],
  residents: [{
    id: 49,
    handle: 'browser-resident',
    current_place_id: 11,
    joined_at: '2026-08-13T17:00:00.000Z',
  }],
  notes: [{
    id: 303,
    place_id: 11,
    author: 'browser-resident',
    body: 'Newest in test square',
    created_at: '2026-08-13T19:05:00.000Z',
    moderated: false,
  }, {
    id: 302,
    place_id: 12,
    author: 'oldwalker',
    body: 'Middle in side room',
    created_at: '2026-08-13T19:04:00.000Z',
    moderated: false,
  }, {
    id: 301,
    place_id: 11,
    author: 'browser-resident',
    body: noteExcerpt,
    created_at: '2026-08-13T19:03:00.000Z',
    moderated: false,
    truncated: true,
  }],
  things: [{
    id: 401,
    place_id: 11,
    name: 'field_lantern',
    body: thingExcerpt,
    owner: 'browser-resident',
    kind: 'artifact',
    traits: ['bright'],
    created_at: '2026-08-13T19:02:00.000Z',
    moderated: false,
    kind_moderated: false,
    truncated: true,
  }],
  agreements: [{
    id: 601,
    body: 'A public agreement opened by its author.',
    created_by: 'browser-resident',
    parties: ['browser-resident', 'oldwalker', 'late-signer'],
    acceded: ['late-signer'],
    signatures: ['browser-resident', 'late-signer'],
    open: true,
    accession_open: true,
    party_count: 35,
    parties_truncated: true,
    created_at: '2026-08-13T19:01:00.000Z',
    moderated: false,
  }, {
    id: 600,
    body: 'An older agreement that remains closed.',
    created_by: 'browser-resident',
    parties: ['browser-resident'],
    acceded: [],
    signatures: [],
    open: true,
    accession_open: false,
    party_count: 1,
    parties_truncated: false,
    created_at: '2026-08-13T19:00:00.000Z',
    moderated: false,
  }],
  events: [{
    id: 503,
    at: '2026-08-13T19:03:00.000Z',
    kind: 'note',
    actor: 'browser-resident',
    detail: { place_id: 11, note_id: 301 },
  }, {
    id: 502,
    at: '2026-08-13T19:02:00.000Z',
    kind: 'thing_created',
    actor: 'browser-resident',
    detail: { place_id: 11, thing_id: 401 },
  }],
  totals: {
    places: 2,
    residents: 1,
    conversations: 3,
    things: 1,
    agreements: 2,
    events: 4,
  },
  body_limits: { notes: 2_000, things: 1_000, agreements: 4_000 },
  refreshed_at: '2026-08-13T19:04:00.000Z',
})

const olderPublicEvents = Object.freeze([{
  id: 501,
  at: '2026-08-13T19:01:00.000Z',
  kind: 'place_edited',
  actor: 'oldwalker',
  detail: { place_id: 11 },
}, {
  id: 500,
  at: '2026-08-13T19:00:00.000Z',
  kind: 'home_set',
  actor: 'oldwalker',
  detail: { place_id: 11 },
}])

interface PublicWindowObservationState {
  readonly write_requests: ReadonlyArray<{ readonly method: string; readonly path: string }>
  readonly detail_requests: ReadonlyArray<{
    readonly path: string
    readonly has_authorization: boolean
    readonly has_cookie: boolean
  }>
  readonly event_queries: ReadonlyArray<{ readonly before_id: number; readonly limit: number }>
}

let publicWindowObservations: PublicWindowObservationState = {
  write_requests: [],
  detail_requests: [],
  event_queries: [],
}

interface StoredRequest extends AuthorizationRequestRecord {
  readonly sessionHash: string
  readonly csrfHash: string
  readonly newSecretHash: string | null
  readonly used: boolean
}

interface StoredCode extends AuthorizationCodeRecord {
  readonly used: boolean
}

interface StoredAccessGrant {
  readonly residentId: number
  readonly resource: string
  readonly scope: string
}

type OAuthStore = NonNullable<OAuthRouteOptions['store']>

function makeMemoryStore(): OAuthStore {
  const requests = new Map<string, StoredRequest>()
  const codes = new Map<string, StoredCode>()
  const accessGrants = new Map<string, StoredAccessGrant>()
  const residents = new Map<number, Resident>([[49, {
    id: 49,
    handle: 'browser-resident',
    model: 'browser-test-model',
    joined_at: '2026-08-13T00:00:00.000Z',
    quota_day: '2026-08-13',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  }]])
  let nextRequestId = 1
  let nextResidentId = 100

  const eligible = (sessionHash: string, csrfHash: string): StoredRequest | null => {
    const request = requests.get(sessionHash)
    if (!request || request.used || request.csrfHash !== csrfHash) return null
    return request
  }

  return {
    createAuthorizationRequest: async (input: AuthorizationRequestInput) => {
      const record: StoredRequest = {
        id: nextRequestId++,
        client_id: input.clientId,
        client_display_name: input.clientName,
        redirect_uri: input.redirectUri,
        resource: input.resource,
        scope: input.scope,
        state: input.state,
        code_challenge: input.codeChallenge,
        intent: null,
        resident_id: null,
        new_handle: null,
        new_model: null,
        root_key_confirmed_at: null,
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        newSecretHash: null,
        used: false,
      }
      requests.set(input.sessionHash, record)
    },

    getAuthorizationRequest: async sessionHash => {
      const request = requests.get(sessionHash)
      return request?.used ? null : (request ?? null)
    },

    cancelAuthorizationRequest: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.resident_id !== null) return null
      requests.set(input.sessionHash, {
        ...request,
        intent: null,
        new_handle: null,
        new_model: null,
        newSecretHash: null,
        used: true,
      })
      return { redirectUri: request.redirect_uri, state: request.state }
    },

    approveExistingResidentAndIssueAuthorizationCode: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.intent !== null) return null
      if (input.residentSecretHash !== sha256(existingResidentKey)) return null
      requests.set(input.sessionHash, {
        ...request,
        intent: 'existing',
        resident_id: 49,
        used: true,
      })
      codes.set(input.authorizationCodeHash, {
        residentId: 49,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        used: false,
      })
      return { redirectUri: request.redirect_uri, state: request.state }
    },

    stageNewResidentRegistration: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.intent !== null || request.resident_id !== null) return null
      const handleTaken = [...residents.values()].some(resident => resident.handle === input.handle)
      if (handleTaken) return { status: 'handle_taken' }
      requests.set(input.sessionHash, {
        ...request,
        intent: 'new',
        new_handle: input.handle,
        new_model: input.model,
        newSecretHash: input.residentSecretHash,
      })
      return { status: 'staged', handle: input.handle }
    },

    confirmNewResidentAndIssueAuthorizationCode: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (
        !request || request.intent !== 'new' || request.resident_id !== null ||
        request.new_handle === null || request.new_model === null || request.newSecretHash === null
      ) return null
      if ([...residents.values()].some(resident => resident.handle === request.new_handle)) return null
      const residentId = nextResidentId++
      residents.set(residentId, {
        id: residentId,
        handle: request.new_handle,
        model: request.new_model,
        joined_at: '2026-08-13T00:00:00.000Z',
        quota_day: '2026-08-13',
        things_today: 0,
        notes_today: 0,
        agreement_actions_today: 0,
      })
      requests.set(input.sessionHash, {
        ...request,
        resident_id: residentId,
        newSecretHash: null,
        root_key_confirmed_at: new Date().toISOString(),
        used: true,
      })
      codes.set(input.authorizationCodeHash, {
        residentId,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        used: false,
      })
      return { redirectUri: request.redirect_uri, state: request.state }
    },

    getAuthorizationCode: async codeHash => {
      const code = codes.get(codeHash)
      return code?.used ? null : (code ?? null)
    },

    exchangeAuthorizationCode: async input => {
      const code = codes.get(input.codeHash)
      if (
        !code || code.used || code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri || code.resource !== input.resource
      ) return false
      if (!residents.has(code.residentId)) return false
      codes.set(input.codeHash, { ...code, used: true })
      accessGrants.set(input.accessTokenHash, {
        residentId: code.residentId,
        resource: code.resource,
        scope: code.scope,
      })
      return true
    },

    rotateRefreshToken: async () => 'invalid',
    revokeTokenFamilyByToken: async () => undefined,
    resolveOAuthAccessToken: async input => {
      const grant = accessGrants.get(input.accessTokenHash)
      if (!grant || grant.resource !== input.resource || grant.scope !== input.scope) return null
      const resident = residents.get(grant.residentId)
      return resident ? { ...resident } : null
    },
    consumeOAuthRateLimit: async () => true,
  }
}

function makeCertificate(): { key: string; cert: string } {
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '-',
    '-out', '-',
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { encoding: 'utf8' })
  if (generated.status !== 0) {
    throw new Error(`Could not create the disposable E2E certificate: ${generated.stderr}`)
  }
  const key = generated.stdout.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/,
  )?.[0]
  const cert = generated.stdout.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  )?.[0]
  if (!key || !cert) throw new Error('OpenSSL returned an incomplete disposable E2E certificate')
  return { key, cert }
}

const environment = {
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  PUBLIC_ORIGIN: origin,
  HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
    client_id: 'browser-e2e-client',
    client_name: 'Hosted Chat Browser Test',
    redirect_uris: [callbackUri],
  }]),
}

process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
process.env.PUBLIC_ORIGIN = origin

const app = new Hono()
const store = makeMemoryStore()
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    publicWindowObservations = {
      ...publicWindowObservations,
      write_requests: [...publicWindowObservations.write_requests, {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      }],
    }
  }
  await next()
})
mountOAuthRoutes(app, { environment, store })
setOAuthResidentResolver(token => residentByOAuthAccessToken(token, environment, store))

app.get('/window', c => c.html(WINDOW_HTML))
app.get('/window.css', c => {
  c.header('Content-Type', 'text/css; charset=utf-8')
  return c.body(WINDOW_CSS)
})
app.get('/window.js', c => {
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  return c.body(WINDOW_JS)
})
app.get('/api/window', c => c.json(publicWindowFixture))
app.get('/api/thing/:id', c => {
  if (c.req.param('id') !== '401') return c.json({ error: 'thing not found' }, 404)
  const path = new URL(c.req.url).pathname
  publicWindowObservations = {
    ...publicWindowObservations,
    detail_requests: [...publicWindowObservations.detail_requests, {
      path,
      has_authorization: Boolean(c.req.header('authorization')),
      has_cookie: Boolean(c.req.header('cookie')),
    }],
  }
  return c.json({ thing: { id: 401, body: thingFull } })
})
app.get('/api/note/:id', c => {
  if (c.req.param('id') !== '301') return c.json({ error: 'note not found' }, 404)
  const path = new URL(c.req.url).pathname
  publicWindowObservations = {
    ...publicWindowObservations,
    detail_requests: [...publicWindowObservations.detail_requests, {
      path,
      has_authorization: Boolean(c.req.header('authorization')),
      has_cookie: Boolean(c.req.header('cookie')),
    }],
  }
  return c.json({ note: { id: 301, body: noteFull } })
})
app.get('/api/events', c => {
  const beforeId = Number(c.req.query('before_id'))
  const limit = Number(c.req.query('limit'))
  publicWindowObservations = {
    ...publicWindowObservations,
    event_queries: [...publicWindowObservations.event_queries, { before_id: beforeId, limit }],
  }
  if (beforeId !== 502 || limit !== 100) {
    return c.json({ error: 'unexpected deterministic pagination request' }, 400)
  }
  return c.json({ events: olderPublicEvents, has_more: false, next_before_id: null })
})
app.get('/__e2e/public-window-state', c => c.json(publicWindowObservations))

app.get('/api/me', async c => {
  const resident = await auth(c)
  if (!resident) return c.json({ error: 'bad or missing bearer secret' }, 401)
  return c.json({
    resident_id: resident.id,
    handle: resident.handle,
    model: resident.model,
    protected: true,
  })
})

app.post('/mcp', c => mcp(c, app))
app.post('/mcp/connect', async c => {
  const response = await mcp(c, app, { hostedChat: true, forwardUnauthorizedStatus: true })
  if (response.status === 401 && !response.headers.get('WWW-Authenticate')) {
    response.headers.set('WWW-Authenticate', oauthChallenge(environment))
  }
  return response
})
app.get('/oauth/callback', c => c.html(
  '<!doctype html><html><body><h1>Chat callback reached</h1><p>The chat app received its one-use sign-in code.</p></body></html>',
))
app.get('/__e2e/health', c => c.json({ ok: true, run: randomUUID() }))

const certificate = makeCertificate()
const server = createServer(
  { key: certificate.key, cert: certificate.cert },
  getRequestListener(app.fetch),
)
server.listen(port, '127.0.0.1')

const stop = () => {
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
