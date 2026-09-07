import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  sha256,
  rotation,
  generateCodes,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerRotationRecoveryBoundariesTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('invalidatePairingCodes false leaves a resident\'s pairing code untouched even after rotation and recovery succeed', async () => {
    // Decision row 74 security fix: CODING_IDENTITY_DOORS_ENABLED off (the
    // default) means identity-browser.ts passes invalidatePairingCodes:
    // false to both confirmRootRotation and confirmRootRecovery. This
    // must never fail the rotation or recovery itself, and must leave any
    // pairing code exactly as it was -- the redundant secret_hash_at_mint
    // recheck at redemption (oauth-store.ts) is what keeps this fail-closed.
    await resetDatabase()
    await database!.query(
      `INSERT INTO pairing_codes (resident_id, code_hash, secret_hash_at_mint, expires_at)
         VALUES (1, $1, $2, now() + interval '9 minutes')`,
      [sha256('untouched:pairing-code'), sha256('existing-root-key')],
    )
    const staged = rotation('untouched-rotation')
    assert.equal((await store.stageRootRotation(staged)).status, 'staged')
    assert.deepEqual(await store.confirmRootRotation({
      sessionHash: staged.sessionHash,
      csrfHash: staged.csrfHash,
      replacementSecretHash: staged.replacementSecretHash,
      invalidatePairingCodes: false,
    }), { status: 'rotated', residentId: 1, handle: 'existing-agent' })
    const afterRotation = await database!.query(
      `SELECT invalidated_at IS NOT NULL AS invalidated FROM pairing_codes WHERE resident_id = 1`,
    )
    assert.deepEqual(afterRotation.rows, [{ invalidated: false }])

    // Insert a fresh recovery code directly at resident 1's post-rotation
    // recovery_generation (rotation already invalidated the original set).
    await database!.query(
      `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         SELECT id, recovery_generation, $1 FROM residents WHERE id = 1`,
      [sha256('untouched-recovery-code')],
    )
    const stagedRecovery = await store.stageRootRecovery({
      sessionHash: sha256('untouched-recovery:session'),
      csrfHash: sha256('untouched-recovery:csrf'),
      recoveryCodeHash: sha256('untouched-recovery-code'),
      replacementSecretHash: sha256('untouched-recovery:replacement'),
    })
    assert.equal(stagedRecovery.status, 'staged')
    assert.deepEqual(await store.confirmRootRecovery({
      sessionHash: sha256('untouched-recovery:session'),
      csrfHash: sha256('untouched-recovery:csrf'),
      replacementSecretHash: sha256('untouched-recovery:replacement'),
      invalidatePairingCodes: false,
    }), { status: 'recovered', residentId: 1, handle: 'existing-agent' })
    const afterRecovery = await database!.query(
      `SELECT invalidated_at IS NOT NULL AS invalidated FROM pairing_codes WHERE resident_id = 1`,
    )
    assert.deepEqual(afterRecovery.rows, [{ invalidated: false }])
  })

  await t.test('root rotation and recovery use one shared generation winner', async () => {
    await resetDatabase()
    const codes = await generateCodes(store, 'rotation-recovery-race')
    const recovery = {
      sessionHash: sha256('rotation-recovery:recovery-session'),
      csrfHash: sha256('rotation-recovery:recovery-csrf'),
      recoveryCodeHash: sha256(codes[0]!),
      replacementSecretHash: sha256('recovery-race-replacement'),
    }
    const rootRotation = rotation('rotation-recovery:rotation')
    assert.equal((await store.stageRootRecovery(recovery)).status, 'staged')
    assert.equal((await store.stageRootRotation(rootRotation)).status, 'staged')
    const recoveryRace = await Promise.all([
      store.confirmRootRecovery({
        sessionHash: recovery.sessionHash,
        csrfHash: recovery.csrfHash,
        replacementSecretHash: recovery.replacementSecretHash,
        invalidatePairingCodes: true,
      }),
      store.confirmRootRotation({
        sessionHash: rootRotation.sessionHash,
        csrfHash: rootRotation.csrfHash,
        replacementSecretHash: rootRotation.replacementSecretHash,
        invalidatePairingCodes: true,
      }),
    ])
    assert.deepEqual(recoveryRace[0], {
      status: 'recovered', residentId: 1, handle: 'existing-agent',
    })
    assert.deepEqual(recoveryRace[1], { status: 'request_unavailable' })
    const recoveryWon = await database!.query(
      `SELECT secret_hash, recovery_generation,
           (SELECT count(*) FROM resident_key_rotations
            WHERE invalidated_at IS NOT NULL
              AND session_hash IS NULL AND csrf_hash IS NULL
              AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL) AS invalidated_rotations
         FROM residents WHERE id = 1`,
    )
    assert.deepEqual(recoveryWon.rows, [{
      secret_hash: recovery.replacementSecretHash,
      recovery_generation: '2',
      invalidated_rotations: '1',
    }])

    await resetDatabase()
    const otherCodes = await generateCodes(store, 'rotation-recovery-other-race')
    const otherRecovery = {
      sessionHash: sha256('rotation-other:recovery-session'),
      csrfHash: sha256('rotation-other:recovery-csrf'),
      recoveryCodeHash: sha256(otherCodes[0]!),
      replacementSecretHash: sha256('other-recovery-replacement'),
    }
    const otherRotation = rotation('rotation-other:rotation')
    assert.equal((await store.stageRootRecovery(otherRecovery)).status, 'staged')
    assert.equal((await store.stageRootRotation(otherRotation)).status, 'staged')
    assert.equal((await store.confirmRootRotation({
      sessionHash: otherRotation.sessionHash,
      csrfHash: otherRotation.csrfHash,
      replacementSecretHash: otherRotation.replacementSecretHash,
      invalidatePairingCodes: true,
    }))?.status, 'rotated')
    assert.deepEqual(await store.confirmRootRecovery({
      sessionHash: otherRecovery.sessionHash,
      csrfHash: otherRecovery.csrfHash,
      replacementSecretHash: otherRecovery.replacementSecretHash,
      invalidatePairingCodes: true,
    }), { status: 'request_unavailable' })
    const rotationWon = await database!.query(
      `SELECT secret_hash, recovery_generation,
           (SELECT count(*) FROM resident_recovery_codes
            WHERE invalidated_at IS NOT NULL) AS invalidated_recovery
         FROM residents WHERE id = 1`,
    )
    assert.deepEqual(rotationWon.rows, [{
      secret_hash: otherRotation.replacementSecretHash,
      recovery_generation: '2',
      invalidated_recovery: '8',
    }])
  })

  await t.test('only five successful root rotations are allowed per resident per UTC day', async () => {
    await resetDatabase()
    let currentSecret = 'existing-root-key'
    for (let index = 0; index < 5; index += 1) {
      const nextSecret = `daily-rotation-${index}`
      const intent = rotation(`daily-${index}`, currentSecret, nextSecret)
      assert.equal((await store.stageRootRotation(intent)).status, 'staged')
      assert.equal((await store.confirmRootRotation({
        sessionHash: intent.sessionHash,
        csrfHash: intent.csrfHash,
        replacementSecretHash: intent.replacementSecretHash,
        invalidatePairingCodes: true,
      }))?.status, 'rotated')
      currentSecret = nextSecret
    }
    const limited = rotation('daily-limited', currentSecret, 'daily-rejected')
    assert.equal((await store.stageRootRotation(limited)).status, 'staged')
    assert.deepEqual(await store.confirmRootRotation({
      sessionHash: limited.sessionHash,
      csrfHash: limited.csrfHash,
      replacementSecretHash: limited.replacementSecretHash,
      invalidatePairingCodes: true,
    }), { status: 'rate_limited' })
    const state = await database!.query(
      `SELECT secret_hash, recovery_generation,
           (SELECT count(*) FROM resident_key_rotations WHERE confirmed_at IS NOT NULL) AS confirmed,
           (SELECT count(*) FROM resident_key_rotations
             WHERE canceled_at IS NOT NULL AND session_hash IS NULL AND csrf_hash IS NULL
               AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL) AS scrubbed_canceled,
           (SELECT count(*) FROM events WHERE kind = 'rotate') AS rotate_events
         FROM residents WHERE id = 1`,
    )
    assert.deepEqual(state.rows, [{
      secret_hash: sha256(currentSecret),
      recovery_generation: '5',
      confirmed: '5',
      scrubbed_canceled: '1',
      rotate_events: '5',
    }])
  })
}
