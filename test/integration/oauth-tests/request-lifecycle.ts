import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  database,
  authorizationRequestInput,
  requestState,
  resetDatabase,
  seedAuthorizationCode,
  sha256,
  stagedRegistration,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerRequestLifecycleTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('existing-resident approval rolls its request update back when code issue fails', async () => {
    await resetDatabase()
    const collidingCodeHash = sha256('existing-code-collision')
    await seedAuthorizationCode(store, 'existing-seed', collidingCodeHash)

    const request = authorizationRequestInput('existing-target')
    await store.createAuthorizationRequest(request)
    const requestBefore = await requestState(request.sessionHash)

    await assert.rejects(
      store.approveExistingResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: sha256('existing-resident-key'),
        authorizationCodeHash: collidingCodeHash,
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    )

    assert.deepEqual(await requestState(request.sessionHash), requestBefore)
    const codes = await database!.query<{ count: string }>(
      'SELECT count(*) FROM oauth_authorization_codes',
    )
    assert.equal(codes.rows[0]!.count, '1')
  })

  await t.test('an unrelated authorization-code collision throws and rolls every new-resident write back', async () => {
    await resetDatabase()
    const collidingCodeHash = sha256('new-code-collision')
    await seedAuthorizationCode(store, 'new-seed', collidingCodeHash)

    const request = authorizationRequestInput('new-target')
    const pendingSecretHash = sha256('atomic-new-resident-key')
    const pendingRecoveryCodeHashes = Array.from(
      { length: 8 },
      (_, index) => sha256(`new-target:recovery:${index}`),
    )
    await store.createAuthorizationRequest(request)
    assert.deepEqual(
      await store.stageNewResidentRegistration({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        handle: 'atomic-new-agent',
        model: 'hosted-chat',
        residentSecretHash: pendingSecretHash,
        recoveryCodeHashes: pendingRecoveryCodeHashes,
      }),
      { status: 'staged', handle: 'atomic-new-agent' },
    )
    const requestBefore = await requestState(request.sessionHash)

    await assert.rejects(
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pendingSecretHash,
        authorizationCodeHash: collidingCodeHash,
      }),
      (error: unknown) => {
        const postgresError = error as { code?: string; constraint?: string }
        return postgresError.code === '23505' &&
          postgresError.constraint === 'oauth_authorization_codes_code_hash_key'
      },
    )
    assert.deepEqual(await requestState(request.sessionHash), requestBefore)

    const state = await database!.query<{
      last_id: number
      residents: string
      events: string
      authorization_codes: string
    }>(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = 'atomic-new-agent') AS residents,
           (SELECT count(*) FROM events WHERE actor = 'atomic-new-agent') AS events,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes`,
    )
    assert.deepEqual(state.rows[0], {
      last_id: 1,
      residents: '0',
      events: '0',
      authorization_codes: '1',
    })
  })

  await t.test('authorization requests can be read and cancelled only with the matching CSRF value', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('request-lifecycle')
    await store.createAuthorizationRequest(request)

    const current = await store.getAuthorizationRequest(request.sessionHash)
    assert.ok(current)
    assert.equal(String(current.id), '1')
    const { id: _databaseId, ...requestWithoutDatabaseId } = current
    assert.deepEqual(requestWithoutDatabaseId, {
      client_id: request.clientId,
      client_display_name: request.clientName,
      redirect_uri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      state: request.state,
      code_challenge: request.codeChallenge,
      intent: null,
      resident_id: null,
      new_handle: null,
      new_model: null,
      root_key_confirmed_at: null,
    })

    assert.equal(
      await store.cancelAuthorizationRequest({
        sessionHash: request.sessionHash,
        csrfHash: sha256('wrong-csrf'),
      }),
      null,
    )
    assert.ok(await store.getAuthorizationRequest(request.sessionHash))

    assert.deepEqual(
      await store.cancelAuthorizationRequest({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      }),
      { redirectUri: request.redirectUri, state: request.state },
    )
    assert.equal(await store.getAuthorizationRequest(request.sessionHash), null)
    const canceledProgress = await store.getAuthorizationRequestProgress({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    })
    assert.equal(canceledProgress?.status, 'canceled')
    assert.equal(canceledProgress?.request.client_id, request.clientId)
    assert.equal(await store.getAuthorizationRequestProgress({
      sessionHash: request.sessionHash,
      csrfHash: sha256('wrong-progress-csrf'),
    }), null)
    assert.ok((await requestState(request.sessionHash)).used_at)
  })

  await t.test('OAuth cancellation and expiry scrub every pending recovery hash', async () => {
    await resetDatabase()
    const canceledRequest = authorizationRequestInput('oauth-canceled-registration')
    const canceled = stagedRegistration('oauth-canceled-registration', 'oauth-canceled-registration')
    await store.createAuthorizationRequest(canceledRequest)
    assert.equal((await store.stageNewResidentRegistration(canceled)).status, 'staged')
    assert.deepEqual(await store.cancelAuthorizationRequest({
      sessionHash: canceledRequest.sessionHash,
      csrfHash: canceledRequest.csrfHash,
    }), { redirectUri: canceledRequest.redirectUri, state: canceledRequest.state })

    const expiredRequest = authorizationRequestInput('oauth-expired-registration')
    const expired = stagedRegistration('oauth-expired-registration', 'oauth-expired-registration')
    await store.createAuthorizationRequest(expiredRequest)
    assert.equal((await store.stageNewResidentRegistration(expired)).status, 'staged')
    await database!.query(
      `UPDATE oauth_authorization_requests
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
      [expiredRequest.sessionHash],
    )
    await store.createAuthorizationRequest(authorizationRequestInput('oauth-cleanup-trigger'))
    const expiredProgress = await store.getAuthorizationRequestProgress({
      sessionHash: expiredRequest.sessionHash,
      csrfHash: expiredRequest.csrfHash,
    })
    assert.equal(expiredProgress?.status, 'expired')
    assert.equal(expiredProgress?.request.client_id, expiredRequest.clientId)

    const state = await database!.query(
      `SELECT request.session_hash, request.intent, request.new_handle, request.new_model,
           request.new_secret_hash, request.used_at IS NOT NULL AS used,
           count(code.code_hash) AS pending_codes
         FROM oauth_authorization_requests request
         LEFT JOIN oauth_authorization_request_recovery_codes code ON code.request_id = request.id
         WHERE request.session_hash IN ($1, $2)
         GROUP BY request.id
         ORDER BY request.session_hash`,
      [canceledRequest.sessionHash, expiredRequest.sessionHash],
    )
    assert.equal(state.rows.length, 2)
    for (const row of state.rows) {
      assert.deepEqual({
        intent: row.intent,
        new_handle: row.new_handle,
        new_model: row.new_model,
        new_secret_hash: row.new_secret_hash,
        used: row.used,
        pending_codes: row.pending_codes,
      }, {
        intent: null,
        new_handle: null,
        new_model: null,
        new_secret_hash: null,
        used: true,
        pending_codes: '0',
      })
    }
  })

}
