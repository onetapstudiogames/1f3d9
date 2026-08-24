import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import {
  RECOVERY_CODE_PREFIX,
  collectRecoveryCodeSet,
  mountIdentityRoutes,
} from '../src/identity-browser.ts'

const ORIGIN = 'https://city.test'
const ROOT_KEY = '1f3d9_sk_' + '11'.repeat(24)
const OTHER_ROOT_KEY = '1f3d9_sk_' + '22'.repeat(24)
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

function assertSecretsAbsent(surface: string, secrets: readonly string[]): void {
  for (const secret of secrets) assert.equal(surface.includes(secret), false)
}

type Registration = {
  sessionHash: string
  csrfHash: string
  handle: string
  model: string
  residentSecretHash: string
  recoveryCodeHashes: string[]
}

async function pageState(
  app: Hono,
  path: '/join' | '/rotate' | '/recovery',
): Promise<{ cookie: string; csrf: string; html: string }> {
  const response = await app.request(path)
  const html = await response.text()
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.equal(response.status, 200)
  assert.ok(csrf)
  assert.ok(cookie)
  assert.match(html, /<form/iu)
  assert.doesNotMatch(html, /name="session_cookie"/iu)
  assert.equal(response.headers.get('location'), null)
  return { cookie, csrf, html }
}

function postForm(
  app: Hono,
  path: string,
  cookie: string,
  values: Record<string, string>,
  origin: string | null = ORIGIN,
  referer?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie,
    ...extraHeaders,
  }
  if (origin !== null) headers.origin = origin
  if (referer !== undefined) headers.referer = referer
  return app.request(path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(values),
  })
}

type MemoryStoreOptions = {
  deniedAttemptKind?: 'join_confirm' | 'join_stage' | 'rotation_begin' | 'rotation_confirm'
  deniedRateCall?: number
  registrationStageOutcome?: 'error' | 'handle_taken' | 'missing' | 'staged'
  registrationConfirmOutcome?: 'error' | 'normal'
  rotationConfirmRateLimited?: boolean
}

