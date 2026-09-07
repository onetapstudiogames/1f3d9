import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  sha256,
  registration,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerRegistrationConfirmationTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('registration stores only hashes and creates nothing before exact key confirmation', async () => {
    await resetDatabase()
    const pending = registration('staged')
    assert.deepEqual(await store.stageResidentRegistration(pending), {
      status: 'staged', handle: 'new-resident',
    })
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
    }), {
      status: 'staged', handle: 'new-resident', clientClass: 'coding_ephemeral',
    })
    const before = await database!.query(
      `SELECT handle, model, client_class, secret_hash, ip_hash, resident_id, confirmed_at, canceled_at
         FROM pending_resident_registrations WHERE session_hash = $1`,
      [pending.sessionHash],
    )
    assert.deepEqual(before.rows, [{
      handle: pending.handle,
      model: pending.model,
      client_class: pending.clientClass,
      secret_hash: pending.residentSecretHash,
      ip_hash: pending.ipHash,
      resident_id: null,
      confirmed_at: null,
      canceled_at: null,
    }])
    const pendingCodes = await database!.query(
      `SELECT ordinal, code_hash
         FROM pending_resident_registration_recovery_codes
         WHERE registration_session_hash = $1
         ORDER BY ordinal`,
      [pending.sessionHash],
    )
    assert.deepEqual(
      pendingCodes.rows,
      pending.recoveryCodeHashes.map((code_hash, index) => ({ ordinal: index + 1, code_hash })),
    )
    assert.equal((await database!.query("SELECT count(*) FROM residents WHERE handle = 'new-resident'")).rows[0]!.count, '0')
    assert.equal((await database!.query("SELECT count(*) FROM events WHERE actor = 'new-resident'")).rows[0]!.count, '0')

    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: sha256('wrong-key'),
      jsonDoorHumanApprovalDeclared: true,
    }), { status: 'credential_rejected' })
    const afterWrongKey = await database!.query(
      `SELECT confirmed_at, canceled_at, secret_hash,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
            WHERE registration_session_hash = $1) AS pending_codes
         FROM pending_resident_registrations WHERE session_hash = $1`,
      [pending.sessionHash],
    )
    assert.deepEqual(afterWrongKey.rows, [{
      confirmed_at: null,
      canceled_at: null,
      secret_hash: pending.residentSecretHash,
      pending_codes: '8',
    }])
    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: pending.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    }), { status: 'confirmed', residentId: 2, handle: 'new-resident' })
    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: pending.residentSecretHash,
      jsonDoorHumanApprovalDeclared: true,
    }), { status: 'confirmed', residentId: 2, handle: 'new-resident' })
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
    }), { status: 'confirmed', residentId: 2, handle: 'new-resident' })

    const after = await database!.query(
      `SELECT handle, model, client_class, secret_hash, ip_hash, resident_id, confirmed_at IS NOT NULL AS confirmed
         FROM pending_resident_registrations WHERE session_hash = $1`,
      [pending.sessionHash],
    )
    assert.deepEqual(after.rows, [{
      handle: null, model: null, client_class: null, secret_hash: null, ip_hash: null,
      resident_id: 2, confirmed: true,
    }])
    const recoveryState = await database!.query(
      `SELECT resident.recovery_generation,
           array_agg(code.code_hash ORDER BY code.code_hash) AS code_hashes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $1) AS pending_codes
         FROM residents resident
         JOIN resident_recovery_codes code ON code.resident_id = resident.id
         WHERE resident.id = 2 AND code.generation = 1
           AND code.used_at IS NULL AND code.invalidated_at IS NULL
         GROUP BY resident.recovery_generation`,
      [pending.sessionHash],
    )
    assert.deepEqual(recoveryState.rows, [{
      recovery_generation: '1',
      code_hashes: [...pending.recoveryCodeHashes].sort(),
      pending_codes: '0',
    }])
    assert.equal((await database!.query("SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'new-resident'")).rows[0]!.count, '1')
    assert.equal((await database!.query('SELECT last_id FROM resident_id_allocator WHERE singleton')).rows[0]!.last_id, 2)
    // Decision row 74 security fix: json_door_human_approval_declared has
    // no column of its own on pending_resident_registrations -- it is
    // bound in directly from confirmResidentRegistration's own
    // jsonDoorHumanApprovalDeclared input parameter, supplied here
    // exactly like identity-api.ts (the JSON door) always supplies it:
    // true.
    const registerEvent = await database!.query<{
      detail: { json_door_human_approval_declared: boolean; client_class: string }
    }>(
      "SELECT detail FROM events WHERE kind = 'register' AND actor = 'new-resident'",
    )
    assert.deepEqual(registerEvent.rows[0]!.detail.json_door_human_approval_declared, true)
    assert.deepEqual(registerEvent.rows[0]!.detail.client_class, 'coding_ephemeral')
  })

  await t.test('a browser-shaped registration keeps its register event byte-identical to main, never client_class or a human-approval key', async () => {
    // Complements the JSON-shaped assertion above: identity-browser.ts's
    // /join page always calls confirmResidentRegistration with
    // jsonDoorHumanApprovalDeclared: null, even when it stages
    // client_class coding_persistent/coding_ephemeral, so the browser
    // path's event detail stays exactly what main has always written --
    // {resident_id, model} -- and never gains client_class or any
    // human-approval key it never declared.
    await resetDatabase()
    const pending = registration('browser-shape', 'browser-shape-resident')
    assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')
    assert.deepEqual(await store.confirmResidentRegistration({
      sessionHash: pending.sessionHash,
      csrfHash: pending.csrfHash,
      residentSecretHash: pending.residentSecretHash,
      jsonDoorHumanApprovalDeclared: null,
    }), { status: 'confirmed', residentId: 2, handle: 'browser-shape-resident' })
    const registerEvent = await database!.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM events WHERE kind = 'register' AND actor = 'browser-shape-resident'",
    )
    assert.equal(registerEvent.rows.length, 1)
    const detail = registerEvent.rows[0]!.detail
    assert.deepEqual(Object.keys(detail).sort(), ['model', 'resident_id'])
    assert.equal(detail.model, 'postgres-test')
    // Neither human_approved nor json_door_human_approval_declared is
    // ever persisted anywhere but the JSON door's confirmed register
    // event's jsonb detail -- confirm no such column exists.
    assert.equal(
      (await database!.query(
        `SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pending_resident_registrations'
             AND column_name IN ('human_approved', 'json_door_human_approval_declared')`,
      )).rows[0]!.count,
      '0',
    )
  })

  await t.test('a missing world root leaves the whole registration pending and unchanged', async () => {
    await resetDatabase()
    await database!.query('DROP TRIGGER places_protect_topology_write ON places')
    await database!.query("DELETE FROM places WHERE place_kind = 'world'")
    const pending = registration('missing-world', 'unplaced-resident')
    assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')

    await assert.rejects(
      store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }),
      /registration confirmation produced no outcome/i,
    )

    const state = await database!.query(
      `SELECT
           (SELECT count(*) FROM residents WHERE handle = 'unplaced-resident') AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = 'unplaced-resident') AS events,
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT resident_id FROM pending_resident_registrations WHERE session_hash = $1) AS resident_id,
           (SELECT confirmed_at FROM pending_resident_registrations WHERE session_hash = $1) AS confirmed_at`,
      [pending.sessionHash],
    )
    assert.deepEqual(state.rows, [{
      residents: '0', presences: '0', events: '0', last_id: 1,
      resident_id: null, confirmed_at: null,
    }])
    assert.equal(
      (await database!.query(
        `SELECT count(*) FROM pending_resident_registration_recovery_codes
           WHERE registration_session_hash = $1`,
        [pending.sessionHash],
      )).rows[0]!.count,
      '8',
    )
  })
}
