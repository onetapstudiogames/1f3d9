import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { expirePaymentAttempt } from '../../../src/payment-attempts.ts'
import {
  insertAttempt,
  postgresCode,
} from '../../helpers/payment-recovery-postgres-fixtures/payment-attempts.ts'

export async function registerMigrationsTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
  recoveryMigrationDdl: string,
  recoveryTriggerRepairMigrationDdl: string,
): Promise<void> {
  await t.test('the trigger repair migration re-allows due x402 expiry from payment_pending', async () => {
    await reset(database)
    await database.query(`
      CREATE OR REPLACE FUNCTION protect_payment_attempt_history() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'payment attempt history cannot be deleted' USING ERRCODE = '55000';
        END IF;
        IF OLD.status IN ('completed', 'invalid', 'expired', 'legacy_completed', 'credit_returned')
          AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
        END IF;
        IF NOT (
          (OLD.status = 'settling' AND NEW.status IN (
            'settling', 'payment_pending', 'invalid', 'expired', 'needs_review'
          ))
          OR (OLD.status = 'payment_pending' AND NEW.status IN (
            'payment_pending', 'completed', 'invalid', 'needs_review'
          ))
          OR (OLD.status = 'needs_review' AND NEW.status IN (
            'needs_review', 'payment_pending', 'completed', 'invalid'
          ))
          OR (
            OLD.method = 'credit'
            AND OLD.status IN ('settling', 'payment_pending')
            AND NEW.status IN ('completed', 'credit_returned')
          )
          OR (OLD.status = NEW.status)
        ) THEN
          RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE = '55000';
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
          RAISE EXCEPTION 'payment attempt update time cannot move backward' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $function$;
    `)
    await insertAttempt(database, {
      publicId: 'pay_recovery_stale_trigger', targetKey: 'frontier:root:stale-trigger',
      status: 'payment_pending', leaseOwner: 'lease-due', recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }

    await assert.rejects(
      expirePaymentAttempt(paymentDatabase, {
        publicId: 'pay_recovery_stale_trigger',
        leaseOwner: 'lease-due',
        reason: 'automatic payment recovery deadline passed',
      }),
      (error: unknown) => postgresCode(error) === '55000',
    )

    await database.query(recoveryTriggerRepairMigrationDdl)
    const expired = await expirePaymentAttempt(paymentDatabase, {
      publicId: 'pay_recovery_stale_trigger',
      leaseOwner: 'lease-due',
      reason: 'automatic payment recovery deadline passed',
    })
    assert.equal(expired.status, 'expired')
    assert.equal(expired.leaseOwner, null)
    assert.equal(expired.invalidReason, 'automatic payment recovery deadline passed')
  })

  await t.test('additive migration backfills old live rows from their last known update', async () => {
    await reset(database)
    await database.query('ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_initialize_recovery_window')
    await database.query('ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_keep_history')
    await database.query('ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_recovery_window_valid')
    await database.query('ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_x402_live_recovery_required')
    await insertAttempt(database, {
      publicId: 'pay_recovery_backfill', targetKey: 'frontier:root:backfill',
      status: 'payment_pending', leaseOwner: null, recovery: 'none',
    })
    await database.query(`UPDATE payment_attempts
      SET recovery_started_at = NULL,
          recovery_deadline_at = NULL,
          created_at = clock_timestamp() - interval '4 hours',
          updated_at = clock_timestamp() - interval '3 hours'
      WHERE public_id = 'pay_recovery_backfill'`)
    await database.query('ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_initialize_recovery_window')
    await database.query('ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_keep_history')

    await database.query(recoveryMigrationDdl)
    const backfill = await database.query<{
      anchored_to_update: boolean
      is_past_deadline: boolean
    }>(`SELECT recovery_started_at = updated_at AS anchored_to_update,
              recovery_deadline_at <= clock_timestamp() AS is_past_deadline
        FROM payment_attempts WHERE public_id = 'pay_recovery_backfill'`)
    assert.deepEqual(backfill.rows, [{ anchored_to_update: true, is_past_deadline: true }])
  })

}
