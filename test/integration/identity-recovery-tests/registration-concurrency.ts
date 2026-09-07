import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  sha256,
  registration,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerRegistrationConcurrencyTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('concurrent correct and wrong confirmations preserve exact saved-key truth', async () => {
    await resetDatabase()
    const pending = registration('race-exact-key', 'race-exact-key')
    assert.equal((await store.stageResidentRegistration(pending)).status, 'staged')
    await database!.query(`
        CREATE OR REPLACE FUNCTION delay_race_registration_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'race-exact-key' THEN
            PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER delay_race_registration_event
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION delay_race_registration_event();
      `)

    const correct = store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: pending.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const wrong = store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: sha256('wrong-racing-key'),
      jsonDoorHumanApprovalDeclared: true,
    })
    assert.deepEqual(await Promise.all([correct, wrong]), [
      { status: 'confirmed', residentId: 2, handle: 'race-exact-key' },
      { status: 'credential_rejected' },
    ])
    assert.equal((await database!.query(
      `SELECT count(*) FROM residents WHERE handle = 'race-exact-key'`,
    )).rows[0]!.count, '1')
    assert.equal((await database!.query(
      `SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'race-exact-key'`,
    )).rows[0]!.count, '1')
    assert.equal((await database!.query(
      `SELECT count(*) FROM resident_recovery_codes WHERE resident_id = 2`,
    )).rows[0]!.count, '8')
  })

  await t.test('an active-code collision rolls back resident creation and keeps the pending set retryable', async () => {
    await resetDatabase()
    const pending = registration('active-code-collision', 'collision-resident')
    await database!.query('UPDATE residents SET recovery_generation = 1 WHERE id = 1')
    await database!.query(
      `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         VALUES (1, 1, $1)`,
      [pending.recoveryCodeHashes[3]],
    )
    assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')

    await assert.rejects(
      store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }),
      { code: '23505', constraint: 'resident_recovery_codes_code_hash_key' },
    )
    const state = await database!.query(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS pending_codes,
           (SELECT secret_hash FROM pending_resident_registrations
             WHERE session_hash = $2) AS pending_secret_hash`,
      [pending.handle, pending.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      last_id: 1,
      residents: '0',
      presences: '0',
      events: '0',
      active_codes: '0',
      pending_codes: '8',
      pending_secret_hash: pending.residentSecretHash,
    }])
  })

  await t.test('a downstream event failure rolls the allocator, resident, presence, and initial codes back', async () => {
    await resetDatabase()
    const pending = registration('event-rollback', 'event-rollback')
    assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')
    await database!.query(`
        CREATE FUNCTION fail_registration_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'event-rollback' THEN
            RAISE EXCEPTION 'injected registration event failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER events_fail_registration
          BEFORE INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION fail_registration_event();
      `)

    await assert.rejects(
      store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }),
      /injected registration event failure/i,
    )
    const state = await database!.query(
      `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS pending_codes`,
      [pending.handle, pending.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      last_id: 1, residents: '0', presences: '0', events: '0',
      active_codes: '0', pending_codes: '8',
    }])
  })

  await t.test('two pending claims for one handle have one confirmed and one handle-taken outcome', async () => {
    await resetDatabase()
    const first = registration('race-first', 'raced-name')
    const second = registration('race-second', 'raced-name')
    assert.equal((await store.stageResidentRegistration(first))?.status, 'staged')
    assert.equal((await store.stageResidentRegistration(second))?.status, 'staged')
    const results = await Promise.all([
      store.confirmResidentRegistration({
        sessionHash: first.sessionHash, csrfHash: first.csrfHash,
        residentSecretHash: first.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }),
      store.confirmResidentRegistration({
        sessionHash: second.sessionHash, csrfHash: second.csrfHash,
        residentSecretHash: second.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }),
    ])
    assert.equal(results.filter(result => result.status === 'confirmed').length, 1)
    assert.equal(results.filter(result => result.status === 'handle_taken').length, 1)
    assert.equal((await database!.query("SELECT count(*) FROM residents WHERE handle = 'raced-name'")).rows[0]!.count, '1')
    assert.equal((await database!.query("SELECT count(*) FROM events WHERE actor = 'raced-name'")).rows[0]!.count, '1')
    assert.equal((await database!.query('SELECT last_id FROM resident_id_allocator WHERE singleton')).rows[0]!.last_id, 2)
    const winner = results[0].status === 'confirmed' ? first : second
    const loser = results[0].status === 'confirmed' ? second : first
    const codes = await database!.query(
      `SELECT
           (SELECT count(*) FROM resident_recovery_codes code
             JOIN residents resident ON resident.id = code.resident_id
             WHERE resident.handle = 'raced-name' AND code.generation = 1
               AND code.used_at IS NULL AND code.invalidated_at IS NULL) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $1) AS winner_pending_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS loser_pending_codes`,
      [winner.sessionHash, loser.sessionHash],
    )
    assert.deepEqual(codes.rows, [{
      active_codes: '8', winner_pending_codes: '0', loser_pending_codes: '0',
    }])
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: loser.sessionHash,
      csrfHash: loser.csrfHash,
    }), { status: 'canceled' })
  })

  await t.test('a cancel waiting behind confirmation reports that it lost', async () => {
    await resetDatabase()
    const pending = registration('cancel-confirm-race', 'cancel-confirm-race')
    assert.equal((await store.stageResidentRegistration(pending)).status, 'staged')
    await database!.query(`
        CREATE OR REPLACE FUNCTION delay_cancel_race_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'cancel-confirm-race' THEN
            PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER delay_cancel_race_event
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION delay_cancel_race_event();
      `)

    const confirmation = store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: pending.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    const cancellation = store.cancelResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
    })
    assert.deepEqual(await confirmation, {
      status: 'confirmed', residentId: 2, handle: pending.handle,
    })
    assert.equal(await cancellation, false)
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
    }), {
      status: 'confirmed', residentId: 2, handle: pending.handle,
    })
  })
}
