import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { database, authorizationRequestInput, resetDatabase, sha256, stagedRegistration, type OAuthStore } from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerRegistrationRollbackTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('a missing world root leaves OAuth resident creation entirely pending', async () => {
    await resetDatabase()
    await database!.query('DROP TRIGGER places_protect_topology_write ON places')
    await database!.query("DELETE FROM places WHERE place_kind = 'world'")
    const request = authorizationRequestInput('oauth-missing-world')
    const pending = stagedRegistration('oauth-missing-world', 'oauth-missing-world')
    await store.createAuthorizationRequest(request)
    assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')

    await assert.rejects(
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        authorizationCodeHash: sha256('oauth-missing-world:authorization-code'),
      }),
    )
    const state = await database!.query(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes`,
      [pending.handle, request.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      last_id: 1, residents: '0', presences: '0', events: '0', active_codes: '0',
      authorization_codes: '0', pending_codes: '8',
    }])
  })

  await t.test('an active recovery-code collision rolls the OAuth resident and authorization code back', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('oauth-active-code-collision')
    const pending = stagedRegistration('oauth-active-code-collision', 'oauth-code-collision')
    await database!.query('UPDATE residents SET recovery_generation = 1 WHERE id = 1')
    await database!.query(
      `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         VALUES (1, 1, $1)`,
      [pending.recoveryCodeHashes[5]],
    )
    await store.createAuthorizationRequest(request)
    assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')

    await assert.rejects(
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        authorizationCodeHash: sha256('oauth-active-code-collision:authorization-code'),
      }),
      (error: unknown) => {
        const postgresError = error as { code?: string; constraint?: string }
        return postgresError.code === '23505' &&
          postgresError.constraint === 'resident_recovery_codes_code_hash_key'
      },
    )
    const state = await database!.query(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes`,
      [pending.handle, request.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      last_id: 1, residents: '0', presences: '0', events: '0', active_codes: '0',
      authorization_codes: '0', pending_codes: '8',
    }])
  })

  await t.test('an OAuth registration event failure rolls every creation write back', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('oauth-event-rollback')
    const pending = stagedRegistration('oauth-event-rollback', 'oauth-event-rollback')
    await store.createAuthorizationRequest(request)
    assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')
    await database!.query(`
        CREATE FUNCTION fail_oauth_registration_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'oauth-event-rollback' THEN
            RAISE EXCEPTION 'injected OAuth registration event failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER events_fail_oauth_registration
          BEFORE INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION fail_oauth_registration_event();
      `)

    await assert.rejects(
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        authorizationCodeHash: sha256('oauth-event-rollback:authorization-code'),
      }),
      /injected OAuth registration event failure/i,
    )
    const state = await database!.query(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes`,
      [pending.handle, request.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      last_id: 1, residents: '0', presences: '0', events: '0', active_codes: '0',
      authorization_codes: '0', pending_codes: '8',
    }])
  })

}
