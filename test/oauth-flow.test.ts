import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { auth, setOAuthResidentResolver, sha256, type Resident } from '../src/core.ts'
import { mcp } from '../src/mcp.ts'
import {
  collectRecoveryCodeSet,
  mountOAuthRoutes,
  residentByOAuthAccessToken,
  type OAuthDiagnosticRecord,
} from '../src/oauth.ts'
import type {
  AuthorizationCodeRecord,
  AuthorizationRequestInput,
  AuthorizationRequestRecord,
  OAuthRateLimitResult,
} from '../src/oauth-store.ts'
import { PAIRING_CODE_PREFIX } from '../src/pair.ts'

type OAuthStore = typeof import('../src/oauth-store.ts').postgresOAuthStore
type TestOAuthStore = OAuthStore & {
  cancelAuthorizationRequest(input: {
    sessionHash: string
    csrfHash: string
  }): Promise<{ redirectUri: string; state: string } | null>
}

const ORIGIN = 'https://1f3d9.com'
const RESOURCE = `${ORIGIN}/mcp/connect`
const CLIENT_ID = 'hosted-chat-flow-test'
const CALLBACK = 'https://chat.example.test/oauth/callback'
const STATE = 'client-state-that-must-survive'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const EXISTING_KEY = `1f3d9_sk_${'ab'.repeat(24)}`
const RECOVERY_CODE_HASH = /^[0-9a-f]{64}$/

function rateLimitResult(admitted: boolean, retryAfterSeconds = 17): OAuthRateLimitResult {
  return { admitted, retryAfterSeconds }
}

function validRecoveryCodeHashes(hashes: readonly string[]): boolean {
  return hashes.length === 8 &&
    new Set(hashes).size === 8 &&
    hashes.every(hash => RECOVERY_CODE_HASH.test(hash))
}

function requireRecoveryCodeHashes(hashes: readonly string[]): void {
  if (!validRecoveryCodeHashes(hashes)) {
    throw new Error('exactly eight unique recovery-code hashes are required')
  }
}

function assertSecretsAbsent(surface: string, secrets: readonly string[]): void {
  for (const secret of secrets) assert.equal(surface.includes(secret), false)
}

const environment = {
  PUBLIC_ORIGIN: ORIGIN,
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
    client_id: CLIENT_ID,
    client_name: 'Hosted Chat Flow Test',
    redirect_uris: [CALLBACK],
  }]),
  HOSTED_CHAT_CIMD_ORIGINS: '',
} as const

interface MemoryAuthorizationRequest extends AuthorizationRequestRecord {
  sessionHash: string
  csrfHash: string
  pendingSecretHash: string | null
  pendingRecoveryCodeHashes: string[] | null
  expiresAt: number
  used: boolean
}

interface MemoryAuthorizationCode extends AuthorizationCodeRecord {
  codeHash: string
  expiresAt: number
  used: boolean
}

interface MemoryFamily {
  id: number
  residentId: number
  clientId: string
  resource: string
  scope: string
  expiresAt: number
  revoked: boolean
}

interface MemoryToken {
  tokenHash: string
  tokenType: 'access' | 'refresh'
  familyId: number
  expiresAt: number
  used: boolean
  revoked: boolean
}

const existingResident = (): Resident => ({
  id: 49,
  handle: 'chatty',
  model: 'hosted-chat',
  joined_at: '2026-08-13T00:00:00.000Z',
  quota_day: '2026-08-13',
  things_today: 0,
  notes_today: 0,
  agreement_actions_today: 0,
})

interface MemoryPairingCode {
  residentId: number
  expiresAt: number
  usedAt: number | null
}

class MemoryOAuthStore {
  private readonly requests = new Map<string, MemoryAuthorizationRequest>()
  private readonly codes = new Map<string, MemoryAuthorizationCode>()
  private readonly families = new Map<number, MemoryFamily>()
  private readonly tokens = new Map<string, MemoryToken>()
  private readonly residents = new Map<number, Resident>([[49, existingResident()]])
  private readonly residentSecretHashes = new Map<string, number>([[sha256(EXISTING_KEY), 49]])
  private readonly recoveryCodes = new Map<number, string[]>()
  private readonly pairingCodes = new Map<string, MemoryPairingCode>()
  private readonly events: { kind: string; actor: string; residentId: number }[] = []
  private nextRequestId = 1
  private nextResidentId = 50
  private nextFamilyId = 1
  private duplicateHandleRollbacks = 0
  private readonly refreshRotations = new Set<string>()

