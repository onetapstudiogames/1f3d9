import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256, type Resident } from '../../src/core.ts'
import { collectRecoveryCodeSet } from '../../src/oauth.ts'
import { rateLimitResult } from './memory-oauth-store.ts'
import {
  type BrowserSession,
  STATE,
  appFor,
  assertSecretsAbsent,
  authorizationUrl,
  begin,
  browserPost,
  fixture,
} from './fixture.ts'

export function registerSignupResilienceTests(): void {
  test('connector signup retries a random collision until all eight initial recovery codes are unique', async () => {
    const byteValues = [1, 1, 2, 3, 4, 5, 6, 7, 8]
    let draw = 0
    const codes = collectRecoveryCodeSet(() =>
      `1f3d9_rc_${(byteValues[draw++] ?? 255).toString(16).padStart(64, '0')}`)

    assert.equal(codes.length, 8)
    assert.equal(new Set(codes).size, 8)
    assert.equal(draw, 9)

    let stalledDraws = 0
    assert.throws(
      () => collectRecoveryCodeSet(() => {
        stalledDraws += 1
        return `1f3d9_rc_${'00'.repeat(32)}`
      }),
      /secure recovery-code generation failed/,
    )
    assert.equal(stalledDraws, 64)
  })

  test('connector signup discloses no generated secrets when throttling or staging fails closed', async () => {
    for (const deniedCall of [1, 2, 3]) {
      const { app, memory } = fixture()
      const session = await begin(app)
      let rateCall = 0
      Object.assign(memory.api, {
        consumeOAuthRateLimit: async () => {
          rateCall += 1
          return rateLimitResult(rateCall !== deniedCall)
        },
      })

      const response = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: `limited-agent-${deniedCall}`, model: 'hosted-chat',
      })
      const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
      assert.equal(response.status, 429)
      assert.match(surface, /after one hour[^.]*return to the chat app[^.]*fresh sign-in/iu)
      assert.doesNotMatch(surface, /on this page/iu)
      assert.doesNotMatch(surface, /name="action" value="register"/u)
      assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
    }

    for (const stageFailure of ['missing', 'duplicate', 'unique_error', 'error'] as const) {
      const { app, memory } = fixture()
      const session = await begin(app)
      if (stageFailure === 'missing') {
        Object.assign(memory.api, { stageNewResidentRegistration: async () => ({ status: 'request_unavailable' as const }) })
      } else if (stageFailure === 'unique_error') {
        Object.assign(memory.api, {
          stageNewResidentRegistration: async () => {
            throw Object.assign(new Error('duplicate handle'), { code: '23505' })
          },
        })
      } else if (stageFailure === 'error') {
        Object.assign(memory.api, {
          stageNewResidentRegistration: async () => {
            throw new Error('registration store unavailable')
          },
        })
      }

      const response = await browserPost(app, session, {
        action: 'register',
        csrf: session.csrf,
        handle: stageFailure === 'duplicate'
          ? 'chatty'
          : `failed-agent-${stageFailure.replace('_', '-')}`,
        model: 'hosted-chat',
      })
      const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
      const state = JSON.parse(memory.safeState()) as {
        residents: Resident[]
        recoveryCodes: unknown[]
        events: unknown[]
      }

      assert.equal({ missing: 403, duplicate: 409, unique_error: 503, error: 503 }[stageFailure], response.status)
      assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
      if (stageFailure === 'duplicate') {
        assert.match(surface, /href="\/window"[^>]*>Check the resident list/iu)
        assert.match(surface, /earlier resident[^.]*choose “I already live here”/iu)
        assert.match(surface, /If it is not[^.]*choose a different name below/iu)
        assert.match(surface, /name="action" value="register"/u)
      }
      assert.deepEqual(state.residents.map(resident => resident.id), [49])
      assert.equal(state.recoveryCodes.length, 0)
      assert.equal(state.events.length, 0)
    }
  })

  test('connector signup rejects an invalid identity before generating or staging secrets', async () => {
    const { app, memory } = fixture()
    const session = await begin(app)
    const response = await browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'invalid_handle', model: 'hosted-chat',
    })
    const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
    const state = JSON.parse(memory.safeState()) as {
      residents: Resident[]
      recoveryCodes: unknown[]
      events: unknown[]
    }

    assert.equal(response.status, 400)
    assert.doesNotMatch(surface, /1f3d9_(?:sk|rc)_/)
    assert.deepEqual(state.residents.map(resident => resident.id), [49])
    assert.equal(state.recoveryCodes.length, 0)
    assert.equal(state.events.length, 0)
  })

  test('connector signup confirmation stays uncommitted when its rate limit or store fails closed', async () => {
    for (const confirmFailure of ['rate_limit', 'missing', 'error'] as const) {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register',
        csrf: session.csrf,
        handle: `unconfirmed-${confirmFailure.replace('_', '-')}`,
        model: 'hosted-chat',
      })
      const stagePage = await staged.text()
      const rootKey = stagePage.match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
      const recoveryCodes = stagePage.match(/1f3d9_rc_[0-9a-f]{64}/g) ?? []
      assert.ok(rootKey)

      if (confirmFailure === 'rate_limit') {
        Object.assign(memory.api, { consumeOAuthRateLimit: async () => rateLimitResult(false) })
      } else if (confirmFailure === 'missing') {
        Object.assign(memory.api, { confirmNewResidentAndIssueAuthorizationCode: async () => ({ status: 'request_unavailable' as const }) })
      } else {
        Object.assign(memory.api, {
          confirmNewResidentAndIssueAuthorizationCode: async () => {
            throw new Error('registration confirmation unavailable')
          },
        })
      }

      const response = await browserPost(app, session, {
        action: 'confirm', csrf: session.csrf, resident_key: rootKey,
      })
      const surface = `${await response.text()}\n${JSON.stringify([...response.headers])}`
      const state = JSON.parse(memory.safeState()) as {
        residents: Resident[]
        recoveryCodes: unknown[]
        events: unknown[]
      }

      assert.equal({ rate_limit: 429, missing: 403, error: 503 }[confirmFailure], response.status)
      if (confirmFailure === 'rate_limit') {
        assert.match(surface, /after one hour[^.]*return to the chat app[^.]*fresh sign-in/iu)
        assert.doesNotMatch(surface, /on this page/iu)
        assert.doesNotMatch(surface, /name="action" value="confirm"/u)
        assert.doesNotMatch(surface, /name="resident_key"/u)
      }
      assertSecretsAbsent(surface, [rootKey, ...recoveryCodes])
      assert.deepEqual(state.residents.map(resident => resident.id), [49])
      assert.equal(state.recoveryCodes.length, 0)
      assert.equal(state.events.length, 0)
    }
  })

  test('cancelling or abandoning key confirmation creates no resident, event, or handle claim', async () => {
    {
      const { app, memory } = fixture()
      const session = await begin(app)
      const staged = await browserPost(app, session, {
        action: 'register', csrf: session.csrf, handle: 'cancelled-agent', model: 'hosted-chat',
      })
      assert.equal(staged.status, 200)

      const cancelled = await browserPost(app, session, {
        action: 'cancel', csrf: session.csrf,
      })
      assert.equal(cancelled.status, 303)
      const state = JSON.parse(memory.safeState()) as {
        residents: Resident[]
        residentSecretHashes: [string, number][]
        recoveryCodes: [number, string[]][]
        events: unknown[]
      }
      assert.deepEqual(state.residents.map(resident => resident.id), [49])
      assert.equal(state.residentSecretHashes.length, 1)
      assert.equal(state.recoveryCodes.length, 0)
      assert.equal(state.events.length, 0)
    }

    {
      const { app, memory } = fixture()
      const abandoned = await begin(app)
      const staged = await browserPost(app, abandoned, {
        action: 'register', csrf: abandoned.csrf, handle: 'abandoned-agent', model: 'hosted-chat',
      })
      assert.equal(staged.status, 200)
      memory.expireBrowserSession(abandoned.rawSession)

      const state = JSON.parse(memory.safeState()) as { residents: Resident[]; events: unknown[] }
      assert.deepEqual(state.residents.map(resident => resident.id), [49])
      assert.equal(state.events.length, 0)

      const retry = await begin(app)
      const cleanedState = JSON.parse(memory.safeState()) as {
        requests: { used: boolean; new_handle: string | null; pendingSecretHash: string | null }[]
      }
      assert.ok(cleanedState.requests.some(request =>
        request.used && request.new_handle === null && request.pendingSecretHash === null))
      const reusedHandle = await browserPost(app, retry, {
        action: 'register', csrf: retry.csrf, handle: 'abandoned-agent', model: 'hosted-chat',
      })
      assert.equal(reusedHandle.status, 200, 'an abandoned pending name must remain available')
    }
  })

  test('same-name pending registrations stay harmless and only one confirmation can create the resident', async () => {
    const { app, memory } = fixture()
    const first = await begin(app)
    const second = await begin(app)
    const stage = (session: BrowserSession) => browserPost(app, session, {
      action: 'register', csrf: session.csrf, handle: 'same-pending-name', model: 'hosted-chat',
    })

    const firstPage = await stage(first)
    const secondPage = await stage(second)
    assert.equal(firstPage.status, 200)
    assert.equal(secondPage.status, 200)
    const firstKey = (await firstPage.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
    const secondKey = (await secondPage.text()).match(/1f3d9_sk_[0-9a-f]{48}/)?.[0]
    assert.ok(firstKey)
    assert.ok(secondKey)
    assert.notEqual(firstKey, secondKey)

    // A separate app instance proves confirmation needs only the shared hashed store,
    // not process memory or another copy of the displayed key.
    const otherInstance = appFor(memory)
    const winner = await browserPost(otherInstance, first, {
      action: 'confirm', csrf: first.csrf, resident_key: firstKey,
    })
    assert.equal(winner.status, 303)

    const beforeLoser = JSON.parse(memory.safeState()) as { nextResidentId: number }
    const loser = await browserPost(app, second, {
      action: 'confirm', csrf: second.csrf, resident_key: secondKey,
    })
    assert.equal(loser.status, 409)
    assert.equal(loser.headers.get('x-1f3d9-reason'), 'handle_taken')
    assert.equal(loser.headers.get('location'), null)
    const loserSurface = `${await loser.text()}\n${[...loser.headers].flat().join('\n')}`
    assert.match(loserSurface, /losing signup is closed/iu)
    assert.match(loserSurface, /saved key and recovery codes are inactive/iu)
    assert.doesNotMatch(loserSurface, new RegExp(`${firstKey}|${secondKey}`, 'i'))

    const state = JSON.parse(memory.safeState()) as {
      requests: Array<{
        sessionHash: string
        used: boolean
        intent: 'existing' | 'new' | null
        new_handle: string | null
        new_model: string | null
        pendingSecretHash: string | null
        pendingRecoveryCodeHashes: string[] | null
      }>
      residents: Resident[]
      residentSecretHashes: [string, number][]
      events: { actor: string }[]
      nextResidentId: number
      duplicateHandleRollbacks: number
    }
    assert.equal(state.residents.filter(resident => resident.handle === 'same-pending-name').length, 1)
    assert.equal(state.events.filter(event => event.actor === 'same-pending-name').length, 1)
    assert.equal(state.residentSecretHashes.length, 2)
    assert.equal(state.nextResidentId, beforeLoser.nextResidentId)
    assert.equal(state.duplicateHandleRollbacks, 1)
    const loserRequest = state.requests.find(request => request.sessionHash === sha256(second.rawSession))
    assert.ok(loserRequest)
    assert.deepEqual({
      used: loserRequest.used,
      intent: loserRequest.intent,
      handle: loserRequest.new_handle,
      model: loserRequest.new_model,
      secretHash: loserRequest.pendingSecretHash,
      recoveryCodeHashes: loserRequest.pendingRecoveryCodeHashes,
    }, {
      used: true,
      intent: null,
      handle: null,
      model: null,
      secretHash: null,
      recoveryCodeHashes: null,
    })
    assert.doesNotMatch(memory.safeState(), new RegExp(`${firstKey}|${secondKey}`, 'i'))

    const restartUrl = authorizationUrl({ state: 'after-handle-race' })
    const restarted = await app.request(restartUrl, { headers: { cookie: second.cookie } })
    assert.equal(restarted.status, 200)
    const replacementCookie = (restarted.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    assert.match(replacementCookie, /^__Host-1f3d9_oauth=/u)
    assert.notEqual(replacementCookie, second.cookie)
    assert.match(await restarted.text(), /Let this chat enter 1F3D9/iu)
  })

}
