import assert from 'node:assert/strict'
import test from 'node:test'
import type { Resident } from '../../src/core.ts'
import { residentByOAuthAccessToken } from '../../src/oauth.ts'
import { EXISTING_KEY } from './memory-oauth-store.ts'
import {
  assertPrivate,
  assertSecretsAbsent,
  authorizationCode,
  begin,
  browserPost,
  environment,
  exchangeCode,
  fixture,
  readTokenPair,
} from './fixture.ts'

export function registerSignupConfirmationTests(): void {
  test('hosted sign-in states its expiry, attempt caps, and reserved-name rule before submission', async () => {
    const { app } = fixture()
    const session = await begin(app)

    assert.match(session.html, /sign-in request[^.]*expires after 15 minutes/iu)
    assert.match(session.html, /authorization code[^.]*expires after 5 minutes/iu)
    assert.match(session.html, /60[^.]*sign-ins[^.]*per IP and client[^.]*UTC hour/iu)
    assert.match(session.html, /10[^.]*pairing-code[^.]*resident-key[^.]*per IP and client[^.]*UTC hour/iu)
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

}
