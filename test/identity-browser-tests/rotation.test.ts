import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../../src/core.ts'
import { ORIGIN, pageState, postForm, assertRetryableCredentialRefusal, assertUnavailableStageRefusal } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { ROOT_KEY, OTHER_ROOT_KEY } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'

export function registerIdentityRotationTests(): void {
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
    await assertRetryableCredentialRefusal(
      wrong,
      '/rotate',
      start.csrf,
      /replacement key could not be verified/iu,
    )
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

    const replay = await postForm(app, '/rotate', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: replacementKey,
    })
    await assertUnavailableStageRefusal(replay, '/rotate')
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
    assert.equal(confirmed.headers.get('x-1f3d9-reason'), 'rate_limited')
    const confirmedBody = await confirmed.text()
    assert.match(confirmedBody, /wait until the next UTC day[^.]*start a new rotation/iu)
    assert.doesNotMatch(confirmedBody, /is active/i)
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
    assert.equal(deniedBegin.headers.get('x-1f3d9-reason'), 'rate_limited')
    assert.match(await deniedBegin.text(), /try again in one hour/iu)
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
    assert.equal(deniedConfirm.headers.get('x-1f3d9-reason'), 'rate_limited')
    assert.match(await deniedConfirm.text(), /try again in one hour/iu)
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

}