function memoryStore(options: MemoryStoreOptions = {}) {
  let registration: Registration | null = null
  let confirmed = false
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
  const calls: Array<{ method: string; input: unknown }> = []

  const store = {
    async consumeIdentityRateLimit(input: { attemptKind?: string }) {
      calls.push({ method: 'rate', input })
      rateCalls += 1
      return input.attemptKind !== options.deniedAttemptKind &&
        rateCalls !== options.deniedRateCall
    },
    async stageResidentRegistration(input: Registration) {
      calls.push({ method: 'stageRegistration', input })
      if (options.registrationStageOutcome === 'error') throw new Error('registration store unavailable')
      if (options.registrationStageOutcome === 'missing') return null
      if (options.registrationStageOutcome === 'handle_taken') return { status: 'handle_taken' as const }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      registration = { ...input, recoveryCodeHashes: [...input.recoveryCodeHashes] }
      return { status: 'staged' as const, handle: input.handle }
    },
    async confirmResidentRegistration(input: {
      sessionHash: string
      csrfHash: string
      residentSecretHash: string
    }) {
      calls.push({ method: 'confirmRegistration', input })
      if (options.registrationConfirmOutcome === 'error') throw new Error('registration confirmation unavailable')
      if (
        confirmed || !registration ||
        registration.sessionHash !== input.sessionHash ||
        registration.csrfHash !== input.csrfHash ||
        registration.residentSecretHash !== input.residentSecretHash ||
        !validRecoveryCodeHashes(registration.recoveryCodeHashes)
      ) return null
      confirmed = true
      recoveryGeneration += 1
      recoveryCodeHashes = [...registration.recoveryCodeHashes]
      return { residentId: 27, handle: registration.handle }
    },
    async cancelResidentRegistration(input: unknown) {
      calls.push({ method: 'cancelRegistration', input })
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
      if (!recoveryCodeHashes.includes(input.recoveryCodeHash) || recovered) return null
      stagedRecovery = { ...input }
      return { handle: 'existing-resident' }
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
        stagedRecovery.csrfHash !== input.csrfHash ||
        stagedRecovery.replacementSecretHash !== input.replacementSecretHash
      ) return null
      recovered = true
      return { residentId: 7, handle: 'existing-resident' }
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
      if (input.residentSecretHash !== sha256(ROOT_KEY) || rotated) return null
      stagedRotation = { ...input }
      return { residentId: 7, handle: 'existing-resident' }
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
        stagedRotation.csrfHash !== input.csrfHash ||
        stagedRotation.replacementSecretHash !== input.replacementSecretHash
      ) return null
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

function appWithMemoryStore(options: MemoryStoreOptions = {}) {
  const app = new Hono()
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  const memory = memoryStore(options)
  mountIdentityRoutes(app, {
    environment: {
      PUBLIC_ORIGIN: ORIGIN,
      VERCEL: '1',
      IDENTITY_RECOVERY_ENABLED: 'true',
      IDENTITY_ROTATION_ENABLED: 'true',
    },
    store: memory.store,
  })
  return { app, memory }
}

test('identity browser rejects a PUBLIC_ORIGIN that is not one exact HTTPS origin', () => {
  for (const publicOrigin of [
    'http://city.test',
    'https://city.test/path',
    'https://city.test?query=yes',
    'not-an-origin',
  ]) {
    assert.throws(
      () => mountIdentityRoutes(new Hono(), {
        environment: { PUBLIC_ORIGIN: publicOrigin },
        store: memoryStore().store,
      }),
      /PUBLIC_ORIGIN must be an HTTPS origin/,
    )
  }
})

test('the recovery surface is absent unless its deployment switch is explicitly enabled', async () => {
  for (const environment of [
    { PUBLIC_ORIGIN: ORIGIN },
    { PUBLIC_ORIGIN: ORIGIN, IDENTITY_RECOVERY_ENABLED: 'false' },
  ]) {
    const app = new Hono()
    const memory = memoryStore()
    mountIdentityRoutes(app, { environment, store: memory.store })

    assert.equal((await app.request('/recovery')).status, 404)
    assert.equal((await app.request('/recovery', { method: 'POST' })).status, 404)
    assert.equal(memory.calls.length, 0)
  }
})

test('rotation is absent unless explicitly enabled and its switch is independent of recovery', async () => {
  for (const environment of [
    { PUBLIC_ORIGIN: ORIGIN },
    { PUBLIC_ORIGIN: ORIGIN, IDENTITY_ROTATION_ENABLED: 'false' },
  ]) {
    const app = new Hono()
    const memory = memoryStore()
    mountIdentityRoutes(app, { environment, store: memory.store })

    assert.equal((await app.request('/rotate')).status, 404)
    assert.equal((await app.request('/rotate', { method: 'POST' })).status, 404)
    assert.equal(memory.calls.length, 0)
  }

  const rotationOnly = new Hono()
  mountIdentityRoutes(rotationOnly, {
    environment: { PUBLIC_ORIGIN: ORIGIN, IDENTITY_ROTATION_ENABLED: 'true' },
    store: memoryStore().store,
  })
  assert.equal((await rotationOnly.request('/rotate')).status, 200)
  assert.equal((await rotationOnly.request('/recovery')).status, 404)

  const recoveryOnly = new Hono()
  mountIdentityRoutes(recoveryOnly, {
    environment: { PUBLIC_ORIGIN: ORIGIN, IDENTITY_RECOVERY_ENABLED: 'true' },
    store: memoryStore().store,
  })
  assert.equal((await recoveryOnly.request('/recovery')).status, 200)
  assert.equal((await recoveryOnly.request('/rotate')).status, 404)
})

test('rotation GET is private and uses a separate host-only session cookie', async () => {
  const { app } = appWithMemoryStore()
  const response = await app.request('/rotate')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^__Host-1f3d9_rotate=/)
  assert.match(setCookie, /; Path=\/; Max-Age=900; Secure; HttpOnly; SameSite=Lax$/)
  assert.doesNotMatch(setCookie, /(?:Domain=|join|recovery)/i)
})

test('identity doors set one base cookie and show the form immediately', async () => {
  for (const path of ['/join', '/rotate', '/recovery'] as const) {
    const { app, memory } = appWithMemoryStore()
    const state = await pageState(app, path)
    assert.match(state.cookie, new RegExp(`^__Host-1f3d9_${path.slice(1)}=`), path)
    assert.equal(memory.calls.length, 0, path)
  }
})

