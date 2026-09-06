import { sha256, type Resident } from '../../src/core.ts'
import type {
  AuthorizationCodeRecord,
  AuthorizationRequestInput,
  AuthorizationRequestRecord,
  OAuthRateLimitResult,
} from '../../src/oauth-store.ts'

type OAuthStore = typeof import('../../src/oauth-store.ts').postgresOAuthStore
type TestOAuthStore = OAuthStore & {
  cancelAuthorizationRequest(input: {
    sessionHash: string
    csrfHash: string
  }): Promise<{ redirectUri: string; state: string } | null>
}

export const EXISTING_KEY = `1f3d9_sk_${'ab'.repeat(24)}`
const RECOVERY_CODE_HASH = /^[0-9a-f]{64}$/

export function rateLimitResult(admitted: boolean, retryAfterSeconds = 17): OAuthRateLimitResult {
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

export class MemoryOAuthStore {
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

    peekPairingCodeResident: async (
      codeHash: Parameters<OAuthStore['peekPairingCodeResident']>[0],
    ) => {
      const pairing = this.pairingCodes.get(codeHash)
      if (!pairing || pairing.usedAt !== null || pairing.expiresAt <= Date.now()) {
        return { status: 'pairing_code_rejected' as const }
      }
      const resident = this.residents.get(pairing.residentId)
      if (!resident) return { status: 'pairing_code_rejected' as const }
      return { status: 'valid' as const, handle: resident.handle }
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
