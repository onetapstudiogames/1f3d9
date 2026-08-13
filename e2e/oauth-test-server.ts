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

const port = Number(process.env.E2E_PORT ?? 41_739)
const origin = `https://127.0.0.1:${port}`
const callbackUri = `${origin}/oauth/callback`
const existingResidentKey = `1f3d9_sk_${'ab'.repeat(24)}`

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
mountOAuthRoutes(app, { environment, store })
setOAuthResidentResolver(token => residentByOAuthAccessToken(token, environment, store))

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
