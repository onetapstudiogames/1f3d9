import assert from 'node:assert/strict'
import test from 'node:test'
import { EXISTING_KEY } from './memory-oauth-store.ts'
import {
  CALLBACK,
  CLIENT_ID,
  ORIGIN,
  RESOURCE,
  STATE,
  VERIFIER,
  assertPrivate,
  authorizationCode,
  authorizationUrl,
  authorizeExisting,
  begin,
  browserPost,
  exchangeCode,
  fixture,
} from './fixture.ts'

export function registerBrowserSecurityTests(): void {
  test('invalid authorization queries reject safely and tell the chat client how to restart', async () => {
    const { app } = fixture()
    for (const patch of [
      { redirect_uri: `${CALLBACK}/near-match` },
      { redirect_uri: 'https://unapproved.example.test/oauth/callback' },
      { resource: ORIGIN },
    ]) {
      const response = await app.request(authorizationUrl(patch))
      assert.equal(response.status, 400)
      assertPrivate(response, true)
      assert.doesNotMatch(
        response.headers.get('content-security-policy') ?? '',
        /https:\/\/(?:chat|unapproved)\.example\.test/u,
      )
      assert.equal(response.headers.get('x-1f3d9-reason'), 'invalid_request')
      const body = await response.text()
      assert.match(body, /Return to the chat app and start sign-in again/iu)
      assert.match(body, /Lost\? Read the city front door/iu)
    }
    const duplicate = await app.request(`${authorizationUrl()}&state=duplicate`)
    assert.equal(duplicate.status, 400)
    assert.equal(duplicate.headers.get('x-1f3d9-reason'), 'invalid_request')
    assert.match(await duplicate.text(), /Return to the chat app and start sign-in again/iu)
    const unknown = await app.request(`${authorizationUrl()}&resident_key=forbidden`)
    assert.equal(unknown.status, 400)
    assert.equal(unknown.headers.get('x-1f3d9-reason'), 'invalid_request')
    assert.match(await unknown.text(), /Return to the chat app and start sign-in again/iu)
  })

  test('browser approval rejects wrong origin and CSRF without reflecting the resident key', async () => {
    const { app } = fixture()
    const session = await begin(app)
    const wrongOrigin = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }, 'https://evil.example')
    assert.equal(wrongOrigin.status, 403)
    assert.equal(wrongOrigin.headers.get('x-1f3d9-error-class'), 'forbidden')
    assert.equal(wrongOrigin.headers.get('x-1f3d9-reason'), 'untrusted_browser_request')
    const wrongOriginPolicy = wrongOrigin.headers.get('content-security-policy') ?? ''
    assert.match(wrongOriginPolicy, /form-action 'self';/u)
    assert.doesNotMatch(wrongOriginPolicy, /[<>]/u)
    const wrongOriginRequestId = wrongOrigin.headers.get('x-request-id') ?? ''
    assert.match(wrongOriginRequestId, /^[0-9a-f-]{36}$/iu)
    const wrongOriginBody = await wrongOrigin.text()
    assert.match(wrongOriginBody, new RegExp(wrongOriginRequestId, 'u'))
    assert.match(wrongOriginBody, /Return to the chat app and start sign-in again/iu)
    assert.doesNotMatch(wrongOriginBody, new RegExp(EXISTING_KEY, 'i'))
    const wrongCsrf = await browserPost(app, session, {
      action: 'link', csrf: 'wrong-csrf', resident_key: EXISTING_KEY,
    })
    assert.equal(wrongCsrf.status, 403)
    assert.equal(wrongCsrf.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch')
    const wrongCsrfBody = await wrongCsrf.text()
    assert.match(wrongCsrfBody, /This sign-in form and its private browser cookie did not match\./u)
    assert.doesNotMatch(wrongCsrfBody, new RegExp(EXISTING_KEY, 'i'))

    const missingCookie = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
      },
      body: new URLSearchParams({
        action: 'link',
        csrf: session.csrf,
        resident_key: EXISTING_KEY,
      }),
    })
    assert.equal(missingCookie.status, 403)
    assert.equal(missingCookie.headers.get('x-1f3d9-reason'), 'browser_cookie_missing')
    assert.match(await missingCookie.text(), /submitted without its private browser cookie/iu)

    const malformedCookie = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: '__Host-1f3d9_oauth=not-a-valid-cookie',
        origin: ORIGIN,
      },
      body: new URLSearchParams({
        action: 'link',
        csrf: session.csrf,
        resident_key: EXISTING_KEY,
      }),
    })
    assert.equal(malformedCookie.status, 403)
    assert.equal(malformedCookie.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch')
    assert.match(
      await malformedCookie.text(),
      /This sign-in form and its private browser cookie did not match\./u,
    )
  })

  test('browser approval distinguishes wrong keys from expired sign-in state and avoids harmful restart advice', async () => {
    {
      const { app } = fixture()
      const session = await begin(app)
      const wrongKey = await browserPost(app, session, {
        action: 'link', csrf: session.csrf, resident_key: `1f3d9_sk_${'cd'.repeat(24)}`,
      })
      assert.equal(wrongKey.status, 403)
      assert.equal(wrongKey.headers.get('x-1f3d9-reason'), 'resident_key_rejected')
      const wrongKeyBody = await wrongKey.text()
      assert.match(wrongKeyBody, /resident key could not be verified/iu)
      assert.doesNotMatch(wrongKeyBody, /Start again/iu)
      assert.match(wrongKeyBody, /href="\/">Lost\? Read the city front door\./u)
    }

    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'staged-expiry-agent', model: 'hosted-chat',
      })
      const stagedPage = await staged.text()
      const rootKey = stagedPage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
      assert.ok(rootKey)

      Object.assign(memory.api, { confirmNewResidentAndIssueAuthorizationCode: async () => ({ status: 'request_unavailable' as const }) })
      const expired = await browserPost(app, session, {
        action: 'confirm', csrf: session.csrf, resident_key: rootKey,
      })
      assert.equal(expired.status, 403)
      assert.equal(expired.headers.get('x-1f3d9-reason'), 'request_unavailable')
      assert.match(await expired.text(), /sign-in request expired|already used/iu)
    }

    {
      const { app } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'wrong-confirm-agent', model: 'hosted-chat',
      })
      const wrong = await browserPost(app, session, {
        action: 'confirm', csrf: session.csrf, resident_key: EXISTING_KEY,
      })
      assert.equal(staged.status, 200)
      assert.equal(wrong.status, 403)
      assert.equal(wrong.headers.get('x-1f3d9-reason'), 'confirmation_rejected')
      const wrongBody = await wrong.text()
      assert.match(wrongBody, /saved resident key could not be verified/iu)
      assert.doesNotMatch(wrongBody, /Start again/iu)
      assert.match(wrongBody, /href="\/">Lost\? Read the city front door\./u)
    }
  })

  test('browser approval accepts a same-origin referrer when Origin is withheld', async () => {
    const { app } = fixture()
    const session = await begin(app)
    const approved = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }, 'null', `${ORIGIN}/oauth/authorize`)

    authorizationCode(approved)
  })

  test('browser approval accepts same-origin fetch metadata when privacy browsers omit Origin and Referer', async () => {
    const { app } = fixture()
    const session = await begin(app)
    const approved = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }, null, undefined, {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    })

    authorizationCode(approved)
  })

  test('browser approval rejects unknown and duplicate fields instead of guessing intent', async () => {
    {
      const { app } = fixture()
      const session = await begin(app)
      const unexpected = await browserPost(app, session, {
        action: 'link',
        csrf: session.csrf,
        resident_key: EXISTING_KEY,
        access_token: 'unexpected-field',
      })
      assert.equal(unexpected.status, 403)
      assert.equal(unexpected.headers.get('location'), null)
      assert.match(await unexpected.text(), /Return to the chat app and start sign-in again/iu)
    }

    {
      const { app } = fixture()
      const session = await begin(app)
      const duplicateFields = new URLSearchParams({
        action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
      })
      duplicateFields.append('csrf', session.csrf)
      const duplicate = await browserPost(app, session, duplicateFields)
      assert.equal(duplicate.status, 403)
      assert.match(await duplicate.text(), /Return to the chat app and start sign-in again/iu)
    }
  })

  test('canceled and confirmed hosted signups report the exact safe resume path without quota', async () => {
    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const canceled = await browserPost(app, session, { action: 'cancel', csrf: session.csrf })
      assert.equal(canceled.status, 303)
      memory.api.consumeOAuthRateLimit = async () => {
        throw new Error('a canceled resume must not spend sign-in quota')
      }
      const resumed = await app.request(session.location, { headers: { cookie: session.cookie } })
      assert.equal(resumed.status, 403)
      assert.equal(resumed.headers.get('x-1f3d9-reason'), 'request_unavailable')
      const body = await resumed.text()
      assert.match(body, /canceled[^.]*no resident/iu)
      assert.match(body, /Return to the chat app and start sign-in again/iu)
    }

    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'confirmed-resume', model: '',
      })
      const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
      assert.ok(key)
      const confirmed = await browserPost(app, session, {
        action: 'confirm', csrf: session.csrf, resident_key: key,
      })
      authorizationCode(confirmed)
      memory.api.consumeOAuthRateLimit = async () => {
        throw new Error('a confirmed resume must not spend sign-in quota')
      }
      const resumed = await app.request(session.location, { headers: { cookie: session.cookie } })
      assert.equal(resumed.status, 403)
      assert.equal(resumed.headers.get('x-1f3d9-reason'), 'request_unavailable')
      const body = await resumed.text()
      assert.match(body, /confirmed-resume[^.]*already (?:exists|lives)/iu)
      assert.match(body, /choose “I already live here,”[^.]*saved key/iu)
      assert.doesNotMatch(body, new RegExp(key, 'u'))
    }
  })

  test('token exchange rejects wrong verifier, resource, private-client credentials, unknown fields, and duplicates', async () => {
    {
      const { app } = fixture()
      const { code } = await authorizeExisting(app)
      const wrongVerifier = await exchangeCode(app, code, { code_verifier: 'x'.repeat(43) })
      assert.equal(wrongVerifier.status, 400)
      assert.deepEqual(await wrongVerifier.json(), { error: 'invalid_grant' })
      const wrongResource = await exchangeCode(app, code, { resource: ORIGIN })
      assert.equal(wrongResource.status, 400)
    }

    {
      const { app } = fixture()
      const { code } = await authorizeExisting(app)
      const unknown = await exchangeCode(app, code, { unexpected: 'field' })
      assert.equal(unknown.status, 400)
      assert.deepEqual(await unknown.json(), { error: 'invalid_request' })
    }

    for (const forbidden of [
      { client_secret: 'must-not-be-accepted' },
      { client_assertion: 'must-not-be-accepted' },
      {
        client_assertion: 'must-not-be-accepted',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      },
    ]) {
      const { app } = fixture()
      const { code } = await authorizeExisting(app)
      const rejected = await exchangeCode(app, code, forbidden)
      assert.equal(rejected.status, 400)
      assert.deepEqual(await rejected.json(), { error: 'invalid_request' })
    }

    {
      const { app } = fixture()
      const { code } = await authorizeExisting(app)
      const rejected = await app.request('/oauth/token', {
        method: 'POST',
        headers: {
          authorization: 'Basic must-not-be-accepted',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          redirect_uri: CALLBACK,
          resource: RESOURCE,
          code,
          code_verifier: VERIFIER,
        }),
      })
      assert.equal(rejected.status, 400)
      assert.deepEqual(await rejected.json(), { error: 'invalid_request' })
    }

    {
      const { app } = fixture()
      const { code } = await authorizeExisting(app)
      const fields = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        resource: RESOURCE,
        code,
        code_verifier: VERIFIER,
      })
      fields.append('code', code)
      const duplicate = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: fields,
      })
      assert.equal(duplicate.status, 400)
      assert.deepEqual(await duplicate.json(), { error: 'invalid_request' })
    }
  })

}