test('identity POST distinguishes a missing cookie from a present cookie that does not match the form', async () => {
  const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

  for (const path of ['/join', '/rotate', '/recovery'] as const) {
    const { app, memory } = appWithMemoryStore()
    const start = await pageState(app, path)
    const cookieName = start.cookie.split('=', 1)[0]

    const missing = await postForm(app, path, '', { action: 'cancel', csrf: start.csrf })
    assert.equal(missing.status, 403, path)
    assert.equal(missing.headers.get('x-1f3d9-reason'), 'browser_cookie_missing', path)
    assert.match(missing.headers.get('x-request-id') ?? '', requestId, path)
    assert.match(await missing.text(), /cookie[^.]*not returned/iu, path)

    const malformed = await postForm(
      app,
      path,
      `${cookieName}=not-a-browser-session`,
      { action: 'cancel', csrf: start.csrf },
    )
    assert.equal(malformed.status, 403, path)
    assert.equal(malformed.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch', path)
    assert.match(await malformed.text(), /form[^.]*private browser cookie[^.]*did not match/iu, path)
    assert.equal(memory.calls.length, 0, path)
  }
})

test('a second tab replacing the route cookie gives the first tab an honest mismatch', async () => {
  for (const path of ['/join', '/rotate', '/recovery'] as const) {
    const { app, memory } = appWithMemoryStore()
    const first = await pageState(app, path)
    const second = await pageState(app, path)

    assert.equal(first.cookie.split('=', 1)[0], second.cookie.split('=', 1)[0], path)
    assert.notEqual(first.cookie, second.cookie, path)

    const refused = await postForm(app, path, second.cookie, {
      action: 'cancel',
      csrf: first.csrf,
    })
    assert.equal(refused.status, 403, path)
    assert.equal(refused.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch', path)
    assert.match(await refused.text(), /form[^.]*private browser cookie[^.]*did not match/iu, path)
    assert.equal(memory.calls.length, 0, path)
  }
})

test('identity refusal request IDs resolve to safe method, route, and reason diagnostics', async () => {
  const { app } = appWithMemoryStore()
  const start = await pageState(app, '/join')
  const logs: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...values: unknown[]) => logs.push(values)
  try {
    const refused = await postForm(app, '/join', '', {
      action: 'confirm',
      csrf: start.csrf,
      resident_key: ROOT_KEY,
    })
    assert.equal(refused.status, 403)
    const requestId = refused.headers.get('x-request-id')
    assert.ok(requestId)
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.[0], 'identity_browser_refusal')
    const diagnostic = JSON.parse(String(logs[0]?.[1])) as Record<string, unknown>
    assert.deepEqual(diagnostic, {
      event: 'identity_browser_refusal',
      request_id: requestId,
      error_class: 'forbidden',
      reason: 'browser_cookie_missing',
      status: 403,
      method: 'POST',
      path: '/join',
    })
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${ROOT_KEY}|${start.csrf}`, 'u'))
  } finally {
    console.error = originalConsoleError
  }
})

test('real browser form posts can use a same-origin referrer when Origin is withheld', async () => {
  const join = appWithMemoryStore()
  const joinStart = await pageState(join.app, '/join')
  const joined = await postForm(join.app, '/join', joinStart.cookie, {
    action: 'stage', csrf: joinStart.csrf, handle: 'mobile-join', model: '',
  }, null, `${ORIGIN}/join`)
  assert.equal(joined.status, 200)
  assert.equal(join.memory.registration()?.handle, 'mobile-join')

  const rotation = appWithMemoryStore()
  const rotationStart = await pageState(rotation.app, '/rotate')
  const rotated = await postForm(rotation.app, '/rotate', rotationStart.cookie, {
    action: 'begin', csrf: rotationStart.csrf, resident_key: ROOT_KEY,
  }, 'null', `${ORIGIN}/rotate`)
  assert.equal(rotated.status, 200)
  assert.ok(rotation.memory.stagedRotation())

  const recovery = appWithMemoryStore()
  const recoveryStart = await pageState(recovery.app, '/recovery')
  const generated = await postForm(recovery.app, '/recovery', recoveryStart.cookie, {
    action: 'generate', csrf: recoveryStart.csrf, resident_key: ROOT_KEY,
  }, null, `${ORIGIN}/recovery`)
  assert.equal(generated.status, 200)
  const recoveryHtml = await generated.text()
  assert.equal((recoveryHtml.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []).length, 8)
})

test('identity forms accept same-origin fetch metadata when privacy browsers omit Origin and Referer', async () => {
  const fetchMetadata = {
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  }

  const join = appWithMemoryStore()
  const joinStart = await pageState(join.app, '/join')
  const joined = await postForm(join.app, '/join', joinStart.cookie, {
    action: 'stage', csrf: joinStart.csrf, handle: 'metadata-join', model: '',
  }, null, undefined, fetchMetadata)
  assert.equal(joined.status, 200)
  assert.equal(join.memory.registration()?.handle, 'metadata-join')

  const rotation = appWithMemoryStore()
  const rotationStart = await pageState(rotation.app, '/rotate')
  const rotated = await postForm(rotation.app, '/rotate', rotationStart.cookie, {
    action: 'begin', csrf: rotationStart.csrf, resident_key: ROOT_KEY,
  }, null, undefined, fetchMetadata)
  assert.equal(rotated.status, 200)
  assert.ok(rotation.memory.stagedRotation())

  const recovery = appWithMemoryStore()
  const recoveryStart = await pageState(recovery.app, '/recovery')
  const generated = await postForm(recovery.app, '/recovery', recoveryStart.cookie, {
    action: 'generate', csrf: recoveryStart.csrf, resident_key: ROOT_KEY,
  }, null, undefined, fetchMetadata)
  assert.equal(generated.status, 200)
  const recoveryHtml = await generated.text()
  assert.equal((recoveryHtml.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []).length, 8)
})

test('identity forms still reject absent or conflicting same-site evidence', async () => {
  const absent = appWithMemoryStore()
  const absentStart = await pageState(absent.app, '/join')
  const noEvidence = await postForm(absent.app, '/join', absentStart.cookie, {
    action: 'stage', csrf: absentStart.csrf, handle: 'no-evidence', model: '',
  }, null)
  assert.equal(noEvidence.status, 403)
  assert.equal(noEvidence.headers.get('x-1f3d9-error-class'), 'forbidden')
  assert.equal(noEvidence.headers.get('x-1f3d9-reason'), 'untrusted_browser_request')
  const noEvidenceRequestId = noEvidence.headers.get('x-request-id') ?? ''
  assert.match(noEvidenceRequestId, /^[0-9a-f-]{36}$/iu)
  assert.match(await noEvidence.text(), new RegExp(noEvidenceRequestId, 'u'))
  assert.equal(absent.memory.registration(), null)

  const conflicting = appWithMemoryStore()
  const conflictingStart = await pageState(conflicting.app, '/rotate')
  const hostileOrigin = await postForm(conflicting.app, '/rotate', conflictingStart.cookie, {
    action: 'begin', csrf: conflictingStart.csrf, resident_key: ROOT_KEY,
  }, 'https://attacker.test', `${ORIGIN}/rotate`)
  assert.equal(hostileOrigin.status, 403)
  assert.equal(conflicting.memory.stagedRotation(), null)

  const hostileMetadata = appWithMemoryStore()
  const hostileMetadataStart = await pageState(hostileMetadata.app, '/join')
  const crossSiteFetch = await postForm(hostileMetadata.app, '/join', hostileMetadataStart.cookie, {
    action: 'stage', csrf: hostileMetadataStart.csrf, handle: 'hostile-metadata', model: '',
  }, null, undefined, {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  })
  assert.equal(crossSiteFetch.status, 403)
  assert.equal(hostileMetadata.memory.registration(), null)

  for (const referer of [
    'https://attacker.test/recovery',
    'http://city.test/recovery',
    'https://city.test:444/recovery',
    'not-a-url',
  ]) {
    const hostileReferrer = appWithMemoryStore()
    const hostileStart = await pageState(hostileReferrer.app, '/recovery')
    const missingOrigin = await postForm(hostileReferrer.app, '/recovery', hostileStart.cookie, {
      action: 'generate', csrf: hostileStart.csrf, resident_key: ROOT_KEY,
    }, null, referer)
    assert.equal(missingOrigin.status, 403)
    assert.equal(hostileReferrer.memory.calls.length, 0)
  }
})

test('legacy registration is retired before it can return a resident key', async () => {
  const { app, memory } = appWithMemoryStore()
  const response = await app.request('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'unsafe-old-door', model: 'test' }),
  })

  assert.equal(response.status, 410)
  assert.deepEqual(await response.json(), {
    error: 'registration moved to the private browser flow at https://city.test/join',
  })
  assert.equal(memory.calls.length, 0)
})

test('identity forms state their expiry, attempt caps, and reserved-name rule before submission', async () => {
  const joinHarness = appWithMemoryStore()
  const join = await pageState(joinHarness.app, '/join')
  assert.match(join.html, /names?[^.]*city[^.]*authority[^.]*reserved/iu)
  assert.match(join.html, /3[^.]*join[^.]*per IP[^.]*UTC hour/iu)
  assert.match(join.html, /300[^.]*join[^.]*total[^.]*UTC hour/iu)
  assert.match(join.html, /15 minutes/iu)
  assert.match(join.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)

  const reserved = await postForm(joinHarness.app, '/join', join.cookie, {
    action: 'stage', csrf: join.csrf, handle: 'founder', model: 'test-model',
  })
  assert.equal(reserved.status, 400)
  assert.match(await reserved.text(), /resident name[^.]*reserved/iu)

  const rotation = await pageState(appWithMemoryStore().app, '/rotate')
  assert.match(rotation.html, /15 minutes/iu)
  assert.match(rotation.html, /5[^.]*rotation[^.]*per IP[^.]*UTC hour/iu)
  assert.match(rotation.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)
  assert.match(rotation.html, /5[^.]*successful rotations[^.]*per resident[^.]*UTC day/iu)

  const recovery = await pageState(appWithMemoryStore().app, '/recovery')
  assert.match(recovery.html, /15 minutes/iu)
  assert.match(recovery.html, /5[^.]*recovery sets?[^.]*per IP[^.]*UTC hour/iu)
  assert.match(recovery.html, /10[^.]*recoveries[^.]*per IP[^.]*UTC hour/iu)
  assert.match(recovery.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)
})

test('join stages only a hash and creates a resident only after exact key re-entry', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/join')
  assert.match(start.html, /has not been created/i)
  assert.equal(memory.registration(), null)

  const stagedResponse = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'new-resident', model: 'test-model',
  })
  assert.equal(stagedResponse.status, 200)
  assert.equal(stagedResponse.headers.get('cache-control'), 'no-store')
  assert.match(stagedResponse.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  const stagedHtml = await stagedResponse.text()
  const rootKey = stagedHtml.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  const recoveryCodes = stagedHtml.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
  assert.ok(rootKey)
  assert.equal(recoveryCodes.length, 8)
  assert.equal(new Set(recoveryCodes).size, 8)
  const initialSecrets = [rootKey, ...recoveryCodes]
  assertSecretsAbsent(JSON.stringify([...stagedResponse.headers]), initialSecrets)
  assert.equal(memory.confirmed(), false)
  assert.equal(memory.registration()?.residentSecretHash, sha256(rootKey))
  assert.equal(memory.registration()?.recoveryCodeHashes.length, 8)
  assert.deepEqual(memory.registration()?.recoveryCodeHashes, recoveryCodes.map(code => sha256(code)))
  assert.doesNotMatch(JSON.stringify(memory.calls), new RegExp(rootKey))
  assert.doesNotMatch(JSON.stringify(memory.calls), /1f3d9_rc_/)

  const wrong = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(wrong.status, 403)
  assertSecretsAbsent(await wrong.text(), initialSecrets)
  assert.equal(memory.confirmed(), false)

  const confirmed = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: rootKey,
  })
  assert.equal(confirmed.status, 200)
  const confirmedHtml = await confirmed.text()
  assert.match(confirmedHtml, /new-resident now lives/i)
  assertSecretsAbsent(confirmedHtml, initialSecrets)
  assertSecretsAbsent(JSON.stringify([...confirmed.headers]), initialSecrets)
  assert.equal(memory.confirmed(), true)

  const replay = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: rootKey,
  })
  assert.equal(replay.status, 403)
  assertSecretsAbsent(await replay.text(), initialSecrets)
})

test('join retries a random collision until all eight initial recovery codes are unique', async () => {
  const byteValues = [1, 1, 2, 3, 4, 5, 6, 7, 8]
  let draw = 0
  const codes = collectRecoveryCodeSet(() =>
    `${RECOVERY_CODE_PREFIX}${(byteValues[draw++] ?? 255).toString(16).padStart(64, '0')}`)

  assert.equal(codes.length, 8)
  assert.equal(new Set(codes).size, 8)
  assert.equal(draw, 9)

  let stalledDraws = 0
  assert.throws(
    () => collectRecoveryCodeSet(() => {
      stalledDraws += 1
      return `${RECOVERY_CODE_PREFIX}${'00'.repeat(32)}`
    }),
    /secure recovery-code generation failed/,
  )
  assert.equal(stalledDraws, 64)
})

test('join discloses no generated secrets when throttling or registration staging fails closed', async () => {
  for (const options of [
    { deniedRateCall: 1 },
    { deniedRateCall: 2 },
    { registrationStageOutcome: 'missing' as const },
    { registrationStageOutcome: 'handle_taken' as const },
    { registrationStageOutcome: 'error' as const },
  ]) {
    const { app, memory } = appWithMemoryStore(options)
    const start = await pageState(app, '/join')
    const response = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'fail-closed', model: 'test-model',
    })
    const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`

    assert.equal([403, 409, 429, 500].includes(response.status), true)
    assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
    assert.equal(memory.registration(), null)
  }
})