  readonly api = {
    createAuthorizationRequest: async (input: AuthorizationRequestInput): Promise<void> => {
      for (const pending of this.requests.values()) {
        if (
          pending.resident_id === null && !pending.used && pending.expiresAt <= Date.now() &&
          (pending.intent !== null || pending.new_handle !== null || pending.new_model !== null ||
            pending.pendingSecretHash !== null || pending.pendingRecoveryCodeHashes !== null)
        ) {
          pending.used = true
          pending.intent = null
          pending.new_handle = null
          pending.new_model = null
          pending.pendingSecretHash = null
          pending.pendingRecoveryCodeHashes = null
        }
      }
      this.requests.set(input.sessionHash, {
        id: this.nextRequestId++,
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
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
        pendingSecretHash: null,
        pendingRecoveryCodeHashes: null,
        expiresAt: Date.now() + 15 * 60_000,
        used: false,
      })
    },

    getAuthorizationRequest: async (
      sessionHash: string,
    ): Promise<AuthorizationRequestRecord | null> => {
      const request = this.validRequest(sessionHash)
      return request ? { ...request } : null
    },

    getAuthorizationRequestProgress: async (input: {
      sessionHash: string
      csrfHash: string
    }) => {
      const request = this.requests.get(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) return null
      const requestRecord: AuthorizationRequestRecord = { ...request }
      if (
        request.used && request.resident_id !== null &&
        request.root_key_confirmed_at !== null
      ) {
        const resident = this.residents.get(request.resident_id)
        return resident
          ? { status: 'confirmed' as const, request: requestRecord, residentId: resident.id, handle: resident.handle }
          : { status: 'unavailable' as const, request: requestRecord }
      }
      if (request.resident_id === null && request.expiresAt <= Date.now()) {
        return { status: 'expired' as const, request: requestRecord }
      }
      if (request.used && request.resident_id === null) {
        return { status: 'canceled' as const, request: requestRecord }
      }
      return { status: 'unavailable' as const, request: requestRecord }
    },

    approveExistingResidentAndIssueAuthorizationCode: async (
      input: Parameters<OAuthStore['approveExistingResidentAndIssueAuthorizationCode']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      const residentId = this.residentSecretHashes.get(input.residentSecretHash)
      if (
        !request || request.csrfHash !== input.csrfHash || request.intent !== null ||
        request.resident_id !== null || residentId === undefined
      ) {
        if (!request || request.csrfHash !== input.csrfHash || request.used) {
          return { status: 'request_unavailable' as const }
        }
        return { status: 'resident_key_rejected' as const }
      }
      const resident = this.residents.get(residentId)
      if (!resident) return { status: 'resident_key_rejected' as const }
      request.intent = 'existing'
      request.resident_id = resident.id
      request.used = true
      this.codes.set(input.authorizationCodeHash, {
        codeHash: input.authorizationCodeHash,
        residentId: resident.id,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      })
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
    },

    stageNewResidentRegistration: async (
      input: Parameters<OAuthStore['stageNewResidentRegistration']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      if (
        !request || request.csrfHash !== input.csrfHash || request.intent !== null ||
        request.resident_id !== null
      ) return { status: 'request_unavailable' as const }
      if ([...this.residents.values()].some(resident => resident.handle === input.handle)) {
        return { status: 'handle_taken' as const }
      }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      request.intent = 'new'
      request.new_handle = input.handle
      request.new_model = input.model
      request.pendingSecretHash = input.residentSecretHash
      request.pendingRecoveryCodeHashes = [...input.recoveryCodeHashes]
      return { status: 'staged' as const, handle: input.handle }
    },

    cancelAuthorizationRequest: async (input: {
      sessionHash: string
      csrfHash: string
    }) => {
      const request = this.validRequest(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash || request.resident_id !== null) return null
      request.used = true
      request.intent = null
      request.new_handle = null
      request.new_model = null
      request.pendingSecretHash = null
      request.pendingRecoveryCodeHashes = null
      return { redirectUri: request.redirect_uri, state: request.state }
    },

    confirmNewResidentAndIssueAuthorizationCode: async (
      input: Parameters<OAuthStore['confirmNewResidentAndIssueAuthorizationCode']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      if (
        !request || request.csrfHash !== input.csrfHash || request.intent !== 'new' ||
        request.resident_id !== null || request.new_handle === null || request.new_model === null ||
        request.pendingSecretHash === null ||
        request.root_key_confirmed_at !== null || request.pendingRecoveryCodeHashes === null ||
        !validRecoveryCodeHashes(request.pendingRecoveryCodeHashes)
      ) return { status: 'request_unavailable' as const }
      if (request.pendingSecretHash !== input.residentSecretHash) {
        return { status: 'confirmation_rejected' as const }
      }
      const allocatedResidentId = this.nextResidentId++
      if ([...this.residents.values()].some(resident => resident.handle === request.new_handle)) {
        // Mirror PostgreSQL statement rollback: the allocator update happens before
        // the unique-handle insert fails, then the whole statement is restored.
        this.nextResidentId = allocatedResidentId
        this.duplicateHandleRollbacks++
        request.used = true
        request.intent = null
        request.new_handle = null
        request.new_model = null
        request.pendingSecretHash = null
        request.pendingRecoveryCodeHashes = null
        return { status: 'handle_taken' as const }
      }
      const resident: Resident = {
        id: allocatedResidentId,
        handle: request.new_handle,
        model: request.new_model,
        joined_at: '2026-08-13T00:00:00.000Z',
        quota_day: '2026-08-13',
        things_today: 0,
        notes_today: 0,
        agreement_actions_today: 0,
      }
      this.residents.set(resident.id, resident)
      this.residentSecretHashes.set(request.pendingSecretHash, resident.id)
      this.recoveryCodes.set(resident.id, [...request.pendingRecoveryCodeHashes])
      this.events.push({ kind: 'register', actor: resident.handle, residentId: resident.id })
      request.resident_id = resident.id
      request.pendingSecretHash = null
      request.pendingRecoveryCodeHashes = null
      const residentId = request.resident_id
      request.used = true
      request.root_key_confirmed_at = new Date().toISOString()
      this.codes.set(input.authorizationCodeHash, {
        codeHash: input.authorizationCodeHash,
        residentId,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      })
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
    },

    getAuthorizationCode: async (codeHash: string): Promise<AuthorizationCodeRecord | null> => {
      const code = this.codes.get(codeHash)
      return code && !code.used && code.expiresAt > Date.now() ? { ...code } : null
    },

    exchangeAuthorizationCode: async (
      input: Parameters<OAuthStore['exchangeAuthorizationCode']>[0],
    ): Promise<boolean> => {
      const code = this.codes.get(input.codeHash)
      if (
        !code || code.used || code.expiresAt <= Date.now() || code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri || code.resource !== input.resource
      ) return false
      code.used = true
      const family: MemoryFamily = {
        id: this.nextFamilyId++,
        residentId: code.residentId,
        clientId: code.clientId,
        resource: code.resource,
        scope: code.scope,
        expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
        revoked: false,
      }
      this.families.set(family.id, family)
      this.addToken(input.accessTokenHash, 'access', family.id, Date.now() + 10 * 60_000)
      this.addToken(input.refreshTokenHash, 'refresh', family.id, family.expiresAt)
      return true
    },

    rotateRefreshToken: async (
      input: Parameters<OAuthStore['rotateRefreshToken']>[0],
    ) => {
      const rotationKey = input.presentedRefreshTokenHash
      if (this.refreshRotations.has(rotationKey)) return 'overlapping' as const
      this.refreshRotations.add(rotationKey)
      try {
        await Promise.resolve()
        const token = this.tokens.get(rotationKey)
        const family = token ? this.families.get(token.familyId) : undefined
        if (
          token?.tokenType === 'refresh' && token.used && family &&
          family.clientId === input.clientId && family.resource === input.resource
        ) {
          this.revokeFamily(family.id)
          return 'reused' as const
        }
        if (
          !token || token.tokenType !== 'refresh' || token.used || token.revoked ||
          token.expiresAt <= Date.now() || !family || family.revoked ||
          family.expiresAt <= Date.now() || family.clientId !== input.clientId ||
          family.resource !== input.resource
        ) return 'invalid' as const
        token.used = true
        this.addToken(input.accessTokenHash, 'access', family.id, Date.now() + 10 * 60_000)
        this.addToken(input.newRefreshTokenHash, 'refresh', family.id, family.expiresAt)
        return 'rotated' as const
      } finally {
        this.refreshRotations.delete(rotationKey)
      }
    },

    resolveRefreshRateLimitSubject: async (
      input: Parameters<OAuthStore['resolveRefreshRateLimitSubject']>[0],
    ) => {
      const token = this.tokens.get(input.presentedRefreshTokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (
        !token || token.tokenType !== 'refresh' || !family ||
        family.clientId !== input.clientId || family.resource !== input.resource
      ) return { status: 'junk' as const }
      if (token.used && !family.revoked && family.expiresAt > Date.now()) {
        return { status: 'reused' as const }
      }
      if (
        token.used || token.revoked || token.expiresAt <= Date.now() ||
        family.revoked || family.expiresAt <= Date.now()
      ) return { status: 'junk' as const }
      return { status: 'active' as const, connectionKey: String(family.id) }
    },

    revokeTokenFamilyByToken: async (
      input: Parameters<OAuthStore['revokeTokenFamilyByToken']>[0],
    ): Promise<void> => {
      const token = this.tokens.get(input.tokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (family?.clientId === input.clientId) this.revokeFamily(family.id)
    },

    resolveOAuthAccessToken: async (
      input: Parameters<OAuthStore['resolveOAuthAccessToken']>[0],
    ): Promise<Resident | null> => {
      const token = this.tokens.get(input.accessTokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (
        !token || token.tokenType !== 'access' || token.used || token.revoked ||
        token.expiresAt <= Date.now() || !family || family.revoked ||
        family.expiresAt <= Date.now() || family.resource !== input.resource ||
        family.scope !== input.scope
      ) return null
      return this.residents.get(family.residentId) ?? null
    },

    consumeOAuthRateLimit: async (
      _input: Parameters<OAuthStore['consumeOAuthRateLimit']>[0],
    ): Promise<OAuthRateLimitResult> => rateLimitResult(true),

    mintPairingCode: async (
      input: Parameters<OAuthStore['mintPairingCode']>[0],
    ) => {
      const expiresAt = Date.now() + 10 * 60_000
      this.pairingCodes.set(input.codeHash, {
        residentId: input.residentId,
        expiresAt,
        usedAt: null,
      })
      return { expiresAt: new Date(expiresAt).toISOString() }
    },

    approveExistingResidentByPairingCodeAndIssueAuthorizationCode: async (
      input: Parameters<OAuthStore['approveExistingResidentByPairingCodeAndIssueAuthorizationCode']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      const pairing = this.pairingCodes.get(input.pairingCodeHash)
      const codeValid = pairing && pairing.usedAt === null && pairing.expiresAt > Date.now()
      if (
        !request || request.csrfHash !== input.csrfHash || request.intent !== null ||
        request.resident_id !== null || !codeValid
      ) {
        if (!request || request.csrfHash !== input.csrfHash || request.used) {
          return { status: 'request_unavailable' as const }
        }
        return { status: 'pairing_code_rejected' as const }
      }
      const resident = this.residents.get(pairing.residentId)
      if (!resident) return { status: 'pairing_code_rejected' as const }
      pairing.usedAt = Date.now()
      request.intent = 'existing'
      request.resident_id = resident.id
      request.used = true
      this.codes.set(input.authorizationCodeHash, {
        codeHash: input.authorizationCodeHash,
        residentId: resident.id,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      })
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
    },
  } satisfies TestOAuthStore

  expirePairingCode(codeHash: string): void {
    const pairing = this.pairingCodes.get(codeHash)
    if (pairing) pairing.expiresAt = Date.now() - 1
  }

  expireBrowserSession(rawSession: string): void {
    const request = this.requests.get(sha256(rawSession))
    if (request) request.expiresAt = Date.now() - 1
  }

  expireAuthorizationCode(rawCode: string): void {
    const code = this.codes.get(sha256(rawCode))
    if (code) code.expiresAt = Date.now() - 1
  }

  safeState(): string {
    return JSON.stringify({
      requests: [...this.requests.values()],
      codes: [...this.codes.values()],
      families: [...this.families.values()],
      tokens: [...this.tokens.values()],
      residents: [...this.residents.values()],
      residentSecretHashes: [...this.residentSecretHashes.entries()],
      recoveryCodes: [...this.recoveryCodes.entries()],
      events: [...this.events],
      nextResidentId: this.nextResidentId,
      duplicateHandleRollbacks: this.duplicateHandleRollbacks,
    })
  }

  private validRequest(sessionHash: string): MemoryAuthorizationRequest | null {
    const request = this.requests.get(sessionHash)
    return request && !request.used && request.expiresAt > Date.now() ? request : null
  }

  private addToken(
    tokenHash: string,
    tokenType: MemoryToken['tokenType'],
    familyId: number,
    expiresAt: number,
  ): void {
    this.tokens.set(tokenHash, {
      tokenHash,
      tokenType,
      familyId,
      expiresAt,
      used: false,
      revoked: false,
    })
  }

  private revokeFamily(familyId: number): void {
    const family = this.families.get(familyId)
    if (family) family.revoked = true
    for (const token of this.tokens.values()) {
      if (token.familyId === familyId) token.revoked = true
    }
  }
}

interface BrowserSession {
  cookie: string
  rawSession: string
  csrf: string
  html: string
  location: string
}

interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

function appFor(
  memory: MemoryOAuthStore,
  diagnostics?: (record: Readonly<OAuthDiagnosticRecord>) => void,
): Hono {
  const app = new Hono()
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  mountOAuthRoutes(app, {
    environment,
    store: memory.api,
    fetcher: (async input => {
      throw new Error(`unexpected network call: ${String(input)}`)
    }) as typeof fetch,
    ...(diagnostics ? { diagnostics } : {}),
  })
  return app
}

function fixture() {
  const memory = new MemoryOAuthStore()
  const app = appFor(memory)
  return { app, memory }
}

function authorizationUrl(patch: Record<string, string> = {}): string {
  const values = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    resource: RESOURCE,
    scope: 'city:resident',
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...patch,
  }
  return `/oauth/authorize?${new URLSearchParams(values)}`
}

async function begin(app: Hono, url = authorizationUrl()): Promise<BrowserSession> {
  const response = await app.request(url)
  assert.equal(response.status, 200)
  assertPrivate(response, true)
  assert.equal(response.headers.get('location'), null)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^__Host-1f3d9_oauth=[^;]+;/u)
  assert.match(setCookie, /; Path=\//i)
  assert.match(setCookie, /; Secure/i)
  assert.match(setCookie, /; HttpOnly/i)
  assert.match(setCookie, /; SameSite=Lax/i)
  const cookie = setCookie.split(';', 1)[0]!
  const rawSession = cookie.split('=', 2)[1]!.split('.', 2)[0]!
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /form-action 'self' https:\/\/chat\.example\.test;/u,
  )
  const html = await response.text()
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrf)
  assert.doesNotMatch(html, /name="session_cookie"|_1f3d9_cookie_/u)
  return { cookie, rawSession, csrf, html, location: url }
}

function assertPrivate(response: Response, html = false): void {
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('referrer-policy'), html ? 'same-origin' : 'no-referrer')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  if (html) assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/i)
}

async function browserPost(
  app: Hono,
  session: BrowserSession,
  fields: Record<string, string> | URLSearchParams,
  origin: string | null = ORIGIN,
  referer?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const body = fields instanceof URLSearchParams
    ? new URLSearchParams(fields)
    : new URLSearchParams(fields)
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: session.cookie,
    ...extraHeaders,
  }
  if (origin !== null) headers.origin = origin
  if (referer !== undefined) headers.referer = referer
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers,
    body,
  })
}

