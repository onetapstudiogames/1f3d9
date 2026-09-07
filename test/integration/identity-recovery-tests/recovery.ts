import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  sha256,
  generateCodes,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerRecoveryTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('abandoned or canceled recovery preserves the old key, code, and connector grant', async () => {
    await resetDatabase()
    const codes = await generateCodes(store, 'abandon')
    await database!.query(
      `WITH family AS (
           INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, expires_at)
           VALUES (1, 'test-client', 'https://city.test/mcp/connect', 'city:resident', now() + interval '1 day')
           RETURNING id
         )
         INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
         SELECT $1, 'access', id, now() + interval '5 minutes' FROM family`,
      [sha256('active-access-token')],
    )
    const stage = {
      sessionHash: sha256('abandon:session'),
      csrfHash: sha256('abandon:csrf'),
      recoveryCodeHash: sha256(codes[0]!),
      replacementSecretHash: sha256('replacement-root-key'),
    }
    assert.deepEqual(await store.stageRootRecovery(stage), {
      status: 'staged', handle: 'existing-agent',
    })
    assert.deepEqual(await store.confirmRootRecovery({
      sessionHash: stage.sessionHash,
      csrfHash: stage.csrfHash,
      replacementSecretHash: sha256('wrong-replacement'),
      invalidatePairingCodes: true,
    }), { status: 'credential_rejected' })
    assert.equal(await store.cancelRootRecovery(stage), true)
    const state = await database!.query(
      `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT used_at FROM resident_recovery_codes WHERE code_hash = $1) AS used_at,
           (SELECT revoked_at FROM oauth_token_families LIMIT 1) AS revoked_at`,
      [sha256(codes[0]!)],
    )
    assert.deepEqual(state.rows[0], {
      secret_hash: sha256('existing-root-key'), used_at: null, revoked_at: null,
    })
  })

  await t.test('one recovery wins, rotates the root, invalidates siblings, and revokes OAuth', async () => {
    await resetDatabase()
    const codes = await generateCodes(store, 'winner')
    await database!.query(
      `WITH families AS (
           INSERT INTO oauth_token_families (
             resident_id, client_id, resource, scope, expires_at, revoked_at, revoke_reason
           ) VALUES
             (1, 'test-client', 'https://city.test/mcp/connect', 'city:resident',
               now() + interval '1 day', NULL, NULL),
             (1, 'already-revoked-client', 'https://city.test/mcp/connect', 'city:resident',
               now() + interval '1 day', now(), 'previous logout')
           RETURNING id, client_id
         )
         INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
         SELECT CASE client_id
           WHEN 'test-client' THEN $1
           ELSE $2
         END, 'access', id, now() + interval '5 minutes' FROM families`,
      [sha256('active-access-token'), sha256('orphaned-access-token')],
    )
    // A pairing code minted under the pre-recovery key must not survive
    // recovery when invalidatePairingCodes is true.
    await database!.query(
      `INSERT INTO pairing_codes (resident_id, code_hash, secret_hash_at_mint, expires_at)
         VALUES (1, $1, $2, now() + interval '9 minutes')`,
      [sha256('winner:pairing-code'), sha256('existing-root-key')],
    )
    const first = {
      sessionHash: sha256('winner:first-session'), csrfHash: sha256('winner:first-csrf'),
      recoveryCodeHash: sha256(codes[0]!), replacementSecretHash: sha256('replacement-one'),
    }
    const second = {
      sessionHash: sha256('winner:second-session'), csrfHash: sha256('winner:second-csrf'),
      recoveryCodeHash: sha256(codes[1]!), replacementSecretHash: sha256('replacement-two'),
    }
    assert.equal((await store.stageRootRecovery(first)).status, 'staged')
    assert.equal((await store.stageRootRecovery(second)).status, 'staged')
    const results = await Promise.all([
      store.confirmRootRecovery({
        sessionHash: first.sessionHash, csrfHash: first.csrfHash,
        replacementSecretHash: first.replacementSecretHash,
        invalidatePairingCodes: true,
      }),
      store.confirmRootRecovery({
        sessionHash: second.sessionHash, csrfHash: second.csrfHash,
        replacementSecretHash: second.replacementSecretHash,
        invalidatePairingCodes: true,
      }),
    ])
    assert.equal(results.filter(result => result.status === 'recovered').length, 1)
    assert.equal(results.filter(result => result.status === 'request_unavailable').length, 1)
    const winner = results[0].status === 'recovered' ? first : second
    const state = await database!.query(
      `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM resident_recovery_codes WHERE used_at IS NOT NULL) AS used,
           (SELECT count(*) FROM resident_recovery_codes WHERE invalidated_at IS NOT NULL) AS invalidated,
           (SELECT count(*) FROM oauth_token_families WHERE revoked_at IS NOT NULL) AS revoked_families,
           (SELECT count(*) FROM oauth_tokens WHERE revoked_at IS NOT NULL) AS revoked_tokens,
           (SELECT count(*) FROM events WHERE kind = 'rotate' AND actor = 'existing-agent') AS rotate_events,
           (SELECT invalidated_at IS NOT NULL FROM pairing_codes WHERE resident_id = 1) AS pairing_code_invalidated`,
    )
    assert.deepEqual(state.rows[0], {
      secret_hash: winner.replacementSecretHash,
      generation: '2', used: '1', invalidated: '7',
      revoked_families: '2', revoked_tokens: '2', rotate_events: '1',
      pairing_code_invalidated: true,
    })

    const usedCode = await store.stageRootRecovery({
      sessionHash: sha256('used-code:session'),
      csrfHash: sha256('used-code:csrf'),
      recoveryCodeHash: winner.recoveryCodeHash,
      replacementSecretHash: sha256('used-code:replacement'),
    })
    const unknownCode = await store.stageRootRecovery({
      sessionHash: sha256('unknown-code:session'),
      csrfHash: sha256('unknown-code:csrf'),
      recoveryCodeHash: sha256('unknown-code'),
      replacementSecretHash: sha256('unknown-code:replacement'),
    })
    assert.deepEqual(usedCode, { status: 'credential_rejected' })
    assert.deepEqual(unknownCode, usedCode)
  })
}
