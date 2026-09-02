// Decision row 74: the JSON identity doors. This exercises
// POST /api/register, POST /api/rotate, and POST /api/recovery end to end
// against a faithful in-memory IdentityStore, proving the one-time reveal,
// the coding-client-only client_class gate, the human_approved gate, and
// every documented refusal.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import { mountIdentityApiRoutes } from '../src/identity-api.ts'
import type {
  IdentityAttemptKind,
  RecoveryConfirmationResult,
  RecoveryGenerationResult,
  RecoveryStageResult,
  RegistrationConfirmationResult,
  RegistrationClientClass,
  RegistrationProgressResult,
  RegistrationStageInput,
  RegistrationStageResult,
  RootRotationResult,
  RotationStageResult,
} from '../src/identity-store.ts'

const ROOT_KEY = /^1f3d9_sk_[0-9a-f]{48}$/u

interface MemoryOptions {
  denyAttemptKind?: IdentityAttemptKind
  denyAfterCalls?: number
}

function memoryIdentityStore(options: MemoryOptions = {}) {
  const residentsByHandle = new Map<string, { id: number; secretHash: string; recoveryGeneration: number }>()
  const residentsById = new Map<number, { handle: string; secretHash: string; recoveryGeneration: number }>()
  const registrations = new Map<string, {
    handle: string
    model: string
    clientClass: RegistrationClientClass
    secretHash: string
    recoveryCodeHashes: string[]
    humanApproved: boolean | undefined
    status: 'staged' | 'confirmed' | 'canceled'
    residentId?: number
  }>()
  const recoveryCodes = new Map<string, { residentId: number; generation: number; used: boolean; invalidated: boolean }>()
  const rotations = new Map<string, {
    residentId: number
    residentSecretHash: string
    replacementSecretHash: string
    recoveryGeneration: number
    settled: boolean
  }>()
  const recoveries = new Map<string, {
    residentId: number
    codeHash: string
    generation: number
    replacementSecretHash: string
    settled: boolean
  }>()
  let nextResidentId = 100
  let rateLimitCalls = 0
  const rateLimitLog: { attemptKind: string; bucketHash: string }[] = []

  const key = (sessionHash: string, csrfHash: string) => `${sessionHash}:${csrfHash}`

  return {
    residentsByHandle,
    residentsById,
    registrations,
    rateLimitLog,
    seedResident(handle: string, secretKey: string): number {
      const id = nextResidentId++
      const record = { id, secretHash: sha256(secretKey), recoveryGeneration: 1 }
      residentsByHandle.set(handle, record)
      residentsById.set(id, { handle, secretHash: record.secretHash, recoveryGeneration: 1 })
      return id
    },
    seedRecoveryCode(residentId: number, code: string, generation = 1): void {
      recoveryCodes.set(sha256(code), { residentId, generation, used: false, invalidated: false })
    },

    async consumeIdentityRateLimit(input: {
      bucketHash: string
      attemptKind: IdentityAttemptKind
      maximum: number
    }): Promise<boolean> {
      rateLimitCalls += 1
      rateLimitLog.push({ attemptKind: input.attemptKind, bucketHash: input.bucketHash })
      if (options.denyAttemptKind === input.attemptKind) {
        if (options.denyAfterCalls === undefined) return false
        return rateLimitCalls > options.denyAfterCalls ? false : true
      }
      return true
    },

    async getResidentRegistrationProgress(input: {
      sessionHash: string
      csrfHash: string
    }): Promise<RegistrationProgressResult> {
      const pending = registrations.get(key(input.sessionHash, input.csrfHash))
      if (!pending) return { status: 'new' }
      if (pending.status === 'confirmed' && pending.residentId !== undefined) {
        return { status: 'confirmed', residentId: pending.residentId, handle: pending.handle }
      }
      if (pending.status === 'canceled') return { status: 'canceled' }
      return { status: 'staged', handle: pending.handle, clientClass: pending.clientClass }
    },

    async stageResidentRegistration(input: RegistrationStageInput): Promise<RegistrationStageResult> {
      if (residentsByHandle.has(input.handle)) return { status: 'handle_taken' }
      registrations.set(key(input.sessionHash, input.csrfHash), {
        handle: input.handle,
        model: input.model,
        clientClass: input.clientClass,
        secretHash: input.residentSecretHash,
        recoveryCodeHashes: [...input.recoveryCodeHashes],
        humanApproved: input.humanApproved,
        status: 'staged',
      })
      return { status: 'staged', handle: input.handle }
    },

    async confirmResidentRegistration(input: {
      sessionHash: string
      csrfHash: string
      residentSecretHash: string
    }): Promise<RegistrationConfirmationResult> {
      const pending = registrations.get(key(input.sessionHash, input.csrfHash))
      if (!pending) return { status: 'request_unavailable' }
      if (pending.status === 'confirmed' && pending.residentId !== undefined) {
        return { status: 'confirmed', residentId: pending.residentId, handle: pending.handle }
      }
      if (pending.status !== 'staged') return { status: 'request_unavailable' }
      if (pending.secretHash !== input.residentSecretHash) return { status: 'credential_rejected' }
      if (residentsByHandle.has(pending.handle)) {
        pending.status = 'canceled'
        return { status: 'handle_taken' }
      }
      const id = nextResidentId++
      residentsByHandle.set(pending.handle, { id, secretHash: pending.secretHash, recoveryGeneration: 1 })
      residentsById.set(id, { handle: pending.handle, secretHash: pending.secretHash, recoveryGeneration: 1 })
      for (const hash of pending.recoveryCodeHashes) {
        recoveryCodes.set(hash, { residentId: id, generation: 1, used: false, invalidated: false })
      }
      pending.status = 'confirmed'
      pending.residentId = id
      return { status: 'confirmed', residentId: id, handle: pending.handle }
    },

    async cancelResidentRegistration(input: { sessionHash: string; csrfHash: string }): Promise<boolean> {
      const pending = registrations.get(key(input.sessionHash, input.csrfHash))
      if (!pending || pending.status !== 'staged') return false
      pending.status = 'canceled'
      return true
    },

    async generateRecoveryCodes(input: {
      residentSecretHash: string
      codeHashes: string[]
    }): Promise<RecoveryGenerationResult | null> {
      const found = [...residentsById.entries()].find(([, record]) => record.secretHash === input.residentSecretHash)
      if (!found) return null
      const [id, record] = found
      record.recoveryGeneration += 1
      for (const [hash, code] of recoveryCodes) {
        if (code.residentId === id && !code.used) code.invalidated = true
      }
      for (const hash of input.codeHashes) {
        recoveryCodes.set(hash, { residentId: id, generation: record.recoveryGeneration, used: false, invalidated: false })
      }
      return { residentId: id, handle: record.handle, generation: record.recoveryGeneration }
    },

    async stageRootRecovery(input: {
      sessionHash: string
      csrfHash: string
      recoveryCodeHash: string
      replacementSecretHash: string
    }): Promise<RecoveryStageResult> {
      const code = recoveryCodes.get(input.recoveryCodeHash)
      if (!code || code.used || code.invalidated) return { status: 'credential_rejected' }
      const resident = residentsById.get(code.residentId)
      if (!resident || resident.recoveryGeneration !== code.generation) return { status: 'credential_rejected' }
      recoveries.set(key(input.sessionHash, input.csrfHash), {
        residentId: code.residentId,
        codeHash: input.recoveryCodeHash,
        generation: code.generation,
        replacementSecretHash: input.replacementSecretHash,
        settled: false,
      })
      return { status: 'staged', handle: resident.handle }
    },

    async confirmRootRecovery(input: {
      sessionHash: string
      csrfHash: string
      replacementSecretHash: string
    }): Promise<RecoveryConfirmationResult> {
      const staged = recoveries.get(key(input.sessionHash, input.csrfHash))
      if (!staged || staged.settled) return { status: 'request_unavailable' }
      if (staged.replacementSecretHash !== input.replacementSecretHash) return { status: 'credential_rejected' }
      const resident = residentsById.get(staged.residentId)
      if (!resident) return { status: 'request_unavailable' }
      resident.secretHash = staged.replacementSecretHash
      resident.recoveryGeneration += 1
      const byHandle = residentsByHandle.get(resident.handle)
      if (byHandle) byHandle.secretHash = staged.replacementSecretHash
      const code = recoveryCodes.get(staged.codeHash)
      if (code) code.used = true
      staged.settled = true
      return { status: 'recovered', residentId: staged.residentId, handle: resident.handle }
    },

    async cancelRootRecovery(input: { sessionHash: string; csrfHash: string }): Promise<boolean> {
      const staged = recoveries.get(key(input.sessionHash, input.csrfHash))
      if (!staged || staged.settled) return false
      staged.settled = true
      return true
    },

    async stageRootRotation(input: {
      sessionHash: string
      csrfHash: string
      residentSecretHash: string
      replacementSecretHash: string
    }): Promise<RotationStageResult> {
      const found = [...residentsById.entries()].find(([, record]) => record.secretHash === input.residentSecretHash)
      if (!found) return { status: 'credential_rejected' }
      const [id, record] = found
      rotations.set(key(input.sessionHash, input.csrfHash), {
        residentId: id,
        residentSecretHash: input.residentSecretHash,
        replacementSecretHash: input.replacementSecretHash,
        recoveryGeneration: record.recoveryGeneration,
        settled: false,
      })
      return { status: 'staged', residentId: id, handle: record.handle }
    },

    async confirmRootRotation(input: {
      sessionHash: string
      csrfHash: string
      replacementSecretHash: string
    }): Promise<RootRotationResult> {
      const staged = rotations.get(key(input.sessionHash, input.csrfHash))
      if (!staged || staged.settled) return { status: 'request_unavailable' }
      if (staged.replacementSecretHash !== input.replacementSecretHash) return { status: 'credential_rejected' }
      const resident = residentsById.get(staged.residentId)
      if (!resident) return { status: 'request_unavailable' }
      resident.secretHash = staged.replacementSecretHash
      resident.recoveryGeneration += 1
      const byHandle = residentsByHandle.get(resident.handle)
      if (byHandle) byHandle.secretHash = staged.replacementSecretHash
      staged.settled = true
      return { status: 'rotated', residentId: staged.residentId, handle: resident.handle }
    },

    async cancelRootRotation(input: { sessionHash: string; csrfHash: string }): Promise<boolean> {
      const staged = rotations.get(key(input.sessionHash, input.csrfHash))
      if (!staged || staged.settled) return false
      staged.settled = true
      return true
    },
  }
}