function authorizationCode(response: Response): string {
  assert.equal(response.status, 303)
  assertPrivate(response)
  const location = new URL(response.headers.get('location') ?? '')
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK)
  assert.equal(location.searchParams.get('state'), STATE)
  const code = location.searchParams.get('code')
  assert.match(code ?? '', /^1f3d9_ac_[0-9a-f]{64}$/)
  return code!
}

async function exchangeCode(app: Hono, code: string, patch: Record<string, string> = {}) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      resource: RESOURCE,
      code,
      code_verifier: VERIFIER,
      ...patch,
    }),
  })
}

async function readTokenPair(response: Response): Promise<TokenPair> {
  assert.equal(response.status, 200)
  assertPrivate(response)
  const pair = await response.json() as TokenPair
  assert.match(pair.access_token, /^1f3d9_at_[0-9a-f]{64}$/)
  assert.match(pair.refresh_token, /^1f3d9_rt_[0-9a-f]{64}$/)
  assert.equal(pair.token_type, 'Bearer')
  assert.equal(pair.scope, 'city:resident')
  return pair
}

async function authorizeExisting(app: Hono): Promise<{ code: string; session: BrowserSession }> {
  const session = await begin(app)
  const response = await browserPost(app, session, {
    action: 'link',
    csrf: session.csrf,
    resident_key: EXISTING_KEY,
  })
  const responseBody = await response.clone().text()
  const responseSurface = `${responseBody}\n${[...response.headers].flat().join('\n')}`
  assert.doesNotMatch(responseSurface, new RegExp(EXISTING_KEY, 'i'))
  return { code: authorizationCode(response), session }
}

async function initialPair(app: Hono): Promise<TokenPair> {
  const { code } = await authorizeExisting(app)
  return readTokenPair(await exchangeCode(app, code))
}

test('OAuth sets its cookie and renders the form in the initial response', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  assert.match(session.cookie, /^__Host-1f3d9_oauth=/u)
  assert.match(session.html, /name="resident_key"[^>]*type="password"/iu)
  const retryContract = session.html.indexOf('If “Prepare resident” is submitted again')
  const registerSubmit = session.html.indexOf('name="action" value="register"')
  assert.ok(retryContract >= 0 && retryContract < registerSubmit)
  assert.match(
    session.html,
    /same staged signup returns[^.]*never creates or shows a second key or recovery-code set/iu,
  )
  assert.equal((JSON.parse(memory.safeState()) as { requests: unknown[] }).requests.length, 1)
})

test('an active OAuth request survives both identical and different authorize reloads', async () => {
  const memory = new MemoryOAuthStore()
  const otherClientId = 'other-approved-hosted-chat'
  const otherCallback = 'https://other-chat.example.test/oauth/callback'
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment: {
      ...environment,
      HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([
        {
          client_id: CLIENT_ID,
          client_name: 'Hosted Chat Flow Test',
          redirect_uris: [CALLBACK],
        },
        {
          client_id: otherClientId,
          client_name: 'Other Approved Chat',
          redirect_uris: [otherCallback],
        },
      ]),
    },
    store: memory.api,
    fetcher: (async input => {
      throw new Error(`unexpected network call: ${String(input)}`)
    }) as typeof fetch,
  })
  const createAuthorizationRequest = memory.api.createAuthorizationRequest
  const consumeOAuthRateLimit = memory.api.consumeOAuthRateLimit
  let createCalls = 0
  let authorizeRateChecks = 0
  memory.api.createAuthorizationRequest = async input => {
    createCalls += 1
    return createAuthorizationRequest(input)
  }
  memory.api.consumeOAuthRateLimit = async input => {
    if (input.attemptKind === 'authorize') authorizeRateChecks += 1
    return consumeOAuthRateLimit(input)
  }

  const session = await begin(app)

  const refreshed = await app.request(session.location, { headers: { cookie: session.cookie } })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.headers.get('set-cookie'), null)
  const refreshedBody = await refreshed.text()
  assert.match(refreshedBody, /continuing the sign-in already held by this browser/iu)
  assert.match(refreshedBody, /start a different connector[^.]*cancel this request first/iu)
  assert.match(refreshedBody, /Hosted Chat Flow Test/iu)

  const changed = new URL(session.location, ORIGIN)
  changed.searchParams.set('client_id', otherClientId)
  changed.searchParams.set('redirect_uri', otherCallback)
  changed.searchParams.set('state', 'different-client-state')
  const preserved = await app.request(`${changed.pathname}${changed.search}`, {
    headers: { cookie: session.cookie },
  })
  assert.equal(preserved.status, 200)
  assert.equal(preserved.headers.get('location'), null)
  assert.equal(preserved.headers.get('x-1f3d9-reason'), null)
  assert.equal(preserved.headers.get('set-cookie'), null)
  const preservedBody = await preserved.text()
  assert.equal(preservedBody, refreshedBody)
  assert.doesNotMatch(preservedBody, /Other Approved Chat|different-client-state|other-chat\.example\.test/u)
  assert.match(
    preserved.headers.get('content-security-policy') ?? '',
    /form-action 'self' https:\/\/chat\.example\.test;/u,
  )

  const originalForm = await browserPost(app, session, {
    action: 'link',
    csrf: session.csrf,
    resident_key: EXISTING_KEY,
  })
  assert.equal(originalForm.status, 303)

  assert.equal(createCalls, 1)
  assert.equal(authorizeRateChecks, 2)
  assert.equal((JSON.parse(memory.safeState()) as { requests: unknown[] }).requests.length, 1)
})

test('an expired database request reports its state without spending quota or replacing the cookie', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  memory.expireBrowserSession(session.rawSession)
  const expiredSessionHash = sha256(session.rawSession)
  const createAuthorizationRequest = memory.api.createAuthorizationRequest
  const createdSessionHashes: string[] = []
  memory.api.createAuthorizationRequest = async input => {
    createdSessionHashes.push(input.sessionHash)
    return createAuthorizationRequest(input)
  }
  memory.api.consumeOAuthRateLimit = async () => {
    throw new Error('an expired resume must not spend sign-in quota')
  }

  const stopped = await app.request(session.location, { headers: { cookie: session.cookie } })
  assert.equal(stopped.status, 403)
  assert.equal(stopped.headers.get('x-1f3d9-reason'), 'request_expired')
  assert.equal(stopped.headers.get('set-cookie'), null)
  assert.deepEqual(createdSessionHashes, [])
  assert.notEqual(expiredSessionHash, '')
  const stoppedBody = await stopped.text()
  assert.match(stoppedBody, /expired[^.]*no resident/iu)
  assert.match(stoppedBody, /Return to the chat app and start sign-in again/iu)
})

test('reloading or repeating a staged signup resumes confirmation without showing its secrets again', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  const staged = await browserPost(app, session, {
    action: 'register',
    csrf: session.csrf,
    handle: 'reload-signup',
    model: '',
  })
  assert.equal(staged.status, 200)
  const stagedPage = await staged.text()
  assert.match(stagedPage, /Save reload-signup's resident key/iu)
  const rootKey = stagedPage.match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
  const recoveryCodes = stagedPage.match(/1f3d9_rc_[0-9a-f]{64}/gu) ?? []
  assert.ok(rootKey)
  assert.equal(recoveryCodes.length, 8)
  const keyInstruction = stagedPage.indexOf('Step 1')
  const keyValue = stagedPage.indexOf(rootKey)
  const codeInstruction = stagedPage.indexOf('Step 2')
  const firstCode = stagedPage.indexOf(recoveryCodes[0]!)
  const confirmation = stagedPage.indexOf('Step 3')
  assert.ok(keyInstruction >= 0 && keyInstruction < keyValue)
  assert.ok(keyValue < codeInstruction && codeInstruction < firstCode)
  assert.ok(firstCode < confirmation)
  assert.match(stagedPage, /password manager|operating-system credential vault/iu)
  assert.match(stagedPage, /outside (?:this|the) chat/iu)
  assert.match(stagedPage, /recovery codes[^.]*separate/iu)

  memory.api.consumeOAuthRateLimit = async () => {
    throw new Error('a staged reload must not spend sign-in quota')
  }

  const reloaded = await app.request(session.location, {
    headers: { cookie: session.cookie },
  })
  assert.equal(reloaded.status, 200)
  assert.equal(reloaded.headers.get('set-cookie'), null)
  const reloadedPage = await reloaded.text()
  assert.match(reloadedPage, /Re-enter the saved resident key/iu)
  assert.match(reloadedPage, /cannot show the resident key or recovery codes again/iu)
  assert.doesNotMatch(reloadedPage, new RegExp(rootKey, 'u'))
  for (const recoveryCode of recoveryCodes) {
    assert.doesNotMatch(reloadedPage, new RegExp(recoveryCode, 'u'))
  }

  const different = new URL(session.location, ORIGIN)
  different.searchParams.set('state', 'different-state-must-not-orphan-staged-signup')
  const preserved = await app.request(`${different.pathname}${different.search}`, {
    headers: { cookie: session.cookie },
  })
  assert.equal(preserved.status, 200)
  assert.equal(preserved.headers.get('set-cookie'), null)
  const preservedPage = await preserved.text()
  assert.match(preservedPage, /Re-enter the saved resident key/iu)
  assert.doesNotMatch(preservedPage, new RegExp(rootKey, 'u'))
  for (const recoveryCode of recoveryCodes) {
    assert.doesNotMatch(preservedPage, new RegExp(recoveryCode, 'u'))
  }

  Object.assign(memory.api, {
    stageNewResidentRegistration: async () => { throw new Error('a staged replay must not stage again') },
  })
  const repeated = await browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'reload-signup', model: '',
  })
  assert.equal(repeated.status, 200)
  const repeatedPage = await repeated.text()
  assert.match(repeatedPage, /Re-enter the saved resident key/iu)
  assert.match(repeatedPage, /cannot show the resident key or recovery codes again/iu)
  assert.doesNotMatch(repeatedPage, new RegExp(rootKey, 'u'))
  for (const recoveryCode of recoveryCodes) {
    assert.doesNotMatch(repeatedPage, new RegExp(recoveryCode, 'u'))
  }
})

