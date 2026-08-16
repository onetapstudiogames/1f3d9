import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../src/core.ts'
import {
  RECOVERY_CODE_PREFIX,
  mountIdentityRoutes,
} from '../src/identity-browser.ts'

const ORIGIN = 'https://city.test'
const ROOT_KEY = '1f3d9_sk_' + '11'.repeat(24)

type Registration = {
  sessionHash: string
  csrfHash: string
  handle: string
  model: string
  residentSecretHash: string
}

function pageState(response: Response): Promise<{ cookie: string; csrf: string; html: string }> {
  return response.text().then(html => {
    const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
    assert.ok(cookie)
    assert.ok(csrf)
    return { cookie, csrf, html }
  })
}

function postForm(
  app: Hono,
  path: string,
  cookie: string,
  values: Record<string, string>,
  origin = ORIGIN,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin,
    },
    body: new URLSearchParams(values),
  })
}

function memoryStore() {
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
  const calls: Array<{ method: string; input: unknown }> = []

  const store = {
    async consumeIdentityRateLimit(input: unknown) {
      calls.push({ method: 'rate', input })
      return true
    },
    async stageResidentRegistration(input: Registration) {
      calls.push({ method: 'stageRegistration', input })
      registration = { ...input }
      return { status: 'staged' as const, handle: input.handle }
    },
    async confirmResidentRegistration(input: {
      sessionHash: string
      csrfHash: string
      residentSecretHash: string
    }) {
      calls.push({ method: 'confirmRegistration', input })
      if (
        confirmed || !registration ||
        registration.sessionHash !== input.sessionHash ||
        registration.csrfHash !== input.csrfHash ||
        registration.residentSecretHash !== input.residentSecretHash
      ) return null
      confirmed = true
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
  }

  return {
    store,
    calls,
    registration: () => registration,
    confirmed: () => confirmed,
    recovered: () => recovered,
  }
}

function appWithMemoryStore() {
  const app = new Hono()
  const memory = memoryStore()
  mountIdentityRoutes(app, {
    environment: { PUBLIC_ORIGIN: ORIGIN, VERCEL: '1', IDENTITY_RECOVERY_ENABLED: 'true' },
    store: memory.store,
  })
  return { app, memory }
}

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

test('join stages only a hash and creates a resident only after exact key re-entry', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(await app.request('/join'))
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
  assert.ok(rootKey)
  assert.equal(memory.confirmed(), false)
  assert.equal(memory.registration()?.residentSecretHash, sha256(rootKey))
  assert.doesNotMatch(JSON.stringify(memory.calls), new RegExp(rootKey))

  const wrong = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: ROOT_KEY,
  })
  assert.equal(wrong.status, 403)
  assert.equal(memory.confirmed(), false)

  const confirmed = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: rootKey,
  })
  assert.equal(confirmed.status, 200)
  assert.match(await confirmed.text(), /new-resident now lives/i)
  assert.equal(memory.confirmed(), true)

  const replay = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, resident_key: rootKey,
  })
  assert.equal(replay.status, 403)
})

test('join rejects cross-site, malformed, duplicate, and unknown form fields', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(await app.request('/join'))

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
  const start = await pageState(await app.request('/join'))
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

test('recovery codes and replacement key exist in plaintext only on one private page each', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(await app.request('/recovery'))

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

  const recoverStart = await pageState(await app.request('/recovery'))
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
  const join = await pageState(await app.request('/join'))
  await postForm(app, '/join', join.cookie, {
    action: 'stage', csrf: join.csrf, handle: 'cancel-me', model: '',
  })
  const canceledJoin = await postForm(app, '/join', join.cookie, {
    action: 'cancel', csrf: join.csrf,
  })
  assert.equal(canceledJoin.status, 200)
  assert.equal(memory.registration(), null)
  assert.equal(memory.confirmed(), false)

  const recovery = await pageState(await app.request('/recovery'))
  const canceledRecovery = await postForm(app, '/recovery', recovery.cookie, {
    action: 'cancel', csrf: recovery.csrf,
  })
  assert.equal(canceledRecovery.status, 200)
  assert.equal(memory.recovered(), false)
})
