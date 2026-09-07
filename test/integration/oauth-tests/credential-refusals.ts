import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  database,
  authorizationRequestInput,
  requestState,
  resetDatabase,
  sha256,
  stagedRegistration,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerCredentialRefusalsTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('unknown and wrong resident keys stay merged and leave the same request retryable', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('existing-key-retry')
    await store.createAuthorizationRequest(request)
    const requestBefore = await requestState(request.sessionHash)

    for (const [index, presentedKey] of [
      'wrong-existing-resident-key',
      'unknown-resident-key',
    ].entries()) {
      assert.deepEqual(
        await store.approveExistingResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: sha256(presentedKey),
          authorizationCodeHash: sha256(`existing-key-retry:rejected-code:${index}`),
        }),
        { status: 'resident_key_rejected' },
      )
      assert.deepEqual(
        await requestState(request.sessionHash),
        requestBefore,
        'a rejected key must not consume or alter the authorization request',
      )
    }

    assert.deepEqual(
      await store.approveExistingResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: sha256('existing-resident-key'),
        authorizationCodeHash: sha256('existing-key-retry:accepted-code'),
      }),
      {
        status: 'approved',
        redirectUri: request.redirectUri,
        state: request.state,
      },
    )
  })

  await t.test('a wrong staged-signup key leaves the same request retryable', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('new-key-retry')
    const pending = stagedRegistration('new-key-retry', 'new-key-retry')
    await store.createAuthorizationRequest(request)
    assert.deepEqual(
      await store.stageNewResidentRegistration(pending),
      { status: 'staged', handle: pending.handle },
    )
    const requestBefore = await requestState(request.sessionHash)

    assert.deepEqual(
      await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: sha256('wrong-new-resident-key'),
        authorizationCodeHash: sha256('new-key-retry:rejected-code'),
      }),
      { status: 'confirmation_rejected' },
    )
    assert.deepEqual(
      await requestState(request.sessionHash),
      requestBefore,
      'a rejected confirmation key must leave the staged signup intact',
    )
    assert.equal(
      (await database!.query(
        `SELECT count(*)
           FROM oauth_authorization_request_recovery_codes code
           JOIN oauth_authorization_requests request ON request.id = code.request_id
           WHERE request.session_hash = $1`,
        [request.sessionHash],
      )).rows[0]!.count,
      '8',
    )

    assert.deepEqual(
      await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        authorizationCodeHash: sha256('new-key-retry:accepted-code'),
      }),
      {
        status: 'approved',
        redirectUri: request.redirectUri,
        state: request.state,
      },
    )
  })

  await t.test('expired and used authorization requests are unavailable rather than key rejections', async () => {
    await resetDatabase()
    const expired = authorizationRequestInput('unavailable-expired')
    const used = authorizationRequestInput('unavailable-used')
    await store.createAuthorizationRequest(expired)
    await store.createAuthorizationRequest(used)
    await database!.query(
      `UPDATE oauth_authorization_requests
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
      [expired.sessionHash],
    )
    assert.deepEqual(
      await store.cancelAuthorizationRequest({
        sessionHash: used.sessionHash,
        csrfHash: used.csrfHash,
      }),
      { redirectUri: used.redirectUri, state: used.state },
    )

    for (const request of [expired, used]) {
      assert.deepEqual(
        await store.approveExistingResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: sha256('existing-resident-key'),
          authorizationCodeHash: sha256(`${request.state}:unavailable-code`),
        }),
        { status: 'request_unavailable' },
      )
    }
  })

  await t.test('a same-handle confirmation returns handle_taken and leaks no resident data', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('duplicate-handle')
    const pendingSecretHash = sha256('pending-new-resident-key')
    const pendingRecoveryCodeHashes = Array.from(
      { length: 8 },
      (_, index) => sha256(`duplicate-handle:recovery:${index}`),
    )
    const authorizationCodeHash = sha256('duplicate-handle-code')

    await store.createAuthorizationRequest(request)
    assert.deepEqual(
      await store.stageNewResidentRegistration({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        handle: 'raced-handle',
        model: 'pending-model',
        residentSecretHash: pendingSecretHash,
        recoveryCodeHashes: pendingRecoveryCodeHashes,
      }),
      { status: 'staged', handle: 'raced-handle' },
    )

    await database!.query(
      `INSERT INTO residents (id, handle, model, secret_hash)
         VALUES (2, 'raced-handle', 'race-winner', $1)`,
      [sha256('race-winner-key')],
    )
    await database!.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
    const result = await store.confirmNewResidentAndIssueAuthorizationCode({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
      residentSecretHash: pendingSecretHash,
      authorizationCodeHash,
    })

    assert.deepEqual(result, { status: 'handle_taken' })
    const canceled = await requestState(request.sessionHash)
    assert.deepEqual({
      intent: canceled.intent,
      resident_id: canceled.resident_id,
      new_handle: canceled.new_handle,
      new_model: canceled.new_model,
      new_secret_hash: canceled.new_secret_hash,
      verified_at: canceled.verified_at,
      approved_at: canceled.approved_at,
      root_key_confirmed_at: canceled.root_key_confirmed_at,
    }, {
      intent: null,
      resident_id: null,
      new_handle: null,
      new_model: null,
      new_secret_hash: null,
      verified_at: null,
      approved_at: null,
      root_key_confirmed_at: null,
    })
    assert.ok(canceled.used_at)
    const pendingCodes = await database!.query<{ count: string }>(
      `SELECT count(*) FROM oauth_authorization_request_recovery_codes code
         JOIN oauth_authorization_requests request ON request.id = code.request_id
         WHERE request.session_hash = $1`,
      [request.sessionHash],
    )
    assert.equal(pendingCodes.rows[0]!.count, '0')
    assert.equal((await store.getAuthorizationRequestProgress({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    }))?.status, 'canceled')

    const allocator = await database!.query<{ last_id: number }>(
      'SELECT last_id FROM resident_id_allocator WHERE singleton',
    )
    assert.equal(allocator.rows[0]!.last_id, 2, 'failed confirmation must return its allocated ID')

    const residents = await database!.query<{
      id: number
      handle: string
      model: string
      secret_hash: string
    }>('SELECT id, handle, model, secret_hash FROM residents ORDER BY id')
    assert.deepEqual(residents.rows, [
      {
        id: 1,
        handle: 'existing-agent',
        model: 'integration-test',
        secret_hash: sha256('existing-resident-key'),
      },
      {
        id: 2,
        handle: 'raced-handle',
        model: 'race-winner',
        secret_hash: sha256('race-winner-key'),
      },
    ])
    assert.ok(!residents.rows.some(resident => resident.secret_hash === pendingSecretHash))

    const leaked = await database!.query<{
      events: string
      authorization_codes: string
    }>(
      `SELECT
           (SELECT count(*) FROM events) AS events,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes`,
    )
    assert.deepEqual(leaked.rows[0], { events: '0', authorization_codes: '0' })
  })

}