test('concurrent repeated signup submissions show secrets once and resume the staged request', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  const stage = memory.api.stageNewResidentRegistration
  let arrivals = 0
  let releaseFirst!: () => void
  const secondArrived = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  memory.api.stageNewResidentRegistration = async input => {
    arrivals += 1
    if (arrivals === 1) await secondArrived
    else releaseFirst()
    return stage(input)
  }

  const submit = () => browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'concurrent-replay', model: '',
  })
  const responses = await Promise.all([submit(), submit()])
  assert.deepEqual(responses.map(response => response.status), [200, 200])

  const bodies = await Promise.all(responses.map(response => response.text()))
  const disclosed = bodies.filter(body => /1f3d9_sk_[0-9a-f]{48}/u.test(body))
  const resumed = bodies.filter(body => /cannot show the resident key or recovery codes again/iu.test(body))
  assert.equal(disclosed.length, 1)
  assert.equal(disclosed[0]!.match(/1f3d9_rc_[0-9a-f]{64}/gu)?.length, 8)
  assert.equal(resumed.length, 1)
  const disclosedSecrets = disclosed[0]!.match(/1f3d9_(?:sk_[0-9a-f]{48}|rc_[0-9a-f]{64})/gu) ?? []
  assert.equal(disclosedSecrets.length, 9)
  assertSecretsAbsent(resumed[0]!, disclosedSecrets)
})

test('authorization accepts a bounded language hint without relaxing unknown-field checks', async () => {
  const { app } = fixture()
  const localized = await begin(app, authorizationUrl({ ui_locales: 'en-US' }))
  assert.match(localized.html, /Hosted Chat Flow Test/iu)

  const oversized = await app.request(authorizationUrl({ ui_locales: 'a'.repeat(257) }))
  assert.equal(oversized.status, 400)

  const malformed = await app.request(authorizationUrl({ ui_locales: 'en_US' }))
  assert.equal(malformed.status, 400)

  const unknown = await app.request(authorizationUrl({ unsupported_hint: 'value' }))
  assert.equal(unknown.status, 400)
})

test('an unexpected authorization-store failure is bounded and logged without request secrets', async () => {
  const memory = new MemoryOAuthStore()
  const leakedCredential = `1f3d9_sk_${'ef'.repeat(24)}`
  memory.api.createAuthorizationRequest = async () => {
    throw new Error(`database failed near ${leakedCredential}`)
  }
  const diagnostics: Array<Record<string, unknown>> = []
  const app = new Hono()
  mountOAuthRoutes(app, {
    environment,
    store: memory.api,
    fetcher: (async input => {
      throw new Error(`unexpected network call: ${String(input)}`)
    }) as typeof fetch,
    diagnostics: record => diagnostics.push(record),
  })

  const response = await app.request(authorizationUrl())
  assert.equal(response.status, 503)
  assertPrivate(response, true)
  assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i)
  const body = await response.text()
  assert.match(body, /try again/i)
  assert.match(body, /Return to the chat app and start sign-in again/iu)
  assert.doesNotMatch(body, new RegExp(leakedCredential, 'i'))

  assert.equal(diagnostics.length, 1)
  assert.deepEqual(
    Object.keys(diagnostics[0] ?? {}).sort(),
    ['client_origin', 'elapsed_ms', 'error_class', 'event', 'request_id', 'stage', 'status'],
  )
  assert.equal(diagnostics[0]?.event, 'oauth_failure')
  assert.equal(diagnostics[0]?.stage, 'authorization_store')
  assert.equal(diagnostics[0]?.client_origin, 'pre-registered')
  assert.equal(diagnostics[0]?.error_class, 'storage_unavailable')
  assert.equal(diagnostics[0]?.status, 503)
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(leakedCredential, 'i'))
})

test('an initial authorization rate limit tells the caller how to restart', async () => {
  const { app, memory } = fixture()
  memory.api.consumeOAuthRateLimit = async () => rateLimitResult(false)

  const response = await app.request(authorizationUrl())
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'rate_limited')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.match(await response.text(), /Return to the chat app and start sign-in again/iu)
})

test('an active existing-resident rate limit discards the expired sign-in form', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  memory.api.consumeOAuthRateLimit = async () => rateLimitResult(false)

  const response = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  })
  const body = await response.text()

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'rate_limited')
  assert.match(body, /after one hour[^.]*return to the chat app[^.]*fresh sign-in/iu)
  assert.doesNotMatch(body, /on this page/iu)
  assert.doesNotMatch(body, /name="action" value="link"/u)
  assert.doesNotMatch(body, /name="resident_key"/u)
})

test('approval, exchange, refresh, and revocation failures stay bounded and emit safe stage records', async () => {
  const leakedCredential = `1f3d9_sk_${'fe'.repeat(24)}`

  const approvalMemory = new MemoryOAuthStore()
  const approvalDiagnostics: OAuthDiagnosticRecord[] = []
  const approvalApp = appFor(approvalMemory, record => approvalDiagnostics.push(record))
  const approvalSession = await begin(approvalApp)
  approvalMemory.api.approveExistingResidentAndIssueAuthorizationCode = async () => {
    throw new Error(`approval storage failed near ${leakedCredential}`)
  }
  const approval = await browserPost(approvalApp, approvalSession, {
    action: 'link',
    csrf: approvalSession.csrf,
    resident_key: EXISTING_KEY,
  })
  assert.equal(approval.status, 503)
  assertPrivate(approval, true)
  assert.deepEqual(approvalDiagnostics.map(record => record.stage), ['browser_approval'])

  const exchangeMemory = new MemoryOAuthStore()
  const exchangeDiagnostics: OAuthDiagnosticRecord[] = []
  const exchangeApp = appFor(exchangeMemory, record => exchangeDiagnostics.push(record))
  const { code } = await authorizeExisting(exchangeApp)
  exchangeMemory.api.exchangeAuthorizationCode = async () => {
    throw new Error(`exchange storage failed near ${leakedCredential}`)
  }
  const exchange = await exchangeCode(exchangeApp, code)
  assert.equal(exchange.status, 503)
  assertPrivate(exchange)
  assert.deepEqual(await exchange.json(), { error: 'temporarily_unavailable' })
  assert.deepEqual(exchangeDiagnostics.map(record => record.stage), ['token_exchange'])

  const refreshMemory = new MemoryOAuthStore()
  const refreshDiagnostics: OAuthDiagnosticRecord[] = []
  const refreshApp = appFor(refreshMemory, record => refreshDiagnostics.push(record))
  const pair = await initialPair(refreshApp)
  refreshMemory.api.rotateRefreshToken = async () => {
    throw new Error(`refresh storage failed near ${leakedCredential}`)
  }
  const refresh = await refreshApp.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      resource: RESOURCE,
      refresh_token: pair.refresh_token,
    }),
  })
  assert.equal(refresh.status, 503)
  assertPrivate(refresh)
  assert.deepEqual(await refresh.json(), { error: 'temporarily_unavailable' })
  assert.deepEqual(refreshDiagnostics.map(record => record.stage), ['token_refresh'])

  const revokeMemory = new MemoryOAuthStore()
  const revokeDiagnostics: OAuthDiagnosticRecord[] = []
  const revokeApp = appFor(revokeMemory, record => revokeDiagnostics.push(record))
  const revokePair = await initialPair(revokeApp)
  revokeMemory.api.revokeTokenFamilyByToken = async () => {
    throw new Error(`revocation storage failed near ${leakedCredential}`)
  }
  const revoke = await revokeApp.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: revokePair.refresh_token,
      client_id: CLIENT_ID,
    }),
  })
  assert.equal(revoke.status, 200)
  assertPrivate(revoke)
  assert.deepEqual(revokeDiagnostics.map(record => record.stage), ['revocation'])

  for (const records of [
    approvalDiagnostics,
    exchangeDiagnostics,
    refreshDiagnostics,
    revokeDiagnostics,
  ]) {
    assert.equal(records.length, 1)
    assert.deepEqual(
      Object.keys(records[0] ?? {}).sort(),
      ['client_origin', 'elapsed_ms', 'error_class', 'event', 'request_id', 'stage', 'status'],
    )
    assert.equal(records[0]?.client_origin, 'pre-registered')
    assert.equal(records[0]?.error_class, 'storage_unavailable')
    assert.doesNotMatch(JSON.stringify(records), new RegExp(leakedCredential, 'i'))
  }
})

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

test('existing resident completes sign-in, PKCE exchange, resolver, replay rejection, and revocation', async () => {
  const { app, memory } = fixture()
  const recoveryCodesBefore = (JSON.parse(memory.safeState()) as { recoveryCodes: unknown[] }).recoveryCodes
  const { code } = await authorizeExisting(app)

  assert.doesNotMatch(memory.safeState(), new RegExp(EXISTING_KEY, 'i'))
  const pair = await readTokenPair(await exchangeCode(app, code))
  assert.doesNotMatch(JSON.stringify(pair), new RegExp(EXISTING_KEY, 'i'))

  const replay = await exchangeCode(app, code)
  assert.equal(replay.status, 400)
  assert.deepEqual(await replay.json(), { error: 'invalid_grant' })

  const resident = await residentByOAuthAccessToken(pair.access_token, environment, memory.api)
  assert.equal(resident?.id, 49)
  assert.equal(resident?.handle, 'chatty')
  assert.doesNotMatch(JSON.stringify(resident), /1f3d9_(?:sk|at|rt|ac)_/i)

  const revoked = await app.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: pair.refresh_token, client_id: CLIENT_ID }),
  })
  assert.equal(revoked.status, 200)
  assertPrivate(revoked)
  assert.equal(await residentByOAuthAccessToken(pair.access_token, environment, memory.api), null)
  const recoveryCodesAfter = (JSON.parse(memory.safeState()) as { recoveryCodes: unknown[] }).recoveryCodes
  assert.deepEqual(recoveryCodesAfter, recoveryCodesBefore, 'linking must not generate or replace recovery codes')
})

