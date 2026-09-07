import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../../src/core.ts'
import { ORIGIN, assertSecretsAbsent, pageState, postForm } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { ROOT_KEY } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'

export function registerIdentityJoinFailureTests(): void {
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
        action: 'stage', csrf: start.csrf, handle: 'fail-closed', model: 'test-model', client_class: 'coding_persistent',
      })
      const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`

      assert.equal([403, 409, 429, 503].includes(response.status), true)
      if (options.deniedRateCall !== undefined) {
        assert.equal(response.headers.get('x-1f3d9-reason'), 'rate_limited')
        assert.match(surface, /after one hour[^.]*fresh join/iu)
        assert.match(surface, /href="\/join\?new=1"/u)
        assert.doesNotMatch(surface, /keep this page|same join/iu)
        assert.doesNotMatch(surface, /name="action" value="confirm"/u)
      }
      if (options.registrationStageOutcome === 'error') {
        assert.equal(response.headers.get('x-1f3d9-reason'), 'storage_unavailable')
        assert.equal(response.headers.get('retry-after'), '1')
        assert.match(surface, /reload[^.]*\/join[^.]*same private cookie/iu)
        assert.match(surface, /href="\/join"[\s\S]*href="\/"/u)
      }
      assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
      assert.equal(memory.registration(), null)
    }
  })

  test('an unavailable state after failed staging does not claim that no resident was created', async () => {
    const { app } = appWithMemoryStore({
      registrationStageOutcome: 'missing',
      registrationProgressAfterFailedStage: 'unavailable',
    })
    const start = await pageState(app, '/join')
    const response = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'unknown-stage-result', model: '', client_class: 'coding_persistent',
    })
    const body = await response.text()

    assert.equal(response.status, 503)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'storage_unavailable')
    assert.match(body, /final state could not be verified/iu)
    assert.doesNotMatch(body, /No resident was created|No identity change was made/iu)
    assert.match(body, /href="\/window"[\s\S]*href="\/join\?new=1"/u)
    assert.doesNotMatch(body, /1f3d9_(?:sk|rc)_/u)
  })

  test('join rejects an expired browser session before generating or staging secrets', async () => {
    const { app, memory } = appWithMemoryStore()
    const start = await pageState(app, '/join')
    const response = await postForm(app, '/join', '', {
      action: 'stage', csrf: start.csrf, handle: 'expired-session', model: 'test-model', client_class: 'coding_persistent',
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
        action: 'stage', csrf: start.csrf, handle: 'unconfirmed', model: 'test-model', client_class: 'coding_persistent',
      })
      const stagePage = await staged.text()
      const rootKey = stagePage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
      const recoveryCodes = stagePage.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
      assert.ok(rootKey)

      const response = await postForm(app, '/join', start.cookie, {
        action: 'confirm', csrf: start.csrf, resident_key: rootKey,
      })
      const responseBody = await response.text()
      const surface = `${responseBody}\n${JSON.stringify([...response.headers])}`

      assert.equal([429, 503].includes(response.status), true)
      if (options.deniedAttemptKind === 'join_confirm') {
        assert.equal(response.headers.get('x-1f3d9-reason'), 'rate_limited')
        assert.match(responseBody, /after one hour/iu)
        assert.match(responseBody, /href="\/window"[\s\S]*href="\/join\?new=1"/u)
        assert.doesNotMatch(responseBody, /on this page/iu)
        assert.doesNotMatch(responseBody, /name="action" value="confirm"/u)
      } else {
        assert.equal(response.headers.get('x-1f3d9-reason'), 'storage_unavailable')
        assert.equal(response.headers.get('retry-after'), '1')
        assert.match(responseBody, /reload[^.]*\/join[^.]*same private cookie/iu)
        assert.match(responseBody, /href="\/join"[\s\S]*href="\/"/u)
        assert.match(responseBody, /could not verify the final state/iu)
        assert.doesNotMatch(responseBody, /No identity change was made/iu)
      }
      assertSecretsAbsent(surface, [rootKey, ...recoveryCodes])
      assert.equal(memory.confirmed(), false)
    }
  })

  test('an unavailable confirmation never treats a separately confirmed resident as proof of the submitted key', async () => {
    const { app } = appWithMemoryStore({
      registrationConfirmOutcome: 'request_unavailable',
      confirmationRaceCompleted: true,
    })
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'raced-confirmation', model: '', client_class: 'coding_persistent',
    })
    assert.equal(staged.status, 200)

    const wrong = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: ROOT_KEY,
    })
    assert.equal(wrong.status, 403)
    assert.equal(wrong.headers.get('x-1f3d9-reason'), 'request_unavailable')
    const body = await wrong.text()
    assert.doesNotMatch(body, /now lives|saved resident key is active/iu)
    assert.match(body, /could not verify|check the resident list/iu)
    assert.match(body, /href="\/window"/u)
    assert.match(body, /href="\/join\?new=1"/u)
  })

  test('a cancel that loses to confirmation renders the created resident truthfully', async () => {
    const { app } = appWithMemoryStore({ registrationCancelOutcome: 'confirmation_won' })
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'cancel-race', model: '', client_class: 'coding_persistent',
    })
    assert.equal(staged.status, 200)

    const canceled = await postForm(app, '/join', start.cookie, {
      action: 'cancel', csrf: start.csrf,
    })
    assert.equal(canceled.status, 200)
    const body = await canceled.text()
    assert.match(body, /cancel-race now lives/iu)
    assert.doesNotMatch(body, /created no resident|Join canceled/iu)
  })

  test('a handle-race loser reaches a fresh join instead of looping on its staged request', async () => {
    const { app } = appWithMemoryStore({ registrationConfirmOutcome: 'handle_taken' })
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'lost-handle-race', model: '', client_class: 'coding_persistent',
    })
    const rootKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(rootKey)
    const lost = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    assert.equal(lost.status, 409)
    assert.equal(lost.headers.get('x-1f3d9-reason'), 'handle_taken')
    const lostBody = await lost.text()
    assert.match(
      lostBody,
      /saved key[^.]*all eight recovery codes[^.]*inactive[^.]*attempt is closed/iu,
    )
    assert.match(lostBody, /href="\/window"[\s\S]*href="\/join\?new=1"/u)

    const fresh = await app.request('/join?new=1', { headers: { cookie: start.cookie } })
    assert.equal(fresh.status, 200)
    const body = await fresh.text()
    assert.match(body, /<h1>Move into 1F3D9<\/h1>/u)
    assert.doesNotMatch(body, /Continue creating lost-handle-race/u)
  })

  test('unavailable join state links both the resident check and a fresh ceremony', async () => {
    const { app } = appWithMemoryStore({ registrationProgressOutcome: 'unavailable' })
    const start = await pageState(app, '/join')
    const response = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: ROOT_KEY,
    })
    assert.equal(response.status, 403)
    const body = await response.text()
    assert.match(body, /href="\/window"/u)
    assert.match(body, /href="\/join\?new=1"/u)
  })

  test('join progress and cancellation store failures preserve the private resume door', async () => {
    {
      const { app } = appWithMemoryStore({ registrationProgressOutcome: 'error' })
      const start = await pageState(app, '/join')
      const failed = await app.request('/join', { headers: { cookie: start.cookie } })
      assert.equal(failed.status, 503)
      assert.equal(failed.headers.get('x-1f3d9-reason'), 'storage_unavailable')
      assert.equal(failed.headers.get('retry-after'), '1')
      assert.equal((failed.headers.get('set-cookie') ?? '').split(';', 1)[0], start.cookie)
      assert.match(await failed.text(), /reload[^.]*\/join[^.]*same private cookie/iu)
    }

    {
      const { app } = appWithMemoryStore({ registrationCancelOutcome: 'error' })
      const start = await pageState(app, '/join')
      await postForm(app, '/join', start.cookie, {
        action: 'stage', csrf: start.csrf, handle: 'cancel-store-error', model: '', client_class: 'coding_persistent',
      })
      const failed = await postForm(app, '/join', start.cookie, {
        action: 'cancel', csrf: start.csrf,
      })
      assert.equal(failed.status, 503)
      assert.equal(failed.headers.get('x-1f3d9-reason'), 'storage_unavailable')
      const body = await failed.text()
      assert.match(body, /href="\/join"[\s\S]*href="\/"/u)
      assert.match(body, /reload[^.]*\/join[^.]*same private cookie/iu)
    }
  })

  test('join rejects cross-site, malformed, duplicate, and unknown form fields', async () => {
    const { app, memory } = appWithMemoryStore()
    const start = await pageState(app, '/join')

    const crossSite = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'new-resident', model: '', client_class: 'coding_persistent',
    }, 'https://attacker.test')
    assert.equal(crossSite.status, 403)
    assert.match(await crossSite.text(), /href="\/join"[\s\S]*href="\/"/u)

    const duplicate = new URLSearchParams({
      action: 'stage', csrf: start.csrf, handle: 'new-resident', model: '', client_class: 'coding_persistent',
    })
    duplicate.append('handle', 'second-resident')
    const duplicateResponse = await app.request('/join', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: start.cookie, origin: ORIGIN },
      body: duplicate,
    })
    assert.equal(duplicateResponse.status, 403)
    assert.match(await duplicateResponse.text(), /href="\/join"[\s\S]*href="\/"/u)

    const unknown = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'new-resident', model: '', client_class: 'coding_persistent', secret: 'nope',
    })
    assert.equal(unknown.status, 403)
    assert.match(await unknown.text(), /href="\/join"[\s\S]*href="\/"/u)
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
        action: 'stage', csrf: start.csrf, handle: 'rate-limited', model: '', client_class: 'coding_persistent',
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

}
