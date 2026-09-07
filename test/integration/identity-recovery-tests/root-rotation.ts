import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  sha256,
  rotation,
  generateCodes,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerRootRotationTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('root rotation stages hashes only and cancel or expiry preserves the old key', async () => {
    await resetDatabase()
    const canceled = rotation('rotation-cancel')
    assert.deepEqual(await store.stageRootRotation(canceled), {
      status: 'staged', residentId: 1, handle: 'existing-agent',
    })
    const staged = await database!.query(
      `SELECT resident_id, session_hash, csrf_hash, resident_secret_hash,
           replacement_secret_hash, recovery_generation, confirmed_at, canceled_at
         FROM resident_key_rotations WHERE session_hash = $1`,
      [canceled.sessionHash],
    )
    assert.deepEqual(staged.rows, [{
      resident_id: 1,
      session_hash: canceled.sessionHash,
      csrf_hash: canceled.csrfHash,
      resident_secret_hash: canceled.residentSecretHash,
      replacement_secret_hash: canceled.replacementSecretHash,
      recovery_generation: '0',
      confirmed_at: null,
      canceled_at: null,
    }])
    assert.deepEqual(await store.confirmRootRotation({
      sessionHash: canceled.sessionHash,
      csrfHash: canceled.csrfHash,
      replacementSecretHash: sha256('wrong-replacement'),
      invalidatePairingCodes: true,
    }), { status: 'credential_rejected' })
    assert.equal(await store.cancelRootRotation(canceled), true)

    const expired = rotation('rotation-expired')
    assert.equal((await store.stageRootRotation(expired)).status, 'staged')
    await database!.query(
      `UPDATE resident_key_rotations
         SET created_at = now() - interval '20 minutes',
             expires_at = now() - interval '5 minutes'
         WHERE session_hash = $1`,
      [expired.sessionHash],
    )
    assert.deepEqual(await store.confirmRootRotation({
      sessionHash: expired.sessionHash,
      csrfHash: expired.csrfHash,
      replacementSecretHash: expired.replacementSecretHash,
      invalidatePairingCodes: true,
    }), { status: 'request_unavailable' })
    assert.equal((await store.stageRootRotation(rotation('rotation-cleanup'))).status, 'staged')

    const state = await database!.query(
      `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT bool_and(session_hash IS NULL AND csrf_hash IS NULL
             AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL)
            FROM resident_key_rotations WHERE canceled_at IS NOT NULL) AS terminal_hashes_cleared,
           (SELECT count(*) FROM events WHERE kind = 'rotate') AS rotate_events`,
    )
    assert.deepEqual(state.rows[0], {
      secret_hash: sha256('existing-root-key'),
      terminal_hashes_cleared: true,
      rotate_events: '0',
    })
  })

  await t.test('one root rotation wins and stops every old resident credential only', async () => {
    await resetDatabase()
    const recoveryCodes = await generateCodes(store, 'rotation-winner')
    await database!.query(
      `INSERT INTO residents (id, handle, model, secret_hash)
         VALUES (2, 'unrelated-agent', 'integration-test', $1)`,
      [sha256('unrelated-root-key')],
    )
    await database!.query(
      `WITH resident_request AS (
           INSERT INTO oauth_authorization_requests (
             session_hash, csrf_hash, client_id, redirect_uri, resource, scope,
             state, code_challenge, intent, resident_id, expires_at
           ) VALUES (
             $1, $2, 'resident-client', 'https://client.test/callback',
             'https://city.test/mcp/connect', 'city:resident', 'resident-state',
             'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'existing', 1,
             now() + interval '10 minutes'
           ) RETURNING id
         ), resident_code AS (
           INSERT INTO oauth_authorization_codes (
             request_id, code_hash, resident_id, client_id, redirect_uri, resource,
             scope, code_challenge, expires_at
           ) SELECT id, $3, 1, 'resident-client', 'https://client.test/callback',
             'https://city.test/mcp/connect', 'city:resident',
             'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', now() + interval '4 minutes'
           FROM resident_request
         ), unrelated_request AS (
           INSERT INTO oauth_authorization_requests (
             session_hash, csrf_hash, client_id, redirect_uri, resource, scope,
             state, code_challenge, intent, resident_id, expires_at
           ) VALUES (
             $4, $5, 'unrelated-client', 'https://other.test/callback',
             'https://city.test/mcp/connect', 'city:resident', 'unrelated-state',
             'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'existing', 2,
             now() + interval '10 minutes'
           ) RETURNING id
         )
         INSERT INTO oauth_authorization_codes (
           request_id, code_hash, resident_id, client_id, redirect_uri, resource,
           scope, code_challenge, expires_at
         ) SELECT id, $6, 2, 'unrelated-client', 'https://other.test/callback',
           'https://city.test/mcp/connect', 'city:resident',
           'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', now() + interval '4 minutes'
         FROM unrelated_request`,
      [
        sha256('resident-auth-session'), sha256('resident-auth-csrf'), sha256('resident-auth-code'),
        sha256('unrelated-auth-session'), sha256('unrelated-auth-csrf'), sha256('unrelated-auth-code'),
      ],
    )
    const families = await database!.query(
      `INSERT INTO oauth_token_families (
           resident_id, client_id, resource, scope, expires_at, revoked_at, revoke_reason
         ) VALUES
           (1, 'resident-active', 'https://city.test/mcp/connect', 'city:resident',
             now() + interval '1 day', NULL, NULL),
           (1, 'resident-old-revoked', 'https://city.test/mcp/connect', 'city:resident',
             now() + interval '1 day', now(), 'previous logout'),
           (2, 'unrelated-active', 'https://city.test/mcp/connect', 'city:resident',
             now() + interval '1 day', NULL, NULL)
         RETURNING id, client_id`,
    )
    for (const family of families.rows) {
      await database!.query(
        `INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
           VALUES ($1, 'access', $3, now() + interval '5 minutes'),
             ($2, 'refresh', $3, now() + interval '1 day')`,
        [sha256(`${family.client_id}:access`), sha256(`${family.client_id}:refresh`), family.id],
      )
    }

    // A pairing code minted under the pre-rotation key must not survive
    // rotation for its own resident, but a different resident's pairing
    // code must be untouched.
    await database!.query(
      `INSERT INTO pairing_codes (resident_id, code_hash, secret_hash_at_mint, expires_at)
         VALUES
           (1, $1, $2, now() + interval '9 minutes'),
           (2, $3, $4, now() + interval '9 minutes')`,
      [
        sha256('rotation-winner:pairing-code'), sha256('existing-root-key'),
        sha256('rotation-winner:unrelated-pairing-code'), sha256('unrelated-root-key'),
      ],
    )

    const first = rotation('rotation-first')
    const second = rotation('rotation-second')
    assert.equal((await store.stageRootRotation(first)).status, 'staged')
    assert.equal((await store.stageRootRotation(second)).status, 'staged')
    const rotationResults = await Promise.all([
      store.confirmRootRotation({
        sessionHash: first.sessionHash,
        csrfHash: first.csrfHash,
        replacementSecretHash: first.replacementSecretHash,
        invalidatePairingCodes: true,
      }),
      store.confirmRootRotation({
        sessionHash: second.sessionHash,
        csrfHash: second.csrfHash,
        replacementSecretHash: second.replacementSecretHash,
        invalidatePairingCodes: true,
      }),
    ])
    assert.equal(rotationResults.filter(result => result?.status === 'rotated').length, 1)
    assert.equal(
      rotationResults.filter(result => result.status === 'request_unavailable').length,
      1,
    )
    const rotationWinner = rotationResults[0]?.status === 'rotated' ? first : second
    const oldKey = await store.stageRootRotation(rotation(
      'old-key-rejected', 'existing-root-key', 'unused-replacement',
    ))
    const unknownKey = await store.stageRootRotation(rotation(
      'unknown-key-rejected', 'never-issued-root-key', 'other-unused-replacement',
    ))
    assert.deepEqual(oldKey, { status: 'credential_rejected' })
    assert.deepEqual(unknownKey, oldKey)

    const state = await database!.query(
      `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM resident_recovery_codes
             WHERE invalidated_at IS NOT NULL) AS invalidated_recovery,
           (SELECT count(*) FROM resident_key_rotations
             WHERE confirmed_at IS NOT NULL) AS confirmed_rotations,
           (SELECT count(*) FROM resident_key_rotations
             WHERE invalidated_at IS NOT NULL) AS invalidated_rotations,
           (SELECT bool_and(session_hash IS NULL AND csrf_hash IS NULL
             AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL)
            FROM resident_key_rotations
            WHERE confirmed_at IS NOT NULL OR invalidated_at IS NOT NULL) AS terminal_hashes_cleared,
           (SELECT count(*) FROM oauth_token_families
             WHERE resident_id = 1 AND revoked_at IS NOT NULL) AS resident_revoked_families,
           (SELECT count(*) FROM oauth_tokens token
             JOIN oauth_token_families family ON family.id = token.family_id
             WHERE family.resident_id = 1 AND token.revoked_at IS NOT NULL) AS resident_revoked_tokens,
           (SELECT count(*) FROM oauth_authorization_codes
             WHERE resident_id = 1 AND used_at IS NOT NULL) AS resident_invalidated_codes,
           (SELECT count(*) FROM oauth_token_families
             WHERE resident_id = 2 AND revoked_at IS NOT NULL) AS unrelated_revoked_families,
           (SELECT count(*) FROM oauth_tokens token
             JOIN oauth_token_families family ON family.id = token.family_id
             WHERE family.resident_id = 2 AND token.revoked_at IS NOT NULL) AS unrelated_revoked_tokens,
           (SELECT count(*) FROM oauth_authorization_codes
             WHERE resident_id = 2 AND used_at IS NOT NULL) AS unrelated_invalidated_codes,
           (SELECT secret_hash FROM residents WHERE id = 2) AS unrelated_secret_hash,
           (SELECT count(*) FROM events
             WHERE kind = 'rotate' AND actor = 'existing-agent') AS rotate_events,
           (SELECT invalidated_at IS NOT NULL FROM pairing_codes WHERE resident_id = 1)
             AS resident_pairing_code_invalidated,
           (SELECT invalidated_at IS NOT NULL FROM pairing_codes WHERE resident_id = 2)
             AS unrelated_pairing_code_invalidated`,
    )
    assert.deepEqual(state.rows[0], {
      secret_hash: rotationWinner.replacementSecretHash,
      generation: '2',
      invalidated_recovery: '8',
      confirmed_rotations: '1',
      invalidated_rotations: '1',
      terminal_hashes_cleared: true,
      resident_revoked_families: '2',
      resident_revoked_tokens: '4',
      resident_invalidated_codes: '1',
      unrelated_revoked_families: '0',
      unrelated_revoked_tokens: '0',
      unrelated_invalidated_codes: '0',
      unrelated_secret_hash: sha256('unrelated-root-key'),
      resident_pairing_code_invalidated: true,
      unrelated_pairing_code_invalidated: false,
      rotate_events: '1',
    })
    assert.equal(recoveryCodes.length, 8)
  })
}