test('unrecognized resident keys stay merged and can be corrected on the same sign-in request', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const unrecognizedKeys = [
    `1f3d9_sk_${'cd'.repeat(24)}`,
    `1f3d9_sk_${'ef'.repeat(24)}`,
  ]

  for (const residentKey of unrecognizedKeys) {
    const rejected = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: residentKey,
    })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.headers.get('x-1f3d9-reason'), 'resident_key_rejected')
    assert.match(
      rejected.headers.get('content-security-policy') ?? '',
      /form-action 'self' https:\/\/chat\.example\.test/u,
    )
    const body = await rejected.text()
    assert.match(body, /resident key could not be verified/iu)
    assert.match(body, /try again on this page/iu)
    assert.match(body, /name="action" value="link"/u)
    assert.match(body, /name="resident_key"[^>]*type="password"/iu)
    assert.match(body, new RegExp(`name="csrf" value="${session.csrf}"`, 'u'))
    assert.doesNotMatch(body, /Start again|close this page/iu)
    assert.doesNotMatch(body, new RegExp(residentKey, 'iu'))
  }

  const corrected = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  })
  authorizationCode(corrected)
})

test('a redeemed access token reaches city actions only through the hosted connector', async () => {
  const { app, memory } = fixture()
  app.get('/api/me', async c => {
    const resident = await auth(c)
    return resident ? c.json({ handle: resident.handle }) : c.json({ error: 'sign in required' }, 401)
  })
  app.post('/mcp', c => mcp(c, app))
  app.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))

  const previousFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  setOAuthResidentResolver(token => residentByOAuthAccessToken(token, environment, memory.api))

  try {
    const pair = await initialPair(app)
    const headers = { authorization: `Bearer ${pair.access_token}` }

    const rawApi = await app.request('/api/me', {
      headers: { ...headers, 'x-1f3d9-internal-connector': 'true' },
    })
    assert.equal(rawApi.status, 401)

    const call = (path: '/mcp' | '/mcp/connect') => app.request(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'me', arguments: {} },
      }),
    })

    const legacy = await call('/mcp')
    assert.equal(legacy.status, 200)
    const legacyPayload = await legacy.json() as { result: { isError: boolean } }
    assert.equal(legacyPayload.result.isError, true)

    const hosted = await call('/mcp/connect')
    assert.equal(hosted.status, 200)
    const hostedPayload = await hosted.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(hostedPayload.result.isError, false)
    assert.match(hostedPayload.result.content[0]?.text ?? '', /chatty/)
  } finally {
    setOAuthResidentResolver(null)
    if (previousFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousFlag
  }
})

test('hosted sign-in states its expiry, attempt caps, and reserved-name rule before submission', async () => {
  const { app } = fixture()
  const session = await begin(app)

  assert.match(session.html, /sign-in request[^.]*expires after 15 minutes/iu)
  assert.match(session.html, /authorization code[^.]*expires after 5 minutes/iu)
  assert.match(session.html, /60[^.]*sign-ins[^.]*per IP and client[^.]*UTC hour/iu)
  assert.match(session.html, /10[^.]*link[^.]*per IP and client[^.]*UTC hour/iu)
  assert.match(session.html, /new-resident[^.]*3 starts[^.]*per IP[^.]*UTC hour/iu)
  assert.match(session.html, /300[^.]*total[^.]*300[^.]*per client[^.]*UTC hour/iu)
  assert.match(session.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)
  assert.match(session.html, /names?[^.]*city[^.]*authority[^.]*reserved/iu)

  const reserved = await browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'official', model: 'hosted-chat',
  })
  assert.equal(reserved.status, 400)
  assert.match(await reserved.text(), /resident name[^.]*reserved/iu)
})

test('new resident sees its root key once, must re-enter it, then receives only OAuth credentials', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  const created = await browserPost(app, session, {
    action: 'register',
    csrf: session.csrf,
    handle: 'goldfish-agent',
    model: 'hosted-chat',
  })
  assert.equal(created.status, 200)
  assertPrivate(created, true)
  const privatePage = await created.text()
  const rootKey = privatePage.match(/<code>(1f3d9_sk_[0-9a-f]{48})<\/code>/)?.[1]
  assert.ok(rootKey)
  const recoveryCodes = privatePage.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
  assert.match(privatePage, /name="resident_key"[^>]*type="password"/i)
  assert.match(privatePage, /has not been created yet/i)
  assert.match(privatePage, /Cancel without creating a resident/i)
  assert.equal(recoveryCodes.length, 8)
  assert.equal(new Set(recoveryCodes).size, 8)
  const initialSecrets = [rootKey, ...recoveryCodes]
  assertSecretsAbsent(JSON.stringify([...created.headers]), initialSecrets)
  assert.doesNotMatch(memory.safeState(), new RegExp(rootKey, 'i'))
  assert.doesNotMatch(memory.safeState(), /1f3d9_rc_[0-9a-f]{64}/i)
  const pendingState = JSON.parse(memory.safeState()) as {
    residents: Resident[]
    residentSecretHashes: [string, number][]
    recoveryCodes: [number, string[]][]
    events: unknown[]
  }
  assert.deepEqual(
    pendingState.residents.map(resident => resident.id),
    [49],
    'a new resident must not exist before the one-time key is confirmed saved',
  )
  assert.equal(
    pendingState.residentSecretHashes.length,
    1,
    'the pending key hash must not be attached to a resident before confirmation',
  )
  assert.equal(pendingState.recoveryCodes.length, 0, 'pending recovery codes must stay unattached')
  assert.equal(pendingState.events.length, 0, 'registration history starts only after confirmation')

  const repeatedRegistration = await browserPost(app, session, {
    action: 'register',
    csrf: session.csrf,
    handle: 'goldfish-agent-two',
    model: 'hosted-chat',
  })
  assert.equal(repeatedRegistration.status, 200)
  const repeatedRegistrationBody = await repeatedRegistration.text()
  assert.match(repeatedRegistrationBody, /Re-enter the saved resident key/iu)
  assert.match(repeatedRegistrationBody, /cannot show the resident key or recovery codes again/iu)
  assertSecretsAbsent(repeatedRegistrationBody, initialSecrets)

  const missingConfirmation = await browserPost(app, session, {
    action: 'confirm',
    csrf: session.csrf,
  })
  assert.equal(missingConfirmation.status, 403)
  assert.equal(missingConfirmation.headers.get('location'), null)
  assertSecretsAbsent(await missingConfirmation.text(), initialSecrets)

  const wrongConfirmation = await browserPost(app, session, {
    action: 'confirm',
    csrf: session.csrf,
    resident_key: EXISTING_KEY,
  })
  assert.equal(wrongConfirmation.status, 403)
  assert.equal(wrongConfirmation.headers.get('location'), null)
  assertSecretsAbsent(await wrongConfirmation.text(), initialSecrets)

  const confirmed = await browserPost(app, session, {
    action: 'confirm',
    csrf: session.csrf,
    resident_key: rootKey,
  })
  const code = authorizationCode(confirmed)
  const redirectSurface = `${confirmed.headers.get('location')}\n${await confirmed.clone().text()}`
  assertSecretsAbsent(redirectSurface, initialSecrets)

  const pair = await readTokenPair(await exchangeCode(app, code))
  assertSecretsAbsent(JSON.stringify(pair), initialSecrets)
  const resident = await residentByOAuthAccessToken(pair.access_token, environment, memory.api)
  assert.equal(resident?.handle, 'goldfish-agent')
  assertSecretsAbsent(JSON.stringify(resident), initialSecrets)
  assertSecretsAbsent(memory.safeState(), initialSecrets)
  const confirmedState = JSON.parse(memory.safeState()) as {
    recoveryCodes: [number, string[]][]
    events: { actor: string }[]
  }
  assert.equal(confirmedState.recoveryCodes.length, 1)
  assert.equal(confirmedState.recoveryCodes[0]?.[1]?.length, 8)
  assert.deepEqual(confirmedState.events.map(event => event.actor), ['goldfish-agent'])
})

test('a wrong staged-signup key keeps the staged request and offers a safe retry form', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const staged = await browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'retry-staged-key', model: 'hosted-chat',
  })
  assert.equal(staged.status, 200)
  const stagedPage = await staged.text()
  const rootKey = stagedPage.match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
  const recoveryCodes = stagedPage.match(/1f3d9_rc_[0-9a-f]{64}/gu) ?? []
  assert.ok(rootKey)
  assert.equal(recoveryCodes.length, 8)

  const wrongKey = `1f3d9_sk_${'fe'.repeat(24)}`
  const rejected = await browserPost(app, session, {
    action: 'confirm', csrf: session.csrf, resident_key: wrongKey,
  })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.headers.get('x-1f3d9-reason'), 'confirmation_rejected')
  assert.match(
    rejected.headers.get('content-security-policy') ?? '',
    /form-action 'self' https:\/\/chat\.example\.test/u,
  )
  const rejectedPage = await rejected.text()
  assert.match(rejectedPage, /saved resident key could not be verified/iu)
  assert.match(rejectedPage, /try again on this page/iu)
  assert.match(rejectedPage, /name="action" value="confirm"/u)
  assert.match(rejectedPage, /name="resident_key"[^>]*type="password"/iu)
  assert.match(rejectedPage, new RegExp(`name="csrf" value="${session.csrf}"`, 'u'))
  assert.doesNotMatch(rejectedPage, /Start again|close this page/iu)
  assertSecretsAbsent(rejectedPage, [wrongKey, rootKey, ...recoveryCodes])

  const corrected = await browserPost(app, session, {
    action: 'confirm', csrf: session.csrf, resident_key: rootKey,
  })
  authorizationCode(corrected)
})

test('connector signup retries a random collision until all eight initial recovery codes are unique', async () => {
  const byteValues = [1, 1, 2, 3, 4, 5, 6, 7, 8]
  let draw = 0
  const codes = collectRecoveryCodeSet(() =>
    `1f3d9_rc_${(byteValues[draw++] ?? 255).toString(16).padStart(64, '0')}`)

  assert.equal(codes.length, 8)
  assert.equal(new Set(codes).size, 8)
  assert.equal(draw, 9)

  let stalledDraws = 0
  assert.throws(
    () => collectRecoveryCodeSet(() => {
      stalledDraws += 1
      return `1f3d9_rc_${'00'.repeat(32)}`
    }),
    /secure recovery-code generation failed/,
  )
  assert.equal(stalledDraws, 64)
})