test('join rejects an expired browser session before generating or staging secrets', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/join')
  const response = await postForm(app, '/join', '', {
    action: 'stage', csrf: start.csrf, handle: 'expired-session', model: 'test-model',
  })
  const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`

  assert.equal(response.status, 403)
  assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
  assert.equal(memory.registration(), null)
})

test('join confirmation stays uncommitted when its rate limit or store fails closed', async () => {
  for (const options of [
    { deniedAttemptKind: 'join_confirm' as const },
    { registrationConfirmOutcome: 'error' as const },
  ]) {
    const { app, memory } = appWithMemoryStore(options)
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'unconfirmed', model: 'test-model',
    })
    const stagePage = await staged.text()
    const rootKey = stagePage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
    const recoveryCodes = stagePage.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
    assert.ok(rootKey)

    const response = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`

    assert.equal([429, 500].includes(response.status), true)
    assertSecretsAbsent(surface, [rootKey, ...recoveryCodes])
    assert.equal(memory.confirmed(), false)
  }
})

test('join rejects cross-site, malformed, duplicate, and unknown form fields', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/join')

  const crossSite = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'new-resident', model: '',
  }, 'https://attacker.test')
  assert.equal(crossSite.status, 403)

  const duplicate = new URLSearchParams({
    action: 'stage', csrf: start.csrf, handle: 'new-resident', model: '',
  })
  duplicate.append('handle', 'second-resident')
  const duplicateResponse = await app.request('/join', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: start.cookie, origin: ORIGIN },
    body: duplicate,
  })
  assert.equal(duplicateResponse.status, 403)

  const unknown = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'new-resident', model: '', secret: 'nope',
  })
  assert.equal(unknown.status, 403)
  assert.equal(memory.registration(), null)
})

