import { sha256, type Resident } from '../../../src/core.ts'
import type { OAuthRouteOptions } from '../../../src/oauth.ts'
import type { AuthorizationCodeRecord, AuthorizationRequestInput, AuthorizationRequestRecord } from '../../../src/oauth-store.ts'
import { existingResidentKey, validRecoveryCodeHashes, requireRecoveryCodeHashes } from './identity-fixtures.ts'
import { identityState } from './identity-state.ts'

interface StoredRequest extends AuthorizationRequestRecord {
  readonly sessionHash: string
  readonly csrfHash: string
  readonly newSecretHash: string | null
  readonly newRecoveryCodeHashes: readonly string[] | null
  readonly used: boolean
}

interface StoredCode extends AuthorizationCodeRecord {
  readonly used: boolean
}

interface StoredAccessGrant {
  readonly familyId: number
}

interface StoredRefreshGrant {
  readonly familyId: number
  readonly used: boolean
}

interface StoredTokenFamily {
  readonly residentId: number
  readonly clientId: string
  readonly resource: string
  readonly scope: string
  readonly revoked: boolean
}

type OAuthStore = NonNullable<OAuthRouteOptions['store']>

function makeMemoryStore(): OAuthStore {
  const requests = new Map<string, StoredRequest>()
  const codes = new Map<string, StoredCode>()
  const accessGrants = new Map<string, StoredAccessGrant>()
  const refreshGrants = new Map<string, StoredRefreshGrant>()
  const tokenFamilies = new Map<number, StoredTokenFamily>()
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
  let nextFamilyId = 1

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
        newRecoveryCodeHashes: null,
        used: false,
      }
      requests.set(input.sessionHash, record)
    },

    getAuthorizationRequest: async sessionHash => {
      const request = requests.get(sessionHash)
      return request?.used ? null : (request ?? null)
    },

    getAuthorizationRequestProgress: async input => {
      const request = requests.get(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) return null
      if (
        request.used && request.resident_id !== null &&
        request.root_key_confirmed_at !== null
      ) {
        const resident = residents.get(request.resident_id)
        return resident
          ? { status: 'confirmed' as const, request, residentId: resident.id, handle: resident.handle }
          : { status: 'unavailable' as const, request }
      }
      if (request.used && request.resident_id === null) {
        return { status: 'canceled' as const, request }
      }
      return { status: 'unavailable' as const, request }
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
        newRecoveryCodeHashes: null,
        used: true,
      })
      return { redirectUri: request.redirect_uri, state: request.state }
    },

    approveExistingResidentAndIssueAuthorizationCode: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.intent !== null) {
        return { status: 'request_unavailable' as const }
      }
      if (input.residentSecretHash !== sha256(existingResidentKey)) {
        return { status: 'resident_key_rejected' as const }
      }
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
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
    },

    stageNewResidentRegistration: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.intent !== null || request.resident_id !== null) {
        return { status: 'request_unavailable' as const }
      }
      const handleTaken = [...residents.values()].some(resident => resident.handle === input.handle)
      if (handleTaken) return { status: 'handle_taken' as const }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      requests.set(input.sessionHash, {
        ...request,
        intent: 'new',
        new_handle: input.handle,
        new_model: input.model,
        newSecretHash: input.residentSecretHash,
        newRecoveryCodeHashes: [...input.recoveryCodeHashes],
      })
      return { status: 'staged' as const, handle: input.handle }
    },

    confirmNewResidentAndIssueAuthorizationCode: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (
        !request || request.intent !== 'new' || request.resident_id !== null ||
        request.new_handle === null || request.new_model === null || request.newSecretHash === null ||
        request.newRecoveryCodeHashes === null || !validRecoveryCodeHashes(request.newRecoveryCodeHashes)
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (input.residentSecretHash !== request.newSecretHash) {
        return { status: 'confirmation_rejected' as const }
      }
      if ([...residents.values()].some(resident => resident.handle === request.new_handle)) {
        return { status: 'handle_taken' as const }
      }
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
      identityState.residents = new Map(identityState.residents).set(residentId, {
        id: residentId,
        handle: request.new_handle,
        secretHash: request.newSecretHash,
        generation: 1,
      })
      const nextRecoveryCodes = new Map(identityState.recoveryCodes)
      for (const codeHash of request.newRecoveryCodeHashes) {
        nextRecoveryCodes.set(codeHash, { residentId, generation: 1, used: false })
      }
      identityState.recoveryCodes = nextRecoveryCodes
      requests.set(input.sessionHash, {
        ...request,
        resident_id: residentId,
        newSecretHash: null,
        newRecoveryCodeHashes: null,
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
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
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
      const familyId = nextFamilyId++
      tokenFamilies.set(familyId, {
        residentId: code.residentId,
        clientId: code.clientId,
        resource: code.resource,
        scope: code.scope,
        revoked: false,
      })
      accessGrants.set(input.accessTokenHash, { familyId })
      refreshGrants.set(input.refreshTokenHash, { familyId, used: false })
      return true
    },

    resolveRefreshRateLimitSubject: async input => {
      const presented = refreshGrants.get(input.presentedRefreshTokenHash)
      const family = presented ? tokenFamilies.get(presented.familyId) : undefined
      if (
        !presented || !family || family.revoked ||
        family.clientId !== input.clientId || family.resource !== input.resource
      ) return { status: 'junk' as const }
      return presented.used
        ? { status: 'reused' as const }
        : { status: 'active' as const, connectionKey: String(presented.familyId) }
    },

    rotateRefreshToken: async input => {
      const presented = refreshGrants.get(input.presentedRefreshTokenHash)
      const family = presented ? tokenFamilies.get(presented.familyId) : undefined
      if (presented?.used && family) {
        tokenFamilies.set(presented.familyId, { ...family, revoked: true })
        return 'reused'
      }
      if (
        !presented || !family || family.revoked ||
        family.clientId !== input.clientId || family.resource !== input.resource
      ) return 'invalid'
      refreshGrants.set(input.presentedRefreshTokenHash, { ...presented, used: true })
      accessGrants.set(input.accessTokenHash, { familyId: presented.familyId })
      refreshGrants.set(input.newRefreshTokenHash, { familyId: presented.familyId, used: false })
      return 'rotated'
    },
    revokeTokenFamilyByToken: async input => {
      const grant = accessGrants.get(input.tokenHash) ?? refreshGrants.get(input.tokenHash)
      const family = grant ? tokenFamilies.get(grant.familyId) : undefined
      if (grant && family?.clientId === input.clientId) {
        tokenFamilies.set(grant.familyId, { ...family, revoked: true })
      }
    },
    resolveOAuthAccessToken: async input => {
      const grant = accessGrants.get(input.accessTokenHash)
      const family = grant ? tokenFamilies.get(grant.familyId) : undefined
      if (!family || family.revoked || family.resource !== input.resource || family.scope !== input.scope) {
        return null
      }
      const resident = residents.get(family.residentId)
      return resident ? { ...resident } : null
    },
    consumeOAuthRateLimit: async () => ({ admitted: true, retryAfterSeconds: 17 }),
  }
}

export { makeMemoryStore }