test('connector signup discloses no generated secrets when throttling or staging fails closed', async () => {
  for (const deniedCall of [1, 2, 3]) {
    const { app, memory } = fixture()
    const session = await begin(app)
    let rateCall = 0
    Object.assign(memory.api, {
      consumeOAuthRateLimit: async () => {
        rateCall += 1
        return rateLimitResult(rateCall !== deniedCall)
      },
    })

    const response = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: `limited-agent-${deniedCall}`, model: 'hosted-chat',
    })
    const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
    assert.equal(response.status, 429)
    assert.match(surface, /after one hour[^.]*return to the chat app[^.]*fresh sign-in/iu)
    assert.doesNotMatch(surface, /on this page/iu)
    assert.doesNotMatch(surface, /name="action" value="register"/u)
    assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
  }

  for (const stageFailure of ['missing', 'duplicate', 'unique_error', 'error'] as const) {
    const { app, memory } = fixture()
    const session = await begin(app)
    if (stageFailure === 'missing') {
      Object.assign(memory.api, { stageNewResidentRegistration: async () => ({ status: 'request_unavailable' as const }) })
    } else if (stageFailure === 'unique_error') {
      Object.assign(memory.api, {
        stageNewResidentRegistration: async () => {
          throw Object.assign(new Error('duplicate handle'), { code: '23505' })
        },
      })
    } else if (stageFailure === 'error') {
      Object.assign(memory.api, {
        stageNewResidentRegistration: async () => {
          throw new Error('registration store unavailable')
        },
      })
    }

    const response = await browserPost(app, session, {
      action: 'register',
      csrf: session.csrf,
      handle: stageFailure === 'duplicate'
        ? 'chatty'
        : `failed-agent-${stageFailure.replace('_', '-')}`,
      model: 'hosted-chat',
    })
    const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
    const state = JSON.parse(memory.safeState()) as {
      residents: Resident[]
      recoveryCodes: unknown[]
      events: unknown[]
    }

    assert.equal({ missing: 403, duplicate: 409, unique_error: 503, error: 503 }[stageFailure], response.status)
    assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
    if (stageFailure === 'duplicate') {
      assert.match(surface, /href="\/window"[^>]*>Check the resident list/iu)
      assert.match(surface, /earlier resident[^.]*choose “I already live here”/iu)
      assert.match(surface, /If it is not[^.]*choose a different name below/iu)
      assert.match(surface, /name="action" value="register"/u)
    }
    assert.deepEqual(state.residents.map(resident => resident.id), [49])
    assert.equal(state.recoveryCodes.length, 0)
    assert.equal(state.events.length, 0)
  }
})

test('connector signup rejects an invalid identity before generating or staging secrets', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  const response = await browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'invalid_handle', model: 'hosted-chat',
  })
  const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
  const state = JSON.parse(memory.safeState()) as {
    residents: Resident[]
    recoveryCodes: unknown[]
    events: unknown[]
  }

  assert.equal(response.status, 400)
  assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
  assert.deepEqual(state.residents.map(resident => resident.id), [49])
  assert.equal(state.recoveryCodes.length, 0)
  assert.equal(state.events.length, 0)
})

test('connector signup confirmation stays uncommitted when its rate limit or store fails closed', async () => {
  for (const confirmFailure of ['rate_limit', 'missing', 'error'] as const) {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register',
      csrf: session.csrf,
      handle: `unconfirmed-${confirmFailure.replace('_', '-')}`,
      model: 'hosted-chat',
    })
    const stagePage = await staged.text()
    const rootKey = stagePage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
    const recoveryCodes = stagePage.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
    assert.ok(rootKey)

    if (confirmFailure === 'rate_limit') {
      Object.assign(memory.api, { consumeOAuthRateLimit: async () => rateLimitResult(false) })
    } else if (confirmFailure === 'missing') {
      Object.assign(memory.api, { confirmNewResidentAndIssueAuthorizationCode: async () => ({ status: 'request_unavailable' as const }) })
    } else {
      Object.assign(memory.api, {
        confirmNewResidentAndIssueAuthorizationCode: async () => {
          throw new Error('registration confirmation unavailable')
        },
      })
    }

    const response = await browserPost(app, session, {
      action: 'confirm', csrf: session.csrf, resident_key: rootKey,
    })
    const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
    const state = JSON.parse(memory.safeState()) as {
      residents: Resident[]
      recoveryCodes: unknown[]
      events: unknown[]
    }

    assert.equal({ rate_limit: 429, missing: 403, error: 503 }[confirmFailure], response.status)
    if (confirmFailure === 'rate_limit') {
      assert.match(surface, /after one hour[^.]*return to the chat app[^.]*fresh sign-in/iu)
      assert.doesNotMatch(surface, /on this page/iu)
      assert.doesNotMatch(surface, /name="action" value="confirm"/u)
      assert.doesNotMatch(surface, /name="resident_key"/u)
    }
    assertSecretsAbsent(surface, [rootKey, ...recoveryCodes])
    assert.deepEqual(state.residents.map(resident => resident.id), [49])
    assert.equal(state.recoveryCodes.length, 0)
    assert.equal(state.events.length, 0)
  }
})

test('cancelling or abandoning key confirmation creates no resident, event, or handle claim', async () => {
  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'cancelled-agent', model: 'hosted-chat',
    })
    assert.equal(staged.status, 200)

    const cancelled = await browserPost(app, session, {
      action: 'cancel', csrf: session.csrf,
    })
    assert.equal(cancelled.status, 303)
    const state = JSON.parse(memory.safeState()) as {
      residents: Resident[]
      residentSecretHashes: [string, number][]
      recoveryCodes: [number, string[]][]
      events: unknown[]
    }
    assert.deepEqual(state.residents.map(resident => resident.id), [49])
    assert.equal(state.residentSecretHashes.length, 1)
    assert.equal(state.recoveryCodes.length, 0)
    assert.equal(state.events.length, 0)
  }

  {
    const { app, memory } = fixture()
    const abandoned = await begin(app)
    const staged = await browserPost(app, abandoned, {
      action: 'register', csrf: abandoned.csrf, handle: 'abandoned-agent', model: 'hosted-chat',
    })
    assert.equal(staged.status, 200)
    memory.expireBrowserSession(abandoned.rawSession)

    const state = JSON.parse(memory.safeState()) as { residents: Resident[]; events: unknown[] }
    assert.deepEqual(state.residents.map(resident => resident.id), [49])
    assert.equal(state.events.length, 0)

    const retry = await begin(app)
    const cleanedState = JSON.parse(memory.safeState()) as {
      requests: { used: boolean; new_handle: string | null; pendingSecretHash: string | null }[]
    }
    assert.ok(cleanedState.requests.some(request =>
      request.used && request.new_handle === null && request.pendingSecretHash === null))
    const reusedHandle = await browserPost(app, retry, {
      action: 'register', csrf: retry.csrf, handle: 'abandoned-agent', model: 'hosted-chat',
    })
    assert.equal(reusedHandle.status, 200, 'an abandoned pending name must remain available')
  }
})

test('same-name pending registrations stay harmless and only one confirmation can create the resident', async () => {
  const { app, memory } = fixture()
  const first = await begin(app)
  const second = await begin(app)
  const stage = (session: BrowserSession) => browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'same-pending-name', model: 'hosted-chat',
  })

  const firstPage = await stage(first)
  const secondPage = await stage(second)
  assert.equal(firstPage.status, 200)
  assert.equal(secondPage.status, 200)
  const firstKey = (await firstPage.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  const secondKey = (await secondPage.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  assert.ok(firstKey)
  assert.ok(secondKey)
  assert.notEqual(firstKey, secondKey)

  // A separate app instance proves confirmation needs only the shared hashed store,
  // not process memory or another copy of the displayed key.
  const otherInstance = appFor(memory)
  const winner = await browserPost(otherInstance, first, {
    action: 'confirm', csrf: first.csrf, resident_key: firstKey,
  })
  assert.equal(winner.status, 303)

  const beforeLoser = JSON.parse(memory.safeState()) as { nextResidentId: number }
  const loser = await browserPost(app, second, {
    action: 'confirm', csrf: second.csrf, resident_key: secondKey,
  })
  assert.equal(loser.status, 409)
  assert.equal(loser.headers.get('x-1f3d9-reason'), 'handle_taken')
  assert.equal(loser.headers.get('location'), null)
  const loserSurface = `${await loser.text()}\n${[...loser.headers].flat().join('\n')}`
  assert.match(loserSurface, /losing signup is closed/iu)
  assert.match(loserSurface, /saved key and recovery codes are inactive/iu)
  assert.doesNotMatch(loserSurface, new RegExp(`${firstKey}|${secondKey}`, 'i'))

  const state = JSON.parse(memory.safeState()) as {
    requests: Array<{
      sessionHash: string
      used: boolean
      intent: 'existing' | 'new' | null
      new_handle: string | null
      new_model: string | null
      pendingSecretHash: string | null
      pendingRecoveryCodeHashes: string[] | null
    }>
    residents: Resident[]
    residentSecretHashes: [string, number][]
    events: { actor: string }[]
    nextResidentId: number
    duplicateHandleRollbacks: number
  }
  assert.equal(state.residents.filter(resident => resident.handle === 'same-pending-name').length, 1)
  assert.equal(state.events.filter(event => event.actor === 'same-pending-name').length, 1)
  assert.equal(state.residentSecretHashes.length, 2)
  assert.equal(state.nextResidentId, beforeLoser.nextResidentId)
  assert.equal(state.duplicateHandleRollbacks, 1)
  const loserRequest = state.requests.find(request => request.sessionHash === sha256(second.rawSession))
  assert.ok(loserRequest)
  assert.deepEqual({
    used: loserRequest.used,
    intent: loserRequest.intent,
    handle: loserRequest.new_handle,
    model: loserRequest.new_model,
    secretHash: loserRequest.pendingSecretHash,
    recoveryCodeHashes: loserRequest.pendingRecoveryCodeHashes,
  }, {
    used: true,
    intent: null,
    handle: null,
    model: null,
    secretHash: null,
    recoveryCodeHashes: null,
  })
  assert.doesNotMatch(memory.safeState(), new RegExp(`${firstKey}|${secondKey}`, 'i'))

  const restartUrl = authorizationUrl({ state: 'after-handle-race' })
  const restarted = await app.request(restartUrl, { headers: { cookie: second.cookie } })
  assert.equal(restarted.status, 200)
  const replacementCookie = (restarted.headers.get('set-cookie') ?? '').split(';', 1)[0]!
  assert.match(replacementCookie, /^__Host-1f3d9_oauth=/u)
  assert.notEqual(replacementCookie, second.cookie)
  assert.match(await restarted.text(), /Let this chat enter 1F3D9/iu)
})

