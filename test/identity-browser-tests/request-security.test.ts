import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORIGIN, pageState, postForm } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { ROOT_KEY } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'

export function registerIdentityRequestSecurityTests(): void {
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
      const missingBody = await missing.text()
      assert.match(missingBody, /cookie[^.]*not returned/iu, path)
      if (path === '/join') {
        assert.match(missingBody, /confirmation response[^.]*lost/iu, path)
        assert.ok(missingBody.indexOf('href="/window"') < missingBody.indexOf('href="/join?new=1"'), path)
      }

      const malformed = await postForm(
        app,
        path,
        `${cookieName}=not-a-browser-session`,
        { action: 'cancel', csrf: start.csrf },
      )
      assert.equal(malformed.status, 403, path)
      assert.equal(malformed.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch', path)
      const malformedBody = await malformed.text()
      assert.match(malformedBody, /form[^.]*private browser cookie[^.]*did not match/iu, path)
      if (path === '/join') {
        assert.match(malformedBody, /confirmation response[^.]*lost/iu, path)
        assert.ok(malformedBody.indexOf('href="/window"') < malformedBody.indexOf('href="/join?new=1"'), path)
      }
      assert.equal(memory.calls.length, 0, path)
    }
  })

  test('a second tab replacing the route cookie gives the first tab an honest mismatch', async () => {
    for (const path of ['/rotate', '/recovery'] as const) {
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

  test('reloading /join preserves its private session and returns the exact ceremony step', async () => {
    const { app, memory } = appWithMemoryStore()
    const first = await pageState(app, '/join')
    const reload = await app.request('/join', { headers: { cookie: first.cookie } })
    const reloadHtml = await reload.text()

    assert.equal(reload.status, 200)
    assert.equal((reload.headers.get('set-cookie') ?? '').split(';', 1)[0], first.cookie)
    assert.match(reload.headers.get('set-cookie') ?? '', /Max-Age=1800/u)
    assert.match(reloadHtml, new RegExp(`name="csrf" value="${first.csrf}"`, 'u'))
    assert.equal(memory.calls.filter(call => call.method === 'registrationProgress').length, 1)
  })

  test('an invalid join cookie links the resident check before a fresh ceremony', async () => {
    const { app } = appWithMemoryStore()
    const response = await app.request('/join', {
      headers: { cookie: '__Host-1f3d9_join=not-a-valid-private-session' },
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /old private join cookie could not be read/iu)
    assert.match(body, /href="\/window"/u)
    assert.match(body, /href="\/join\?new=1"/u)
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
      action: 'stage', csrf: joinStart.csrf, handle: 'mobile-join', model: '', client_class: 'coding_persistent',
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
      action: 'stage', csrf: joinStart.csrf, handle: 'metadata-join', model: '', client_class: 'coding_persistent',
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
      action: 'stage', csrf: absentStart.csrf, handle: 'no-evidence', model: '', client_class: 'coding_persistent',
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
      action: 'stage', csrf: hostileMetadataStart.csrf, handle: 'hostile-metadata', model: '', client_class: 'coding_persistent',
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

  test('identity-browser.ts itself never defines POST /api/register (decision row 74 moved it to identity-api.ts)', async () => {
    const { app, memory } = appWithMemoryStore()
    const response = await app.request('/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'unsafe-old-door', model: 'test' }),
    })

    // mountIdentityRoutes (this file) only ever mounted the browser pages
    // /join, /rotate, and /recovery. The coding-client JSON door at
    // POST /api/register now lives in src/identity-api.ts, exercised by
    // test/identity-api.test.ts, so an app that mounts only this module has no
    // route here at all.
    assert.equal(response.status, 404)
    assert.equal(memory.calls.length, 0)
  })

}
