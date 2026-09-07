import { sha256 } from '../../../src/core.ts'

export const ROOT_KEY = '1f3d9_sk_' + '11'.repeat(24)
export const OTHER_ROOT_KEY = '1f3d9_sk_' + '22'.repeat(24)
const RECOVERY_CODE_HASH = /^[0-9a-f]{64}$/

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

type Registration = {
  sessionHash: string
  csrfHash: string
  handle: string
  model: string
  clientClass: 'coding_ephemeral' | 'coding_persistent' | 'hosted_browser' | 'oauth_refused'
  residentSecretHash: string
  recoveryCodeHashes: string[]
}

export type MemoryStoreOptions = {
  deniedAttemptKind?:
    | 'join_confirm'
    | 'join_stage'
    | 'recovery_begin'
    | 'recovery_confirm'
    | 'recovery_generate'
    | 'rotation_begin'
    | 'rotation_confirm'
  deniedRateCall?: number
  registrationProgressOutcome?: 'error' | 'normal' | 'unavailable'
  registrationProgressAfterFailedStage?: 'canceled' | 'expired' | 'unavailable'
  registrationResumeClientClass?: 'legacy_unknown'
  registrationStageBarrier?: () => Promise<void>
  registrationStageOutcome?: 'error' | 'handle_taken' | 'missing' | 'staged'
  registrationConfirmOutcome?: 'error' | 'handle_taken' | 'normal' | 'request_unavailable'
  registrationCancelOutcome?: 'confirmation_won' | 'error' | 'normal'
  confirmationRaceCompleted?: boolean
  rotationConfirmRateLimited?: boolean
}