function appFor(options: {
  store?: ReturnType<typeof memoryIdentityStore>
  rotationEnabled?: boolean
  recoveryEnabled?: boolean
} = {}) {
  const app = new Hono()
  mountIdentityApiRoutes(app, {
    environment: {
      PUBLIC_ORIGIN: 'https://city.test',
      IDENTITY_ROTATION_ENABLED: options.rotationEnabled === false ? 'false' : 'true',
      IDENTITY_RECOVERY_ENABLED: options.recoveryEnabled === false ? 'false' : 'true',
    },
    store: options.store ?? memoryIdentityStore(),
  })
  return app
}

function postJson(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const STAGE_BODY = {
  action: 'stage',
  handle: 'shipmate-42',
  client_class: 'coding_persistent',
  human_approved: true,
}

test('a full register -> confirm cycle reveals the key and codes exactly once and never again', async () => {
  const app = appFor()
  const staged = await postJson(app, '/api/register', STAGE_BODY)
  assert.equal(staged.status, 200)
  const stagedBody = await staged.json() as {
    status: string; handle: string; stage_token: string
    resident_key: string; recovery_codes: string[]
  }
  assert.equal(stagedBody.status, 'staged')
  assert.equal(stagedBody.handle, 'shipmate-42')
  assert.match(stagedBody.resident_key, ROOT_KEY)
  assert.equal(stagedBody.recovery_codes.length, 8)
  assert.equal(new Set(stagedBody.recovery_codes).size, 8)

  const confirmed = await postJson(app, '/api/register', {
    action: 'confirm', stage_token: stagedBody.stage_token, resident_key: stagedBody.resident_key,
  })
  assert.equal(confirmed.status, 200)
  const confirmedBody = await confirmed.json() as { status: string; resident_id: number; handle: string }
  assert.equal(confirmedBody.status, 'confirmed')
  assert.equal(confirmedBody.handle, 'shipmate-42')
  assert.equal(typeof confirmedBody.resident_id, 'number')

  // A repeated confirm with the same stage_token and key returns the same
  // resident and never reveals the secrets a second time.
  const replay = await postJson(app, '/api/register', {
    action: 'confirm', stage_token: stagedBody.stage_token, resident_key: stagedBody.resident_key,
  })
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), confirmedBody)
})

