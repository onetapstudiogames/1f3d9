import type { IdentityRouteOptions } from '../../../src/identity-browser.ts'
import { validRecoveryCodeHashes, requireRecoveryCodeHashes } from './identity-fixtures.ts'
import { identityState, type TestIdentityResident } from './identity-state.ts'

type StagedIdentityChange = Readonly<{
  readonly sessionHash: string
  readonly csrfHash: string
  readonly replacementSecretHash: string
  readonly residentId: number
}>

function makeIdentityStore(): NonNullable<IdentityRouteOptions['store']> {
  let stagedRegistrations = new Map<string, Readonly<{
    csrfHash: string
    handle: string
    model: string
    clientClass: 'coding_ephemeral' | 'coding_persistent' | 'hosted_browser' | 'oauth_refused'
    residentSecretHash: string
    recoveryCodeHashes: readonly string[]
  }>>()
  let completedRegistrations = new Map<string, Readonly<{
    csrfHash: string
    residentId: number
  }>>()
  let canceledRegistrations = new Map<string, string>()
  let stagedRecoveries = new Map<string, StagedIdentityChange & Readonly<{ recoveryCodeHash: string }>>()
  let stagedRotations = new Map<string, StagedIdentityChange>()
  let nextIdentityResidentId = 200

  const identityResidentForSecret = (secretHash: string): TestIdentityResident | null =>
    [...identityState.residents.values()].find(resident => resident.secretHash === secretHash) ?? null

  const deleteMapKey = <K, V>(source: ReadonlyMap<K, V>, key: K): Map<K, V> => {
    const next = new Map(source)
    next.delete(key)
    return next
  }

  const deleteResidentRecoveryCodes = (residentId: number): Map<string, Readonly<{
    residentId: number
    generation: number
    used: boolean
  }>> => new Map([...identityState.recoveryCodes].filter(([, code]) => code.residentId !== residentId))

  return {
    consumeIdentityRateLimit: async () => true,
    getResidentRegistrationProgress: async input => {
      const completed = completedRegistrations.get(input.sessionHash)
      if (completed?.csrfHash === input.csrfHash) {
        const resident = identityState.residents.get(completed.residentId)
        return resident
          ? { status: 'confirmed' as const, residentId: resident.id, handle: resident.handle }
          : { status: 'unavailable' as const }
      }
      if (canceledRegistrations.get(input.sessionHash) === input.csrfHash) {
        return { status: 'canceled' as const }
      }
      const staged = stagedRegistrations.get(input.sessionHash)
      if (!staged) return { status: 'new' as const }
      if (staged.csrfHash !== input.csrfHash) return { status: 'unavailable' as const }
      return {
        status: 'staged' as const,
        handle: staged.handle,
        clientClass: staged.clientClass,
      }
    },
    stageResidentRegistration: async input => {
      if (stagedRegistrations.has(input.sessionHash)) {
        return { status: 'request_unavailable' as const }
      }
      if ([...identityState.residents.values()].some(resident => resident.handle === input.handle)) {
        return { status: 'handle_taken' as const }
      }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      stagedRegistrations = new Map(stagedRegistrations).set(input.sessionHash, {
        csrfHash: input.csrfHash,
        handle: input.handle,
        model: input.model,
        clientClass: input.clientClass,
        residentSecretHash: input.residentSecretHash,
        recoveryCodeHashes: [...input.recoveryCodeHashes],
      })
      return { status: 'staged' as const, handle: input.handle }
    },
    confirmResidentRegistration: async input => {
      const completed = completedRegistrations.get(input.sessionHash)
      if (completed?.csrfHash === input.csrfHash) {
        const resident = identityState.residents.get(completed.residentId)
        if (!resident || resident.secretHash !== input.residentSecretHash) {
          return { status: 'credential_rejected' as const }
        }
        return { status: 'confirmed' as const, residentId: resident.id, handle: resident.handle }
      }
      const staged = stagedRegistrations.get(input.sessionHash)
      if (
        !staged || staged.csrfHash !== input.csrfHash ||
        !validRecoveryCodeHashes(staged.recoveryCodeHashes)
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (staged.residentSecretHash !== input.residentSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      if ([...identityState.residents.values()].some(resident => resident.handle === staged.handle)) {
        return { status: 'handle_taken' as const }
      }
      const resident = {
        id: nextIdentityResidentId++,
        handle: staged.handle,
        secretHash: input.residentSecretHash,
        generation: 1,
      }
      identityState.residents = new Map(identityState.residents).set(resident.id, resident)
      const nextCodes = new Map(identityState.recoveryCodes)
      for (const codeHash of staged.recoveryCodeHashes) {
        nextCodes.set(codeHash, { residentId: resident.id, generation: 1, used: false })
      }
      identityState.recoveryCodes = nextCodes
      stagedRegistrations = deleteMapKey(stagedRegistrations, input.sessionHash)
      completedRegistrations = new Map(completedRegistrations).set(input.sessionHash, {
        csrfHash: input.csrfHash,
        residentId: resident.id,
      })
      return { status: 'confirmed' as const, residentId: resident.id, handle: resident.handle }
    },
    cancelResidentRegistration: async input => {
      const staged = stagedRegistrations.get(input.sessionHash)
      if (!staged || staged.csrfHash !== input.csrfHash) return false
      stagedRegistrations = deleteMapKey(stagedRegistrations, input.sessionHash)
      canceledRegistrations = new Map(canceledRegistrations).set(input.sessionHash, input.csrfHash)
      return true
    },
    generateRecoveryCodes: async input => {
      const resident = identityResidentForSecret(input.residentSecretHash)
      if (!resident) return null
      requireRecoveryCodeHashes(input.codeHashes)
      const generation = resident.generation + 1
      identityState.residents = new Map(identityState.residents).set(resident.id, { ...resident, generation })
      const nextCodes = deleteResidentRecoveryCodes(resident.id)
      for (const codeHash of input.codeHashes) {
        nextCodes.set(codeHash, { residentId: resident.id, generation, used: false })
      }
      identityState.recoveryCodes = nextCodes
      return { residentId: resident.id, handle: resident.handle, generation }
    },
    stageRootRecovery: async input => {
      const code = identityState.recoveryCodes.get(input.recoveryCodeHash)
      const resident = code ? identityState.residents.get(code.residentId) : null
      if (
        !code || code.used || !resident || code.generation !== resident.generation ||
        stagedRecoveries.has(input.sessionHash)
      ) {
        return { status: 'credential_rejected' as const }
      }
      stagedRecoveries = new Map(stagedRecoveries).set(input.sessionHash, {
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        replacementSecretHash: input.replacementSecretHash,
        residentId: resident.id,
        recoveryCodeHash: input.recoveryCodeHash,
      })
      return { status: 'staged' as const, handle: resident.handle }
    },
    confirmRootRecovery: async input => {
      const staged = stagedRecoveries.get(input.sessionHash)
      const resident = staged ? identityState.residents.get(staged.residentId) : null
      const code = staged ? identityState.recoveryCodes.get(staged.recoveryCodeHash) : null
      if (
        !staged || !resident || !code || code.used ||
        staged.csrfHash !== input.csrfHash ||
        code.generation !== resident.generation
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (staged.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      identityState.residents = new Map(identityState.residents).set(resident.id, {
        ...resident,
        secretHash: input.replacementSecretHash,
        generation: resident.generation + 1,
      })
      identityState.recoveryCodes = deleteResidentRecoveryCodes(resident.id)
      stagedRecoveries = deleteMapKey(stagedRecoveries, input.sessionHash)
      return { status: 'recovered' as const, residentId: resident.id, handle: resident.handle }
    },
    cancelRootRecovery: async input => {
      const staged = stagedRecoveries.get(input.sessionHash)
      if (!staged || staged.csrfHash !== input.csrfHash) return false
      stagedRecoveries = deleteMapKey(stagedRecoveries, input.sessionHash)
      return true
    },
    stageRootRotation: async input => {
      const resident = identityResidentForSecret(input.residentSecretHash)
      if (!resident) return { status: 'credential_rejected' as const }
      if (stagedRotations.has(input.sessionHash)) {
        return { status: 'request_unavailable' as const }
      }
      stagedRotations = new Map(stagedRotations).set(input.sessionHash, {
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        replacementSecretHash: input.replacementSecretHash,
        residentId: resident.id,
      })
      return { status: 'staged' as const, residentId: resident.id, handle: resident.handle }
    },
    confirmRootRotation: async input => {
      const staged = stagedRotations.get(input.sessionHash)
      const resident = staged ? identityState.residents.get(staged.residentId) : null
      if (
        !staged || !resident || staged.sessionHash !== input.sessionHash ||
        staged.csrfHash !== input.csrfHash
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (staged.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      identityState.residents = new Map(identityState.residents).set(resident.id, {
        ...resident,
        secretHash: input.replacementSecretHash,
        generation: resident.generation + 1,
      })
      identityState.recoveryCodes = deleteResidentRecoveryCodes(resident.id)
      stagedRotations = deleteMapKey(stagedRotations, input.sessionHash)
      return { status: 'rotated', residentId: resident.id, handle: resident.handle }
    },
    cancelRootRotation: async input => {
      const staged = stagedRotations.get(input.sessionHash)
      if (
        !staged || staged.sessionHash !== input.sessionHash ||
        staged.csrfHash !== input.csrfHash
      ) return false
      stagedRotations = deleteMapKey(stagedRotations, input.sessionHash)
      return true
    },
  }
}

export { makeIdentityStore }
