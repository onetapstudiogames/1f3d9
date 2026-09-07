import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  sha256,
  registration,
  rotation,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerMigrationsTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
  recoveryMigrationDdl: string,
  rotationMigrationDdl: string,
  initialRecoveryCodesMigrationDdl: string,
  resumableRegistrationMigrationDdl: string,
): Promise<void> {
  await t.test('the recovery migration can be reapplied without changing existing identity state', async () => {
    await resetDatabase()
    await database!.query(recoveryMigrationDdl)
    await database!.query(recoveryMigrationDdl)
    const state = await database!.query(
      `SELECT
           (SELECT count(*) FROM residents) AS residents,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM pending_resident_registrations) AS pending,
           (SELECT count(*) FROM resident_recovery_codes) AS recovery_codes`,
    )
    assert.deepEqual(state.rows, [{
      residents: '1', generation: '0', pending: '0', recovery_codes: '0',
    }])
  })

  await t.test('the rotation migration is idempotent and preserves staged hashes', async () => {
    await resetDatabase()
    const staged = rotation('migration-preserved')
    await database!.query(
      `INSERT INTO resident_key_rotations (
           resident_id, recovery_generation, session_hash, csrf_hash,
           resident_secret_hash, replacement_secret_hash, expires_at
         ) VALUES (1, 0, $1, $2, $3, $4, now() + interval '15 minutes')`,
      [
        staged.sessionHash, staged.csrfHash,
        staged.residentSecretHash, staged.replacementSecretHash,
      ],
    )
    await database!.query(rotationMigrationDdl)
    await database!.query(rotationMigrationDdl)
    await database!.query(
      `INSERT INTO identity_rate_limits (bucket_hash, attempt_kind, window_start)
         VALUES ($1, 'rotation_begin', date_trunc('hour', now(), 'UTC')),
           ($2, 'rotation_confirm', date_trunc('hour', now(), 'UTC'))`,
      [sha256('migration-begin'), sha256('migration-confirm')],
    )
    const state = await database!.query(
      `SELECT session_hash, csrf_hash, resident_secret_hash, replacement_secret_hash,
           (SELECT count(*) FROM identity_rate_limits
            WHERE attempt_kind IN ('rotation_begin', 'rotation_confirm')) AS rate_kinds
         FROM resident_key_rotations`,
    )
    assert.deepEqual(state.rows, [{
      session_hash: staged.sessionHash,
      csrf_hash: staged.csrfHash,
      resident_secret_hash: staged.residentSecretHash,
      replacement_secret_hash: staged.replacementSecretHash,
      rate_kinds: '2',
    }])
  })

  await t.test('the initial-code migration is idempotent and old staged rows remain writable but fail closed', async () => {
    await resetDatabase()
    await database!.query(initialRecoveryCodesMigrationDdl)
    await database!.query(initialRecoveryCodesMigrationDdl)
    const legacy = registration('legacy-no-codes', 'legacy-no-codes')
    await database!.query(
      `INSERT INTO pending_resident_registrations (
           session_hash, csrf_hash, ip_hash, handle, model, client_class, secret_hash, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '15 minutes')`,
      [
        legacy.sessionHash, legacy.csrfHash, legacy.ipHash, legacy.handle,
        legacy.model, legacy.clientClass, legacy.residentSecretHash,
      ],
    )

    await assert.rejects(
      store.confirmResidentRegistration({
        sessionHash: legacy.sessionHash,
        csrfHash: legacy.csrfHash,
        residentSecretHash: legacy.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }),
      /registration confirmation produced no outcome/i,
    )
    const state = await database!.query(
      `SELECT
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS pending_codes,
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id`,
      [legacy.handle, legacy.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      residents: '0', presences: '0', active_codes: '0', pending_codes: '0', last_id: 1,
    }])

    await database!.query(
      `UPDATE pending_resident_registrations
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
      [legacy.sessionHash],
    )
    assert.equal(
      (await store.stageResidentRegistration(registration('legacy-cleanup-trigger', 'legacy-cleanup-trigger')))?.status,
      'staged',
    )
    const expired = await database!.query(
      `SELECT handle, model, client_class, secret_hash, ip_hash, canceled_at IS NOT NULL AS canceled
         FROM pending_resident_registrations WHERE session_hash = $1`,
      [legacy.sessionHash],
    )
    assert.deepEqual(expired.rows, [{
      handle: null, model: null, client_class: null, secret_hash: null, ip_hash: null, canceled: true,
    }])
  })

  await t.test('the resumable-registration migration upgrades an old staged join and is idempotent', async () => {
    await resetDatabase()
    await database!.query(`
        ALTER TABLE pending_resident_registrations
          DROP CONSTRAINT pending_resident_registrations_client_class_valid;
        ALTER TABLE pending_resident_registrations DROP COLUMN client_class;
      `)
    const legacy = registration('resumable-legacy', 'resumable-legacy')
    await database!.query(
      `INSERT INTO pending_resident_registrations (
           session_hash, csrf_hash, ip_hash, handle, model, secret_hash, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '15 minutes')`,
      [
        legacy.sessionHash, legacy.csrfHash, legacy.ipHash, legacy.handle,
        legacy.model, legacy.residentSecretHash,
      ],
    )
    await database!.query(
      `INSERT INTO pending_resident_registration_recovery_codes (
           registration_session_hash, ordinal, code_hash
         ) SELECT $1, code.ordinality::smallint, code.code_hash
           FROM unnest($2::text[]) WITH ORDINALITY AS code(code_hash, ordinality)`,
      [legacy.sessionHash, legacy.recoveryCodeHashes],
    )
    assert.equal((await database!.query(
      `SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pending_resident_registrations'
           AND column_name = 'client_class'`,
    )).rows[0]!.count, '0')

    await database!.query(resumableRegistrationMigrationDdl)
    const upgraded = await database!.query(
      `SELECT
           (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'pending_resident_registrations'
              AND column_name = 'client_class') AS columns,
           (SELECT convalidated FROM pg_constraint
            WHERE conrelid = 'pending_resident_registrations'::regclass
              AND conname = 'pending_resident_registrations_client_class_valid') AS validated`,
    )
    assert.deepEqual(upgraded.rows, [{ columns: '1', validated: true }])
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: legacy.sessionHash,
      csrfHash: legacy.csrfHash,
    }), {
      status: 'staged', handle: legacy.handle, clientClass: 'legacy_unknown',
    })

    const pending = registration('resumable-migration', 'resumable-migration')
    assert.equal((await store.stageResidentRegistration(pending)).status, 'staged')
    await database!.query(resumableRegistrationMigrationDdl)
    const state = await database!.query(
      `SELECT client_class, secret_hash,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
            WHERE registration_session_hash = $1) AS pending_codes
         FROM pending_resident_registrations WHERE session_hash = $1`,
      [pending.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      client_class: 'coding_ephemeral',
      secret_hash: pending.residentSecretHash,
      pending_codes: '8',
    }])
    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: legacy.sessionHash,
      csrfHash: legacy.csrfHash,
      residentSecretHash: legacy.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    }), {
      status: 'confirmed', residentId: 2, handle: legacy.handle,
    })
  })
}