test('registration refuses a client_class other than coding_persistent or coding_ephemeral', async () => {
  const app = appFor()
  for (const clientClass of ['hosted_browser', 'oauth_refused', 'not-a-class']) {
    const response = await postJson(app, '/api/register', { ...STAGE_BODY, client_class: clientClass })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string; next_step: string }
    assert.match(body.error, /coding_persistent.*coding_ephemeral|coding_ephemeral.*coding_persistent/isu)
    assert.match(body.next_step, /\/join/u)
  }
})

test('registration refuses without human_approved: true', async () => {
  const app = appFor()
  for (const value of [false, 'true', 1, undefined]) {
    const body: Record<string, unknown> = { ...STAGE_BODY }
    if (value === undefined) delete body.human_approved
    else body.human_approved = value
    const response = await postJson(app, '/api/register', body)
    assert.equal(response.status, 400)
    assert.match(
      (await response.json() as { error: string }).error,
      /human_approved must be exactly true/iu,
    )
  }
})

test('registration refuses a reserved handle before touching the store', async () => {
  const app = appFor()
  const response = await postJson(app, '/api/register', { ...STAGE_BODY, handle: 'founder' })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'reserved_handle')
})

test('registration refuses an already-taken handle', async () => {
  const store = memoryIdentityStore()
  store.seedResident('shipmate-42', `1f3d9_sk_${'aa'.repeat(24)}`)
  const app = appFor({ store })
  const response = await postJson(app, '/api/register', STAGE_BODY)
  assert.equal(response.status, 409)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'handle_taken')
})

