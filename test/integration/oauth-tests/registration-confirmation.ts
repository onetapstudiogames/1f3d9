import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
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

export async function registerRegistrationConfirmationTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('new-resident registration stays staged until confirmation, then issues one code', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('new-resident-success')
    const residentSecretHash = sha256('new-resident-success:key')
    const recoveryCodeHashes = Array.from(
      { length: 8 },
      (_, index) => sha256(`new-resident-success:recovery:${index}`),
    )
    const codeHash = sha256('new-resident-success:code')
    await store.createAuthorizationRequest(request)

    assert.deepEqual(
      await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash,
        authorizationCodeHash: sha256('new-resident-success:not-ready-code'),
      }),
      { status: 'confirmation_not_ready' },
    )
    assert.deepEqual(
      await store.stageNewResidentRegistration({
        sessionHash: request.sessionHash,
        csrfHash: sha256('wrong-csrf'),
        handle: 'new-resident',
        model: 'hosted-chat',
        residentSecretHash,
        recoveryCodeHashes,
      }),
      { status: 'request_unavailable' },
    )
    assert.deepEqual(
      await store.stageNewResidentRegistration({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        handle: 'existing-agent',
        model: 'hosted-chat',
        residentSecretHash,
        recoveryCodeHashes,
      }),
      { status: 'handle_taken' },
    )
    assert.deepEqual(
      await store.stageNewResidentRegistration({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        handle: 'new-resident',
        model: 'hosted-chat',
        residentSecretHash,
        recoveryCodeHashes,
      }),
      { status: 'staged', handle: 'new-resident' },
    )

    const staged = await requestState(request.sessionHash)
    assert.equal(staged.intent, 'new')
    assert.equal(staged.resident_id, null)
    assert.equal(staged.new_secret_hash, residentSecretHash)
    const pendingCodes = await database!.query(
      `SELECT code.ordinal, code.code_hash
         FROM oauth_authorization_request_recovery_codes code
         JOIN oauth_authorization_requests request ON request.id = code.request_id
         WHERE request.session_hash = $1
         ORDER BY code.ordinal`,
      [request.sessionHash],
    )
    assert.deepEqual(
      pendingCodes.rows,
      recoveryCodeHashes.map((code_hash, index) => ({ ordinal: index + 1, code_hash })),
    )
    assert.equal(
      (await database!.query("SELECT count(*) FROM residents WHERE handle = 'new-resident'"))
        .rows[0]!.count,
      '0',
    )

    assert.deepEqual(
      await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash,
        authorizationCodeHash: codeHash,
      }),
      {
        status: 'approved',
        redirectUri: request.redirectUri,
        state: request.state,
      },
    )
    assert.deepEqual(
      await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash,
        authorizationCodeHash: sha256('second-code'),
      }),
      { status: 'request_unavailable' },
    )
    const confirmedProgress = await store.getAuthorizationRequestProgress({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    })
    assert.equal(confirmedProgress?.status, 'confirmed')
    if (confirmedProgress?.status === 'confirmed') {
      assert.equal(confirmedProgress.residentId, 2)
      assert.equal(confirmedProgress.handle, 'new-resident')
      assert.equal(confirmedProgress.request.client_id, request.clientId)
    }

    const resident = await database!.query<{
      id: number
      handle: string
      model: string
      secret_hash: string
      recovery_generation: string
    }>("SELECT id, handle, model, secret_hash, recovery_generation FROM residents WHERE handle = 'new-resident'")
    assert.deepEqual(resident.rows, [{
      id: 2,
      handle: 'new-resident',
      model: 'hosted-chat',
      secret_hash: residentSecretHash,
      recovery_generation: '1',
    }])
    const initialRecoveryCodes = await database!.query<{
      code_hashes: string[]
      pending_codes: string
    }>(
      `SELECT array_agg(code_hash ORDER BY code_hash) AS code_hashes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $1) AS pending_codes
         FROM resident_recovery_codes
         WHERE resident_id = 2 AND generation = 1
           AND used_at IS NULL AND invalidated_at IS NULL`,
      [request.sessionHash],
    )
    assert.deepEqual(initialRecoveryCodes.rows, [{
      code_hashes: [...recoveryCodeHashes].sort(), pending_codes: '0',
    }])
    assert.deepEqual(await store.getAuthorizationCode(codeHash), {
      residentId: 2,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
    })
    assert.equal(
      (await database!.query("SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'new-resident'"))
        .rows[0]!.count,
      '1',
    )
  })

  await t.test('two concurrent OAuth claims for one handle create one complete resident only', async () => {
    await resetDatabase()
    const firstRequest = authorizationRequestInput('oauth-race-first')
    const secondRequest = authorizationRequestInput('oauth-race-second')
    const first = stagedRegistration('oauth-race-first', 'oauth-raced-name')
    const second = stagedRegistration('oauth-race-second', 'oauth-raced-name')
    await Promise.all([
      store.createAuthorizationRequest(firstRequest),
      store.createAuthorizationRequest(secondRequest),
    ])
    assert.equal((await store.stageNewResidentRegistration(first)).status, 'staged')
    assert.equal((await store.stageNewResidentRegistration(second)).status, 'staged')

    const results = await Promise.all([
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: firstRequest.sessionHash,
        csrfHash: firstRequest.csrfHash,
        residentSecretHash: first.residentSecretHash,
        authorizationCodeHash: sha256('oauth-race-first:authorization-code'),
      }),
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: secondRequest.sessionHash,
        csrfHash: secondRequest.csrfHash,
        residentSecretHash: second.residentSecretHash,
        authorizationCodeHash: sha256('oauth-race-second:authorization-code'),
      }),
    ])
    assert.deepEqual(
      results.map(result => result.status).sort(),
      ['approved', 'handle_taken'],
    )
    const winner = results[0].status === 'approved' ? first : second
    const loser = results[0].status === 'approved' ? second : first
    const state = await database!.query(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = 'oauth-raced-name') AS residents,
           (SELECT count(*) FROM resident_presence presence
             JOIN residents resident ON resident.id = presence.resident_id
             WHERE resident.handle = 'oauth-raced-name') AS presences,
           (SELECT count(*) FROM events WHERE actor = 'oauth-raced-name') AS events,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM resident_recovery_codes code
             JOIN residents resident ON resident.id = code.resident_id
             WHERE resident.handle = 'oauth-raced-name' AND code.generation = 1
               AND code.used_at IS NULL AND code.invalidated_at IS NULL) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $1) AS winner_pending_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS loser_pending_codes`,
      [winner.sessionHash, loser.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      last_id: 2, residents: '1', presences: '1', events: '1', authorization_codes: '1',
      active_codes: '8', winner_pending_codes: '0', loser_pending_codes: '0',
    }])
    assert.equal((await store.getAuthorizationRequestProgress({
      sessionHash: loser.sessionHash,
      csrfHash: loser.csrfHash,
    }))?.status, 'canceled')
  })

  await t.test('OAuth cancellation waiting behind confirmation reports the completed resident', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('oauth-cancel-confirm-race')
    const pending = stagedRegistration('oauth-cancel-confirm-race', 'oauth-cancel-race')
    await store.createAuthorizationRequest(request)
    assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')
    await database!.query(`
        CREATE OR REPLACE FUNCTION delay_oauth_cancel_race_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'oauth-cancel-race' THEN
            PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER delay_oauth_cancel_race_event
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION delay_oauth_cancel_race_event();
      `)

    const confirmation = store.confirmNewResidentAndIssueAuthorizationCode({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
      residentSecretHash: pending.residentSecretHash,
      authorizationCodeHash: sha256('oauth-cancel-confirm-race:authorization-code'),
    })
    await delay(25)
    const cancellation = store.cancelAuthorizationRequest({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    })

    assert.equal((await confirmation).status, 'approved')
    assert.equal(await cancellation, null)
    const progress = await store.getAuthorizationRequestProgress({
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    })
    assert.equal(progress?.status, 'confirmed')
    if (progress?.status === 'confirmed') {
      assert.equal(progress.handle, 'oauth-cancel-race')
      assert.equal(progress.residentId, 2)
    }
  })

}