test('refresh tokens rotate once; reuse revokes the whole token family', async () => {
  const { app, memory } = fixture()
  const first = await initialPair(app)
  const rotate = () => app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      resource: RESOURCE,
      refresh_token: first.refresh_token,
    }),
  })

  const second = await readTokenPair(await rotate())
  assert.notEqual(second.access_token, first.access_token)
  assert.notEqual(second.refresh_token, first.refresh_token)

  const reuse = await rotate()
  assert.equal(reuse.status, 400)
  assert.deepEqual(await reuse.json(), { error: 'invalid_grant' })
  assert.equal(await residentByOAuthAccessToken(first.access_token, environment, memory.api), null)
  assert.equal(await residentByOAuthAccessToken(second.access_token, environment, memory.api), null)

  const descendant = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      resource: RESOURCE,
      refresh_token: second.refresh_token,
    }),
  })
  assert.equal(descendant.status, 400)
  assert.deepEqual(await descendant.json(), { error: 'invalid_grant' })
})

test('invalid authorization queries reject safely and tell the chat client how to restart', async () => {
  const { app } = fixture()
  for (const patch of [
    { redirect_uri: `${CALLBACK}/near-match` },
    { redirect_uri: 'https://unapproved.example.test/oauth/callback' },
    { resource: ORIGIN },
  ]) {
    const response = await app.request(authorizationUrl(patch))
    assert.equal(response.status, 400)
    assertPrivate(response, true)
    assert.doesNotMatch(
      response.headers.get('content-security-policy') ?? '',
      /https:\/\/(?:chat|unapproved)\.example\.test/u,
    )
    assert.equal(response.headers.get('x-1f3d9-reason'), 'invalid_request')
    const body = await response.text()
    assert.match(body, /Return to the chat app and start sign-in again/iu)
    assert.match(body, /Lost\? Read the city front door/iu)
  }
  const duplicate = await app.request(`${authorizationUrl()}&state=duplicate`)
  assert.equal(duplicate.status, 400)
  assert.equal(duplicate.headers.get('x-1f3d9-reason'), 'invalid_request')
  assert.match(await duplicate.text(), /Return to the chat app and start sign-in again/iu)
  const unknown = await app.request(`${authorizationUrl()}&resident_key=forbidden`)
  assert.equal(unknown.status, 400)
  assert.equal(unknown.headers.get('x-1f3d9-reason'), 'invalid_request')
  assert.match(await unknown.text(), /Return to the chat app and start sign-in again/iu)
})

test('browser approval rejects wrong origin and CSRF without reflecting the resident key', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const wrongOrigin = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  }, 'https://evil.example')
  assert.equal(wrongOrigin.status, 403)
  assert.equal(wrongOrigin.headers.get('x-1f3d9-error-class'), 'forbidden')
  assert.equal(wrongOrigin.headers.get('x-1f3d9-reason'), 'untrusted_browser_request')
  const wrongOriginPolicy = wrongOrigin.headers.get('content-security-policy') ?? ''
  assert.match(wrongOriginPolicy, /form-action 'self';/u)
  assert.doesNotMatch(wrongOriginPolicy, /[<>]/u)
  const wrongOriginRequestId = wrongOrigin.headers.get('x-request-id') ?? ''
  assert.match(wrongOriginRequestId, /^[0-9a-f-]{36}$/iu)
  const wrongOriginBody = await wrongOrigin.text()
  assert.match(wrongOriginBody, new RegExp(wrongOriginRequestId, 'u'))
  assert.match(wrongOriginBody, /Return to the chat app and start sign-in again/iu)
  assert.doesNotMatch(wrongOriginBody, new RegExp(EXISTING_KEY, 'i'))
  const wrongCsrf = await browserPost(app, session, {
    action: 'link', csrf: 'wrong-csrf', resident_key: EXISTING_KEY,
  })
  assert.equal(wrongCsrf.status, 403)
  assert.equal(wrongCsrf.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch')
  const wrongCsrfBody = await wrongCsrf.text()
  assert.match(wrongCsrfBody, /This sign-in form and its private browser cookie did not match\./u)
  assert.doesNotMatch(wrongCsrfBody, new RegExp(EXISTING_KEY, 'i'))

  const missingCookie = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
    },
    body: new URLSearchParams({
      action: 'link',
      csrf: session.csrf,
      resident_key: EXISTING_KEY,
    }),
  })
  assert.equal(missingCookie.status, 403)
  assert.equal(missingCookie.headers.get('x-1f3d9-reason'), 'browser_cookie_missing')
  assert.match(await missingCookie.text(), /submitted without its private browser cookie/iu)

  const malformedCookie = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: '__Host-1f3d9_oauth=not-a-valid-cookie',
      origin: ORIGIN,
    },
    body: new URLSearchParams({
      action: 'link',
      csrf: session.csrf,
      resident_key: EXISTING_KEY,
    }),
  })
  assert.equal(malformedCookie.status, 403)
  assert.equal(malformedCookie.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch')
  assert.match(
    await malformedCookie.text(),
    /This sign-in form and its private browser cookie did not match\./u,
  )
})

test('browser approval distinguishes wrong keys from expired sign-in state and avoids harmful restart advice', async () => {
  {
    const { app } = fixture()
    const session = await begin(app)
    const wrongKey = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: `1f3d9_sk_${'cd'.repeat(24)}`,
    })
    assert.equal(wrongKey.status, 403)
    assert.equal(wrongKey.headers.get('x-1f3d9-reason'), 'resident_key_rejected')
    const wrongKeyBody = await wrongKey.text()
    assert.match(wrongKeyBody, /resident key could not be verified/iu)
    assert.doesNotMatch(wrongKeyBody, /Start again/iu)
    assert.match(wrongKeyBody, /href="\/">Lost\? Read the city front door\./u)
  }

  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'staged-expiry-agent', model: 'hosted-chat',
    })
    const stagedPage = await staged.text()
    const rootKey = stagedPage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
    assert.ok(rootKey)

    Object.assign(memory.api, { confirmNewResidentAndIssueAuthorizationCode: async () => ({ status: 'request_unavailable' as const }) })
    const expired = await browserPost(app, session, {
      action: 'confirm', csrf: session.csrf, resident_key: rootKey,
    })
    assert.equal(expired.status, 403)
    assert.equal(expired.headers.get('x-1f3d9-reason'), 'request_unavailable')
    assert.match(await expired.text(), /sign-in request expired|already used/iu)
  }

  {
    const { app } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'wrong-confirm-agent', model: 'hosted-chat',
    })
    const wrong = await browserPost(app, session, {
      action: 'confirm', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    assert.equal(staged.status, 200)
    assert.equal(wrong.status, 403)
    assert.equal(wrong.headers.get('x-1f3d9-reason'), 'confirmation_rejected')
    const wrongBody = await wrong.text()
    assert.match(wrongBody, /saved resident key could not be verified/iu)
    assert.doesNotMatch(wrongBody, /Start again/iu)
    assert.match(wrongBody, /href="\/">Lost\? Read the city front door\./u)
  }
})

test('browser approval accepts a same-origin referrer when Origin is withheld', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const approved = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  }, 'null', `${ORIGIN}/oauth/authorize`)

  authorizationCode(approved)
})

test('browser approval accepts same-origin fetch metadata when privacy browsers omit Origin and Referer', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const approved = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  }, null, undefined, {
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  })

  authorizationCode(approved)
})

test('browser approval rejects unknown and duplicate fields instead of guessing intent', async () => {
  {
    const { app } = fixture()
    const session = await begin(app)
    const unexpected = await browserPost(app, session, {
      action: 'link',
      csrf: session.csrf,
      resident_key: EXISTING_KEY,
      access_token: 'unexpected-field',
    })
    assert.equal(unexpected.status, 403)
    assert.equal(unexpected.headers.get('location'), null)
    assert.match(await unexpected.text(), /Return to the chat app and start sign-in again/iu)
  }

  {
    const { app } = fixture()
    const session = await begin(app)
    const duplicateFields = new URLSearchParams({
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    duplicateFields.append('csrf', session.csrf)
    const duplicate = await browserPost(app, session, duplicateFields)
    assert.equal(duplicate.status, 403)
    assert.match(await duplicate.text(), /Return to the chat app and start sign-in again/iu)
  }
})

test('canceled and confirmed hosted signups report the exact safe resume path without quota', async () => {
  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const canceled = await browserPost(app, session, { action: 'cancel', csrf: session.csrf })
    assert.equal(canceled.status, 303)
    memory.api.consumeOAuthRateLimit = async () => {
      throw new Error('a canceled resume must not spend sign-in quota')
    }
    const resumed = await app.request(session.location, { headers: { cookie: session.cookie } })
    assert.equal(resumed.status, 403)
    assert.equal(resumed.headers.get('x-1f3d9-reason'), 'request_unavailable')
    const body = await resumed.text()
    assert.match(body, /canceled[^.]*no resident/iu)
    assert.match(body, /Return to the chat app and start sign-in again/iu)
  }

  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'confirmed-resume', model: '',
    })
    const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(key)
    const confirmed = await browserPost(app, session, {
      action: 'confirm', csrf: session.csrf, resident_key: key,
    })
    authorizationCode(confirmed)
    memory.api.consumeOAuthRateLimit = async () => {
      throw new Error('a confirmed resume must not spend sign-in quota')
    }
    const resumed = await app.request(session.location, { headers: { cookie: session.cookie } })
    assert.equal(resumed.status, 403)
    assert.equal(resumed.headers.get('x-1f3d9-reason'), 'request_unavailable')
    const body = await resumed.text()
    assert.match(body, /confirmed-resume[^.]*already (?:exists|lives)/iu)
    assert.match(body, /choose “I already live here,”[^.]*saved key/iu)
    assert.doesNotMatch(body, new RegExp(key, 'u'))
  }
})