test('confirming with the wrong key is refused and the stage_token stays usable', async () => {
  const app = appFor()
  const staged = await postJson(app, '/api/register', STAGE_BODY)
  const stagedBody = await staged.json() as { stage_token: string }
  const wrongKey = `1f3d9_sk_${'ff'.repeat(24)}`
  const wrong = await postJson(app, '/api/register', {
    action: 'confirm', stage_token: stagedBody.stage_token, resident_key: wrongKey,
  })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.headers.get('x-1f3d9-reason'), 'credential_rejected')
})

test('registration stage is rate-limited per IP and the confirm step is rate-limited per stage_token', async () => {
  const staged = appFor({ store: memoryIdentityStore({ denyAttemptKind: 'join_stage' }) })
  const stageResponse = await postJson(staged, '/api/register', STAGE_BODY)
  assert.equal(stageResponse.status, 429)
  assert.equal(stageResponse.headers.get('x-1f3d9-reason'), 'rate_limited')

  const confirmStore = memoryIdentityStore({ denyAttemptKind: 'join_confirm' })
  const app = appFor({ store: confirmStore })
  const stage = await postJson(app, '/api/register', STAGE_BODY)
  const stageBody = await stage.json() as { stage_token: string; resident_key: string }
  const confirmResponse = await postJson(app, '/api/register', {
    action: 'confirm', stage_token: stageBody.stage_token, resident_key: stageBody.resident_key,
  })
  assert.equal(confirmResponse.status, 429)
  assert.equal(confirmResponse.headers.get('x-1f3d9-reason'), 'rate_limited')
})

test('an oversized or non-JSON body is refused before any store call', async () => {
  const store = memoryIdentityStore()
  const app = appFor({ store })
  const oversized = await app.request('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stage', handle: 'x'.repeat(9_000) }),
  })
  assert.equal(oversized.status, 400)
  assert.match((await oversized.json() as { error: string }).error, /8192 bytes/u)
  assert.equal(store.rateLimitLog.length, 0)
})

test('unexpected fields on any action are refused', async () => {
  const app = appFor()
  const response = await postJson(app, '/api/register', { ...STAGE_BODY, extra: 'nope' })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'unexpected_form_fields')
})

test('rotation is unavailable with a 503 when IDENTITY_ROTATION_ENABLED is off', async () => {
  const app = appFor({ rotationEnabled: false })
  const response = await postJson(app, '/api/rotate', { action: 'begin', resident_key: `1f3d9_sk_${'ab'.repeat(24)}` })
  assert.equal(response.status, 503)
  assert.match((await response.json() as { error: string }).error, /\/api\/rotate is unavailable on this deployment/u)
})

test('recovery is unavailable with a 503 when IDENTITY_RECOVERY_ENABLED is off', async () => {
  const app = appFor({ recoveryEnabled: false })
  const response = await postJson(app, '/api/recovery', { action: 'generate', resident_key: `1f3d9_sk_${'ab'.repeat(24)}` })
  assert.equal(response.status, 503)
  assert.match((await response.json() as { error: string }).error, /\/api\/recovery is unavailable on this deployment/u)
})

