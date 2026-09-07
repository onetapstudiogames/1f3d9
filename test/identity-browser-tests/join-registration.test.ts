import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../../src/core.ts'
import { RECOVERY_CODE_PREFIX, collectRecoveryCodeSet } from '../../src/identity-browser.ts'
import { assertSecretsAbsent, pageState, postForm, assertRetryableCredentialRefusal } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { ROOT_KEY, OTHER_ROOT_KEY } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'

export function registerIdentityJoinRegistrationTests(): void {
  test('join stages only a hash and creates a resident only after exact key re-entry', async () => {
    const { app, memory } = appWithMemoryStore()
    const start = await pageState(app, '/join')
    assert.match(start.html, /has not been created/i)
    assert.equal(memory.registration(), null)

    const stagedResponse = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'new-resident', model: 'test-model', client_class: 'coding_ephemeral',
    })
    assert.equal(stagedResponse.status, 200)
    assert.equal((stagedResponse.headers.get('set-cookie') ?? '').split(';', 1)[0], start.cookie)
    assert.match(stagedResponse.headers.get('set-cookie') ?? '', /Max-Age=1800/u)
    assert.equal(stagedResponse.headers.get('cache-control'), 'no-store')
    assert.match(stagedResponse.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    const stagedHtml = await stagedResponse.text()
    const rootKey = stagedHtml.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
    const recoveryCodes = stagedHtml.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
    assert.ok(rootKey)
    assert.equal(recoveryCodes.length, 8)
    assert.equal(new Set(recoveryCodes).size, 8)
    const keyInstruction = stagedHtml.indexOf('Step 1')
    const keyValue = stagedHtml.indexOf(rootKey)
    const codeInstruction = stagedHtml.indexOf('Step 2')
    const firstCode = stagedHtml.indexOf(recoveryCodes[0]!)
    const confirmation = stagedHtml.indexOf('Step 3')
    assert.ok(keyInstruction >= 0 && keyInstruction < keyValue)
    assert.ok(keyValue < codeInstruction && codeInstruction < firstCode)
    assert.ok(firstCode < confirmation)
    assert.match(stagedHtml, /password manager|operating-system credential vault/iu)
    assert.match(stagedHtml, /outside (?:this|the) temporary (?:client|machine|workspace|session)/iu)
    assert.match(stagedHtml, /recovery codes[^.]*separate/iu)
    const initialSecrets = [rootKey, ...recoveryCodes]
    assertSecretsAbsent(JSON.stringify([...stagedResponse.headers]), initialSecrets)
    assert.equal(memory.confirmed(), false)
    assert.equal(memory.registration()?.residentSecretHash, sha256(rootKey))
    assert.equal(memory.registration()?.recoveryCodeHashes.length, 8)
    assert.deepEqual(memory.registration()?.recoveryCodeHashes, recoveryCodes.map(code => sha256(code)))
    assert.doesNotMatch(JSON.stringify(memory.calls), new RegExp(rootKey))
    assert.doesNotMatch(JSON.stringify(memory.calls), /1f3d9_rc_/)

    const callsBeforeReload = memory.calls.length
    const resumed = await app.request('/join', { headers: { cookie: start.cookie } })
    const resumedHtml = await resumed.text()
    assert.equal(resumed.status, 200)
    assert.equal((resumed.headers.get('set-cookie') ?? '').split(';', 1)[0], start.cookie)
    assert.match(resumed.headers.get('set-cookie') ?? '', /Max-Age=1800/u)
    assert.match(resumedHtml, /where you stopped|continue/iu)
    assert.match(resumedHtml, /If you saved the key and all eight codes/iu)
    assert.match(resumedHtml, /If you did not save both/iu)
    assert.match(resumedHtml, /name="action" value="confirm"/u)
    assertSecretsAbsent(resumedHtml, initialSecrets)
    assert.equal(memory.calls.length, callsBeforeReload + 1)

    const replayedStage = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'new-resident', model: 'test-model', client_class: 'coding_ephemeral',
    })
    const replayedStageHtml = await replayedStage.text()
    assert.equal(replayedStage.status, 200)
    assert.match(replayedStageHtml, /where you stopped|continue/iu)
    assertSecretsAbsent(replayedStageHtml, initialSecrets)
    assert.equal(memory.calls.filter(call => call.method === 'stageRegistration').length, 1)

    const wrong = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: ROOT_KEY,
    })
    const wrongBody = await assertRetryableCredentialRefusal(
      wrong,
      '/join',
      start.csrf,
      /saved (?:resident )?key could not be verified/iu,
    )
    assertSecretsAbsent(wrongBody, initialSecrets)
    assert.equal(memory.confirmed(), false)

    const confirmed = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    assert.equal(confirmed.status, 200)
    assert.equal((confirmed.headers.get('set-cookie') ?? '').split(';', 1)[0], start.cookie)
    assert.match(confirmed.headers.get('set-cookie') ?? '', /Max-Age=1800/u)
    const confirmedHtml = await confirmed.text()
    assert.match(confirmedHtml, /new-resident now lives/i)
    assertSecretsAbsent(confirmedHtml, initialSecrets)
    assertSecretsAbsent(JSON.stringify([...confirmed.headers]), initialSecrets)
    assert.equal(memory.confirmed(), true)

    const replay = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    assert.equal(replay.status, 200)
    const replayBody = await replay.text()
    assert.match(replayBody, /new-resident now lives/i)
    assertSecretsAbsent(replayBody, initialSecrets)
    assert.equal(memory.calls.filter(call => call.method === 'stageRegistration').length, 1)
  })

  test('confirmed join retries stop at the same ten-attempt confirmation limit', async () => {
    const maximumConfirmAttempts = 10
    const joinStageRateCalls = 2
    const bucketsPerConfirmAttempt = 2
    const { app, memory } = appWithMemoryStore({
      deniedRateCall: joinStageRateCalls + (maximumConfirmAttempts * bucketsPerConfirmAttempt) + 1,
    })
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'limited-retry', model: '', client_class: 'coding_persistent',
    })
    const rootKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(rootKey)

    const confirmed = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    assert.equal(confirmed.status, 200)

    const legitimateRetry = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    assert.equal(legitimateRetry.status, 200)
    assert.match(await legitimateRetry.text(), /limited-retry now lives/iu)

    for (let attempt = 3; attempt <= maximumConfirmAttempts; attempt += 1) {
      const rejected = await postForm(app, '/join', start.cookie, {
        action: 'confirm', csrf: start.csrf, resident_key: OTHER_ROOT_KEY,
      })
      assert.equal(rejected.status, 403, `confirmation attempt ${attempt}`)
      assert.equal(rejected.headers.get('x-1f3d9-reason'), 'credential_rejected')
    }

    const limited = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: OTHER_ROOT_KEY,
    })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('x-1f3d9-reason'), 'rate_limited')
    const limitedBody = await limited.text()
    assert.match(limitedBody, /after one hour/iu)
    assert.match(limitedBody, /href="\/window"[\s\S]*href="\/join\?new=1"/u)
    assert.doesNotMatch(limitedBody, /name="action" value="confirm"/u)

    const confirmRateInputs = memory.calls
      .filter(call => call.method === 'rate')
      .map(call => call.input as { attemptKind?: string; bucketHash?: string; maximum?: number })
      .filter(input => input.attemptKind === 'join_confirm')
    assert.equal(confirmRateInputs.length, 21)
    assert.equal(confirmRateInputs.every(input => input.maximum === maximumConfirmAttempts), true)
    assert.equal(new Set(confirmRateInputs.map(input => input.bucketHash)).size, 2)
    assert.equal(memory.calls.filter(call => call.method === 'confirmRegistration').length, 10)
  })

  test('two overlapping join submissions reveal only the one credential set that was persisted', async () => {
    let arrivals = 0
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const barrier = async () => {
      arrivals += 1
      if (arrivals === 2) release()
      await gate
    }
    const { app, memory } = appWithMemoryStore({ registrationStageBarrier: barrier })
    const start = await pageState(app, '/join')
    const values = {
      action: 'stage', csrf: start.csrf, handle: 'overlapping-join', model: '', client_class: 'coding_ephemeral',
    }

    const responses = await Promise.all([
      postForm(app, '/join', start.cookie, values),
      postForm(app, '/join', start.cookie, values),
    ])
    const bodies = await Promise.all(responses.map(response => response.text()))
    const secretSets = bodies.map(body => body.match(/1f3d9_(?:sk|rc)_[0-9a-f]+/gu) ?? [])
    assert.deepEqual(responses.map(response => response.status), [200, 200])
    assert.deepEqual(secretSets.map(secrets => secrets.length).sort((left, right) => left - right), [0, 9])

    const revealIndex = secretSets.findIndex(secrets => secrets.length === 9)
    const resumeIndex = revealIndex === 0 ? 1 : 0
    const revealed = secretSets[revealIndex]!
    assert.match(bodies[resumeIndex]!, /where you stopped|continue/iu)
    assertSecretsAbsent(bodies[resumeIndex]!, revealed)
    assert.equal(memory.calls.filter(call => call.method === 'stageRegistration').length, 2)
    assert.equal(memory.registration()?.residentSecretHash, sha256(revealed[0]!))
    assert.deepEqual(memory.registration()?.recoveryCodeHashes, revealed.slice(1).map(sha256))
  })

  test('an initial handle conflict checks for a lost successful join before suggesting another name', async () => {
    const { app } = appWithMemoryStore({ registrationStageOutcome: 'handle_taken' })
    const start = await pageState(app, '/join')
    const response = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'maybe-already-home', model: '', client_class: 'coding_persistent',
    })
    const body = await response.text()

    assert.equal(response.status, 409)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'handle_taken')
    assert.match(body, /earlier confirmation response[^.]*lost/iu)
    assert.match(body, /use the (?:resident )?key you saved[^.]*do not register again/iu)
    assert.match(body, /only choose a different name[^.]*someone else/iu)
    assert.ok(body.indexOf('href="/window"') < body.indexOf('href="/join?new=1"'))
  })

  test('a legacy staged join resumes without guessing which client owns credential custody', async () => {
    const { app } = appWithMemoryStore({ registrationResumeClientClass: 'legacy_unknown' })
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'legacy-resume', model: '', client_class: 'coding_persistent',
    })
    const stagedBody = await staged.text()
    const secrets = stagedBody.match(/1f3d9_(?:sk|rc)_[0-9a-f]+/gu) ?? []
    assert.equal(secrets.length, 9)

    const resumed = await app.request('/join', { headers: { cookie: start.cookie } })
    const body = await resumed.text()
    assert.equal(resumed.status, 200)
    assert.match(body, /before the city recorded which client/iu)
    assert.match(body, /durable storage outside this client, context, workspace, and session/iu)
    assert.match(body, /all eight recovery codes[^.]*separate durable record/iu)
    assert.match(body, /name="action" value="confirm"/u)
    assert.match(body, /name="action" value="cancel"/u)
    assertSecretsAbsent(body, secrets)
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

}