export function memoryStore(options: MemoryStoreOptions = {}) {
  let registration: Registration | null = null
  let confirmed = false
  let canceledRegistration: { sessionHash: string; csrfHash: string } | null = null
  let recoveryGeneration = 0
  let recoveryCodeHashes: string[] = []
  let stagedRecovery: {
    sessionHash: string
    csrfHash: string
    replacementSecretHash: string
    recoveryCodeHash: string
  } | null = null
  let recovered = false
  let stagedRotation: {
    sessionHash: string
    csrfHash: string
    residentSecretHash: string
    replacementSecretHash: string
  } | null = null
  let rotated = false
  let rateCalls = 0
  let registrationStageFailed = false
  const calls: Array<{ method: string; input: unknown }> = []

  const store = {
    async consumeIdentityRateLimit(input: { attemptKind?: string }) {
      calls.push({ method: 'rate', input })
      rateCalls += 1
      return input.attemptKind !== options.deniedAttemptKind &&
        rateCalls !== options.deniedRateCall
    },
    async getResidentRegistrationProgress(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'registrationProgress', input })
      if (options.registrationProgressOutcome === 'error') {
        throw new Error('registration progress unavailable')
      }
      if (options.registrationProgressOutcome === 'unavailable') {
        return { status: 'unavailable' as const }
      }
      if (registrationStageFailed && options.registrationProgressAfterFailedStage) {
        return { status: options.registrationProgressAfterFailedStage }
      }
      if (
        canceledRegistration?.sessionHash === input.sessionHash &&
        canceledRegistration.csrfHash === input.csrfHash
      ) return { status: 'canceled' as const }
      if (registration?.sessionHash !== input.sessionHash || registration.csrfHash !== input.csrfHash) {
        return { status: 'new' as const }
      }
      if (confirmed) {
        return { status: 'confirmed' as const, residentId: 27, handle: registration.handle }
      }
      return {
        status: 'staged' as const,
        handle: registration.handle,
        clientClass: options.registrationResumeClientClass ?? registration.clientClass,
      }
    },
    async stageResidentRegistration(input: Registration) {
      calls.push({ method: 'stageRegistration', input })
      if (options.registrationStageOutcome === 'error') throw new Error('registration store unavailable')
      if (options.registrationStageOutcome === 'missing') {
        registrationStageFailed = true
        return { status: 'request_unavailable' as const }
      }
      if (options.registrationStageOutcome === 'handle_taken') return { status: 'handle_taken' as const }
      await options.registrationStageBarrier?.()
      if (registration?.sessionHash === input.sessionHash && registration.csrfHash === input.csrfHash) {
        return { status: 'request_unavailable' as const }
      }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      registration = { ...input, recoveryCodeHashes: [...input.recoveryCodeHashes] }
      return { status: 'staged' as const, handle: input.handle }
    },
    async confirmResidentRegistration(input: {
      sessionHash: string
      csrfHash: string
      residentSecretHash: string
      jsonDoorHumanApprovalDeclared: boolean | null
    }) {
      calls.push({ method: 'confirmRegistration', input })
      if (options.registrationConfirmOutcome === 'error') throw new Error('registration confirmation unavailable')
      if (options.registrationConfirmOutcome === 'handle_taken') {
        return { status: 'handle_taken' as const }
      }
      if (options.registrationConfirmOutcome === 'request_unavailable') {
        if (options.confirmationRaceCompleted) confirmed = true
        return { status: 'request_unavailable' as const }
      }
      if (
        !registration ||
        registration.sessionHash !== input.sessionHash ||
        registration.csrfHash !== input.csrfHash ||
        !validRecoveryCodeHashes(registration.recoveryCodeHashes)
      ) return { status: 'request_unavailable' as const }
      if (confirmed) {
        return registration.residentSecretHash === input.residentSecretHash
          ? { status: 'confirmed' as const, residentId: 27, handle: registration.handle }
          : { status: 'credential_rejected' as const }
      }
      if (registration.residentSecretHash !== input.residentSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      confirmed = true
      recoveryGeneration += 1
      recoveryCodeHashes = [...registration.recoveryCodeHashes]
      return { status: 'confirmed' as const, residentId: 27, handle: registration.handle }
    },
    async cancelResidentRegistration(input: unknown) {
      calls.push({ method: 'cancelRegistration', input })
      if (options.registrationCancelOutcome === 'error') {
        throw new Error('registration cancellation unavailable')
      }
      if (options.registrationCancelOutcome === 'confirmation_won') {
        confirmed = true
        return false
      }
      if (!registration || confirmed) return false
      canceledRegistration = {
        sessionHash: registration.sessionHash,
        csrfHash: registration.csrfHash,
      }
      registration = null
      return true
    },
    async generateRecoveryCodes(input: {
      residentSecretHash: string
      codeHashes: string[]
    }) {
      calls.push({ method: 'generateRecoveryCodes', input })
      if (input.residentSecretHash !== sha256(ROOT_KEY)) return null
      requireRecoveryCodeHashes(input.codeHashes)
      recoveryGeneration += 1
      recoveryCodeHashes = [...input.codeHashes]
      return { residentId: 7, handle: 'existing-resident', generation: recoveryGeneration }
    },
    async stageRootRecovery(input: {
      sessionHash: string
      csrfHash: string
      recoveryCodeHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'stageRootRecovery', input })
      if (!recoveryCodeHashes.includes(input.recoveryCodeHash) || recovered) {
        return { status: 'credential_rejected' as const }
      }
      stagedRecovery = { ...input }
      return { status: 'staged' as const, handle: 'existing-resident' }
    },
    async confirmRootRecovery(input: {
      sessionHash: string
      csrfHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'confirmRootRecovery', input })
      if (
        recovered || !stagedRecovery ||
        stagedRecovery.sessionHash !== input.sessionHash ||
        stagedRecovery.csrfHash !== input.csrfHash
      ) return { status: 'request_unavailable' as const }
      if (stagedRecovery.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      recovered = true
      return { status: 'recovered' as const, residentId: 7, handle: 'existing-resident' }
    },
    async cancelRootRecovery(input: unknown) {
      calls.push({ method: 'cancelRootRecovery', input })
      stagedRecovery = null
      return true
    },
    async stageRootRotation(input: {
      sessionHash: string
      csrfHash: string
      residentSecretHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'stageRootRotation', input })
      if (input.residentSecretHash !== sha256(ROOT_KEY) || rotated) {
        return { status: 'credential_rejected' as const }
      }
      stagedRotation = { ...input }
      return { status: 'staged' as const, residentId: 7, handle: 'existing-resident' }
    },
    async confirmRootRotation(input: {
      sessionHash: string
      csrfHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'confirmRootRotation', input })
      if (options.rotationConfirmRateLimited) return { status: 'rate_limited' as const }
      if (
        rotated || !stagedRotation ||
        stagedRotation.sessionHash !== input.sessionHash ||
        stagedRotation.csrfHash !== input.csrfHash
      ) return { status: 'request_unavailable' as const }
      if (stagedRotation.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      rotated = true
      return { status: 'rotated' as const, residentId: 7, handle: 'existing-resident' }
    },
    async cancelRootRotation(input: {
      sessionHash: string
      csrfHash: string
    }) {
      calls.push({ method: 'cancelRootRotation', input })
      if (
        !stagedRotation || stagedRotation.sessionHash !== input.sessionHash ||
        stagedRotation.csrfHash !== input.csrfHash
      ) return false
      stagedRotation = null
      return true
    },
  }

  return {
    store,
    calls,
    registration: () => registration
      ? { ...registration, recoveryCodeHashes: [...registration.recoveryCodeHashes] }
      : null,
    confirmed: () => confirmed,
    recovered: () => recovered,
    stagedRotation: () => stagedRotation,
    rotated: () => rotated,
  }
}