test('identity throttling trusts only the platform-appended client address', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/join')
  const response = await app.request('/join', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: start.cookie,
      origin: ORIGIN,
      'x-vercel-forwarded-for': '198.51.100.9, 203.0.113.17',
    },
    body: new URLSearchParams({
      action: 'stage', csrf: start.csrf, handle: 'rate-limited', model: '',
    }),
  })

  assert.equal(response.status, 200)
  const rateCalls = memory.calls.filter(call => call.method === 'rate')
  assert.deepEqual(rateCalls[0], {
    method: 'rate',
    input: {
      bucketHash: sha256('identity:join_stage:ip:203.0.113.17'),
      attemptKind: 'join_stage',
      maximum: 3,
    },
  })
  assert.doesNotMatch(JSON.stringify(rateCalls), new RegExp(sha256('identity:join_stage:ip:198.51.100.9'), 'u'))
})

test('rotation stages hashes, shows the replacement once, and requires exact re-entry', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/rotate')
  assert.match(start.html, /old key.*remain(?:s)? active/i)

  const stagedResponse = await postForm(app, '/rotate', start.cookie, {
    action: 'begin', csrf: start.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(stagedResponse.status, 200)
  assert.equal(stagedResponse.headers.get('cache-control'), 'no-store')
  const stagedHtml = await stagedResponse.text()
  const replacementKey = stagedHtml.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  assert.ok(replacementKey)
  assert.notEqual(replacementKey, ROOT_KEY)
  assert.equal(memory.rotated(), false)
  assert.equal(memory.stagedRotation()?.residentSecretHash, sha256(ROOT_KEY))
  assert.equal(memory.stagedRotation()?.replacementSecretHash, sha256(replacementKey))
  const stageCall = memory.calls.find(call => call.method === 'stageRootRotation')
  assert.ok(stageCall)
  assert.doesNotMatch(JSON.stringify(stageCall), /1f3d9_sk_/)

  const wrong = await postForm(app, '/rotate', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: OTHER_ROOT_KEY,
  })
  assert.equal(wrong.status, 403)
  assert.equal(memory.rotated(), false)

  const confirmed = await postForm(app, '/rotate', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: replacementKey,
  })
  assert.equal(confirmed.status, 200)
  assert.match(await confirmed.text(), /old key.*connector sessions.*recovery codes.*revoked/is)
  assert.equal(memory.rotated(), true)
  const confirmCall = memory.calls.find(call => call.method === 'confirmRootRotation')
  assert.ok(confirmCall)
  assert.doesNotMatch(JSON.stringify(confirmCall), /1f3d9_sk_/)
})

