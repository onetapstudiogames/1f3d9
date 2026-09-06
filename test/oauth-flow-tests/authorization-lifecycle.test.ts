import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '../../src/core.ts'
import { EXISTING_KEY } from './memory-oauth-store.ts'
import {
  CALLBACK,
  CHALLENGE,
  ORIGIN,
  STATE,
  VERIFIER,
  authorizationCode,
  authorizeExisting,
  begin,
  browserPost,
  exchangeCode,
  fixture,
} from './fixture.ts'

export function registerAuthorizationLifecycleTests(): void {
  test('OAuth cancel and confirm races re-read the completed resident before replying', async () => {
    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'cancel-race-resident', model: '',
      })
      const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
      assert.ok(key)
      const confirm = memory.api.confirmNewResidentAndIssueAuthorizationCode
      memory.api.cancelAuthorizationRequest = async input => {
        const completed = await confirm({
          ...input,
          residentSecretHash: sha256(key),
          authorizationCodeHash: sha256('cancel-race-authorization-code'),
        })
        assert.equal(completed.status, 'approved')
        return null
      }

      const canceled = await browserPost(app, session, {
        action: 'cancel', csrf: session.csrf,
      })
      assert.equal(canceled.status, 403)
      assert.equal(canceled.headers.get('x-1f3d9-reason'), 'request_unavailable')
      const body = await canceled.text()
      assert.match(body, /cancel-race-resident[^.]*already lives/iu)
      assert.match(body, /choose “I already live here,”[^.]*saved key/iu)
      assert.doesNotMatch(body, new RegExp(key, 'u'))
    }

    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'confirm-race-resident', model: '',
      })
      const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
      assert.ok(key)
      const confirm = memory.api.confirmNewResidentAndIssueAuthorizationCode
      memory.api.confirmNewResidentAndIssueAuthorizationCode = async input => {
        const completed = await confirm(input)
        assert.equal(completed.status, 'approved')
        return { status: 'request_unavailable' as const }
      }

      const response = await browserPost(app, session, {
        action: 'confirm', csrf: session.csrf, resident_key: key,
      })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('x-1f3d9-reason'), 'request_unavailable')
      const body = await response.text()
      assert.match(body, /confirm-race-resident[^.]*already lives/iu)
      assert.match(body, /choose “I already live here,”[^.]*saved key/iu)
      assert.doesNotMatch(body, new RegExp(key, 'u'))
    }
  })

  test('expired and used connector requests direct the person back to the chat app', async () => {
    const stopped: Response[] = []

    {
      const { app, memory } = fixture()
      const session = await begin(app)
      memory.expireBrowserSession(session.rawSession)
      stopped.push(await browserPost(app, session, {
        action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
      }))
    }

    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'expired-staged-key', model: 'hosted-chat',
      })
      const rootKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
      assert.ok(rootKey)
      memory.expireBrowserSession(session.rawSession)
      stopped.push(await browserPost(app, session, {
        action: 'confirm', csrf: session.csrf, resident_key: rootKey,
      }))
    }

    {
      const { app } = fixture()
      const session = await begin(app)
      const approved = await browserPost(app, session, {
        action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
      })
      authorizationCode(approved)
      stopped.push(await browserPost(app, session, {
        action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
      }))
    }

    for (const [index, response] of stopped.entries()) {
      assert.equal(response.status, 403)
      assert.equal(
        response.headers.get('x-1f3d9-reason'),
        index < 2 ? 'request_expired' : 'request_unavailable',
      )
      const body = await response.text()
      assert.match(body, /return to the chat app and start sign-in again/iu)
      assert.doesNotMatch(body, /name="resident_key"/u)
    }
  })

  test('a non-handle unique violation is a storage fault, not a taken-name claim', async () => {
    const { app, memory } = fixture()
    const session = await begin(app)
    Object.assign(memory.api, {
      approveExistingResidentAndIssueAuthorizationCode: async () => {
        throw Object.assign(new Error('authorization-code collision'), { code: '23505' })
      },
    })

    const response = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'storage_unavailable')
    assert.equal(response.headers.get('retry-after'), '1')
    assert.doesNotMatch(await response.text(), /resident name[^.]*taken|handle_taken/iu)
  })

  test('cancel atomically consumes the request before returning access_denied', async () => {
    const { app } = fixture()
    const session = await begin(app)
    const cancelled = await browserPost(app, session, {
      action: 'cancel',
      csrf: session.csrf,
    })
    assert.equal(cancelled.status, 303)
    const location = new URL(cancelled.headers.get('location') ?? '')
    assert.equal(`${location.origin}${location.pathname}`, CALLBACK)
    assert.equal(location.searchParams.get('error'), 'access_denied')
    assert.equal(location.searchParams.get('state'), STATE)
    assert.equal(location.searchParams.get('code'), null)
    assert.doesNotMatch(location.href, /1f3d9_(?:sk|at|rt|ac)_/i)

    const replay = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    assert.equal(replay.status, 403)
    assert.equal(replay.headers.get('location'), null)
  })

  test('expired browser sessions and authorization codes cannot be used', async () => {
    {
      const { app, memory } = fixture()
      const session = await begin(app)
      memory.expireBrowserSession(session.rawSession)
      const expired = await browserPost(app, session, {
        action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
      })
      assert.equal(expired.status, 403)
      assert.equal(expired.headers.get('location'), null)
      assert.doesNotMatch(await expired.text(), new RegExp(EXISTING_KEY, 'i'))
    }

    {
      const { app, memory } = fixture()
      const { code } = await authorizeExisting(app)
      memory.expireAuthorizationCode(code)
      const expired = await exchangeCode(app, code)
      assert.equal(expired.status, 400)
      assert.deepEqual(await expired.json(), { error: 'invalid_grant' })
    }
  })

  test('PKCE fixture is the RFC S256 vector used by the browser-flow tests', () => {
    const derived = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url')
    assert.equal(derived, CHALLENGE)
  })

  // Decision row 74: a signed-in coding client mints a pairing code with
  // POST /api/pair (test/pair.test.ts covers that door); the human enters it
  // here in place of the resident key. These tests exercise the /oauth/authorize
  // side of that contract using the same fixture and helpers as the resident-key
  // "link" flow above.
}