test('a full rotate begin -> confirm cycle replaces the key and the old key stops working', async () => {
  const store = memoryIdentityStore()
  const originalKey = `1f3d9_sk_${'11'.repeat(24)}`
  store.seedResident('rotator', originalKey)
  const app = appFor({ store })

  const begin = await postJson(app, '/api/rotate', { action: 'begin', resident_key: originalKey })
  assert.equal(begin.status, 200)
  const beginBody = await begin.json() as { status: string; stage_token: string; resident_key: string; handle: string }
  assert.equal(beginBody.status, 'staged')
  assert.equal(beginBody.handle, 'rotator')
  assert.match(beginBody.resident_key, ROOT_KEY)
  assert.notEqual(beginBody.resident_key, originalKey)

  const confirm = await postJson(app, '/api/rotate', {
    action: 'confirm', stage_token: beginBody.stage_token, resident_key: beginBody.resident_key,
  })
  assert.equal(confirm.status, 200)
  const confirmBody = await confirm.json() as { status: string; handle: string }
  assert.equal(confirmBody.status, 'rotated')
  assert.equal(confirmBody.handle, 'rotator')

  const staleBegin = await postJson(app, '/api/rotate', { action: 'begin', resident_key: originalKey })
  assert.equal(staleBegin.status, 403)
  assert.equal(staleBegin.headers.get('x-1f3d9-reason'), 'credential_rejected')
})

test('rotate begin with a malformed key is refused', async () => {
  const app = appFor()
  const response = await postJson(app, '/api/rotate', { action: 'begin', resident_key: 'not-a-key' })
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'credential_rejected')
})

test('rotate cancel leaves the old key in place', async () => {
  const store = memoryIdentityStore()
  const originalKey = `1f3d9_sk_${'22'.repeat(24)}`
  store.seedResident('canceler', originalKey)
  const app = appFor({ store })
  const begin = await postJson(app, '/api/rotate', { action: 'begin', resident_key: originalKey })
  const beginBody = await begin.json() as { stage_token: string }
  const cancel = await postJson(app, '/api/rotate', { action: 'cancel', stage_token: beginBody.stage_token })
  assert.equal(cancel.status, 200)
  assert.deepEqual(await cancel.json(), { status: 'canceled' })
})

test('a full recovery generate -> begin -> confirm cycle replaces the key with an unused code', async () => {
  const store = memoryIdentityStore()
  const originalKey = `1f3d9_sk_${'33'.repeat(24)}`
  const residentId = store.seedResident('recoverer', originalKey)
  const app = appFor({ store })

  const generated = await postJson(app, '/api/recovery', { action: 'generate', resident_key: originalKey })
  assert.equal(generated.status, 200)
  const generatedBody = await generated.json() as { status: string; recovery_codes: string[]; handle: string }
  assert.equal(generatedBody.status, 'generated')
  assert.equal(generatedBody.recovery_codes.length, 8)
  assert.equal(generatedBody.handle, 'recoverer')

  const usedCode = generatedBody.recovery_codes[0]!
  const begin = await postJson(app, '/api/recovery', { action: 'begin', recovery_code: usedCode })
  assert.equal(begin.status, 200)
  const beginBody = await begin.json() as { status: string; stage_token: string; resident_key: string }
  assert.equal(beginBody.status, 'staged')
  assert.match(beginBody.resident_key, ROOT_KEY)

  const confirm = await postJson(app, '/api/recovery', {
    action: 'confirm', stage_token: beginBody.stage_token, resident_key: beginBody.resident_key,
  })
  assert.equal(confirm.status, 200)
  assert.deepEqual(await confirm.json(), { status: 'recovered', resident_id: residentId, handle: 'recoverer' })

  // The same recovery code cannot start a second recovery.
  const reused = await postJson(app, '/api/recovery', { action: 'begin', recovery_code: usedCode })
  assert.equal(reused.status, 403)
  assert.equal(reused.headers.get('x-1f3d9-reason'), 'credential_rejected')
})

test('recovery begin with an unknown code is refused', async () => {
  const app = appFor()
  const response = await postJson(app, '/api/recovery', {
    action: 'begin', recovery_code: `1f3d9_rc_${'44'.repeat(32)}`,
  })
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'credential_rejected')
})

test('an invalid action name is refused with invalid_request', async () => {
  const app = appFor()
  for (const path of ['/api/register', '/api/rotate', '/api/recovery']) {
    const response = await postJson(app, path, { action: 'not-real' })
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'invalid_request')
  }
})