test('canceling a staged rotation keeps the old key and grants unchanged', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/rotate')
  const staged = await postForm(app, '/rotate', start.cookie, {
    action: 'begin', csrf: start.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(staged.status, 200)
  assert.ok(memory.stagedRotation())

  const canceled = await postForm(app, '/rotate', start.cookie, {
    action: 'cancel', csrf: start.csrf,
  })
  assert.equal(canceled.status, 200)
  assert.match(await canceled.text(), /old key.*connector sessions.*recovery codes.*remain unchanged/is)
  assert.equal(memory.stagedRotation(), null)
  assert.equal(memory.rotated(), false)
})

test('rotation reports an atomic confirmation rate limit without claiming success', async () => {
  const { app, memory } = appWithMemoryStore({ rotationConfirmRateLimited: true })
  const start = await pageState(app, '/rotate')
  const staged = await postForm(app, '/rotate', start.cookie, {
    action: 'begin', csrf: start.csrf, resident_key: ROOT_KEY,
  })
  const replacementKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  assert.ok(replacementKey)

  const confirmed = await postForm(app, '/rotate', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: replacementKey,
  })
  assert.equal(confirmed.status, 429)
  assert.doesNotMatch(await confirmed.text(), /is active/i)
  assert.equal(memory.rotated(), false)
})

