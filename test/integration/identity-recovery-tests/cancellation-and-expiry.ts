import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  registration,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerCancellationAndExpiryTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('registration cancellation and expiry scrub every pending recovery hash', async () => {
    await resetDatabase()
    const canceled = registration('canceled-registration', 'canceled-registration')
    assert.equal((await store.stageResidentRegistration(canceled))?.status, 'staged')
    assert.equal(await store.cancelResidentRegistration({
      sessionHash: canceled.sessionHash,
      csrfHash: canceled.csrfHash,
    }), true)
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: canceled.sessionHash,
      csrfHash: canceled.csrfHash,
    }), { status: 'canceled' })
    assert.equal(await store.cancelResidentRegistration({
      sessionHash: canceled.sessionHash,
      csrfHash: canceled.csrfHash,
    }), false)
    await database!.query(
      `UPDATE pending_resident_registrations
         SET created_at = now() - interval '3 minutes',
             canceled_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
      [canceled.sessionHash],
    )
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: canceled.sessionHash,
      csrfHash: canceled.csrfHash,
    }), { status: 'canceled' })

    const expired = registration('expired-registration', 'expired-registration')
    assert.equal((await store.stageResidentRegistration(expired))?.status, 'staged')
    await database!.query(
      `UPDATE pending_resident_registrations
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
      [expired.sessionHash],
    )
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: expired.sessionHash,
      csrfHash: expired.csrfHash,
    }), { status: 'expired' })
    assert.equal(
      (await store.stageResidentRegistration(registration('cleanup-trigger', 'cleanup-trigger')))?.status,
      'staged',
    )
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: expired.sessionHash,
      csrfHash: expired.csrfHash,
    }), { status: 'expired' })

    const state = await database!.query(
      `SELECT pending.session_hash, pending.handle, pending.model, pending.client_class, pending.secret_hash,
           pending.ip_hash, pending.canceled_at IS NOT NULL AS canceled,
           count(code.code_hash) AS pending_codes
         FROM pending_resident_registrations pending
         LEFT JOIN pending_resident_registration_recovery_codes code
           ON code.registration_session_hash = pending.session_hash
         WHERE pending.session_hash IN ($1, $2)
         GROUP BY pending.session_hash, pending.handle, pending.model, pending.client_class, pending.secret_hash,
           pending.ip_hash, pending.canceled_at
         ORDER BY pending.session_hash`,
      [canceled.sessionHash, expired.sessionHash],
    )
    assert.equal(state.rows.length, 2)
    for (const row of state.rows) {
      assert.deepEqual({
        handle: row.handle,
        model: row.model,
        client_class: row.client_class,
        secret_hash: row.secret_hash,
        ip_hash: row.ip_hash,
        canceled: row.canceled,
        pending_codes: row.pending_codes,
      }, {
        handle: null,
        model: null,
        client_class: null,
        secret_hash: null,
        ip_hash: null,
        canceled: true,
        pending_codes: '0',
      })
    }
    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: canceled.sessionHash,
      csrfHash: canceled.csrfHash,
      residentSecretHash: canceled.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    }), { status: 'request_unavailable' })
    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: expired.sessionHash,
      csrfHash: expired.csrfHash,
      residentSecretHash: expired.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    }), { status: 'request_unavailable' })
  })
}
