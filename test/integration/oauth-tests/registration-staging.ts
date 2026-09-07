import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  database,
  initialRecoveryCodesMigrationDdl,
  authorizationRequestInput,
  requestState,
  resetDatabase,
  sha256,
  stagedRegistration,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerRegistrationStagingTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('the initial-code migration is idempotent and legacy new-resident requests fail closed', async () => {
    await resetDatabase()
    await database!.query(initialRecoveryCodesMigrationDdl)
    await database!.query(initialRecoveryCodesMigrationDdl)
    const request = authorizationRequestInput('legacy-oauth-no-codes')
    const staged = stagedRegistration('legacy-oauth-no-codes', 'legacy-oauth-no-codes')
    await store.createAuthorizationRequest(request)
    await database!.query(
      `UPDATE oauth_authorization_requests
         SET intent = 'new', new_handle = $1, new_model = $2,
             new_secret_hash = $3, verified_at = now(), approved_at = now()
         WHERE session_hash = $4`,
      [staged.handle, staged.model, staged.residentSecretHash, request.sessionHash],
    )

    await assert.rejects(
      store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: staged.residentSecretHash,
        authorizationCodeHash: sha256('legacy-oauth-no-codes:authorization-code'),
      }),
    )
    const state = await database!.query(
      `SELECT
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes,
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id`,
      [staged.handle, request.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      residents: '0', presences: '0', active_codes: '0', authorization_codes: '0',
      pending_codes: '0', last_id: 1,
    }])

    await database!.query(
      `UPDATE oauth_authorization_requests
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
      [request.sessionHash],
    )
    await store.createAuthorizationRequest(authorizationRequestInput('legacy-oauth-cleanup-trigger'))
    const expired = await requestState(request.sessionHash)
    assert.deepEqual({
      intent: expired.intent,
      new_handle: expired.new_handle,
      new_model: expired.new_model,
      new_secret_hash: expired.new_secret_hash,
      used: expired.used_at !== null,
    }, {
      intent: null, new_handle: null, new_model: null, new_secret_hash: null, used: true,
    })
  })

  await t.test('OAuth registration rejects every non-exact, malformed, or duplicate initial-code set', async () => {
    await resetDatabase()
    const valid = stagedRegistration('invalid-oauth-code-set', 'invalid-oauth-code-set')
    const attempts = [
      valid.recoveryCodeHashes.slice(0, 7),
      [...valid.recoveryCodeHashes, sha256('oauth-ninth-code')],
      valid.recoveryCodeHashes.map((hash, index) => index === 7 ? valid.recoveryCodeHashes[0]! : hash),
      valid.recoveryCodeHashes.map((hash, index) => index === 7 ? 'not-a-sha256-hash' : hash),
    ]
    for (const [index, recoveryCodeHashes] of attempts.entries()) {
      const request = authorizationRequestInput(`invalid-oauth-code-set:${index}`)
      await store.createAuthorizationRequest(request)
      await assert.rejects(
        store.stageNewResidentRegistration({
          ...valid,
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          recoveryCodeHashes,
        }),
        /exactly eight unique sha256 recovery-code hashes are required/i,
      )
    }
    assert.equal((await database!.query('SELECT count(*) FROM oauth_authorization_request_recovery_codes')).rows[0]!.count, '0')
    assert.equal(
      (await database!.query("SELECT count(*) FROM oauth_authorization_requests WHERE intent = 'new'")).rows[0]!.count,
      '0',
    )
  })

  await t.test('concurrent duplicate OAuth staging keeps one resumable credential set', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('concurrent-oauth-stage')
    await store.createAuthorizationRequest(request)
    const firstCredentials = stagedRegistration('concurrent-oauth-stage:first', 'concurrent-oauth-stage')
    const secondCredentials = stagedRegistration('concurrent-oauth-stage:second', 'concurrent-oauth-stage')
    const first = {
      ...firstCredentials,
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    }
    const second = {
      ...secondCredentials,
      sessionHash: request.sessionHash,
      csrfHash: request.csrfHash,
    }
    const attempts = [first, second] as const

    const results = await Promise.all(
      attempts.map(attempt => store.stageNewResidentRegistration(attempt)),
    )

    assert.deepEqual(
      results.map(result => result.status).sort(),
      ['request_unavailable', 'staged'],
    )
    const winnerIndex = results.findIndex(result => result.status === 'staged')
    const winner = winnerIndex === 0 ? first : second
    const loser = winnerIndex === 0 ? second : first
    const persisted = await requestState(request.sessionHash)
    assert.deepEqual({
      intent: persisted.intent,
      resident_id: persisted.resident_id,
      new_handle: persisted.new_handle,
      new_model: persisted.new_model,
      new_secret_hash: persisted.new_secret_hash,
      root_key_confirmed_at: persisted.root_key_confirmed_at,
      used_at: persisted.used_at,
    }, {
      intent: 'new',
      resident_id: null,
      new_handle: winner.handle,
      new_model: winner.model,
      new_secret_hash: winner.residentSecretHash,
      root_key_confirmed_at: null,
      used_at: null,
    })
    const persistedCodes = await database!.query<{ ordinal: number; code_hash: string }>(
      `SELECT code.ordinal, code.code_hash
         FROM oauth_authorization_request_recovery_codes code
         JOIN oauth_authorization_requests request ON request.id = code.request_id
         WHERE request.session_hash = $1
         ORDER BY code.ordinal`,
      [request.sessionHash],
    )
    assert.deepEqual(
      persistedCodes.rows,
      winner.recoveryCodeHashes.map((code_hash, index) => ({ ordinal: index + 1, code_hash })),
    )
    assert.equal(
      loser.recoveryCodeHashes.some(hash => persistedCodes.rows.some(row => row.code_hash === hash)),
      false,
    )
    const resumable = await store.getAuthorizationRequest(request.sessionHash)
    assert.ok(resumable)
    assert.deepEqual({
      intent: resumable.intent,
      new_handle: resumable.new_handle,
      new_model: resumable.new_model,
      root_key_confirmed_at: resumable.root_key_confirmed_at,
    }, {
      intent: 'new',
      new_handle: winner.handle,
      new_model: winner.model,
      root_key_confirmed_at: null,
    })
  })

}