test('rotation rejects an incorrect old key and browser rate-limit denials', async () => {
  const incorrect = appWithMemoryStore()
  const incorrectStart = await pageState(incorrect.app, '/rotate')
  const rejected = await postForm(incorrect.app, '/rotate', incorrectStart.cookie, {
    action: 'begin', csrf: incorrectStart.csrf, resident_key: OTHER_ROOT_KEY,
  })
  assert.equal(rejected.status, 403)
  assert.equal(incorrect.memory.stagedRotation(), null)

  const beginLimited = appWithMemoryStore({ deniedAttemptKind: 'rotation_begin' })
  const beginStart = await pageState(beginLimited.app, '/rotate')
  const deniedBegin = await postForm(beginLimited.app, '/rotate', beginStart.cookie, {
    action: 'begin', csrf: beginStart.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(deniedBegin.status, 429)
  assert.equal(beginLimited.memory.calls.some(call => call.method === 'stageRootRotation'), false)

  const confirmLimited = appWithMemoryStore({ deniedAttemptKind: 'rotation_confirm' })
  const confirmStart = await pageState(confirmLimited.app, '/rotate')
  const staged = await postForm(confirmLimited.app, '/rotate', confirmStart.cookie, {
    action: 'begin', csrf: confirmStart.csrf, resident_key: ROOT_KEY,
  })
  const replacementKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  assert.ok(replacementKey)
  const deniedConfirm = await postForm(confirmLimited.app, '/rotate', confirmStart.cookie, {
    action: 'confirm', csrf: confirmStart.csrf, resident_key: replacementKey,
  })
  assert.equal(deniedConfirm.status, 429)
  assert.equal(confirmLimited.memory.calls.some(call => call.method === 'confirmRootRotation'), false)
})

test('rotation rejects hostile origins, unknown actions, and extra or duplicate fields', async () => {
  const attempts: Array<(
    app: Hono,
    state: Awaited<ReturnType<typeof pageState>>,
  ) => Response | Promise<Response>> = [
    (app, state) => postForm(app, '/rotate', state.cookie, {
      action: 'begin', csrf: state.csrf, resident_key: ROOT_KEY,
    }, 'https://attacker.test'),
    (app, state) => postForm(app, '/rotate', state.cookie, {
      action: 'replace', csrf: state.csrf, resident_key: ROOT_KEY,
    }),
    (app, state) => postForm(app, '/rotate', state.cookie, {
      action: 'begin', csrf: state.csrf, resident_key: ROOT_KEY, extra: 'nope',
    }),
    (app, state) => app.request('/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: state.cookie, origin: ORIGIN },
      body: JSON.stringify({ action: 'begin', csrf: state.csrf, resident_key: ROOT_KEY }),
    }),
    (app, state) => {
      const values = new URLSearchParams({
        action: 'begin', csrf: state.csrf, resident_key: ROOT_KEY,
      })
      values.append('resident_key', OTHER_ROOT_KEY)
      return app.request('/rotate', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: state.cookie,
          origin: ORIGIN,
        },
        body: values,
      })
    },
  ]

  for (const attempt of attempts) {
    const { app, memory } = appWithMemoryStore()
    const start = await pageState(app, '/rotate')
    assert.equal((await attempt(app, start)).status, 403)
    assert.equal(memory.stagedRotation(), null)
  }
})