test('token exchange rejects wrong verifier, resource, private-client credentials, unknown fields, and duplicates', async () => {
  {
    const { app } = fixture()
    const { code } = await authorizeExisting(app)
    const wrongVerifier = await exchangeCode(app, code, { code_verifier: 'x'.repeat(43) })
    assert.equal(wrongVerifier.status, 400)
    assert.deepEqual(await wrongVerifier.json(), { error: 'invalid_grant' })
    const wrongResource = await exchangeCode(app, code, { resource: ORIGIN })
    assert.equal(wrongResource.status, 400)
  }

  {
    const { app } = fixture()
    const { code } = await authorizeExisting(app)
    const unknown = await exchangeCode(app, code, { unexpected: 'field' })
    assert.equal(unknown.status, 400)
    assert.deepEqual(await unknown.json(), { error: 'invalid_request' })
  }

  for (const forbidden of [
    { client_secret: 'must-not-be-accepted' },
    { client_assertion: 'must-not-be-accepted' },
    {
      client_assertion: 'must-not-be-accepted',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    },
  ]) {
    const { app } = fixture()
    const { code } = await authorizeExisting(app)
    const rejected = await exchangeCode(app, code, forbidden)
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), { error: 'invalid_request' })
  }

  {
    const { app } = fixture()
    const { code } = await authorizeExisting(app)
    const rejected = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        authorization: 'Basic must-not-be-accepted',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        resource: RESOURCE,
        code,
        code_verifier: VERIFIER,
      }),
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), { error: 'invalid_request' })
  }

  {
    const { app } = fixture()
    const { code } = await authorizeExisting(app)
    const fields = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      resource: RESOURCE,
      code,
      code_verifier: VERIFIER,
    })
    fields.append('code', code)
    const duplicate = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields,
    })
    assert.equal(duplicate.status, 400)
    assert.deepEqual(await duplicate.json(), { error: 'invalid_request' })
  }
})

test('OAuth cancel and confirm races re-read the completed resident before replying', async () => {
  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'cancel-race-resident', model: '',
    })
    const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(key)
    const confirm = memory.api.confirmNewResidentAndIssueAuthorizationCode
    memory.api.cancelAuthorizationRequest = async input => {
      const completed = await confirm({
        ...input,
        residentSecretHash: sha256(key),
        authorizationCodeHash: sha256('cancel-race-authorization-code'),
      })
      assert.equal(completed.status, 'approved')
      return null
    }

    const canceled = await browserPost(app, session, {
      action: 'cancel', csrf: session.csrf,
    })
    assert.equal(canceled.status, 403)
    assert.equal(canceled.headers.get('x-1f3d9-reason'), 'request_unavailable')
    const body = await canceled.text()
    assert.match(body, /cancel-race-resident[^.]*already lives/iu)
    assert.match(body, /choose “I already live here,”[^.]*saved key/iu)
    assert.doesNotMatch(body, new RegExp(key, 'u'))
  }

  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'confirm-race-resident', model: '',
    })
    const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(key)
    const confirm = memory.api.confirmNewResidentAndIssueAuthorizationCode
    memory.api.confirmNewResidentAndIssueAuthorizationCode = async input => {
      const completed = await confirm(input)
      assert.equal(completed.status, 'approved')
      return { status: 'request_unavailable' as const }
    }

    const response = await browserPost(app, session, {
      action: 'confirm', csrf: session.csrf, resident_key: key,
    })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'request_unavailable')
    const body = await response.text()
    assert.match(body, /confirm-race-resident[^.]*already lives/iu)
    assert.match(body, /choose “I already live here,”[^.]*saved key/iu)
    assert.doesNotMatch(body, new RegExp(key, 'u'))
  }
})

test('expired and used connector requests direct the person back to the chat app', async () => {
  const stopped: Response[] = []

  {
    const { app, memory } = fixture()
    const session = await begin(app)
    memory.expireBrowserSession(session.rawSession)
    stopped.push(await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }))
  }

  {
    const { app, memory } = fixture()
    const session = await begin(app)
    const staged = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'expired-staged-key', model: 'hosted-chat',
    })
    const rootKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(rootKey)
    memory.expireBrowserSession(session.rawSession)
    stopped.push(await browserPost(app, session, {
      action: 'confirm', csrf: session.csrf, resident_key: rootKey,
    }))
  }

  {
    const { app } = fixture()
    const session = await begin(app)
    const approved = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    authorizationCode(approved)
    stopped.push(await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }))
  }

  for (const [index, response] of stopped.entries()) {
    assert.equal(response.status, 403)
    assert.equal(
      response.headers.get('x-1f3d9-reason'),
      index < 2 ? 'request_expired' : 'request_unavailable',
    )
    const body = await response.text()
    assert.match(body, /return to the chat app and start sign-in again/iu)
    assert.doesNotMatch(body, /name="resident_key"/u)
  }
})

test('a non-handle unique violation is a storage fault, not a taken-name claim', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  Object.assign(memory.api, {
    approveExistingResidentAndIssueAuthorizationCode: async () => {
      throw Object.assign(new Error('authorization-code collision'), { code: '23505' })
    },
  })

  const response = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'storage_unavailable')
  assert.equal(response.headers.get('retry-after'), '1')
  assert.doesNotMatch(await response.text(), /resident name[^.]*taken|handle_taken/iu)
})

test('cancel atomically consumes the request before returning access_denied', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const cancelled = await browserPost(app, session, {
    action: 'cancel',
    csrf: session.csrf,
  })
  assert.equal(cancelled.status, 303)
  const location = new URL(cancelled.headers.get('location') ?? '')
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK)
  assert.equal(location.searchParams.get('error'), 'access_denied')
  assert.equal(location.searchParams.get('state'), STATE)
  assert.equal(location.searchParams.get('code'), null)
  assert.doesNotMatch(location.href, /1f3d9_(?:sk|at|rt|ac)_/i)

  const replay = await browserPost(app, session, {
    action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
  })
  assert.equal(replay.status, 403)
  assert.equal(replay.headers.get('location'), null)
})

test('expired browser sessions and authorization codes cannot be used', async () => {
  {
    const { app, memory } = fixture()
    const session = await begin(app)
    memory.expireBrowserSession(session.rawSession)
    const expired = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    assert.equal(expired.status, 403)
    assert.equal(expired.headers.get('location'), null)
    assert.doesNotMatch(await expired.text(), new RegExp(EXISTING_KEY, 'i'))
  }

  {
    const { app, memory } = fixture()
    const { code } = await authorizeExisting(app)
    memory.expireAuthorizationCode(code)
    const expired = await exchangeCode(app, code)
    assert.equal(expired.status, 400)
    assert.deepEqual(await expired.json(), { error: 'invalid_grant' })
  }
})

test('PKCE fixture is the RFC S256 vector used by the browser-flow tests', () => {
  const derived = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url')
  assert.equal(derived, CHALLENGE)
})

// Decision row 74: a signed-in coding client mints a pairing code with
// POST /api/pair (test/pair.test.ts covers that door); the human enters it
// here in place of the resident key. These tests exercise the /oauth/authorize
// side of that contract using the same fixture and helpers as the resident-key
// "link" flow above.
async function mintedPairingCode(memory: MemoryOAuthStore, residentId = 49): Promise<string> {
  const rawCode = PAIRING_CODE_PREFIX + '11'.repeat(32)
  await memory.api.mintPairingCode({ residentId, codeHash: sha256(rawCode) })
  return rawCode
}

test('the consent page offers a pairing-code fieldset that never asks for the resident key', async () => {
  const { app } = fixture()
  const session = await begin(app)
  assert.match(session.html, /Have a pairing code instead/iu)
  assert.match(session.html, /name="pairing_code"[^>]*type="password"/iu)
  assert.match(session.html, new RegExp(`name="action" value="pair"`, 'u'))
  assert.match(session.html, /POST \/api\/pair/u)
  assert.match(session.html, /never reveals the resident key/iu)
})

test('a valid pairing code approves the resident and issues a code, never revealing a resident key', async () => {
  const { app, memory } = fixture()
  const pairingCode = await mintedPairingCode(memory)
  const session = await begin(app)
  const response = await browserPost(app, session, {
    action: 'pair', csrf: session.csrf, pairing_code: pairingCode,
  })
  const responseBody = await response.clone().text()
  const responseSurface = `${responseBody}\n${[...response.headers].flat().join('\n')}`
  assert.doesNotMatch(responseSurface, /1f3d9_sk_/i)
  const code = authorizationCode(response)
  const pair = await readTokenPair(await exchangeCode(app, code))
  assert.ok(pair.access_token)
})

test('an unrecognized pairing code is refused as pairing_code_rejected with a retry form', async () => {
  const { app } = fixture()
  const session = await begin(app)
  const response = await browserPost(app, session, {
    action: 'pair', csrf: session.csrf, pairing_code: PAIRING_CODE_PREFIX + '22'.repeat(32),
  })
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')
  const body = await response.text()
  assert.match(body, /pairing code could not be verified/iu)
  assert.match(body, /name="action" value="pair"/u)
  assert.match(body, /name="pairing_code"[^>]*type="password"/iu)
})

test('an expired pairing code is refused the same as an unknown one', async () => {
  const { app, memory } = fixture()
  const pairingCode = await mintedPairingCode(memory)
  memory.expirePairingCode(sha256(pairingCode))
  const session = await begin(app)
  const response = await browserPost(app, session, {
    action: 'pair', csrf: session.csrf, pairing_code: pairingCode,
  })
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')
})

test('a pairing code works exactly once', async () => {
  const { app, memory } = fixture()
  const pairingCode = await mintedPairingCode(memory)
  const firstSession = await begin(app)
  const first = await browserPost(app, firstSession, {
    action: 'pair', csrf: firstSession.csrf, pairing_code: pairingCode,
  })
  authorizationCode(first)

  const secondSession = await begin(app)
  const second = await browserPost(app, secondSession, {
    action: 'pair', csrf: secondSession.csrf, pairing_code: pairingCode,
  })
  assert.equal(second.status, 403)
  assert.equal(second.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')
})
