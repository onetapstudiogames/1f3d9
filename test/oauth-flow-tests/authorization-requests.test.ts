import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../../src/core.ts'
import { mountOAuthRoutes } from '../../src/oauth.ts'
import { EXISTING_KEY, MemoryOAuthStore } from './memory-oauth-store.ts'
import {
  CALLBACK,
  CLIENT_ID,
  ORIGIN,
  STATE,
  appFor,
  assertPrivate,
  assertSecretsAbsent,
  authorizationUrl,
  begin,
  browserPost,
  environment,
  fixture,
} from './fixture.ts'

export function registerAuthorizationRequestTests(): void {
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

}
