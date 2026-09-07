import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RECOVERY_CODE_PREFIX } from '../../src/identity-browser.ts'
import { pageState, postForm, assertRetryableCredentialRefusal, assertUnavailableStageRefusal, refusalMessage } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { ROOT_KEY, OTHER_ROOT_KEY } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'

export function registerIdentityRecoveryTests(): void {
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
    await assertRetryableCredentialRefusal(
      wrong,
      '/recovery',
      recoverStart.csrf,
      /replacement key could not be verified/iu,
    )
    assert.equal(memory.recovered(), false)

    const confirmed = await postForm(app, '/recovery', recoverStart.cookie, {
      action: 'confirm', csrf: recoverStart.csrf, resident_key: replacementKey,
    })
    assert.equal(confirmed.status, 200)
    assert.match(await confirmed.text(), /old key and connector sessions are revoked/i)
    assert.equal(memory.recovered(), true)

    const replay = await postForm(app, '/recovery', recoverStart.cookie, {
      action: 'confirm', csrf: recoverStart.csrf, resident_key: replacementKey,
    })
    await assertUnavailableStageRefusal(replay, '/recovery')
  })

  test('root-key and recovery-code refusals keep the security-sensitive pairs merged', async () => {
    const rootKeyMessages: string[] = []
    for (const residentKey of ['not-a-resident-key', OTHER_ROOT_KEY]) {
      const { app } = appWithMemoryStore()
      const start = await pageState(app, '/rotate')
      const rejected = await postForm(app, '/rotate', start.cookie, {
        action: 'begin', csrf: start.csrf, resident_key: residentKey,
      })
      assert.equal(rejected.status, 403)
      assert.equal(rejected.headers.get('x-1f3d9-reason'), 'credential_rejected')
      rootKeyMessages.push(refusalMessage(await rejected.text()))
    }
    assert.equal(rootKeyMessages[0], rootKeyMessages[1], 'malformed and unrecognized root keys stay merged')

    const { app } = appWithMemoryStore()
    const generationStart = await pageState(app, '/recovery')
    const generated = await postForm(app, '/recovery', generationStart.cookie, {
      action: 'generate', csrf: generationStart.csrf, resident_key: ROOT_KEY,
    })
    const codes = (await generated.text()).match(/1f3d9_rc_[0-9a-f]{64}/gu) ?? []
    assert.equal(codes.length, 8)

    const recoveryStart = await pageState(app, '/recovery')
    const staged = await postForm(app, '/recovery', recoveryStart.cookie, {
      action: 'begin', csrf: recoveryStart.csrf, recovery_code: codes[0]!,
    })
    const replacementKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(replacementKey)
    const confirmed = await postForm(app, '/recovery', recoveryStart.cookie, {
      action: 'confirm', csrf: recoveryStart.csrf, resident_key: replacementKey,
    })
    assert.equal(confirmed.status, 200)

    const recoveryCodeMessages: string[] = []
    for (const recoveryCode of [codes[0]!, `1f3d9_rc_${'99'.repeat(32)}`]) {
      const retryStart = await pageState(app, '/recovery')
      const rejected = await postForm(app, '/recovery', retryStart.cookie, {
        action: 'begin', csrf: retryStart.csrf, recovery_code: recoveryCode,
      })
      assert.equal(rejected.status, 403)
      assert.equal(rejected.headers.get('x-1f3d9-reason'), 'credential_rejected')
      recoveryCodeMessages.push(refusalMessage(await rejected.text()))
    }
    assert.equal(recoveryCodeMessages[0], recoveryCodeMessages[1], 'used and unknown recovery codes stay merged')
  })

  test('recovery confirmation rate limits remain explicit and actionable', async () => {
    const { app, memory } = appWithMemoryStore({ deniedAttemptKind: 'recovery_confirm' })
    const generationStart = await pageState(app, '/recovery')
    const generated = await postForm(app, '/recovery', generationStart.cookie, {
      action: 'generate', csrf: generationStart.csrf, resident_key: ROOT_KEY,
    })
    const recoveryCode = (await generated.text()).match(/1f3d9_rc_[0-9a-f]{64}/u)?.[0]
    assert.ok(recoveryCode)

    const recoveryStart = await pageState(app, '/recovery')
    const staged = await postForm(app, '/recovery', recoveryStart.cookie, {
      action: 'begin', csrf: recoveryStart.csrf, recovery_code: recoveryCode,
    })
    const replacementKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(replacementKey)

    const denied = await postForm(app, '/recovery', recoveryStart.cookie, {
      action: 'confirm', csrf: recoveryStart.csrf, resident_key: replacementKey,
    })
    assert.equal(denied.status, 429)
    assert.equal(denied.headers.get('x-1f3d9-reason'), 'rate_limited')
    assert.match(await denied.text(), /try again in one hour/iu)
    assert.equal(memory.recovered(), false)
    assert.equal(memory.calls.some(call => call.method === 'confirmRootRecovery'), false)
  })

  test('canceling a staged flow does not create or recover a resident', async () => {
    const { app, memory } = appWithMemoryStore()
    const join = await pageState(app, '/join')
    await postForm(app, '/join', join.cookie, {
      action: 'stage', csrf: join.csrf, handle: 'cancel-me', model: '', client_class: 'coding_persistent',
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
}