test('rotation throttling sends only hashed IP and session buckets', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/rotate')
  const staged = await app.request('/rotate', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: start.cookie,
      origin: ORIGIN,
      'x-vercel-forwarded-for': '198.51.100.9, 203.0.113.17',
    },
    body: new URLSearchParams({
      action: 'begin', csrf: start.csrf, resident_key: ROOT_KEY,
    }),
  })
  const replacementKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  assert.ok(replacementKey)
  const confirmed = await postForm(app, '/rotate', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: replacementKey,
  })
  assert.equal(confirmed.status, 200)

  const rateInputs = memory.calls.filter(call => call.method === 'rate').map(call => call.input)
  assert.deepEqual(rateInputs[0], {
    bucketHash: sha256('identity:rotation_begin:ip:203.0.113.17'),
    attemptKind: 'rotation_begin',
    maximum: 5,
  })
  assert.ok(rateInputs.some(input => (
    input as { attemptKind?: string }
  ).attemptKind === 'rotation_confirm'))
  const rawSession = start.cookie.split('=', 2)[1]!
  assert.doesNotMatch(JSON.stringify(rateInputs), /(?:198\.51\.100\.9|203\.0\.113\.17|__Host-1f3d9_rotate)/)
  assert.doesNotMatch(JSON.stringify(rateInputs), new RegExp(rawSession, 'u'))
})

test('recovery codes and replacement key exist in plaintext only on one private page each', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/recovery')

  const generated = await postForm(app, '/recovery', start.cookie, {
    action: 'generate', csrf: start.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(generated.status, 200)
  assert.equal(generated.headers.get('cache-control'), 'no-store')
  const codePage = await generated.text()
  const codes = [...codePage.matchAll(/1f3d9_rc_[0-9a-f]{64}/g)].map(match => match[0])
  assert.equal(codes.length, 8)
  assert.equal(new Set(codes).size, 8)
  assert.ok(codes.every(code => code.startsWith(RECOVERY_CODE_PREFIX)))
  const generationCall = memory.calls.find(call => call.method === 'generateRecoveryCodes')
  assert.ok(generationCall)
  assert.doesNotMatch(JSON.stringify(generationCall), /1f3d9_(?:sk|rc)_/)

  const recoverStart = await pageState(app, '/recovery')
  const staged = await postForm(app, '/recovery', recoverStart.cookie, {
    action: 'begin', csrf: recoverStart.csrf, recovery_code: codes[0]!,
  })
  assert.equal(staged.status, 200)
  const replacementPage = await staged.text()
  const replacementKey = replacementPage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
  assert.ok(replacementKey)
  assert.equal(memory.recovered(), false)
  const stageCall = memory.calls.find(call => call.method === 'stageRootRecovery')
  assert.ok(stageCall)
  assert.doesNotMatch(JSON.stringify(stageCall), /1f3d9_(?:sk|rc)_/)

  const wrong = await postForm(app, '/recovery', recoverStart.cookie, {
    action: 'confirm', csrf: recoverStart.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(wrong.status, 403)
  assert.equal(memory.recovered(), false)

  const confirmed = await postForm(app, '/recovery', recoverStart.cookie, {
    action: 'confirm', csrf: recoverStart.csrf, resident_key: replacementKey,
  })
  assert.equal(confirmed.status, 200)
  assert.match(await confirmed.text(), /old key and connector sessions are revoked/i)
  assert.equal(memory.recovered(), true)
})

test('canceling a staged flow does not create or recover a resident', async () => {
  const { app, memory } = appWithMemoryStore()
  const join = await pageState(app, '/join')
  await postForm(app, '/join', join.cookie, {
    action: 'stage', csrf: join.csrf, handle: 'cancel-me', model: '',
  })
  const canceledJoin = await postForm(app, '/join', join.cookie, {
    action: 'cancel', csrf: join.csrf,
  })
  assert.equal(canceledJoin.status, 200)
  assert.equal(memory.registration(), null)
  assert.equal(memory.confirmed(), false)

  const recovery = await pageState(app, '/recovery')
  const canceledRecovery = await postForm(app, '/recovery', recovery.cookie, {
    action: 'cancel', csrf: recovery.csrf,
  })
  assert.equal(canceledRecovery.status, 200)
  assert.equal(memory.recovered(), false)
})
